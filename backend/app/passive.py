"""Passive mode: build sessions from agent transcripts on a schedule, no hooks.

The collector runs the bridge's own ``cot import`` (the same parsers the hooks
use, with per-file offsets so each pass only reads new lines) for each enabled
agent, then runs the insight rules over the result. Two phases, in that order,
so sessions and their metadata appear as soon as they're imported and findings
follow once analysis finishes.

Transcript folders are read from the collector's own filesystem. The desktop
app runs the collector on the host, so it can see ``~/.claude`` and friends; a
Docker collector only mounts ``~/.cot`` and reports the folders as unreadable.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from . import cron, db, store, timeutil

AGENTS = ("claude", "cursor", "codex", "opencode", "hermes")
_HOME_ENV = {"claude": "COT_CLAUDE_HOME", "cursor": "COT_CURSOR_HOME", "codex": "COT_CODEX_HOME",
             "opencode": "COT_OPENCODE_HOME", "hermes": "COT_HERMES_HOME"}
_HOME_DIR = {"claude": ".claude", "cursor": ".cursor", "codex": ".codex",
             "opencode": ".local/share/opencode", "hermes": ".hermes"}
# Same globs as the bridge's ``_discover_transcripts``.
_GLOB = {
    "claude": "projects/**/*.jsonl",
    "cursor": "projects/**/agent-transcripts/**/*.jsonl",
    "codex": "sessions/**/*.jsonl",
}
# Run history behind the Settings import chart.
RUNS_KEPT_DAYS = 30
# A transcript written to this recently belongs to a session that's still
# running; scheduled passes leave it for the next run so it's imported whole.
ACTIVE_WINDOW_MIN = 10

# Where the bridge posts events back. Set from incoming requests (see main.py),
# so it follows whatever port this collector actually serves on.
self_url = f"http://127.0.0.1:{os.environ.get('COT_PORT', '31337')}"


# --------------------------------------------------------------- settings

def config() -> dict[str, Any]:
    try:
        agents = json.loads(db.get_setting("passive_agents") or "null")
    except ValueError:
        agents = None
    if not isinstance(agents, list):
        agents = list(AGENTS)
    expr = db.get_setting("passive_cron") or cron.DEFAULT_CRON
    return {
        "enabled": db.get_setting("passive_enabled") == "1",
        "agents": [a for a in AGENTS if a in agents],
        "cron": expr,
    }


def update_config(*, enabled: bool | None = None, agents: list[str] | None = None, expr: str | None = None) -> dict[str, Any]:
    if expr is not None:
        cron.parse(expr)  # raises CronError for the API to report
        db.set_setting("passive_cron", " ".join(expr.split()))
        db.set_setting("passive_next_run", "")
    if agents is not None:
        db.set_setting("passive_agents", json.dumps([a for a in AGENTS if a in agents]))
    if enabled is not None:
        db.set_setting("passive_enabled", "1" if enabled else "0")
        if enabled:
            db.set_setting("passive_next_run", "")
    db.record_audit_event("settings.passive.updated", target="passive", detail=config())
    return config()


def schedule_info(expr: str, now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now().astimezone()
    nxt = cron.next_run(expr, now)
    after = cron.next_run(expr, nxt)
    return {"cron": expr, "description": cron.describe(expr), "next_runs": [nxt.isoformat(), after.isoformat()]}


# ----------------------------------------------------------- discovery

def _import_home() -> Path:
    # Sandbox desktop builds have an empty HOME but read real transcripts; the
    # bridge honours the same variable.
    env = os.environ.get("COT_IMPORT_HOME")
    return Path(env) if env else Path.home()


def transcript_root(agent: str) -> Path:
    if os.environ.get("COT_IMPORT_HOME"):
        return _import_home() / _HOME_DIR[agent]
    env = os.environ.get(_HOME_ENV[agent])
    if env:
        return Path(env)
    if agent == "opencode" and os.environ.get("XDG_DATA_HOME"):
        return Path(os.environ["XDG_DATA_HOME"]) / "opencode"
    if agent == "hermes" and os.environ.get("HERMES_HOME"):
        return Path(os.environ["HERMES_HOME"])
    return Path.home() / _HOME_DIR[agent]


_bridge_module: Any = None


def _load_bridge() -> Any:
    import importlib.machinery
    import importlib.util

    loader = importlib.machinery.SourceFileLoader("cot_bridge", str(_bridge_path()))
    spec = importlib.util.spec_from_loader("cot_bridge", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def _bridge() -> Any:
    """The bridge script loaded as a module, for the OpenCode store reader it
    shares with ``cot import`` (OpenCode keeps a database, not transcripts)."""
    global _bridge_module
    if _bridge_module is None:
        _bridge_module = _load_bridge()
    return _bridge_module


def _opencode_sessions(root: Path) -> list[dict[str, Any]]:
    try:
        return _bridge()._opencode_session_index(root)  # noqa: SLF001
    except Exception:  # noqa: BLE001 - an unreadable store reads as empty
        return []


def _hermes_sessions(root: Path) -> list[dict[str, Any]]:
    try:
        return _bridge()._hermes_session_index(root)  # noqa: SLF001
    except Exception:  # noqa: BLE001 - an unreadable store reads as empty
        return []


def _hermes_store_bytes(root: Path) -> int:
    total = 0
    for name in ("state.db", "state.db-wal"):
        try:
            total += (root / name).stat().st_size
        except OSError:
            continue
    return total


def _opencode_store_bytes(root: Path) -> int:
    total = 0
    for p in [root / "opencode.db", root / "opencode.db-wal", *root.glob("storage/**/*.json")]:
        try:
            total += p.stat().st_size
        except OSError:
            continue
    return total


def _project_of(agent: str, root: Path, path: Path) -> str | None:
    """Project folder name for Claude/Cursor (``projects/<encoded cwd>/``)."""
    if agent == "codex":
        return None
    try:
        rel = path.relative_to(root / "projects")
    except ValueError:
        return None
    return rel.parts[0] if len(rel.parts) > 1 else None


def scan(agent: str) -> dict[str, Any]:
    """What's on disk for one agent, without importing anything: the metadata
    onboarding shows straight away."""
    root = transcript_root(agent)
    out: dict[str, Any] = {
        "agent": agent,
        "root": str(root),
        "readable": False,
        "transcripts": 0,
        "bytes": 0,
        "projects": 0,
        "oldest": None,
        "newest": None,
        "active": 0,
    }
    try:
        resolved = root.resolve(strict=True)
        resolved.relative_to(_import_home().resolve(strict=True))
    except (OSError, ValueError):
        # Missing, or outside the home folder (the bridge refuses those too).
        return out
    if not os.access(resolved, os.R_OK | os.X_OK):
        return out
    out["readable"] = True
    projects: set[str] = set()
    oldest = newest = None
    active_after = time.time() - ACTIVE_WINDOW_MIN * 60
    if agent == "opencode":
        for sess in _opencode_sessions(resolved):
            updated = (sess.get("updated") or 0) / 1000
            out["transcripts"] += 1
            oldest = updated if oldest is None else min(oldest, updated)
            newest = updated if newest is None else max(newest, updated)
            if updated >= active_after:
                out["active"] += 1
            if sess.get("directory"):
                projects.add(sess["directory"])
        out["bytes"] = _opencode_store_bytes(resolved)
    if agent == "hermes":
        for sess in _hermes_sessions(resolved):
            if sess.get("parent_session_id"):
                continue  # subagent and compression children fold into their parent
            updated = sess.get("updated") or 0
            out["transcripts"] += 1
            oldest = updated if oldest is None else min(oldest, updated)
            newest = updated if newest is None else max(newest, updated)
            if updated >= active_after:
                out["active"] += 1
            if sess.get("cwd"):
                projects.add(sess["cwd"])
        out["bytes"] = _hermes_store_bytes(resolved)
    for path in (resolved.glob(_GLOB[agent]) if agent in _GLOB else ()):
        try:
            st = path.stat()
        except OSError:
            continue
        out["transcripts"] += 1
        out["bytes"] += st.st_size
        oldest = st.st_mtime if oldest is None else min(oldest, st.st_mtime)
        newest = st.st_mtime if newest is None else max(newest, st.st_mtime)
        if st.st_mtime >= active_after:
            out["active"] += 1
        p = _project_of(agent, resolved, path)
        if p:
            projects.add(p)
    out["projects"] = len(projects)
    if oldest is not None:
        out["oldest"] = datetime.fromtimestamp(oldest, tz=timezone.utc).isoformat()
        out["newest"] = datetime.fromtimestamp(newest, tz=timezone.utc).isoformat()
    return out


def _session_counts() -> dict[str, int]:
    with store.read() as conn:
        rows = conn.execute(
            "SELECT source, COUNT(*) AS n FROM sessions WHERE parent_session_id IS NULL"
            " AND import_root_id IS NULL GROUP BY source"
        ).fetchall()
    return {r["source"]: r["n"] for r in rows}


_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_PENDING_TTL_S = 30.0
_pending_cache: dict[str, Any] = {}


def _import_offsets() -> dict[str, int]:
    # The bridge keeps its state under the real HOME even when it reads
    # transcripts from COT_IMPORT_HOME (sandboxed desktop builds).
    path = Path.home() / ".cot" / "import_offsets.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _on_disk(agent: str) -> list[tuple[str, str, float]]:
    """(session id, offsets key, last written) for each quiet session on disk.
    Sessions written to in the last ACTIVE_WINDOW_MIN are left out: an import
    holds them back anyway."""
    root = transcript_root(agent)
    try:
        resolved = root.resolve(strict=True)
        resolved.relative_to(_import_home().resolve(strict=True))
    except (OSError, ValueError):
        return []
    quiet_before = time.time() - ACTIVE_WINDOW_MIN * 60
    out: list[tuple[str, str, float]] = []
    if agent == "opencode":
        for sess in _opencode_sessions(resolved):
            updated = (sess.get("updated") or 0) / 1000
            if updated < quiet_before:
                out.append((sess["id"], f"opencode:{sess['id']}", updated))
        return out
    if agent == "hermes":
        for sess in _hermes_sessions(resolved):
            updated = sess.get("updated") or 0
            if not sess.get("parent_session_id") and updated < quiet_before:
                out.append((sess["id"], f"hermes:{sess['id']}", updated))
        return out
    for path in resolved.glob(_GLOB[agent]):
        if path.parent.name == "subagents":
            continue
        m = _UUID_RE.search(path.stem)
        if not m:
            continue
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        if mtime < quiet_before:
            out.append((m.group(0), str(path), mtime))
    return out


def pending(*, fresh: bool = False) -> dict[str, Any]:
    """Sessions on disk that cot hasn't imported yet, per enabled agent.

    A session counts as imported once it exists in cot (by hook or import) or
    the importer has recorded reading it, so one that yields no events doesn't
    keep the prompt up forever. Cached briefly: it walks the transcript folders."""
    now = time.monotonic()
    if not fresh and _pending_cache.get("at", -1e9) > now - _PENDING_TTL_S:
        return _pending_cache["value"]
    with store.read() as conn:
        known = {r["id"] for r in conn.execute("SELECT id FROM sessions")}
    offsets = _import_offsets()
    by_agent: dict[str, int] = {}
    newest: float | None = None
    for agent in config()["agents"]:
        n = 0
        for sid, key, written in _on_disk(agent):
            if sid in known or key in offsets:
                continue
            n += 1
            newest = written if newest is None else max(newest, written)
        if n:
            by_agent[agent] = n
    value = {
        "total": sum(by_agent.values()),
        "by_agent": by_agent,
        "newest": datetime.fromtimestamp(newest, tz=timezone.utc).isoformat() if newest else None,
    }
    _pending_cache.update(at=now, value=value)
    return value


# ----------------------------------------------------------------- runs

_lock = threading.Lock()
_state: dict[str, Any] = {"running": False}


# DB paths whose passive_runs table is known to exist. runs() sits behind the
# task tray's poll, and a CREATE ... IF NOT EXISTS still takes the write lock,
# so doing it on every poll turned a read into a write that failed with
# "database is locked" whenever anything else was writing.
_runs_table_ready: set[str] = set()


def _ensure_runs_table() -> None:
    path = str(store.path())
    if path in _runs_table_ready:
        return
    with store.write() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS passive_runs ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,"
            " status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}')"
        )
    _runs_table_ready.add(path)


def runs(limit: int = 10) -> list[dict[str, Any]]:
    _ensure_runs_table()
    with store.read() as conn:
        rows = conn.execute(
            "SELECT * FROM passive_runs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [
        {
            "id": r["id"],
            "trigger": r["trigger"],
            "started_at": r["started_at"],
            "finished_at": r["finished_at"],
            "status": r["status"],
            **json.loads(r["detail"] or "{}"),
        }
        for r in rows
    ]


def _history_cutoff(days: int = RUNS_KEPT_DAYS) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def history(days: int = RUNS_KEPT_DAYS) -> list[dict[str, Any]]:
    """Every run in the last ``days``, oldest first, for the Settings chart."""
    _ensure_runs_table()
    days = max(1, min(days, RUNS_KEPT_DAYS))
    with store.read() as conn:
        rows = conn.execute(
            "SELECT * FROM passive_runs WHERE started_at >= ? ORDER BY id", (_history_cutoff(days),)
        ).fetchall()
    out = []
    for r in rows:
        d = json.loads(r["detail"] or "{}")
        out.append({
            "id": r["id"], "trigger": r["trigger"], "status": r["status"],
            "started_at": r["started_at"], "finished_at": r["finished_at"],
            "new_sessions": d.get("new_sessions"), "events": d.get("events"), "findings": d.get("findings"),
        })
    return out


def running() -> dict[str, Any]:
    return dict(_state)


def _set_progress(agent: str, files_done: int, files_total: int, bytes_done: int, bytes_total: int) -> None:
    """Record the bridge's progress for ``agent`` and the run's overall share.

    Overall progress is by bytes across every agent in the run, since a few
    large transcripts take far longer than many small ones."""
    _state["agents"] = {
        **_state.get("agents", {}),
        agent: {"status": "importing", "files_done": files_done, "files_total": files_total,
                "bytes_done": bytes_done, "bytes_total": bytes_total},
    }
    totals = _state.get("bytes_by_agent", {})
    totals[agent] = bytes_total
    done = sum(totals.get(a, 0) for a in _state.get("finished_agents", ()))
    total = sum(totals.values())
    _state["progress"] = {"bytes_done": done + bytes_done, "bytes_total": max(total, 1), "agent": agent}


def _bridge_path() -> Path:
    here = Path(__file__).resolve()
    for candidate in (here.parent.parent.parent / "bridge" / "cot", here.parent.parent / "bridge" / "cot"):
        if candidate.exists():
            return candidate
    return here.parent.parent.parent / "bridge" / "cot"


# Called with a session id after imported events are stored, so the dashboard's
# live stream picks them up. main.py points it at its revision counter.
on_ingest: Callable[[str | None], None] = lambda session_id: None


def _ingest(url: str, body: dict[str, Any] | list[dict[str, Any]]) -> None:
    """Where the in-process import's events go instead of an HTTP POST: the
    same writes ``/v1/ingest/{source}`` makes, one transaction per batch."""
    source = url.rsplit("/v1/ingest/", 1)[-1]
    if isinstance(body, dict) and body.get("_attach_to_prompt"):
        db.attach_to_prompt(str(body.get("session_id") or ""), body.get("text"),
                            body.get("attachments") or [], body.get("timestamp"))
        on_ingest(str(body.get("session_id") or ""))
        return
    items = body if isinstance(body, list) else [body]
    for result in db.record_ingests([(source, b) for b in items]):
        on_ingest(result.get("session_id"))


def _import_agent(agent: str, *, hold_back: bool = True, progress: bool = True) -> dict[str, int]:
    """Import one agent's transcripts in this process, with the bridge's own
    parsers, writing events straight to the store. Transcripts of sessions
    still in progress are held back unless ``hold_back`` is off (the watcher,
    which imports them as they're written). Either way only sessions quiet for
    ACTIVE_WINDOW_MIN are marked completed. Returns events stored and how many
    transcripts were held back.

    The bridge still reaches this collector over HTTP for the few per-pass
    calls (session origins, completion, question recovery); only the events,
    which are nearly all the work, skip the round trip."""
    # A fresh load per run, as the subprocess it replaces was: the bridge reads
    # HOME (its ~/.cot state) and its config when it loads.
    bridge = _load_bridge()
    bridge.COT_ENDPOINT = self_url
    bridge._INGEST_SINK = _ingest  # noqa: SLF001
    bridge._PROGRESS_SINK = _set_progress if progress else (lambda *_: None)  # noqa: SLF001
    try:
        posted, held_back = bridge._run_import(  # noqa: SLF001
            [agent], skip_active_s=ACTIVE_WINDOW_MIN * 60 if hold_back else 0, verbose=False,
            complete_quiet_s=ACTIVE_WINDOW_MIN * 60,
        )
    finally:
        bridge._INGEST_SINK = None  # noqa: SLF001
        bridge._PROGRESS_SINK = None  # noqa: SLF001
    return {"events": posted, "held_back": len(held_back)}


def _analyze() -> int:
    from . import insights

    def progress(done: int, total: int) -> None:
        _state["analysis"] = {"done": done, "total": total}

    return len(insights.compute_insights(days=30, progress=progress)["insights"])


def run(
    trigger: str = "manual",
    *,
    importer: Callable[[str], int | dict[str, int]] | None = None,
    analyzer: Callable[[], int] | None = None,
) -> dict[str, Any] | None:
    """One passive pass: import every enabled, readable agent, then analyze.

    Returns the finished run, or None when a pass is already running."""
    if not _lock.acquire(blocking=False):
        return None
    importer = importer or _import_agent
    analyzer = analyzer or _analyze
    started = timeutil.now()
    cfg = config()
    detail: dict[str, Any] = {"agents": {}, "phase": "metadata"}
    _state.update(running=True, trigger=trigger, started_at=started, phase="metadata", agents={},
                  finished_agents=[], bytes_by_agent={})
    _ensure_runs_table()
    with store.write() as conn:
        run_id = conn.execute(
            "INSERT INTO passive_runs (trigger, started_at, status, detail) VALUES (?, ?, 'running', ?)",
            (trigger, started, json.dumps(detail)),
        ).lastrowid
    status = "ok"
    try:
        before = _session_counts()
        # Sizes up front, so the overall bar counts agents not started yet.
        scans = {agent: scan(agent) for agent in cfg["agents"]}
        _state["bytes_by_agent"] = {a: s["bytes"] for a, s in scans.items() if s["readable"]}
        for agent in cfg["agents"]:
            info: dict[str, Any] = {"status": "skipped"}
            if not scans[agent]["readable"]:
                info = {"status": "unreadable"}
            else:
                _state["agents"] = {**_state["agents"], agent: {"status": "importing"}}
                try:
                    got = importer(agent)
                    info = {"status": "ok", **(got if isinstance(got, dict) else {"events": got, "held_back": 0})}
                except Exception as exc:  # noqa: BLE001 - one agent failing shouldn't stop the rest
                    info = {"status": "error", "error": str(exc)[:300]}
                    status = "partial"
            detail["agents"][agent] = info
            _state["agents"] = {**_state["agents"], agent: info}
            _state["finished_agents"] = [*_state["finished_agents"], agent]
        after = _session_counts()
        detail["new_sessions"] = sum(max(0, after.get(a, 0) - before.get(a, 0)) for a in cfg["agents"])
        detail["events"] = sum(i.get("events", 0) for i in detail["agents"].values())
        detail["held_back"] = sum(i.get("held_back", 0) for i in detail["agents"].values())
        # Metadata is in; the slower analysis runs next while sessions are already browsable.
        detail["phase"] = "analysis"
        _state["phase"] = "analysis"
        if "progress" in _state:
            _state["progress"]["bytes_done"] = _state["progress"]["bytes_total"]
        _state["analysis"] = {"done": 0, "total": 1}
        with store.write() as conn:
            conn.execute("UPDATE passive_runs SET detail = ? WHERE id = ?", (json.dumps(detail), run_id))
        detail["findings"] = analyzer()
        detail["phase"] = "done"
    except Exception as exc:  # noqa: BLE001
        status = "error"
        detail["error"] = str(exc)[:300]
    finally:
        finished = timeutil.now()
        with store.write() as conn:
            conn.execute(
                "UPDATE passive_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?",
                (finished, status, json.dumps(detail), run_id),
            )
            conn.execute("DELETE FROM passive_runs WHERE started_at < ?", (_history_cutoff(),))
        _pending_cache.clear()
        _state.clear()
        _state["running"] = False
        _lock.release()
    return {"id": run_id, "trigger": trigger, "started_at": started, "finished_at": finished, "status": status, **detail}


def import_now(agents: list[str]) -> bool:
    """Import ``agents`` straight away, live sessions included, without the
    analysis pass or a run record: the file watcher's path. False when another
    pass holds the lock (the caller retries)."""
    if not _lock.acquire(blocking=False):
        return False
    try:
        for agent in agents:
            try:
                _import_agent(agent, hold_back=False, progress=False)
            except Exception:  # noqa: BLE001 - one agent failing shouldn't stop the rest
                pass
        _pending_cache.clear()
    finally:
        _lock.release()
    return True


def run_in_background(trigger: str = "manual") -> bool:
    """Start a pass on a worker thread; False if one is already running."""
    if _lock.locked():
        return False
    threading.Thread(target=run, args=(trigger,), daemon=True, name="cot-passive-run").start()
    return True


# ------------------------------------------------------------ scheduler

def due(now: datetime) -> bool:
    """Whether a scheduled pass should start now; advances the stored next run."""
    cfg = config()
    if not cfg["enabled"]:
        return False
    stored = db.get_setting("passive_next_run") or ""
    try:
        nxt = datetime.fromisoformat(stored) if stored else None
    except ValueError:
        nxt = None
    if nxt is None:
        db.set_setting("passive_next_run", cron.next_run(cfg["cron"], now).isoformat())
        return False
    if now < nxt:
        return False
    db.set_setting("passive_next_run", cron.next_run(cfg["cron"], now).isoformat())
    return True


def next_scheduled() -> str | None:
    if not config()["enabled"]:
        return None
    return db.get_setting("passive_next_run") or None


def start_scheduler(interval_s: float = 20.0) -> threading.Thread | None:
    if os.environ.get("COT_PASSIVE_SCHEDULER", "1") == "0":
        return None

    def loop() -> None:
        while True:
            try:
                if due(datetime.now().astimezone()):
                    run("schedule")
            except Exception:  # noqa: BLE001 - keep the scheduler alive
                pass
            time.sleep(interval_s)

    t = threading.Thread(target=loop, daemon=True, name="cot-passive-scheduler")
    t.start()
    return t

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
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import cron, db, store, timeutil

AGENTS = ("claude", "cursor", "codex")
_HOME_ENV = {"claude": "COT_CLAUDE_HOME", "cursor": "COT_CURSOR_HOME", "codex": "COT_CODEX_HOME"}
_HOME_DIR = {"claude": ".claude", "cursor": ".cursor", "codex": ".codex"}
# Same globs as the bridge's ``_discover_transcripts``.
_GLOB = {
    "claude": "projects/**/*.jsonl",
    "cursor": "projects/**/agent-transcripts/**/*.jsonl",
    "codex": "sessions/**/*.jsonl",
}
# An import is stopped only when it goes quiet this long: the bridge reports
# progress per transcript, so a large history can run as long as it needs.
_IMPORT_IDLE_TIMEOUT_S = 15 * 60
_RUNS_KEPT = 50
_POSTED_RE = re.compile(r"done\s+\S+\s+(\d+)\s+events posted")
_HELD_RE = re.compile(r"held back (\d+) in-progress")
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
    return Path(env) if env else Path.home() / _HOME_DIR[agent]


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
    for path in resolved.glob(_GLOB[agent]):
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


# ----------------------------------------------------------------- runs

_lock = threading.Lock()
_state: dict[str, Any] = {"running": False}


def _ensure_runs_table() -> None:
    with store.write() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS passive_runs ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,"
            " status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}')"
        )


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


def _import_agent(agent: str) -> dict[str, int]:
    """Run ``cot import --agent <agent>`` against this collector, holding back
    transcripts of sessions still in progress. Returns events posted and how
    many transcripts were held back."""
    env = {**os.environ, "COT_ENDPOINT": self_url, "COT_IMPORT_PROGRESS": "1", "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(
        [sys.executable, str(_bridge_path()), "import", "--agent", agent, "--skip-active", str(ACTIVE_WINDOW_MIN)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    last_output = time.monotonic()
    stalled = threading.Event()
    finished = threading.Event()

    def watchdog() -> None:
        while not finished.wait(5):
            if time.monotonic() - last_output > _IMPORT_IDLE_TIMEOUT_S:
                stalled.set()
                proc.kill()
                return

    threading.Thread(target=watchdog, daemon=True).start()
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            last_output = time.monotonic()
            parts = line.split()
            if len(parts) == 6 and parts[0] == "cot-progress" and parts[1] == agent:
                _set_progress(agent, *(int(x) for x in parts[2:]))
            else:
                lines.append(line)
        proc.wait()
    finally:
        finished.set()
    out = "".join(lines)
    if stalled.is_set():
        raise RuntimeError(f"import stopped: no progress for {_IMPORT_IDLE_TIMEOUT_S // 60} minutes")
    if proc.returncode != 0:
        tail = out.strip().splitlines()[-1:] or [f"import failed (exit {proc.returncode})"]
        raise RuntimeError(tail[0][:300])
    posted = _POSTED_RE.search(out)
    held = _HELD_RE.search(out)
    return {"events": int(posted.group(1)) if posted else 0, "held_back": int(held.group(1)) if held else 0}


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
            conn.execute(
                "DELETE FROM passive_runs WHERE id NOT IN (SELECT id FROM passive_runs ORDER BY id DESC LIMIT ?)",
                (_RUNS_KEPT,),
            )
        _state.clear()
        _state["running"] = False
        _lock.release()
    return {"id": run_id, "trigger": trigger, "started_at": started, "finished_at": finished, "status": status, **detail}


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

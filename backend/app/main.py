"""cot collector API.

Receives agent hook events and serves them back for the dashboard. Everything
is stored in one local SQLite file; nothing leaves the machine.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform as _platform
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, db
from .normalize import normalize

app = FastAPI(title="cot collector", version=__version__)

AGENTS = ("claude", "cursor", "codex")
EXPECTED_HOOKS = {
    "claude": [
        "SessionStart",
        "SessionEnd",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "Stop",
        "SubagentStop",
        "PreCompact",
        "Notification",
    ],
    "cursor": [
        "sessionStart",
        "sessionEnd",
        "beforeSubmitPrompt",
        "afterAgentResponse",
        "afterAgentThought",
        "preToolUse",
        "postToolUse",
        "postToolUseFailure",
        "subagentStart",
        "subagentStop",
        "preCompact",
        "stop",
    ],
    "codex": [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PermissionRequest",
        "PreCompact",
        "PostCompact",
        "SubagentStart",
        "SubagentStop",
        "Stop",
    ],
}
HOOK_LABELS = {
    "SessionStart": "Session start",
    "SessionEnd": "Session end",
    "UserPromptSubmit": "Prompt submitted",
    "PreToolUse": "Tool start",
    "PostToolUse": "Tool finish",
    "PostToolUseFailure": "Tool failed",
    "Stop": "Session stopped",
    "SubagentStart": "Subagent start",
    "SubagentStop": "Subagent finish",
    "PreCompact": "Compaction start",
    "PostCompact": "Compaction finish",
    "Notification": "Notification",
    "PermissionRequest": "Permission requested",
    "sessionStart": "Session start",
    "sessionEnd": "Session end",
    "beforeSubmitPrompt": "Prompt submitted",
    "afterAgentResponse": "Response",
    "afterAgentThought": "Thought",
    "preToolUse": "Tool start",
    "postToolUse": "Tool finish",
    "postToolUseFailure": "Tool failed",
    "subagentStart": "Subagent start",
    "subagentStop": "Subagent finish",
    "preCompact": "Compaction start",
    "stop": "Session stopped",
}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _bridge_dir() -> Path:
    here = Path(__file__).resolve()
    for candidate in (here.parent.parent.parent / "bridge", here.parent.parent / "bridge"):
        if candidate.exists():
            return candidate
    return here.parent.parent.parent / "bridge"


_BRIDGE_DIR = _bridge_dir()


@app.on_event("startup")
async def _startup() -> None:
    db.init_db()
    # Opt-in telemetry runs in the background so it never blocks request handling
    # and degrades silently when offline/air-gapped.
    asyncio.create_task(_telemetry_loop())


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__, "db_path": str(db.db_path())}


def _hook_status_path() -> Path:
    return db.db_path().parent / "hooks_status.json"


def _read_hook_manifest() -> dict[str, Any]:
    try:
        data = json.loads(_hook_status_path().read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _hook_label(name: str) -> str:
    return HOOK_LABELS.get(name, name)


def _repair_agents(value: str | None) -> list[str]:
    if not value:
        return list(AGENTS)
    requested = [part.strip().lower() for part in value.replace(",", " ").split()]
    return [a for a in AGENTS if a in requested]


def _repair_script(agents: list[str]) -> str:
    agent_args = " ".join(agents)
    return f"""#!/bin/sh
set -e
COT_ENDPOINT="${{COT_ENDPOINT:-http://127.0.0.1:31337}}"
COT_HOME="${{HOME}}/.cot"
TARGET="${{COT_HOME}}/bin/cot"
mkdir -p "${{COT_HOME}}/bin"
curl -fsSL "${{COT_ENDPOINT}}/cot" -o "${{TARGET}}"
chmod +x "${{TARGET}}"
env COT_ENDPOINT="${{COT_ENDPOINT}}" COT_REPAIR=1 "${{TARGET}}" install {agent_args}
printf '%s\\n' "cot hook repair complete. Return to the hook setup screen."
"""


# Where the published "latest version" manifest lives. Overridable for testing.
_VERSION_MANIFEST_URL = os.environ.get(
    "COT_VERSION_MANIFEST_URL", "https://cot.run/version.json"
)
# Re-check at most this often; the result is cached in-memory between calls.
_VERSION_CACHE_TTL = 6 * 60 * 60  # 6 hours
_version_cache: dict[str, Any] = {"fetched_at": 0.0, "latest": None, "url": None}


def _parse_semver(value: str) -> tuple[int, ...]:
    parts = value.strip().lstrip("v").split(".")
    out: list[int] = []
    for part in parts:
        # Take the leading digit run only, dropping any pre-release/build
        # suffix (e.g. "1.2.0-rc1" -> the "0" component stops at "-").
        num = ""
        for ch in part:
            if not ch.isdigit():
                break
            num += ch
        if not num:
            break
        out.append(int(num))
    return tuple(out) if out else (0,)


def _fetch_latest() -> tuple[str | None, str | None]:
    """Fetch the published manifest, caching the result. Returns (latest, url).

    Never raises: any network/parse failure returns the last known value (or
    Nones), so an offline or air-gapped collector degrades silently.
    """
    now = time.time()
    if now - _version_cache["fetched_at"] < _VERSION_CACHE_TTL and _version_cache["latest"]:
        return _version_cache["latest"], _version_cache["url"]
    try:
        req = urllib.request.Request(
            _VERSION_MANIFEST_URL, headers={"User-Agent": f"cot/{__version__}"}
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        latest = str(data["version"]).strip()
        url = data.get("url")
        _version_cache.update(fetched_at=now, latest=latest, url=url)
        return latest, url
    except Exception:
        # Mark the attempt so we don't retry on every request while offline.
        _version_cache["fetched_at"] = now
        return _version_cache["latest"], _version_cache["url"]


@app.get("/v1/version")
def version_info(refresh: bool = False) -> dict[str, Any]:
    """Current vs. latest published version. Self-hosters can disable the
    outbound check entirely with COT_DISABLE_UPDATE_CHECK=1."""
    if os.environ.get("COT_DISABLE_UPDATE_CHECK") in ("1", "true", "yes"):
        return {"current": __version__, "latest": None, "update_available": False, "url": None}
    if refresh:
        _version_cache["fetched_at"] = 0.0
    latest, url = _fetch_latest()
    update_available = bool(latest) and _parse_semver(latest) > _parse_semver(__version__)
    return {
        "current": __version__,
        "latest": latest,
        "update_available": update_available,
        "url": url,
    }


# --- Opt-in telemetry ---------------------------------------------------------
#
# When enabled (on by default, toggled in onboarding/settings), the collector
# periodically POSTs *anonymous aggregate* metrics to cot.run so we can spot and
# fix issues across installs. It only sends counts and identifiers that carry no
# user content: never prompts, responses, thoughts, file paths, commands, or
# arguments. Users only need to allow outbound access to cot.run; self-hosters
# can hard-disable it with COT_DISABLE_TELEMETRY=1.

_TELEMETRY_URL = os.environ.get("COT_TELEMETRY_URL", "https://cot.run/v1/telemetry")
# Don't report more often than this, even across restarts.
_TELEMETRY_MIN_INTERVAL = 20 * 60 * 60  # 20 hours
_TELEMETRY_PERIOD = 24 * 60 * 60  # 24 hours


def _telemetry_env_disabled() -> bool:
    return os.environ.get("COT_DISABLE_TELEMETRY") in ("1", "true", "yes")


def _telemetry_enabled() -> bool:
    """Effective opt-in state: the stored preference (default on), unless an
    env override has hard-disabled it for this deployment."""
    if _telemetry_env_disabled():
        return False
    return db.get_setting("telemetry_enabled", "1") in ("1", "true", "yes", "on")


def _telemetry_payload() -> dict[str, Any]:
    """Build the anonymous aggregate report. Content-free by construction: we
    hand-pick count-only fields and drop anything path/text-bearing."""
    m = db.metrics()
    totals = m.get("totals", {})
    fun = m.get("fun", {})
    return {
        "install_id": db.get_install_id(),
        "version": __version__,
        "sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "runtime": {
            "python": _platform.python_version(),
            "os": _platform.system(),
            "arch": _platform.machine(),
        },
        "metrics": {
            "sessions": totals.get("sessions", 0),
            "events": totals.get("events", 0),
            "tool_calls": totals.get("tool_calls", 0),
            "projects": totals.get("projects", 0),
            "errors": totals.get("errors", 0),
            "permissions": totals.get("permissions", 0),
            "error_rate": fun.get("error_rate", 0.0),
            "tokens_total": m.get("tokens", {}).get("total", 0),
            "days_active": len(m.get("by_day", [])),
            "installed_at": db.get_setting("installed_at"),
            "by_source": [
                {"source": r.get("source"), "events": r.get("events", 0)}
                for r in m.get("by_source", [])
            ],
            "by_category": m.get("by_category", []),
        },
    }


def _send_telemetry(force: bool = False) -> None:
    """Send one report if enabled and not throttled. Never raises."""
    try:
        if not _telemetry_enabled():
            return
        now = time.time()
        if not force:
            last = db.get_setting("telemetry_last_sent")
            if last:
                try:
                    if now - float(last) < _TELEMETRY_MIN_INTERVAL:
                        return
                except ValueError:
                    pass
        body = json.dumps(_telemetry_payload()).encode("utf-8")
        req = urllib.request.Request(
            _TELEMETRY_URL,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"cot/{__version__}",
            },
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
        db.set_setting("telemetry_last_sent", str(now))
    except Exception:
        # Offline/air-gapped/blocked: drop silently, try again next cycle.
        pass


async def _telemetry_loop() -> None:
    # Small initial delay so startup isn't competing with the first report.
    await asyncio.sleep(60)
    while True:
        try:
            await asyncio.to_thread(_send_telemetry, False)
        except Exception:
            pass
        await asyncio.sleep(_TELEMETRY_PERIOD)


@app.get("/v1/settings")
def get_settings() -> dict[str, Any]:
    return {
        "telemetry_enabled": _telemetry_enabled(),
        "telemetry_env_disabled": _telemetry_env_disabled(),
        "telemetry_endpoint": _TELEMETRY_URL,
    }


@app.put("/v1/settings")
async def update_settings(request: Request) -> dict[str, Any]:
    body = await _json_body(request)
    if "telemetry_enabled" in body:
        enabled = bool(body["telemetry_enabled"])
        db.set_setting("telemetry_enabled", "1" if enabled else "0")
        db.record_audit_event(
            "settings.telemetry.updated",
            target="telemetry_enabled",
            detail={"telemetry_enabled": enabled},
        )
        # Opting in: send a first report promptly (best-effort, off-thread) so the
        # choice takes effect without waiting for the daily cycle.
        if enabled and not _telemetry_env_disabled():
            threading.Thread(target=_send_telemetry, args=(True,), daemon=True).start()
    return get_settings()


@app.get("/v1/audit/self")
def get_self_audit(limit: int = 100) -> dict[str, Any]:
    return {"events": db.audit_events(max(1, min(limit, 500)))}


@app.post("/v1/audit/self")
async def record_self_audit(request: Request) -> dict[str, Any]:
    body = await _json_body(request)
    event_id = db.record_audit_event(
        str(body.get("action") or "unknown"),
        actor=str(body.get("actor") or "cot"),
        target=str(body.get("target")) if body.get("target") is not None else None,
        status=str(body.get("status") or "ok"),
        detail=body.get("detail"),
    )
    return {"ok": True, "event_id": event_id}


@app.get("/v1/retention")
def get_retention() -> dict[str, Any]:
    return db.retention_status()


@app.put("/v1/retention")
async def update_retention(request: Request) -> dict[str, Any]:
    body = await _json_body(request)
    enabled = bool(body["enabled"]) if "enabled" in body else None
    days = int(body["days"]) if "days" in body else None
    db.set_retention_policy(enabled=enabled, days=days)
    return db.retention_status()


@app.post("/v1/retention/cleanup")
async def cleanup_retention(request: Request) -> dict[str, Any]:
    body = await _json_body(request)
    return db.cleanup_retention(dry_run=bool(body.get("dry_run", True)))


@app.get("/install.sh")
def install_script(repair: bool = False, agents: str | None = None):
    if repair:
        selected = _repair_agents(agents)
        return PlainTextResponse(
            _repair_script(selected),
            media_type="text/x-shellscript",
            headers={"Content-Disposition": 'attachment; filename="cot-repair.sh"'},
        )
    script = _BRIDGE_DIR / "install.sh"
    if not script.exists():
        raise HTTPException(status_code=404, detail="install.sh not found")
    return FileResponse(script, media_type="text/plain")


@app.get("/repair.sh")
def repair_script(agents: str | None = None):
    selected = _repair_agents(agents)
    return PlainTextResponse(
        _repair_script(selected),
        media_type="text/x-shellscript",
        headers={"Content-Disposition": 'attachment; filename="cot-repair.sh"'},
    )


@app.get("/cot")
def bridge_script() -> FileResponse:
    script = _BRIDGE_DIR / "cot"
    if not script.exists():
        raise HTTPException(status_code=404, detail="cot bridge not found")
    return FileResponse(script, media_type="text/plain")


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Hook payload must be a JSON object")
    return body


@app.post("/v1/ingest/{source}")
async def ingest(source: str, request: Request) -> dict[str, Any]:
    if source not in ("claude", "cursor", "codex"):
        raise HTTPException(status_code=404, detail=f"Unknown source: {source}")
    body = await _json_body(request)

    # Attachment metadata folds onto the matching prompt event, not a new row.
    if body.get("_attach_to_prompt"):
        attached = db.attach_to_prompt(
            str(body.get("session_id") or ""),
            body.get("text"),
            body.get("attachments") or [],
            body.get("timestamp"),
        )
        return {"ok": True, "attached": attached}

    norm = normalize(source, body)
    if db.should_ignore_event(norm):
        return {
            "ok": True,
            "ignored": True,
            "session_id": norm["session_id"],
            "event_id": None,
            "hook": norm["hook"],
            "category": norm.get("category"),
        }
    session_id, event_id = db.record_event(norm, body)
    return {
        "ok": True,
        "session_id": session_id,
        "event_id": event_id,
        "hook": norm["hook"],
        "category": norm.get("category"),
    }


@app.get("/v1/stats")
def get_stats() -> dict[str, Any]:
    return db.stats()


@app.get("/v1/sessions")
def get_sessions(
    limit: int = 50,
    status: str | None = None,
    source: str | None = None,
    q: str | None = None,
    archived: bool = False,
) -> dict[str, Any]:
    limit = max(1, min(limit, 500))
    return {
        "sessions": db.list_sessions(
            limit, status=status, source=source, q=q, archived=archived
        )
    }


@app.post("/v1/sessions/{session_id}/archive")
def archive_session(session_id: str) -> dict[str, Any]:
    if not db.set_archived(session_id, True):
        raise HTTPException(status_code=404, detail="Session not found")
    db.record_audit_event("session.archived", target=session_id)
    return {"ok": True, "archived": True}


@app.post("/v1/sessions/{session_id}/unarchive")
def unarchive_session(session_id: str) -> dict[str, Any]:
    if not db.set_archived(session_id, False):
        raise HTTPException(status_code=404, detail="Session not found")
    db.record_audit_event("session.unarchived", target=session_id)
    return {"ok": True, "archived": False}


@app.get("/v1/sessions/origins")
def get_session_origins() -> dict[str, Any]:
    return {"origins": db.session_origins()}


@app.get("/v1/import/summary")
def get_import_summary() -> dict[str, Any]:
    return db.import_summary()


@app.get("/v1/import/report")
def get_import_report() -> dict[str, Any]:
    """Ingestion quality + per-source coverage (category mix, % other,
    token/model coverage). Surfaces parsing regressions and what each agent
    actually logs."""
    return db.import_quality()


@app.post("/v1/sessions/complete-imported")
def complete_imported_sessions() -> dict[str, Any]:
    return db.complete_imported_sessions()


@app.post("/v1/import/reset")
def reset_import() -> dict[str, Any]:
    """Delete previously imported transcript data so it can be re-ingested with
    the current parsers. Live hook events are preserved."""
    return db.reset_imported()


@app.post("/v1/questions/reset-recovered")
def reset_recovered_answers() -> dict[str, Any]:
    """Clear heuristically-recovered question answers so a fresh recovery pass
    can re-derive them. Real tool-result answers are untouched."""
    return {"ok": True, "cleared": db.clear_recovered_answers()}


@app.post("/v1/questions/answer")
async def set_question_answer(request: Request) -> dict[str, Any]:
    """Merge a host-recovered AskQuestion answer onto stored question events.

    Cursor never persists the selection, so the bridge recovers it from the
    agent's follow-up prose (it can read the transcripts; the container can't)
    and posts it here keyed by the question's signature."""
    body = await _json_body(request)
    updated = db.set_question_answer(
        str(body.get("session_id") or ""),
        body.get("title"),
        body.get("qids") if isinstance(body.get("qids"), list) else [],
        body.get("response") if isinstance(body.get("response"), dict) else {},
    )
    return {"ok": True, "updated": updated}


@app.get("/v1/connections")
def get_connections() -> dict[str, Any]:
    return {"connections": db.connections()}


@app.get("/v1/hooks/status")
def get_hook_status() -> dict[str, Any]:
    manifest = _read_hook_manifest()
    manifest_agents = manifest.get("agents") if isinstance(manifest.get("agents"), dict) else {}
    connections = {c["source"]: c for c in db.connections()}

    agents: list[dict[str, Any]] = []
    for source in AGENTS:
        entry = manifest_agents.get(source) if isinstance(manifest_agents.get(source), dict) else {}
        expected = entry.get("expected_hooks") if isinstance(entry.get("expected_hooks"), list) else EXPECTED_HOOKS[source]
        expected_hooks = [str(h) for h in expected if h]
        installed_raw = entry.get("installed_hooks") if isinstance(entry.get("installed_hooks"), list) else entry.get("hooks")
        installed_hooks = [str(h) for h in installed_raw if h] if isinstance(installed_raw, list) else []
        missing_raw = entry.get("missing_hooks") if isinstance(entry.get("missing_hooks"), list) else [
            h for h in expected_hooks if h not in installed_hooks
        ]
        missing_hooks = [str(h) for h in missing_raw if h]
        conn = connections.get(source, {})
        events = int(conn.get("events") or 0)
        connected = bool(conn.get("connected"))
        manifest_installed = bool(entry.get("installed"))
        installed = manifest_installed or (not manifest_agents and events > 0)
        if not installed and events == 0:
            health = "not_installed"
        elif missing_hooks:
            health = "missing_hooks"
        elif installed and events == 0:
            health = "no_events"
        elif installed and not connected:
            health = "stale"
        else:
            health = "healthy"
        repair_url = f"/repair.sh?agents={source}"
        latest_backup = entry.get("latest_backup") if isinstance(entry.get("latest_backup"), dict) else None
        agents.append(
            {
                "source": source,
                "installed": installed,
                "connected": connected,
                "sessions": int(conn.get("sessions") or 0),
                "events": events,
                "last_event": conn.get("last_event"),
                "config_path": entry.get("config_path"),
                "config_exists": entry.get("config_exists"),
                "valid_json": entry.get("valid_json"),
                "expected_hooks": expected_hooks,
                "installed_hooks": installed_hooks,
                "missing_hooks": missing_hooks,
                "hooks": expected_hooks,
                "labels": [_hook_label(h) for h in expected_hooks],
                "installed_labels": [_hook_label(h) for h in installed_hooks],
                "missing_labels": [_hook_label(h) for h in missing_hooks],
                "backup_count": int(entry.get("backup_count") or 0),
                "latest_backup": latest_backup,
                "warnings": entry.get("warnings") if isinstance(entry.get("warnings"), list) else [],
                "health": health,
                "repair_url": repair_url,
            }
        )

    return {
        "updated_at": manifest.get("updated_at"),
        "endpoint": manifest.get("endpoint"),
        "manifest_found": bool(manifest_agents),
        "repair_all_url": "/repair.sh?agents=claude,cursor,codex",
        "agents": agents,
    }


@app.get("/v1/metrics")
def get_metrics(tz: str | None = Query(None)) -> dict[str, Any]:
    return db.metrics(tz)


@app.get("/v1/metrics/history")
def get_metrics_history(category: str = "shell", limit: int = 200) -> dict[str, Any]:
    if category not in ("shell", "web"):
        raise HTTPException(status_code=400, detail="category must be 'shell' or 'web'")
    limit = max(1, min(limit, 500))
    return {"items": db.metrics_history(category, limit)}


@app.get("/v1/search")
def search(q: str = "", limit: int = 40) -> dict[str, Any]:
    q = q.strip()
    if len(q) < 2:
        return {"results": []}
    return {"results": db.search(q, max(1, min(limit, 100)))}


class ExportRequest(BaseModel):
    session_ids: list[str] | None = None
    source: str | None = None
    cwd: str | None = None
    models: list[str] | None = None
    started_after: str | None = None
    started_before: str | None = None
    ended_after: str | None = None
    ended_before: str | None = None
    status: str | None = None
    min_tokens: int | None = None
    min_cost: float | None = None
    min_events: int | None = None
    fields: list[str] | None = None
    limit: int = 10000


def _pick_fields(row: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in fields:
        parts = f.split(".")
        val: Any = row
        for p in parts:
            if isinstance(val, dict):
                val = val.get(p)
            else:
                val = None
                break
        out[f] = val
    return out


@app.post("/v1/export")
def export_sessions(body: ExportRequest) -> dict[str, Any]:
    sessions = db.export_sessions(
        session_ids=body.session_ids,
        source=body.source,
        cwd=body.cwd,
        models=body.models,
        started_after=body.started_after,
        started_before=body.started_before,
        ended_after=body.ended_after,
        ended_before=body.ended_before,
        status=body.status,
        min_tokens=body.min_tokens,
        min_cost=body.min_cost,
        min_events=body.min_events,
        limit=max(1, min(body.limit, 50000)),
    )
    if body.fields:
        sessions = [_pick_fields(s, body.fields) for s in sessions]
    return {"sessions": sessions, "count": len(sessions)}


@app.get("/v1/sessions/{session_id}/events/{event_id}")
def get_event_detail(session_id: str, event_id: int) -> dict[str, Any]:
    """Full detail for one event, lazy-loaded when a truncated event is
    selected so the session list payload stays small."""
    detail = db.get_event_detail(session_id, event_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return detail


@app.get("/v1/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    session = db.get_session_detail(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# Serve the built dashboard so the whole app runs from one container. Mounted
# last so the API routes above take precedence. Absent in local dev (Vite serves
# the frontend), so this is skipped there.
_STATIC_DIR = Path(
    os.environ.get("COT_STATIC_DIR", str(Path(__file__).resolve().parent.parent / "static"))
)
if _STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(_STATIC_DIR), html=True), name="dashboard")

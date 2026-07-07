"""cot collector API.

Receives agent hook events and serves them back for the dashboard. Everything
is stored in one local SQLite file; nothing leaves the machine.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform as _platform
import re
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

import urllib.error

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, db, insights

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

# --- Local-only network hardening -------------------------------------------
#
# The collector binds to loopback and stores the developer's most sensitive data
# (prompts, responses, shell commands, file paths, code). It is unauthenticated,
# so the *browser* boundary must be enforced explicitly — otherwise any website
# the user visits could read or destroy that data via the local API.
#
#   * Origins  : only loopback browser origins may read responses (no more "*").
#   * Hosts    : only loopback Host headers are served, defeating DNS rebinding.
#   * Writes   : a present, non-loopback Origin on a mutating request is rejected
#                (CSRF defense), while header-less clients (the bridge) pass.
#
# Non-standard deployments (reverse proxy, custom hostnames) can widen these with
# COT_ALLOWED_ORIGINS / COT_ALLOWED_HOSTS (comma-separated; "*" disables a guard).

_LOCAL_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def _configured_origins() -> list[str]:
    raw = os.environ.get("COT_ALLOWED_ORIGINS", "")
    return [o.strip() for o in raw.split(",") if o.strip()]


def _is_allowed_origin(origin: str) -> bool:
    allowed = _configured_origins()
    if allowed:
        return "*" in allowed or origin in allowed
    return bool(_LOCAL_ORIGIN_RE.match(origin))


def _allowed_hosts() -> list[str]:
    raw = os.environ.get("COT_ALLOWED_HOSTS", "")
    hosts = [h.strip() for h in raw.split(",") if h.strip()]
    if hosts:
        return hosts
    # Loopback names/addresses, plus the docker-compose service hostname the Vite
    # dev proxy targets. TrustedHostMiddleware strips the port before matching.
    return ["localhost", "127.0.0.1", "[::1]", "api"]


@app.middleware("http")
async def _enforce_local_origin(request: Request, call_next):
    """CSRF / DNS-rebind defense for state-changing requests.

    Browsers attach an Origin header to cross-origin (and most same-origin)
    writes; non-browser callers (the bridge, curl, health checks) send none and
    are allowed through. A present but non-loopback Origin is rejected before the
    handler runs, so a malicious page cannot trigger destructive actions
    (retention wipe, import reset, settings changes) even though CORS already
    prevents it from reading any response.
    """
    if request.method not in _SAFE_METHODS:
        origin = request.headers.get("origin")
        if origin and not _is_allowed_origin(origin):
            return JSONResponse(
                {"detail": "Cross-origin request forbidden"}, status_code=403
            )
    return await call_next(request)


app.add_middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts())

_cors_kwargs: dict[str, Any] = {"allow_methods": ["*"], "allow_headers": ["*"]}
_explicit_origins = _configured_origins()
if _explicit_origins:
    _cors_kwargs["allow_origins"] = _explicit_origins
else:
    _cors_kwargs["allow_origin_regex"] = _LOCAL_ORIGIN_RE.pattern
app.add_middleware(CORSMiddleware, **_cors_kwargs)

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


def _repair_script(agents: list[str], endpoint: str | None = None) -> str:
    agent_args = " ".join(agents)
    # Default to the URL this script was fetched from, so repair still targets
    # the right collector when the installer picked a non-default port.
    default_endpoint = (endpoint or "http://127.0.0.1:31337").rstrip("/")
    return f"""#!/bin/sh
set -e
COT_ENDPOINT="${{COT_ENDPOINT:-{default_endpoint}}}"
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
        "install_id": db.get_install_id(),
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


# --- First-party analytics proxy ---------------------------------------------
#
# The dashboard runs on 127.0.0.1, and our users are developers — so a hardcoded
# cloud.umami.is script is reliably blocked by ad/tracker blockers
# (ERR_BLOCKED_BY_CLIENT). Proxying the tracker script and its collect endpoint
# through our own origin makes every request first-party, which defeats the
# common blocklists. Best-effort: upstream failures (offline/air-gapped) return
# a 502 the tracker silently ignores. Disable entirely with COT_DISABLE_ANALYTICS=1.

_UMAMI_UPSTREAM = os.environ.get("COT_UMAMI_HOST", "https://cloud.umami.is").rstrip("/")
_UMAMI_SCRIPT_TTL = 6 * 60 * 60  # cache the tracker JS for 6h
_umami_script_cache: dict[str, Any] = {"body": None, "fetched_at": 0.0}


def _analytics_env_disabled() -> bool:
    return os.environ.get("COT_DISABLE_ANALYTICS") in ("1", "true", "yes")


@app.get("/stats/script.js")
def umami_script() -> Response:
    if _analytics_env_disabled():
        return Response(status_code=404)
    now = time.time()
    cache = _umami_script_cache
    if cache["body"] is None or now - cache["fetched_at"] > _UMAMI_SCRIPT_TTL:
        try:
            req = urllib.request.Request(
                f"{_UMAMI_UPSTREAM}/script.js",
                headers={"User-Agent": f"cot/{__version__}"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                cache["body"] = resp.read()
                cache["fetched_at"] = now
        except Exception:
            if cache["body"] is None:
                return Response(status_code=502)
    return Response(
        content=cache["body"],
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=21600"},
    )


@app.post("/stats/api/send")
async def umami_send(request: Request) -> Response:
    if _analytics_env_disabled():
        return Response(status_code=404)
    body = await request.body()
    # Umami rejects requests without a User-Agent and derives the visitor from
    # it, so the original client UA/IP must be forwarded — otherwise every event
    # looks like it came from this server.
    ua = request.headers.get("user-agent", f"cot/{__version__}")
    fwd = request.headers.get("x-forwarded-for") or (
        request.client.host if request.client else ""
    )
    cache_token = request.headers.get("x-umami-cache")
    content_type = request.headers.get("content-type", "application/json")

    def _forward() -> tuple[int, bytes, str]:
        headers = {"Content-Type": content_type, "User-Agent": ua}
        if fwd:
            headers["X-Forwarded-For"] = fwd
        if cache_token:
            headers["x-umami-cache"] = cache_token
        req = urllib.request.Request(
            f"{_UMAMI_UPSTREAM}/api/send", data=body, method="POST", headers=headers
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read(), resp.headers.get("Content-Type", "text/plain")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), exc.headers.get("Content-Type", "text/plain")

    try:
        status, content, ctype = await asyncio.to_thread(_forward)
    except Exception:
        return Response(status_code=502)
    return Response(content=content, status_code=status, media_type=ctype)


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
def install_script(request: Request, repair: bool = False, agents: str | None = None):
    if repair:
        selected = _repair_agents(agents)
        return PlainTextResponse(
            _repair_script(selected, endpoint=str(request.base_url)),
            media_type="text/x-shellscript",
            headers={"Content-Disposition": 'attachment; filename="cot-repair.sh"'},
        )
    script = _BRIDGE_DIR / "install.sh"
    if not script.exists():
        raise HTTPException(status_code=404, detail="install.sh not found")
    return FileResponse(script, media_type="text/plain")


@app.get("/repair.sh")
def repair_script(request: Request, agents: str | None = None):
    selected = _repair_agents(agents)
    return PlainTextResponse(
        _repair_script(selected, endpoint=str(request.base_url)),
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


async def _ingest_body(request: Request) -> tuple[dict[str, Any] | None, str | None]:
    raw = await request.body()
    try:
        body = json.loads(raw.decode("utf-8") if raw else "{}")
    except Exception as exc:
        text = raw.decode("utf-8", errors="replace")
        return None, str(exc) or f"Malformed JSON: {text[:80]}"
    if not isinstance(body, dict):
        return None, "Hook payload must be a JSON object"
    return body, None


@app.post("/v1/ingest/{source}")
async def ingest(source: str, request: Request) -> dict[str, Any]:
    if source not in ("claude", "cursor", "codex"):
        raise HTTPException(status_code=404, detail=f"Unknown source: {source}")
    body, malformed_error = await _ingest_body(request)
    if body is None:
        raw_text = (await request.body()).decode("utf-8", errors="replace")
        return db.record_malformed_ingest(source, raw_text, origin="hook", error=malformed_error)

    # Attachment metadata folds onto the matching prompt event, not a new row.
    if body.get("_attach_to_prompt"):
        attached = db.attach_to_prompt(
            str(body.get("session_id") or ""),
            body.get("text"),
            body.get("attachments") or [],
            body.get("timestamp"),
        )
        return {"ok": True, "attached": attached}

    return db.record_ingest(source, body)


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


@app.post("/v1/subagent-links")
async def post_subagent_links(request: Request) -> dict[str, Any]:
    """Record child→parent subagent links the bridge derives from the on-disk
    transcript nesting, so subagent sessions embed under their launching parent."""
    body = await _json_body(request)
    links = body.get("links")
    if not isinstance(links, list):
        raise HTTPException(status_code=400, detail="Expected { links: [...] }")
    applied = db.set_subagent_links(links)
    return {"ok": True, "applied": applied, "received": len(links)}


@app.get("/v1/import/summary")
def get_import_summary() -> dict[str, Any]:
    return db.import_summary()


@app.get("/v1/import/report")
def get_import_report() -> dict[str, Any]:
    """Ingestion quality + per-source coverage (category mix, % other,
    token/model coverage). Surfaces parsing regressions and what each agent
    actually logs."""
    return db.import_quality()


@app.get("/v1/drift/report")
def get_drift_report() -> dict[str, Any]:
    return db.drift_report()


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


@app.get("/v1/insights")
def get_insights(
    days: int = Query(30),
    pillar: str | None = Query(None),
    severity: str | None = Query(None),
    status: str = Query("active"),
) -> dict[str, Any]:
    """Actionable findings across sessions; runs lifecycle reconcile on read."""
    if pillar is not None and pillar not in insights.PILLARS:
        raise HTTPException(status_code=400, detail=f"pillar must be one of {insights.PILLARS}")
    if severity is not None and severity not in insights.SEVERITIES:
        raise HTTPException(status_code=400, detail=f"severity must be one of {insights.SEVERITIES}")
    if status not in insights.STATUSES and status != "all":
        raise HTTPException(status_code=400, detail=f"status must be one of {insights.STATUSES} or 'all'")
    result = insights.compute_insights(days=max(0, min(days, 365)))
    items = result["insights"]
    if status != "all":
        items = [f for f in items if f["status"] == status]
    if pillar:
        items = [f for f in items if f["pillar"] == pillar]
    if severity:
        items = [f for f in items if f["severity"] == severity]
    result["insights"] = items
    return result


@app.post("/v1/insights/{fingerprint}/dismiss")
def dismiss_insight(fingerprint: str) -> dict[str, Any]:
    if not insights.set_finding_status(fingerprint, "dismissed"):
        raise HTTPException(status_code=404, detail="Finding not found")
    return {"ok": True}


@app.post("/v1/insights/{fingerprint}/restore")
def restore_insight(fingerprint: str) -> dict[str, Any]:
    if not insights.set_finding_status(fingerprint, "active"):
        raise HTTPException(status_code=404, detail="Finding not found")
    return {"ok": True}


@app.get("/v1/sessions/{session_id}/insights")
def get_session_insights(session_id: str) -> dict[str, Any]:
    """Per-session findings, ephemeral (no lifecycle persistence)."""
    if not insights.session_exists(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return insights.compute_insights(session_id=session_id)


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
    include: list[str] | None = None
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
    include_keys: set[str] = set()
    if body.include:
        allowed = {"events", "components", "conversation", "clarifications"}
        include_keys = {k for k in body.include if k in allowed}
        if include_keys:
            sessions = db.enrich_sessions(sessions, list(include_keys))
    if body.fields:
        sessions = [
            {**_pick_fields(s, body.fields), **{k: s[k] for k in include_keys if k in s}}
            for s in sessions
        ]
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

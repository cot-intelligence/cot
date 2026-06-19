"""SQLite storage. A single database file collates every agent's events.

The DB lives in the user's home directory (``~/.cot/cot.db``) so all data
stays local and is trivially portable/backup-able. Override with COT_DB_PATH.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import string
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .costing import estimate_cost
from .normalize import categorize, normalize

_write_lock = threading.Lock()

_SESSION_END_HOOKS = {"Stop", "stop", "SessionEnd", "sessionEnd"}
_SESSION_START_HOOKS = {"SessionStart", "sessionStart"}
_CURSOR_GRANULAR_HOOKS = {
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "beforeReadFile",
    "afterFileEdit",
}

# A session is reported "active" only while it keeps emitting events. After this
# much silence we treat it as completed, regardless of whether a Stop/SessionEnd
# hook ever arrived. This makes "active" mean "running now" rather than the
# stored flag, which is unreliable: Stop fires after every turn, and sessions
# that never send an end hook would otherwise linger as active forever.
_ACTIVE_WINDOW_SECONDS = 600


def _parse_ts(value: Any) -> datetime | None:
    """Parse an event timestamp into an aware datetime.

    Timestamps are usually ISO strings, but legacy rows store a numeric epoch
    (seconds or milliseconds) — ``body["timestamp"]`` from some agents is an
    int, and SQLite keeps it as an integer storage class, so ``MAX(ts)`` comes
    back as an ``int`` rather than text.
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        # Heuristic: values past ~year 2286 in seconds are really milliseconds.
        seconds = value / 1000 if value > 1e11 else value
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _format_ts(value: Any) -> str | None:
    """Serialize a stored timestamp as an ISO string for API responses."""
    dt = _parse_ts(value)
    return dt.isoformat() if dt else None


def _live_status(last_ts: Any) -> str:
    """Effective status derived from recency of the last event."""
    dt = _parse_ts(last_ts)
    if dt is None:
        return "completed"
    age = (datetime.now(timezone.utc) - dt).total_seconds()
    return "active" if age <= _ACTIVE_WINDOW_SECONDS else "completed"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    cwd         TEXT,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    source      TEXT NOT NULL,
    hook        TEXT NOT NULL,
    tool        TEXT,
    phase       TEXT NOT NULL,
    ts          TEXT NOT NULL,
    payload     TEXT,
    category    TEXT,
    title       TEXT,
    detail      TEXT,
    target      TEXT,
    status      TEXT,
    duration_ms INTEGER,
    model       TEXT,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cache_read_tokens   INTEGER,
    cache_write_tokens  INTEGER,
    attachments TEXT,
    dedup_key   TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    actor       TEXT NOT NULL DEFAULT 'cot',
    target      TEXT,
    status      TEXT NOT NULL DEFAULT 'ok',
    detail      TEXT,
    ts          TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);
"""


def db_path() -> Path:
    import os

    env = os.environ.get("COT_DB_PATH")
    if env:
        return Path(env)
    return Path.home() / ".cot" / "cot.db"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # DELETE journal mode: WAL breaks on Docker bind mounts (macOS virtiofs disk I/O).
    conn = sqlite3.connect(path, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA journal_mode=DELETE;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def _add_column_if_missing(
    conn: sqlite3.Connection, table: str, name: str, col_def: str, cols: set[str]
) -> None:
    if name not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {col_def}")
        cols.add(name)


def _migrate(conn: sqlite3.Connection) -> None:
    event_cols = _table_columns(conn, "events")
    for name, col_def in (
        ("source", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("hook", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("tool", "TEXT"),
        ("phase", "TEXT NOT NULL DEFAULT 'instant'"),
        ("ts", "TEXT NOT NULL DEFAULT ''"),
        ("payload", "TEXT"),
        ("created_at", "TEXT NOT NULL DEFAULT ''"),
        ("category", "TEXT"),
        ("title", "TEXT"),
        ("detail", "TEXT"),
        ("target", "TEXT"),
        ("status", "TEXT"),
        ("duration_ms", "INTEGER"),
        ("model", "TEXT"),
        ("input_tokens", "INTEGER"),
        ("output_tokens", "INTEGER"),
        ("cache_read_tokens", "INTEGER"),
        ("cache_write_tokens", "INTEGER"),
        ("attachments", "TEXT"),
        ("dedup_key", "TEXT"),
    ):
        _add_column_if_missing(conn, "events", name, col_def, event_cols)

    session_cols = _table_columns(conn, "sessions")
    for name, col_def in (
        ("source", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("cwd", "TEXT"),
        ("started_at", "TEXT NOT NULL DEFAULT ''"),
        ("ended_at", "TEXT"),
        ("status", "TEXT NOT NULL DEFAULT 'active'"),
        ("archived", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL DEFAULT ''"),
    ):
        _add_column_if_missing(conn, "sessions", name, col_def, session_cols)

    if "source" in session_cols:
        conn.execute(
            "UPDATE sessions SET source = ("
            " SELECT e.source FROM events e WHERE e.session_id = sessions.id"
            " ORDER BY e.id LIMIT 1"
            ") WHERE source = 'unknown' AND EXISTS ("
            " SELECT 1 FROM events e WHERE e.session_id = sessions.id"
            ")"
        )

    now = _now()
    conn.execute(
        "UPDATE events SET ts = ? WHERE ts IS NULL OR ts = ''",
        (now,),
    )
    conn.execute(
        "UPDATE events SET created_at = ? WHERE created_at IS NULL OR created_at = ''",
        (now,),
    )
    conn.execute(
        "UPDATE sessions SET started_at = ? WHERE started_at IS NULL OR started_at = ''",
        (now,),
    )
    conn.execute(
        "UPDATE sessions SET created_at = ? WHERE created_at IS NULL OR created_at = ''",
        (now,),
    )


def _backfill(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events WHERE category IS NULL"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            raw = {}
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        conn.execute(
            "UPDATE events SET category=?, title=?, detail=?, target=?, status=?, duration_ms=?"
            " WHERE id=?",
            (
                cat["category"],
                cat["title"],
                cat["detail"],
                cat["target"],
                cat["status"],
                cat["duration_ms"],
                row["id"],
            ),
        )


def _recategorize_network_calls(conn: sqlite3.Connection) -> None:
    """Re-classify stored browser navigations as external network (web) calls."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload, category, target FROM events"
        " WHERE category = 'mcp'"
        " AND (hook = 'afterMCPExecution' OR hook IN ('PostToolUse', 'postToolUse'))"
        " AND (target LIKE '%browser_navigate%' OR payload LIKE '%browser_navigate%')"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        if cat["category"] != row["category"] or cat.get("target") != row["target"]:
            conn.execute(
                "UPDATE events SET category=?, title=?, target=? WHERE id=?",
                (cat["category"], cat["title"], cat["target"], row["id"]),
            )


def _subagent_display_label(title: str | None, target: str) -> str:
    """Prefer human type/description over raw call_/toolu_ ids in summaries."""
    t = (title or "").strip()
    if t and t not in ("Subagent", "Subagent started", "Subagent stopped"):
        return t
    if target.startswith(("call_", "toolu_")):
        return "Subagent"
    return target or "Subagent"


def _recategorize_subagents(conn: sqlite3.Connection) -> None:
    """Fix stored subagent rows: unique ids as target, stops as subagent not lifecycle."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events"
        " WHERE hook IN ('subagentStart', 'SubagentStart', 'subagentStop', 'SubagentStop')"
        " OR (category = 'subagent' AND tool IN ('Task', 'Agent'))"
        " OR (hook IN ('subagentStop', 'SubagentStop') AND category = 'lifecycle')"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        conn.execute(
            "UPDATE events SET category=?, title=?, target=?, status=?, duration_ms=?"
            " WHERE id=?",
            (
                cat["category"],
                cat["title"],
                cat["target"],
                cat["status"],
                cat["duration_ms"],
                row["id"],
            ),
        )


def _recategorize_cursor_tools(conn: sqlite3.Connection) -> None:
    """Cursor's generic pre/postToolUse events used to fall through to ``other``
    (only MCP was rescued). They now categorize like Claude/Codex tool calls —
    re-run them so historical shell/read/edit/search/subagent/web rows are fixed."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload, category, target FROM events"
        " WHERE source = 'cursor'"
        " AND hook IN ('preToolUse', 'postToolUse', 'postToolUseFailure')"
        " AND category = 'other'"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        if cat["category"] == "other":
            continue
        conn.execute(
            "UPDATE events SET category=?, title=?, detail=?, target=?, status=?,"
            " duration_ms=? WHERE id=?",
            (
                cat["category"],
                cat["title"],
                cat["detail"],
                cat["target"],
                cat["status"],
                cat["duration_ms"],
                row["id"],
            ),
        )


def _recategorize_web_targets(conn: sqlite3.Connection) -> None:
    """Backfill web-search targets from provider-specific payload fields."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload, target FROM events"
        " WHERE category = 'web' AND tool IN ('WebSearch', 'WebFetch')"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        if cat.get("target") == row["target"]:
            continue
        conn.execute(
            "UPDATE events SET title=?, detail=?, target=?, status=?, duration_ms=?"
            " WHERE id=?",
            (
                cat["title"],
                cat["detail"],
                cat["target"],
                cat["status"],
                cat["duration_ms"],
                row["id"],
            ),
        )


def _recategorize_questions(conn: sqlite3.Connection) -> None:
    """AskUserQuestion / request_user_input tool calls used to fall through to
    ``other``; they now have their own ``question`` category. Re-run any stored
    ones so the timeline shows them as structured questions."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events"
        " WHERE tool IN ('AskUserQuestion', 'request_user_input')"
        " AND category != 'question'"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        conn.execute(
            "UPDATE events SET category=?, title=?, detail=?, target=?, status=?,"
            " duration_ms=? WHERE id=?",
            (
                cat["category"],
                cat["title"],
                cat["detail"],
                cat["target"],
                cat["status"],
                cat["duration_ms"],
                row["id"],
            ),
        )


def _drop_redundant_cursor_hooks(conn: sqlite3.Connection) -> None:
    """Cursor fires granular hooks plus generic pre/postToolUse for the same
    action. The generic pair is the canonical, richer source, so granular rows
    are duplicates that double-count shell/read/edit/mcp/web. Keep this cleanup
    idempotent because older collectors may have inserted rows after the first
    migration pass."""
    conn.execute(
        "DELETE FROM events WHERE source = 'cursor' AND hook IN ("
        " 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution',"
        " 'afterMCPExecution', 'beforeReadFile', 'afterFileEdit')"
    )
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('migrated_drop_cursor_granular', '1')"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )


def should_ignore_event(norm: dict[str, Any]) -> bool:
    """Return True for hook rows intentionally excluded from storage."""
    return norm.get("source") == "cursor" and norm.get("hook") in _CURSOR_GRANULAR_HOOKS


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_category ON events(category)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)"
        )
        _backfill(conn)
        _recategorize_network_calls(conn)
        _recategorize_subagents(conn)
        _recategorize_cursor_tools(conn)
        _recategorize_web_targets(conn)
        _recategorize_questions(conn)
        _drop_redundant_cursor_hooks(conn)


def get_setting(key: str, default: str | None = None) -> str | None:
    """Read a key/value preference, returning ``default`` when unset."""
    with _connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row is not None else default


def set_setting(key: str, value: str) -> None:
    """Upsert a key/value preference."""
    with _write_lock, _connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def record_audit_event(
    action: str,
    *,
    actor: str = "cot",
    target: str | None = None,
    status: str = "ok",
    detail: Any = None,
) -> int:
    """Append a first-party audit event for cot's own config/actions."""
    action = str(action or "").strip()
    if not action:
        action = "unknown"
    if status not in ("ok", "error", "dry_run"):
        status = str(status or "ok")
    payload = None
    if detail is not None:
        payload = json.dumps(detail, ensure_ascii=False, default=str)
    now = _now()
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO audit_events (action, actor, target, status, detail, ts, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (action, actor or "cot", target, status, payload, now, now),
        )
        return int(cur.lastrowid)


def audit_events(limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 500))
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM audit_events ORDER BY ts DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        detail: Any = None
        if r["detail"]:
            try:
                detail = json.loads(r["detail"])
            except (json.JSONDecodeError, TypeError):
                detail = r["detail"]
        out.append(
            {
                "id": r["id"],
                "action": r["action"],
                "actor": r["actor"],
                "target": r["target"],
                "status": r["status"],
                "detail": detail,
                "ts": _format_ts(r["ts"]) or r["ts"],
            }
        )
    return out


def retention_policy() -> dict[str, Any]:
    enabled = get_setting("retention_enabled", "0") in ("1", "true", "yes", "on")
    raw_days = get_setting("retention_days", "30")
    try:
        days = int(raw_days or "30")
    except ValueError:
        days = 30
    days = max(1, min(days, 3650))
    return {"enabled": enabled, "days": days}


def set_retention_policy(enabled: bool | None = None, days: int | None = None) -> dict[str, Any]:
    before = retention_policy()
    if enabled is not None:
        set_setting("retention_enabled", "1" if enabled else "0")
    if days is not None:
        set_setting("retention_days", str(max(1, min(int(days), 3650))))
    after = retention_policy()
    record_audit_event(
        "retention.policy.updated",
        target="retention",
        detail={"before": before, "after": after},
    )
    return after


def _retention_cutoff(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _retention_candidates(conn: sqlite3.Connection, cutoff: str) -> tuple[list[str], int]:
    rows = conn.execute(
        "SELECT s.id, COUNT(e.id) AS event_count,"
        " COALESCE(MAX(e.ts), s.ended_at, s.started_at, s.created_at) AS last_ts"
        " FROM sessions s LEFT JOIN events e ON e.session_id = s.id"
        " GROUP BY s.id"
        " HAVING last_ts IS NOT NULL AND last_ts < ?",
        (cutoff,),
    ).fetchall()
    return [r["id"] for r in rows], sum(int(r["event_count"] or 0) for r in rows)


def retention_status() -> dict[str, Any]:
    policy = retention_policy()
    cutoff = _retention_cutoff(policy["days"])
    with _connect() as conn:
        sessions, events = _retention_candidates(conn, cutoff)
        oldest = conn.execute("SELECT MIN(ts) AS ts FROM events").fetchone()["ts"]
    return {
        "policy": policy,
        "cutoff": cutoff,
        "oldest_event": _format_ts(oldest),
        "eligible_sessions": len(sessions) if policy["enabled"] else 0,
        "eligible_events": events if policy["enabled"] else 0,
        "preview_sessions": len(sessions),
        "preview_events": events,
    }


def cleanup_retention(*, dry_run: bool = True) -> dict[str, Any]:
    policy = retention_policy()
    cutoff = _retention_cutoff(policy["days"])
    with _write_lock, _connect() as conn:
        sessions, events = _retention_candidates(conn, cutoff)
        deleted_sessions = deleted_events = 0
        if policy["enabled"] and not dry_run and sessions:
            deleted_sessions = len(sessions)
            deleted_events = events
            conn.executemany("DELETE FROM sessions WHERE id = ?", [(sid,) for sid in sessions])
    result = {
        "dry_run": dry_run,
        "policy": policy,
        "cutoff": cutoff,
        "eligible_sessions": len(sessions) if policy["enabled"] else 0,
        "eligible_events": events if policy["enabled"] else 0,
        "deleted_sessions": deleted_sessions,
        "deleted_events": deleted_events,
    }
    record_audit_event(
        "retention.cleanup",
        target="retention",
        status="dry_run" if dry_run else "ok",
        detail=result,
    )
    return result


def get_install_id() -> str:
    """A stable, anonymous identifier for this collector install.

    Generated once and stored locally; lets opt-in telemetry de-duplicate
    reports from the same machine without tying them to any user identity.
    """
    existing = get_setting("install_id")
    if existing:
        return existing
    import uuid

    new_id = uuid.uuid4().hex
    set_setting("install_id", new_id)
    set_setting(
        "installed_at",
        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    return new_id


def record_event(norm: dict[str, Any], raw: dict[str, Any]) -> tuple[str, int]:
    sid = norm["session_id"]
    ts = norm["ts"]
    # Cursor (Claude-Code-compatible) fires each hook to BOTH the cursor and
    # claude bridge, posting byte-identical payloads ~20ms apart. Fingerprint the
    # payload and skip a duplicate seen for this session in the last few seconds.
    dedup_key = hashlib.sha1(
        json.dumps(raw, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    with _write_lock, _connect() as conn:
        dup = conn.execute(
            "SELECT id FROM events WHERE session_id = ? AND dedup_key = ? AND created_at >= ?"
            " ORDER BY id DESC LIMIT 1",
            (sid, dedup_key, cutoff),
        ).fetchone()
        if dup is not None:
            return sid, int(dup["id"])
        row = conn.execute("SELECT id FROM sessions WHERE id = ?", (sid,)).fetchone()
        if row is None or norm["hook"] in _SESSION_START_HOOKS:
            if row is None:
                conn.execute(
                    "INSERT INTO sessions (id, source, cwd, started_at, status, created_at)"
                    " VALUES (?, ?, ?, ?, 'active', ?)",
                    (sid, norm["source"], norm["cwd"], ts, _now()),
                )
        elif norm["cwd"]:
            conn.execute(
                "UPDATE sessions SET cwd = COALESCE(cwd, ?) WHERE id = ?",
                (norm["cwd"], sid),
            )

        if norm["hook"] in _SESSION_END_HOOKS:
            conn.execute(
                "UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?",
                (ts, sid),
            )

        cur = conn.execute(
            "INSERT INTO events (session_id, source, hook, tool, phase, ts, payload,"
            " category, title, detail, target, status, duration_ms, model,"
            " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
            " dedup_key, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                sid,
                norm["source"],
                norm["hook"],
                norm["tool"],
                norm["phase"],
                ts,
                json.dumps(raw, ensure_ascii=False, default=str),
                norm.get("category"),
                norm.get("title"),
                norm.get("detail"),
                norm.get("target"),
                norm.get("status"),
                norm.get("duration_ms"),
                norm.get("model"),
                norm.get("input_tokens"),
                norm.get("output_tokens"),
                norm.get("cache_read_tokens"),
                norm.get("cache_write_tokens"),
                dedup_key,
                _now(),
            ),
        )
        return sid, int(cur.lastrowid)


def _duration_seconds(first: Any, last: Any) -> float | None:
    first_dt = _parse_ts(first)
    last_dt = _parse_ts(last)
    if first_dt is None or last_dt is None:
        return None
    return round((last_dt - first_dt).total_seconds(), 2)


def _first_prompt(conn: sqlite3.Connection, session_id: str) -> str | None:
    row = conn.execute(
        "SELECT detail FROM events WHERE session_id=? AND category='prompt' ORDER BY id ASC LIMIT 1",
        (session_id,),
    ).fetchone()
    if not row or not row["detail"]:
        return None
    text = str(row["detail"]).strip().replace("\n", " ")
    return text if len(text) <= 80 else text[:79] + "…"


def _category_counts(conn: sqlite3.Connection, session_id: str) -> dict[str, int]:
    rows = conn.execute(
        "SELECT category, COUNT(*) AS n FROM events WHERE session_id=? AND category IS NOT NULL"
        " GROUP BY category",
        (session_id,),
    ).fetchall()
    return {r["category"]: r["n"] for r in rows}


def _session_summary(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    agg = conn.execute(
        "SELECT COUNT(*) AS events,"
        " SUM(CASE WHEN tool IS NOT NULL THEN 1 ELSE 0 END) AS tools,"
        " MIN(ts) AS first_ts, MAX(ts) AS last_ts"
        " FROM events WHERE session_id = ?",
        (row["id"],),
    ).fetchone()
    last_ts = agg["last_ts"]
    models = [
        r["model"]
        for r in conn.execute(
            "SELECT DISTINCT model FROM events"
            " WHERE session_id = ? AND model IS NOT NULL AND model != ''"
            " ORDER BY model",
            (row["id"],),
        ).fetchall()
    ]
    tok = conn.execute(
        "SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,"
        " COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw"
        " FROM events WHERE session_id = ?",
        (row["id"],),
    ).fetchone()
    cost_rows = [
        dict(r)
        for r in conn.execute(
            "SELECT model,"
            " COALESCE(SUM(input_tokens),0) input_tokens,"
            " COALESCE(SUM(output_tokens),0) output_tokens,"
            " COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,"
            " COALESCE(SUM(cache_write_tokens),0) cache_write_tokens"
            " FROM events WHERE session_id = ?"
            " GROUP BY model"
            " HAVING COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)"
            " + COALESCE(SUM(cache_read_tokens),0) + COALESCE(SUM(cache_write_tokens),0) > 0"
            " ORDER BY model",
            (row["id"],),
        ).fetchall()
    ]
    return {
        "id": row["id"],
        "source": row["source"],
        "cwd": row["cwd"],
        "models": models,
        "archived": bool(row["archived"]),
        "status": _live_status(last_ts),
        "started_at": _format_ts(row["started_at"]) or str(row["started_at"] or ""),
        "ended_at": _format_ts(row["ended_at"]),
        "last_activity": _format_ts(last_ts),
        "event_count": agg["events"] or 0,
        "tool_count": agg["tools"] or 0,
        "duration_seconds": _duration_seconds(agg["first_ts"], last_ts),
        "title": _first_prompt(conn, row["id"]),
        "category_counts": _category_counts(conn, row["id"]),
        "tokens": {
            "input": tok["i"],
            "output": tok["o"],
            "cache_read": tok["cr"],
            "cache_write": tok["cw"],
            "total": tok["i"] + tok["o"] + tok["cr"] + tok["cw"],
        },
        "cost": estimate_cost(cost_rows),
    }


def metrics() -> dict[str, Any]:
    """Cross-session aggregates for the metrics dashboard."""
    with _connect() as conn:
        one = lambda sql, *p: conn.execute(sql, p).fetchone()  # noqa: E731
        rows = lambda sql, *p: conn.execute(sql, p).fetchall()  # noqa: E731

        sessions = one("SELECT COUNT(*) n FROM sessions")["n"]
        events = one("SELECT COUNT(*) n FROM events")["n"]
        tool_calls = one("SELECT COUNT(*) n FROM events WHERE tool IS NOT NULL")["n"]
        projects = one("SELECT COUNT(DISTINCT cwd) n FROM sessions WHERE cwd IS NOT NULL")["n"]

        last_rows = rows("SELECT session_id, MAX(ts) lt FROM events GROUP BY session_id")
        active = sum(1 for r in last_rows if _live_status(r["lt"]) == "active")

        durs = rows(
            "SELECT (julianday(MAX(ts))-julianday(MIN(ts)))*86400 d"
            " FROM events GROUP BY session_id"
        )
        dvals = [r["d"] for r in durs if r["d"] is not None]
        avg_duration = round(sum(dvals) / len(dvals), 2) if dvals else None

        tok = one(
            "SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,"
            " COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw"
            " FROM events"
        )
        tokens = {
            "input": tok["i"],
            "output": tok["o"],
            "cache_read": tok["cr"],
            "cache_write": tok["cw"],
            "total": tok["i"] + tok["o"] + tok["cr"] + tok["cw"],
        }

        by_day = [
            {"day": r["d"], "events": r["n"]}
            for r in rows(
                "SELECT substr(ts,1,10) d, COUNT(*) n FROM events"
                " WHERE ts IS NOT NULL GROUP BY d ORDER BY d"
            )
        ]
        busiest_day = max(by_day, key=lambda x: x["events"]) if by_day else None

        by_hour = [
            {"hour": int(r["h"]), "events": r["n"]}
            for r in rows(
                "SELECT substr(ts,12,2) h, COUNT(*) n FROM events"
                " WHERE ts IS NOT NULL AND substr(ts,12,2) != '' GROUP BY h ORDER BY h"
            )
        ]
        peak_hour = max(by_hour, key=lambda x: x["events"])["hour"] if by_hour else None

        by_category = [
            {"category": r["category"], "events": r["n"]}
            for r in rows(
                "SELECT category, COUNT(*) n FROM events WHERE category IS NOT NULL"
                " GROUP BY category ORDER BY n DESC"
            )
        ]
        by_tool = [
            {"tool": r["tool"], "events": r["n"]}
            for r in rows(
                "SELECT tool, COUNT(*) n FROM events WHERE tool IS NOT NULL"
                " GROUP BY tool ORDER BY n DESC LIMIT 12"
            )
        ]
        cost_rows = [
            dict(r)
            for r in rows(
                "SELECT model,"
                " COALESCE(SUM(input_tokens),0) input_tokens,"
                " COALESCE(SUM(output_tokens),0) output_tokens,"
                " COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,"
                " COALESCE(SUM(cache_write_tokens),0) cache_write_tokens"
                " FROM events GROUP BY model"
                " HAVING COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)"
                " + COALESCE(SUM(cache_read_tokens),0) + COALESCE(SUM(cache_write_tokens),0) > 0"
                " ORDER BY model"
            )
        ]
        cost = estimate_cost(cost_rows)
        cost_by_model = {m["model"]: m for m in cost["models"]}
        by_model = [
            {
                "model": r["model"],
                "events": r["n"],
                "output_tokens": r["o"] or 0,
                "total_tokens": (cost_by_model.get(r["model"]) or {}).get("total_tokens", 0),
                "cost_usd": (cost_by_model.get(r["model"]) or {}).get("total_usd", 0.0),
                "pricing_found": bool((cost_by_model.get(r["model"]) or {}).get("pricing_found")),
            }
            for r in rows(
                "SELECT model, COUNT(*) n, SUM(output_tokens) o FROM events"
                " WHERE model IS NOT NULL AND model != '' GROUP BY model ORDER BY n DESC"
            )
        ]
        by_source = [
            {"source": r["source"], "sessions": r["s"], "events": r["e"]}
            for r in rows(
                "SELECT e.source, COUNT(DISTINCT e.session_id) s, COUNT(*) e"
                " FROM events e GROUP BY e.source ORDER BY e DESC"
            )
        ]
        by_project = [
            {
                "cwd": r["cwd"],
                "sessions": r["s"],
                "events": r["e"],
                "last_activity": _format_ts(r["lt"]),
            }
            for r in rows(
                "SELECT s.cwd, COUNT(DISTINCT s.id) s, COUNT(ev.id) e, MAX(ev.ts) lt"
                " FROM sessions s LEFT JOIN events ev ON ev.session_id = s.id"
                " WHERE s.cwd IS NOT NULL GROUP BY s.cwd ORDER BY e DESC LIMIT 10"
            )
        ]

        errors = one(
            "SELECT COUNT(*) n FROM events WHERE status IN ('error','blocked')"
        )["n"]
        permissions = one("SELECT COUNT(*) n FROM events WHERE category='permission'")["n"]

        busiest_sessions = [
            {"session_id": r["session_id"], "events": r["n"], "cwd": r["cwd"]}
            for r in rows(
                "SELECT e.session_id, COUNT(*) n, s.cwd"
                " FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
                " GROUP BY e.session_id ORDER BY n DESC LIMIT 8"
            )
        ]

        def cat_count(cat: str) -> int:
            return one("SELECT COUNT(*) n FROM events WHERE category=?", cat)["n"]

        fun = {
            "busiest_day": busiest_day,
            "peak_hour": peak_hour,
            "shell_commands": cat_count("shell"),
            "files_edited": cat_count("file_edit"),
            "files_read": cat_count("file_read"),
            "files_touched": one(
                "SELECT COUNT(DISTINCT target) n FROM events"
                " WHERE category IN ('file_edit','file_read') AND target IS NOT NULL"
            )["n"],
            "web_calls": cat_count("web"),
            "mcp_calls": cat_count("mcp"),
            "prompts": cat_count("prompt"),
            "responses": cat_count("response"),
            "thoughts": cat_count("thought"),
            "top_tool": by_tool[0]["tool"] if by_tool else None,
            "error_rate": round(errors / tool_calls, 4) if tool_calls else 0.0,
        }

        att_total = att_bytes = att_prompts = att_images = att_docs = 0
        att_by_type: dict[str, int] = {}
        for r in rows("SELECT attachments FROM events WHERE attachments IS NOT NULL AND attachments != ''"):
            try:
                atts = json.loads(r["attachments"])
            except (json.JSONDecodeError, TypeError):
                continue
            if not atts:
                continue
            att_prompts += 1
            for a in atts:
                if not isinstance(a, dict):
                    continue
                att_total += 1
                sz = a.get("size_bytes")
                if isinstance(sz, (int, float)):
                    att_bytes += int(sz)
                if a.get("kind") == "image":
                    att_images += 1
                elif a.get("kind") == "document":
                    att_docs += 1
                mt = a.get("media_type") or a.get("kind") or "file"
                fmt = mt.split("/")[-1].upper() if "/" in mt else str(mt).upper()
                att_by_type[fmt] = att_by_type.get(fmt, 0) + 1
        attachments_summary = {
            "total": att_total,
            "prompts_with": att_prompts,
            "total_bytes": att_bytes,
            "images": att_images,
            "documents": att_docs,
            "by_type": [
                {"type": k, "count": v}
                for k, v in sorted(att_by_type.items(), key=lambda x: -x[1])
            ],
        }

        return {
            "totals": {
                "sessions": sessions,
                "events": events,
                "tool_calls": tool_calls,
                "active_sessions": active,
                "projects": projects,
                "avg_duration_seconds": avg_duration,
                "errors": errors,
                "permissions": permissions,
            },
            "tokens": tokens,
            "cost": cost,
            "by_day": by_day,
            "by_hour": by_hour,
            "by_category": by_category,
            "by_tool": by_tool,
            "by_model": by_model,
            "by_source": by_source,
            "by_project": by_project,
            "busiest_sessions": busiest_sessions,
            "attachments": attachments_summary,
            "fun": fun,
        }


def metrics_history(category: str, limit: int = 200) -> list[dict[str, Any]]:
    """Return individual shell commands or web URLs across all sessions,
    each with enough info to deep-link to the originating event."""
    if category not in ("shell", "web"):
        return []
    with _connect() as conn:
        rows = conn.execute(
            "SELECT e.id, e.session_id, e.target, e.title, e.ts, e.source,"
            " e.duration_ms, e.status, s.cwd"
            " FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
            " WHERE e.category = ? AND e.target IS NOT NULL AND e.target != ''"
            " AND e.phase IN ('end', 'instant')"
            " ORDER BY e.ts DESC LIMIT ?",
            (category, limit),
        ).fetchall()
    return [
        {
            "event_id": r["id"],
            "session_id": r["session_id"],
            "target": r["target"],
            "title": r["title"],
            "ts": _format_ts(r["ts"]),
            "source": r["source"],
            "duration_ms": r["duration_ms"],
            "status": r["status"],
            "cwd": r["cwd"],
        }
        for r in rows
    ]


def connections() -> list[dict[str, Any]]:
    """Per-source ingest activity — which agents are wired up and sending.

    A source counts as connected if it produced an event within the active
    window (same recency rule as live sessions).
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT source, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,"
            " MAX(ts) AS last_ts"
            " FROM events GROUP BY source ORDER BY last_ts DESC"
        ).fetchall()
    return [
        {
            "source": r["source"],
            "sessions": r["sessions"],
            "events": r["events"],
            "last_event": _format_ts(r["last_ts"]),
            "connected": _live_status(r["last_ts"]) == "active",
        }
        for r in rows
    ]


def set_archived(session_id: str, archived: bool) -> bool:
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "UPDATE sessions SET archived = ? WHERE id = ?",
            (1 if archived else 0, session_id),
        )
        return cur.rowcount > 0


def list_sessions(
    limit: int = 50,
    status: str | None = None,
    source: str | None = None,
    q: str | None = None,
    archived: bool = False,
) -> list[dict[str, Any]]:
    clauses: list[str] = ["s.archived = ?"]
    params: list[Any] = [1 if archived else 0]
    if source:
        clauses.append("s.source = ?")
        params.append(source)
    if q:
        clauses.append("(s.id LIKE ? OR s.cwd LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])
    # Hide empty "launch-and-quit" sessions — only SessionStart/SessionEnd, no
    # real work (no prompt, tool, or response). These are created by Claude's
    # launcher bootstrapping in the home dir and add only noise.
    clauses.append(
        "EXISTS (SELECT 1 FROM events ev WHERE ev.session_id = s.id"
        " AND ev.category IS NOT NULL AND ev.category != 'lifecycle')"
    )
    where = f"WHERE {' AND '.join(clauses)}"
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT s.* FROM sessions s"
            f" LEFT JOIN (SELECT session_id, MAX(ts) AS last_ts FROM events GROUP BY session_id) e"
            f"   ON e.session_id = s.id"
            f" {where}"
            f" ORDER BY COALESCE(s.ended_at, e.last_ts, s.started_at) DESC"
            f" LIMIT ?",
            params,
        ).fetchall()
        summaries = [_session_summary(conn, r) for r in rows]
    # "active"/"completed" is recency-derived (see _live_status), so the status
    # filter is applied here rather than in SQL.
    if status:
        summaries = [s for s in summaries if s["status"] == status]
    return summaries


def _snippet(text: str, query: str, before: int = 60, after: int = 140) -> str:
    """A whitespace-collapsed excerpt centered on the first match of ``query``."""
    flat = " ".join(text.split())
    idx = flat.lower().find(query.lower())
    if idx < 0:
        return flat[: before + after]
    start = max(0, idx - before)
    end = min(len(flat), idx + len(query) + after)
    out = flat[start:end]
    if start > 0:
        out = "…" + out
    if end < len(flat):
        out = out + "…"
    return out


def _like_escape(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _search_terms(query: str) -> list[str]:
    """Split into word cores, trimming edge punctuation.

    The user types the plain text they see, but the stored text carries markdown
    and punctuation (e.g. ``session**,``). Trimming edges off each token so we
    match on the word core (``session``) makes those line up.
    """
    terms: list[str] = []
    for raw in query.split():
        t = raw.strip(string.punctuation)
        if t:
            terms.append(t)
    return terms


def search(query: str, limit: int = 40) -> list[dict[str, Any]]:
    """Full-text-ish search across event titles, targets and detail bodies.

    Covers everything captured: prompts/responses (conversation), file paths,
    shell commands, MCP calls, etc. — each event's text is stored in detail.

    Matching is token-based (every whitespace-separated word must appear), not a
    single contiguous substring. This way formatting that sits between words in
    the stored text — markdown like ``**bold**``, links, punctuation — does not
    prevent a match against the plain text the user sees and types.
    """
    terms = _search_terms(query)
    if not terms:
        return []
    clauses: list[str] = []
    params: list[Any] = []
    for t in terms:
        like = f"%{_like_escape(t)}%"
        clauses.append(
            "(e.title LIKE ? ESCAPE '\\' OR e.target LIKE ? ESCAPE '\\'"
            " OR e.detail LIKE ? ESCAPE '\\')"
        )
        params.extend([like, like, like])
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(
            "SELECT e.id, e.session_id, e.category, e.title, e.target, e.detail,"
            " e.ts, e.source, e.model, s.cwd AS cwd"
            " FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
            f" WHERE {' AND '.join(clauses)}"
            " ORDER BY e.ts DESC LIMIT ?",
            params,
        ).fetchall()
    return [
        {
            "session_id": r["session_id"],
            "event_id": r["id"],
            "category": r["category"],
            "title": r["title"],
            "target": r["target"],
            "ts": _format_ts(r["ts"]),
            "source": r["source"],
            "model": r["model"],
            "cwd": r["cwd"],
            "snippet": _snippet(r["detail"] or r["title"] or r["target"] or "", terms[0]),
        }
        for r in rows
    ]


def _event_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "hook": row["hook"],
        "tool": row["tool"],
        "phase": row["phase"],
        "ts": _format_ts(row["ts"]),
        "source": row["source"],
        "category": row["category"],
        "title": row["title"],
        "detail": row["detail"],
        "target": row["target"],
        "status": row["status"],
        "duration_ms": row["duration_ms"],
        "model": row["model"],
        "attachments": json.loads(row["attachments"]) if row["attachments"] else None,
        "payload": row["payload"],
    }


def attach_to_prompt(session_id: str, text: str | None, attachments: list[dict]) -> bool:
    """Merge file/image metadata onto the matching prompt event (by exact text,
    else the latest prompt in the session) rather than creating a separate row."""
    if not attachments:
        return False
    with _write_lock, _connect() as conn:
        row = None
        if text:
            row = conn.execute(
                "SELECT id, attachments FROM events"
                " WHERE session_id=? AND category='prompt' AND detail=?"
                " ORDER BY id DESC LIMIT 1",
                (session_id, text),
            ).fetchone()
        if row is None:
            row = conn.execute(
                "SELECT id, attachments FROM events"
                " WHERE session_id=? AND category='prompt' ORDER BY id DESC LIMIT 1",
                (session_id,),
            ).fetchone()
        if row is None:
            return False
        existing = json.loads(row["attachments"]) if row["attachments"] else []
        merged = existing + [a for a in attachments if a not in existing]
        conn.execute(
            "UPDATE events SET attachments=? WHERE id=?",
            (json.dumps(merged, ensure_ascii=False), row["id"]),
        )
        return True


_EMPTY = (None, "", {}, [])


def _merge_detail(start_detail: Any, end_detail: Any) -> Any:
    """Combine a start event's detail (rich input, e.g. diff) with the end
    event's detail (result/response), so edits keep both before/after and result."""
    def _load(raw: Any) -> Any:
        if not isinstance(raw, str):
            return raw
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw

    s = _load(start_detail)
    e = _load(end_detail)
    if not isinstance(s, dict) or not isinstance(e, dict):
        return end_detail or start_detail

    merged = dict(s)
    for key, val in e.items():
        if (
            key in ("input", "arguments", "tool_input")
            and isinstance(val, dict)
            and isinstance(merged.get(key), dict)
        ):
            combined = dict(val)
            combined.update({k: v for k, v in merged[key].items() if v not in _EMPTY})
            merged[key] = combined
        elif val not in _EMPTY:
            merged[key] = val
    return json.dumps(merged, indent=2, ensure_ascii=False, default=str)


def timeline(session_id: str) -> list[dict[str, Any]]:
    """Build timeline items, merging start/end pairs into spans."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE session_id=? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
        events = [_event_row(r) for r in rows]

    spans: dict[str, dict[str, Any]] = {}
    items: list[dict[str, Any]] = []

    for ev in events:
        cat = ev.get("category") or "other"
        target = ev.get("target") or ""
        phase = ev.get("phase") or "instant"
        key = f"{cat}::{target}"

        if phase == "start":
            spans[key] = {**ev, "start_ts": ev["ts"], "end_ts": None, "ongoing": True}
            continue

        if phase == "end" and key in spans:
            start = spans.pop(key)
            dur = ev.get("duration_ms") or start.get("duration_ms")
            if dur is None:
                dur = int((_duration_seconds(start["start_ts"], ev["ts"]) or 0) * 1000)
            items.append({
                **start,
                "end_ts": ev["ts"],
                "ongoing": False,
                "duration_ms": dur,
                "detail": _merge_detail(start.get("detail"), ev.get("detail")),
                "status": ev.get("status") or start.get("status"),
            })
            continue

        items.append({**ev, "start_ts": ev["ts"], "end_ts": ev["ts"], "ongoing": False})

    for pending in spans.values():
        items.append({**pending, "end_ts": None})

    items.sort(key=lambda x: x.get("start_ts") or x.get("ts") or "")
    return items


def events_list(session_id: str) -> list[dict[str, Any]]:
    """Every stored event, one row per hook fire (no start/end merging)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE session_id=? ORDER BY id ASC",
            (session_id,),
        ).fetchall()
    return [
        {**_event_row(r), "start_ts": r["ts"], "end_ts": r["ts"], "ongoing": False}
        for r in rows
    ]


def session_components(session_id: str) -> dict[str, Any]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT category, target, title, phase FROM events WHERE session_id=?",
            (session_id,),
        ).fetchall()

    files_edited: dict[str, int] = {}
    files_read: dict[str, int] = {}
    mcp_calls: dict[str, int] = {}
    web_calls: dict[str, int] = {}
    skills: dict[str, int] = {}
    # Keyed by stable subagent id; value holds display label + event count.
    subagents: dict[str, dict[str, Any]] = {}
    shell_count = 0
    prompts = 0
    responses = 0

    for r in rows:
        cat = r["category"] or "other"
        target = r["target"] or ""
        if cat == "file_edit" and target:
            files_edited[target] = files_edited.get(target, 0) + 1
        elif cat in ("file_read", "context_read") and target:
            bucket = skills if cat == "context_read" else files_read
            bucket[target] = bucket.get(target, 0) + 1
        elif cat == "mcp" and target:
            mcp_calls[target] = mcp_calls.get(target, 0) + 1
        elif cat == "web" and target and (r["phase"] or "") in ("end", "instant"):
            web_calls[target] = web_calls.get(target, 0) + 1
        elif cat == "memory" and target:
            skills[target] = skills.get(target, 0) + 1
        elif cat == "subagent" and target:
            label = _subagent_display_label(r["title"], target)
            entry = subagents.setdefault(target, {"target": label, "count": 0})
            if label != target:
                entry["target"] = label
            entry["count"] += 1
        elif cat == "shell":
            shell_count += 1
        elif cat == "prompt":
            prompts += 1
        elif cat == "response":
            responses += 1

    return {
        "files_edited": [{"path": k, "count": v} for k, v in sorted(files_edited.items())],
        "files_read": [{"path": k, "count": v} for k, v in sorted(files_read.items())],
        "skills_context": [{"path": k, "count": v} for k, v in sorted(skills.items())],
        "mcp_plugins": [{"target": k, "count": v} for k, v in sorted(mcp_calls.items())],
        "web_calls": [{"target": k, "count": v} for k, v in sorted(web_calls.items())],
        "subagents": [{"target": v["target"], "count": v["count"]} for v in sorted(subagents.values(), key=lambda x: -x["count"])],
        "shell_count": shell_count,
        "prompt_count": prompts,
        "response_count": responses,
    }


# Only structured questions count: the agent explicitly asking the user via
# Claude's AskUserQuestion or Codex's request_user_input. We never guess from
# assistant prose.
_QUESTION_TOOLS = {"AskUserQuestion", "request_user_input"}
_QUESTION_END_HOOKS = {"PostToolUse", "postToolUse"}


def _coerce_dict(val: Any) -> dict[str, Any]:
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip():
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _parse_questions(detail: Any) -> list[dict[str, Any]]:
    """Break a structured-question event (AskUserQuestion / request_user_input)
    into its individual sub-questions, each paired with the user's chosen answer
    when it's recoverable.

    A single tool call can pose several questions at once; this returns one entry
    per question: ``{header, question, options, answer}``. Codex carries the
    answers in the response keyed by each question's ``id``; Claude doesn't put
    the selection in the hook, so ``answer`` is ``None`` there.
    """
    obj = _coerce_dict(detail)
    if not obj:
        return []
    src = obj.get("input") if isinstance(obj.get("input"), dict) else obj
    qs = src.get("questions") if isinstance(src.get("questions"), list) else []
    # Codex response: {"answers": {<question id>: {"answers": [<label>, ...]}}}.
    resp = _coerce_dict(obj.get("response") or obj.get("output"))
    answers = resp.get("answers") if isinstance(resp.get("answers"), dict) else {}

    out: list[dict[str, Any]] = []
    for q in qs:
        if not isinstance(q, dict) or not q.get("question"):
            continue
        ans: str | None = None
        picked = answers.get(q.get("id")) if q.get("id") else None
        if isinstance(picked, dict) and isinstance(picked.get("answers"), list):
            ans = ", ".join(str(a) for a in picked["answers"] if a)
        elif isinstance(picked, list):
            ans = ", ".join(str(a) for a in picked if a)
        elif isinstance(picked, str):
            ans = picked
        options = [
            str(o.get("label"))
            for o in (q.get("options") or [])
            if isinstance(o, dict) and o.get("label")
        ]
        out.append(
            {
                "header": q.get("header"),
                "question": str(q.get("question")),
                "options": options,
                "answer": ans or None,
            }
        )
    return out


def _question_text(detail: Any) -> str:
    """Pull the human-readable question(s) out of a structured-question detail."""
    return " · ".join(q["question"] for q in _parse_questions(detail))


def _excerpt(text: str | None, limit: int = 200) -> str:
    if not text:
        return ""
    collapsed = " ".join(str(text).split())
    return collapsed if len(collapsed) <= limit else collapsed[: limit - 1] + "…"


def _build_clarifications(
    ev_rows: list[sqlite3.Row],
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    """Flag the agent's explicit questions to the user (AskUserQuestion) and how
    they were answered.

    The PreToolUse fires when the question is posed; the PostToolUse fires once
    the user has answered (synchronously), so a completed pair = answered. If a
    user prompt instead follows an open question, that prompt is the answer.
    Annotations are keyed by the question's start event id — the same id the
    merged timeline span carries — so the badge lands on the right item.
    """
    questions: list[dict[str, Any]] = []
    pending: dict[str, Any] | None = None

    def _new(row: sqlite3.Row, answered: bool) -> dict[str, Any]:
        return {
            "start_id": row["id"],
            "ts": row["ts"],
            "detail": row["detail"],
            "answered": answered,
            "answer_id": None,
            "answer_ts": None,
            "answer_detail": None,
        }

    for r in ev_rows:
        if r["tool"] in _QUESTION_TOOLS:
            if r["hook"] in _QUESTION_END_HOOKS:
                # Answer was returned inline to the agent — no separate event.
                if pending is not None:
                    pending["answered"] = True
                else:
                    pending = _new(r, answered=True)
                questions.append(pending)
                pending = None
            else:
                if pending is not None:
                    questions.append(pending)
                pending = _new(r, answered=False)
        elif r["category"] == "prompt" and pending is not None and not pending["answered"]:
            pending["answered"] = True
            pending["answer_id"] = r["id"]
            pending["answer_ts"] = r["ts"]
            pending["answer_detail"] = r["detail"]
            questions.append(pending)
            pending = None
    if pending is not None:
        questions.append(pending)

    clarifications: list[dict[str, Any]] = []
    annotations: dict[int, dict[str, Any]] = {}
    for q in questions:
        annotations[q["start_id"]] = {
            "is_question": True,
            "answered": q["answered"],
            "answer_event_id": q["answer_id"],
        }
        if q["answer_id"] is not None:
            annotations[q["answer_id"]] = {"answers_event_id": q["start_id"]}
        clarifications.append(
            {
                "question_event_id": q["start_id"],
                "question_ts": q["ts"],
                "question_excerpt": _excerpt(_question_text(q["detail"])),
                "answer_event_id": q["answer_id"],
                "answer_ts": q["answer_ts"],
                "answer_excerpt": _excerpt(q["answer_detail"]) if q["answer_detail"] else None,
                "answered": q["answered"],
            }
        )
    return clarifications, annotations


def get_session_detail(session_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return None
        summary = _session_summary(conn, row)
        ev_rows = conn.execute(
            "SELECT id, category, detail, ts, hook, tool FROM events"
            " WHERE session_id=? ORDER BY id ASC",
            (session_id,),
        ).fetchall()

    clarifications, annotations = _build_clarifications(ev_rows)
    events = events_list(session_id)
    tl = timeline(session_id)
    for item in events:
        extra = annotations.get(item["id"])
        if extra:
            item.update(extra)
        if item.get("category") == "question":
            item["questions"] = _parse_questions(item.get("detail"))
    for item in tl:
        extra = annotations.get(item["id"])
        if extra:
            item.update(extra)
        if item.get("category") == "question":
            item["questions"] = _parse_questions(item.get("detail"))

    return {
        "summary": summary,
        "components": session_components(session_id),
        "events": events,
        "timeline": tl,
        "clarifications": clarifications,
    }


def get_session(session_id: str) -> dict[str, Any] | None:
    return get_session_detail(session_id)


def stats() -> dict[str, Any]:
    with _connect() as conn:
        sessions = conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
        events = conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()["n"]
        tool_calls = conn.execute(
            "SELECT COUNT(*) AS n FROM events WHERE tool IS NOT NULL"
        ).fetchone()["n"]
        by_source = {
            r["source"]: r["n"]
            for r in conn.execute(
                "SELECT source, COUNT(*) AS n FROM sessions GROUP BY source"
            ).fetchall()
        }
        # Effective status is recency-derived, so count live sessions from each
        # session's most recent event rather than the stored flag.
        last_rows = conn.execute(
            "SELECT session_id, MAX(ts) AS last_ts FROM events GROUP BY session_id"
        ).fetchall()
        active = sum(1 for r in last_rows if _live_status(r["last_ts"]) == "active")
        by_status = {"active": active, "completed": max(sessions - active, 0)}
        avg_row = conn.execute(
            "SELECT AVG(d) AS a FROM ("
            " SELECT (julianday(MAX(ts)) - julianday(MIN(ts))) * 86400 AS d"
            " FROM events GROUP BY session_id)"
        ).fetchone()
        avg_duration = round(avg_row["a"], 2) if avg_row and avg_row["a"] is not None else None
        return {
            "sessions": sessions,
            "events": events,
            "tool_calls": tool_calls,
            "active_sessions": active,
            "avg_duration_seconds": avg_duration,
            "by_source": by_source,
            "by_status": by_status,
        }

"""SQLite storage. A single database file collates every agent's events.

The DB lives in the user's home directory (``~/.cot/cot.db``) so all data
stays local and is trivially portable/backup-able. Override with COT_DB_PATH.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import string
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import __version__
from .normalize import categorize, normalize
from .pricing import cost_for, normalize_model

_write_lock = threading.Lock()

_SESSION_END_HOOKS = {"Stop", "stop", "SessionEnd", "sessionEnd"}
_SESSION_START_HOOKS = {"SessionStart", "sessionStart"}
_APPROVAL_REVIEW_PREFIX = "The following is the Codex agent history"
_APPROVAL_REVIEW_RE = re.compile(r"\bReviewed Codex session id:\s*([0-9a-fA-F-]{36})\b")


def _clean_upload_wrapper_text(text: str | None) -> str:
    out = str(text or "").strip()
    user_query = re.search(r"<user_query>\s*(.*?)\s*</user_query>", out, re.S)
    if user_query:
        out = user_query.group(1).strip()
    marker = "## My request for Codex:"
    if marker in out:
        out = out.split(marker, 1)[1].strip()
    out = re.sub(r"<uploaded_documents>.*?</uploaded_documents>", "", out, flags=re.S).strip()
    out = re.sub(r"<image\b[^>]*>\s*</image>", "", out, flags=re.S).strip()
    return out


def _approval_review_origin_from_text(text: str | None) -> str | None:
    body = str(text or "").lstrip()
    if not body.startswith(_APPROVAL_REVIEW_PREFIX):
        return None
    match = _APPROVAL_REVIEW_RE.search(body)
    return match.group(1).lower() if match else None
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
    origin      TEXT,
    raw_ingest_id INTEGER,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (raw_ingest_id) REFERENCES raw_ingest_events(id) ON DELETE SET NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session_category ON events(session_id, category);
CREATE INDEX IF NOT EXISTS idx_events_session_model ON events(session_id, model);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_sessions_archived_source ON sessions(archived, source);

CREATE TABLE IF NOT EXISTS raw_ingest_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    origin      TEXT NOT NULL,
    received_at TEXT NOT NULL,
    session_id_guess TEXT,
    raw_kind    TEXT,
    raw_payload TEXT,
    raw_payload_truncated INTEGER NOT NULL DEFAULT 0,
    raw_hash    TEXT NOT NULL,
    parser_version TEXT,
    agent_version TEXT,
    status      TEXT NOT NULL,
    event_id    INTEGER,
    projection_error TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_ingest_source_received ON raw_ingest_events(source, received_at);
CREATE INDEX IF NOT EXISTS idx_raw_ingest_status ON raw_ingest_events(status);
CREATE INDEX IF NOT EXISTS idx_raw_ingest_event ON raw_ingest_events(event_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS insight_findings (
    fingerprint TEXT PRIMARY KEY,
    rule_id     TEXT NOT NULL,
    pillar      TEXT NOT NULL,
    tier        INTEGER NOT NULL DEFAULT 2,
    severity    TEXT NOT NULL,
    title       TEXT,
    detail      TEXT,
    recommendation TEXT,
    evidence    TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    resolved_at TEXT,
    dismissed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_findings_status ON insight_findings(status, pillar);

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


_EVENT_INSERT_SQL = (
    "INSERT INTO events (session_id, source, hook, tool, phase, ts, payload,"
    " category, title, detail, target, status, duration_ms, model,"
    " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
    " dedup_key, origin, raw_ingest_id, created_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def _dedup_key(raw: dict[str, Any]) -> str:
    return hashlib.sha1(
        json.dumps(raw, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    ).hexdigest()


def _event_params(
    norm: dict[str, Any],
    raw: dict[str, Any],
    dedup_key: str,
    ts: str | None = None,
    origin: str = "hook",
    raw_ingest_id: int | None = None,
) -> tuple[Any, ...]:
    return (
        norm["session_id"],
        norm["source"],
        norm["hook"],
        norm["tool"],
        norm["phase"],
        ts or norm["ts"],
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
        origin,
        raw_ingest_id,
        _now(),
    )


def _tokens_dict(row: sqlite3.Row) -> dict[str, int]:
    return _tokens_from_parts(row["i"], row["o"], row["cr"], row["cw"])


def _tokens_from_parts(i: Any, o: Any, cr: Any, cw: Any) -> dict[str, int]:
    i = int(i or 0)
    o = int(o or 0)
    cr = int(cr or 0)
    cw = int(cw or 0)
    return {
        "input": i,
        "output": o,
        "cache_read": cr,
        "cache_write": cw,
        "total": i + o + cr + cw,
    }


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # DELETE journal mode: WAL breaks on Docker bind mounts (macOS virtiofs disk I/O).
    conn = sqlite3.connect(path, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000;")
    journal_mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
    if str(journal_mode).lower() != "delete":
        conn.execute("PRAGMA journal_mode=DELETE;")
    conn.execute("PRAGMA foreign_keys=ON;")
    # Keep sort/temp B-trees in RAM. The container runs read-only with a tiny
    # (~16MB) /tmp tmpfs, so spilling a large session's ORDER BY to a temp file
    # raised SQLITE_FULL ("database or disk is full"). Memory temp store avoids
    # the tmpfs entirely; query working sets here are well within RAM.
    conn.execute("PRAGMA temp_store=MEMORY;")
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
        ("origin", "TEXT"),
        ("raw_ingest_id", "INTEGER"),
    ):
        _add_column_if_missing(conn, "events", name, col_def, event_cols)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_raw_ingest ON events(raw_ingest_id)"
    )

    session_cols = _table_columns(conn, "sessions")
    for name, col_def in (
        ("source", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("cwd", "TEXT"),
        ("started_at", "TEXT NOT NULL DEFAULT ''"),
        ("ended_at", "TEXT"),
        ("status", "TEXT NOT NULL DEFAULT 'active'"),
        ("archived", "INTEGER NOT NULL DEFAULT 0"),
        ("created_at", "TEXT NOT NULL DEFAULT ''"),
        # A subagent session launched by a parent agent. Derived deterministically
        # from the on-disk transcript nesting (.../<parent>/subagents/<child>.jsonl)
        # so the child's work embeds under the parent instead of orphaning.
        ("parent_session_id", "TEXT"),
        ("subagent_label", "TEXT"),
    ):
        _add_column_if_missing(conn, "sessions", name, col_def, session_cols)
    if "parent_session_id" in session_cols:
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)"
        )

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
    """Structured question tools used to fall through to ``other`` and had no
    stable merge target. Re-run stored rows so the timeline can pair asked and
    answered events."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events"
        " WHERE tool IN ('AskUserQuestion', 'AskQuestion', 'request_user_input')"
        " AND (category != 'question' OR target IS NULL OR target = '')"
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


def _recategorize_web_search(conn: sqlite3.Connection) -> None:
    """WebSearch events were historically stored as ``search``; they belong in
    ``web``. Re-run categorize to fix category, title, and target."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events"
        " WHERE tool IN ('WebSearch', 'WebFetch') AND category = 'search'"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        conn.execute(
            "UPDATE events SET category=?, title=?, target=?, detail=?, status=?,"
            " duration_ms=? WHERE id=?",
            (
                cat["category"],
                cat["title"],
                cat["target"],
                cat["detail"],
                cat["status"],
                cat["duration_ms"],
                row["id"],
            ),
        )


def _recategorize_browser_navigate_starts(conn: sqlite3.Connection) -> None:
    """preToolUse events for browser_navigate were stored as ``mcp``; they
    should be ``web`` (with the URL as target) so start/end spans merge."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events"
        " WHERE category = 'mcp'"
        " AND hook IN ('PreToolUse', 'preToolUse')"
        " AND (tool LIKE '%browser_navigate%')"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        if cat["category"] == "mcp":
            continue
        conn.execute(
            "UPDATE events SET category=?, title=?, target=?, detail=?, status=?,"
            " duration_ms=? WHERE id=?",
            (
                cat["category"],
                cat["title"],
                cat["target"],
                cat["detail"],
                cat["status"],
                cat["duration_ms"],
                row["id"],
            ),
        )


def _backfill_search_targets(conn: sqlite3.Connection) -> None:
    """Search/shell events (Grep etc.) with empty targets — backfill from the
    glob or file_path fields in tool_input now that the extractor checks them."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events"
        " WHERE category IN ('search', 'shell')"
        " AND tool IN ('Grep', 'Glob', 'Search', 'Codebase', 'GrepSearch', 'FileSearch', 'ListDir')"
        " AND (target IS NULL OR target = '')"
    ).fetchall()
    for row in rows:
        try:
            raw = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        cat = categorize(row["source"], row["hook"], raw, row["tool"])
        new_target = cat.get("target") or ""
        if not new_target:
            continue
        conn.execute(
            "UPDATE events SET target=? WHERE id=?",
            (new_target, row["id"]),
        )


def _merge_search_into_shell(conn: sqlite3.Connection) -> None:
    """The ``search`` category (Grep, Glob, etc.) has been folded into ``shell``.
    Reclassify all stored search events."""
    conn.execute("UPDATE events SET category = 'shell' WHERE category = 'search'")


def _dedup_cursor_subagent_starts(conn: sqlite3.Connection) -> None:
    """Cursor fires ``subagentStart`` AND ``preToolUse`` (tool=Task/Subagent)
    for the same subagent, producing two ``start`` rows with the same
    ``subagent::target`` key. Mark the redundant subagentStart with
    phase='superseded' so the timeline merge skips it while keeping the
    lifecycle record intact."""
    conn.execute(
        "UPDATE events SET phase = 'superseded'"
        " WHERE source = 'cursor' AND hook = 'subagentStart'"
        " AND phase = 'start'"
        " AND EXISTS ("
        "   SELECT 1 FROM events e2"
        "   WHERE e2.session_id = events.session_id"
        "   AND e2.target = events.target"
        "   AND e2.source = 'cursor'"
        "   AND e2.hook = 'preToolUse'"
        "   AND e2.tool IN ('Task', 'Subagent')"
        " )"
    )


def _norm_choice(text: object) -> str:
    return " ".join(str(text or "").lower().replace("_", " ").split())


def _contains_positive(haystack: str, needle: str) -> bool:
    if not needle:
        return False
    start = haystack.find(needle)
    if start < 0:
        return False
    before = haystack[max(0, start - 24) : start].split()
    return not any(tok in {"no", "not", "without"} for tok in before[-3:])


def _choice_matches(label: str, option_id: str, response_text: str) -> bool:
    haystack = _norm_choice(response_text)
    candidates = [label, label.split(" (", 1)[0]]
    if " for now" in label:
        candidates.append(label.split(" for now", 1)[0])
    if " — " in label:
        candidates.append(label.split(" — ", 1)[0])
    if any(len(_norm_choice(c)) >= 4 and _contains_positive(haystack, _norm_choice(c)) for c in candidates):
        return True
    oid = _norm_choice(option_id.replace("_", " "))
    # Option ids only count as a match when reasonably long; short ids are
    # often common English words (e.g. "accept", "keep") that appear in prose
    # by coincidence and produce false positives.
    if len(oid) >= 8 and _contains_positive(haystack, oid):
        return True
    return False


# The agent states its choice up front (acknowledgment + a "settling on X"
# sentence); the long deliberation tail re-mentions every option and only adds
# ambiguity. Bounding the match to this leading window keeps recall (the choice
# is usually within a few sentences) without letting an essay trigger a wrong
# match — and the uniqueness guard rejects anything still ambiguous.
_ANSWER_REGION_CHARS = 700


def _answer_region(text: str) -> str:
    region = str(text or "").strip()
    markers = (
        "\n---",
        "\n## Full picture",
        "\n## Suggested",
        "\n**Suggested roadmap",
        "\n**Still unanswered",
        "\n**Two optional follow-ups",
    )
    for marker in markers:
        idx = region.find(marker)
        if idx >= 0:
            region = region[:idx]
    return region[:_ANSWER_REGION_CHARS]


# Generic words that carry no option-identifying signal; dropped before the
# title-token match so they don't inflate the overlap score.
_TITLE_STOPWORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "then", "with", "your", "you", "for",
        "now", "via", "use", "using", "run", "not", "but", "its", "this",
        "that", "into", "etc", "all", "any", "per", "are", "was", "will",
    }
)


def _option_title(label: str) -> str:
    """The short, identifying head of an option label — the part before the
    first ':', em/en dash, or '(' — e.g. "Rebuild prod image + restart" out of
    "Rebuild prod image + restart (Recommended): docker build ..."."""
    t = str(label or "")
    for sep in (":", " — ", " - ", " ("):
        if sep in t:
            t = t.split(sep, 1)[0]
    return t.strip()


def _word_tokens(text: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9]+", str(text or "").lower()) if w]


def _title_tokens(title: str) -> list[str]:
    return [w for w in _word_tokens(title) if len(w) >= 3 and w not in _TITLE_STOPWORDS]


def _token_present(tok: str, resp_tokens: list[str]) -> bool:
    """Prefix-tolerant match so "rebuild" matches "rebuilding", "image" matches
    "images", etc. without a full stemmer."""
    for rt in resp_tokens:
        if len(rt) < 3:
            continue
        if rt.startswith(tok) or tok.startswith(rt):
            return True
    return False


_TITLE_MATCH_MIN_RATIO = 0.6


def _unique_title_match(options: list[Any], match_text: str, min_margin: float = 0.2) -> str | None:
    """Recover a paraphrased selection by title-word overlap, committing only
    to a *clear* winner.

    Each option scores by the fraction of its title words present in the prose.
    We return the top option only when it clears the ratio bar AND beats the
    runner-up by ``min_margin`` — so a short generic label that coincidentally
    edges out the real (longer) answer, or two near-tied options, abstains
    rather than recording a wrong choice. Callers pass a smaller margin for the
    high-signal decision region and a larger one for the noisier fallback."""
    resp_tokens = _word_tokens(match_text)
    if not resp_tokens:
        return None
    scored: list[tuple[float, int, str]] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        label = str(opt.get("label") or "").strip()
        oid = str(opt.get("id") or "").strip()
        tt = _title_tokens(_option_title(label))
        if len(tt) < 2:
            scored.append((0.0, 0, label or oid))
            continue
        present = sum(1 for t in tt if _token_present(t, resp_tokens))
        scored.append((present / len(tt), present, label or oid))
    if not scored:
        return None
    scored.sort(key=lambda x: (-x[0], -x[1]))
    best_ratio, best_present, best_label = scored[0]
    second_ratio = scored[1][0] if len(scored) > 1 else 0.0
    if (
        best_present >= 2
        and best_ratio >= _TITLE_MATCH_MIN_RATIO
        and best_ratio - second_ratio >= min_margin
    ):
        return best_label
    return None


# Phrases with which the agent explicitly restates the user's pick. The text
# right after one of these is a high-signal "decision span" — far more reliable
# than loose token overlap across the whole reply.
_DECISION_ANCHORS = re.compile(
    r"\b(?:went with|going with|go with|i'?ll go with|let'?s go with|you chose|"
    r"i chose|we chose|chose|settling on|settle on|decided (?:on|to)|decided|"
    r"picked|selected|opting for|opted for)\b"
    r"|^\s*(?:got it|ok|okay|sounds good|perfect|great)\b[\s,:\u2014-]",
    re.I | re.M,
)
_DECISION_SPAN_CHARS = 200


def _decision_region(text: str) -> str:
    """Concatenate the short spans that follow each decision phrase. Empty when
    the reply states no explicit choice (e.g. it defers to more questions)."""
    s = str(text or "")
    spans = [s[m.start() : m.start() + _DECISION_SPAN_CHARS] for m in _DECISION_ANCHORS.finditer(s)]
    return " ".join(spans)


def _match_question(options: list[Any], region: str, min_margin: float = 0.2) -> list[str]:
    """Match options against a region: exact label/id hits first, then the
    margin-based title-token fallback (commits only on a clear winner)."""
    labels: list[str] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        label = str(opt.get("label") or "").strip()
        oid = str(opt.get("id") or "").strip()
        if _choice_matches(label, oid, region):
            labels.append(label or oid)
    if not labels:
        single = _unique_title_match(options, region, min_margin)
        if single:
            labels = [single]
    return labels


def _cursor_question_response(tool_input: dict[str, Any], response_text: str) -> dict[str, Any]:
    """Recover Cursor AskQuestion selections from the assistant summary.

    Cursor writes the AskQuestion prompt to its transcript, but current hooks do
    not include a tool result. The next assistant response normally names the
    selected option labels. Match only explicit labels/ids so we do not invent
    free-form answers.
    """
    questions = tool_input.get("questions") if isinstance(tool_input.get("questions"), list) else []
    answer_region = _answer_region(response_text)
    decision_region = _decision_region(response_text)
    haystack = _norm_choice(response_text)
    mentions_skip = any(word in haystack for word in ("skipped", "unanswered", "still open"))
    answers: dict[str, dict[str, list[str]]] = {}
    skipped: list[str] = []

    for q in questions:
        if not isinstance(q, dict):
            continue
        qid = str(q.get("id") or "")
        if not qid:
            continue
        options = q.get("options") if isinstance(q.get("options"), list) else []
        # Explicit decision span first (highest signal → smaller margin), then
        # fall back to the leading reply region (noisier → larger margin).
        labels = _match_question(options, decision_region, 0.15) if decision_region else []
        if not labels:
            labels = _match_question(options, answer_region, 0.25)
        if labels:
            answers[qid] = {"answers": labels}
        elif mentions_skip:
            skipped.append(qid)

    out: dict[str, Any] = {}
    if answers:
        out["answers"] = answers
        out["answer_source"] = "assistant_summary"
    if skipped:
        out["skipped"] = skipped
    return out


def _safe_cursor_transcript_path(path: str) -> Path | None:
    try:
        candidate = Path(path).expanduser()
    except (TypeError, ValueError):
        return None
    if not candidate.is_absolute() or candidate.suffix != ".jsonl":
        return None
    try:
        resolved = candidate.resolve(strict=True)
        cursor_root = (Path.home() / ".cursor").resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    try:
        resolved.relative_to(cursor_root)
    except ValueError:
        return None
    try:
        if resolved.stat().st_size > 25 * 1024 * 1024:
            return None
    except OSError:
        return None
    return resolved


def _message_content(obj: dict[str, Any]) -> list[Any]:
    message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
    content = obj.get("content")
    if content is None:
        content = message.get("content")
    return content if isinstance(content, list) else []


def _scan_cursor_question_artifacts(transcript_path: Path) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    with transcript_path.open("r", encoding="utf-8", errors="replace") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            for block in _message_content(obj):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use" and block.get("name") == "AskQuestion":
                    inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                    if isinstance(inp.get("questions"), list):
                        pending.append({"line": line_no, "input": inp})
                    continue
                if block.get("type") != "text" or not pending:
                    continue
                response_text = str(block.get("text") or "")
                if not response_text.strip():
                    continue
                for item in pending:
                    inp = item["input"]
                    qids = [
                        str(q.get("id") or "")
                        for q in inp.get("questions", [])
                        if isinstance(q, dict) and q.get("id")
                    ]
                    artifact_id = hashlib.sha1(
                        json.dumps(
                            {
                                "path": str(transcript_path),
                                "line": item["line"],
                                "title": inp.get("title"),
                                "qids": qids,
                            },
                            sort_keys=True,
                            ensure_ascii=False,
                        ).encode("utf-8")
                    ).hexdigest()
                    artifacts.append(
                        {
                            "id": artifact_id,
                            "line": item["line"],
                            "input": inp,
                            "response": _cursor_question_response(inp, response_text),
                            "response_text": response_text,
                        }
                    )
                pending = []
    for item in pending:
        inp = item["input"]
        qids = [
            str(q.get("id") or "")
            for q in inp.get("questions", [])
            if isinstance(q, dict) and q.get("id")
        ]
        artifact_id = hashlib.sha1(
            json.dumps(
                {
                    "path": str(transcript_path),
                    "line": item["line"],
                    "title": inp.get("title"),
                    "qids": qids,
                },
                sort_keys=True,
                ensure_ascii=False,
            ).encode("utf-8")
        ).hexdigest()
        artifacts.append(
            {
                "id": artifact_id,
                "line": item["line"],
                "input": inp,
                "response": {},
                "response_text": "",
            }
        )
    return artifacts


def _response_fingerprint(text: Any) -> str:
    stripped = str(text or "").replace("[REDACTED]", "")
    return " ".join(stripped.lower().split())


def _timestamp_before(value: Any, milliseconds: int = 1) -> str:
    dt = _parse_ts(value) or datetime.now(timezone.utc)
    return (dt - timedelta(milliseconds=milliseconds)).isoformat()


def _cursor_transcript_sources(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT e.session_id, e.ts, e.category, e.detail, e.payload, s.cwd"
        " FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
        " WHERE e.source = 'cursor' AND e.payload LIKE '%transcript_path%'"
        " ORDER BY e.id ASC"
    ).fetchall()
    sources: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        path = payload.get("transcript_path")
        if not isinstance(path, str) or not path:
            continue
        key = (row["session_id"], path)
        item = sources.setdefault(
            key,
            {
                "session_id": row["session_id"],
                "transcript_path": path,
                "cwd": row["cwd"],
                "responses": [],
                "last_ts": row["ts"],
            },
        )
        item["last_ts"] = row["ts"]
        if row["category"] == "response":
            item["responses"].append({"ts": row["ts"], "detail": row["detail"] or ""})
    return list(sources.values())


def _question_event_ts(source: dict[str, Any], response_text: str) -> str | None:
    needle = _response_fingerprint(response_text)
    if needle:
        for row in source.get("responses", []):
            hay = _response_fingerprint(row.get("detail"))
            if hay and (needle.startswith(hay[:120]) or hay.startswith(needle[:120])):
                return _timestamp_before(row.get("ts"))
    return None


def _question_signature(tool_input: dict[str, Any]) -> tuple[str, tuple[str, ...]]:
    questions = tool_input.get("questions") if isinstance(tool_input.get("questions"), list) else []
    qids = tuple(
        str(q.get("id") or q.get("prompt") or q.get("question") or "")
        for q in questions
        if isinstance(q, dict)
    )
    return str(tool_input.get("title") or ""), qids


def _cursor_question_event_exists(
    conn: sqlite3.Connection,
    session_id: str,
    artifact_id: str,
    tool_input: dict[str, Any],
    hook: str,
) -> bool:
    if conn.execute(
        "SELECT 1 FROM events WHERE session_id = ? AND hook = ? AND payload LIKE ? LIMIT 1",
        (session_id, hook, f"%{artifact_id}%"),
    ).fetchone():
        return True
    wanted = _question_signature(tool_input)
    rows = conn.execute(
        "SELECT payload FROM events WHERE session_id = ? AND source = 'cursor'"
        " AND hook = ? AND tool = 'AskQuestion'",
        (session_id, hook),
    ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        existing = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
        if _question_signature(existing) == wanted:
            return True
    return False


def _insert_cursor_question_event(
    conn: sqlite3.Connection,
    raw: dict[str, Any],
) -> None:
    dk = _dedup_key(raw)
    if conn.execute(
        "SELECT 1 FROM events WHERE session_id = ? AND dedup_key = ? LIMIT 1",
        (raw["session_id"], dk),
    ).fetchone():
        return
    norm = normalize("cursor", raw)
    conn.execute(_EVENT_INSERT_SQL, _event_params(norm, raw, dk))


def _insert_backfilled_cursor_question(
    conn: sqlite3.Connection,
    source: dict[str, Any],
    artifact: dict[str, Any],
) -> None:
    answer_ts = _question_event_ts(source, artifact.get("response_text") or "")
    if answer_ts is None:
        return
    ask_ts = _timestamp_before(answer_ts, milliseconds=1)
    base = {
        "conversation_id": source["session_id"],
        "session_id": source["session_id"],
        "cwd": source.get("cwd"),
        "tool_name": "AskQuestion",
        "tool_input": artifact["input"],
        "_synthetic_cursor_question_id": artifact["id"],
    }
    if not _cursor_question_event_exists(
        conn, source["session_id"], artifact["id"], artifact["input"], "preToolUse"
    ):
        _insert_cursor_question_event(
            conn,
            {
                **base,
                "hook_event_name": "preToolUse",
                "tool_response": {},
                "timestamp": ask_ts,
            },
        )
    if not _cursor_question_event_exists(
        conn, source["session_id"], artifact["id"], artifact["input"], "postToolUse"
    ):
        _insert_cursor_question_event(
            conn,
            {
                **base,
                "hook_event_name": "postToolUse",
                "tool_response": artifact["response"],
                "timestamp": answer_ts,
            },
        )


def _backfill_cursor_questions(conn: sqlite3.Connection) -> None:
    """Recover Cursor AskQuestion prompts that only exist in transcript JSONL."""
    for source in _cursor_transcript_sources(conn):
        path = _safe_cursor_transcript_path(source["transcript_path"])
        if path is None:
            continue
        try:
            artifacts = _scan_cursor_question_artifacts(path)
        except OSError:
            continue
        for artifact in artifacts:
            _insert_backfilled_cursor_question(conn, source, artifact)


def _purge_import_for_hook_sessions(conn: sqlite3.Connection) -> None:
    """A session captured live (hook events) must not also carry imported rows.

    A timing race can let the importer ingest a transcript for a session that
    also gets live hooks, producing duplicate events with mtime-based
    timestamps mixed with real ones. Live hook data is authoritative (real
    timestamps, proper Pre/Post pairs), so drop the imported approximation for
    any session that has hook events, then reset that session's bounds to the
    surviving (real) events."""
    affected = [
        r["session_id"]
        for r in conn.execute(
            "SELECT session_id FROM events GROUP BY session_id"
            " HAVING SUM(CASE WHEN origin = 'hook' OR origin IS NULL THEN 1 ELSE 0 END) > 0"
            "    AND SUM(CASE WHEN origin = 'import' THEN 1 ELSE 0 END) > 0"
        ).fetchall()
    ]
    if not affected:
        return
    conn.executemany(
        "DELETE FROM events WHERE session_id = ? AND origin = 'import'",
        [(sid,) for sid in affected],
    )
    for sid in affected:
        bounds = conn.execute(
            "SELECT MIN(ts) mn, MAX(ts) mx FROM events WHERE session_id = ?", (sid,)
        ).fetchone()
        if bounds and bounds["mn"]:
            conn.execute(
                "UPDATE sessions SET started_at = ? WHERE id = ?", (bounds["mn"], sid)
            )


def _recategorize_other_tools(conn: sqlite3.Connection) -> None:
    """Re-run categorize on stored ``other`` rows that carry a tool name, so
    newly-mapped tools (the ``meta`` bucket, Skill, etc.) move out of the
    catch-all without a full re-import. Idempotent: rows that still resolve to
    ``other`` are left untouched."""
    rows = conn.execute(
        "SELECT id, source, hook, tool, payload FROM events"
        " WHERE category = 'other' AND tool IS NOT NULL AND tool != ''"
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


def _question_response_obj(detail: Any) -> dict[str, Any] | None:
    """Parse a stored question event's detail into its {input, response} object."""
    if not isinstance(detail, str):
        return None
    try:
        obj = json.loads(detail)
    except (json.JSONDecodeError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


_MIGRATIONS_VERSION = "8"
_RAW_PAYLOAD_MAX_BYTES = 64 * 1024


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
        stored = conn.execute(
            "SELECT value FROM settings WHERE key = 'migrations_version'"
        ).fetchone()
        if stored and stored["value"] == _MIGRATIONS_VERSION:
            return
        _backfill(conn)
        _recategorize_network_calls(conn)
        _recategorize_subagents(conn)
        _recategorize_cursor_tools(conn)
        _recategorize_web_targets(conn)
        _recategorize_questions(conn)
        _drop_redundant_cursor_hooks(conn)
        _recategorize_web_search(conn)
        _recategorize_browser_navigate_starts(conn)
        _backfill_search_targets(conn)
        _merge_search_into_shell(conn)
        _dedup_cursor_subagent_starts(conn)
        _backfill_cursor_questions(conn)
        _recategorize_other_tools(conn)
        _purge_import_for_hook_sessions(conn)
        conn.execute(
            "UPDATE events SET origin = 'hook' WHERE origin IS NULL"
        )
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('migrations_version', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_MIGRATIONS_VERSION,),
        )


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


def _raw_hash(raw_text: str) -> str:
    return hashlib.sha1(raw_text.encode("utf-8", errors="replace")).hexdigest()


def _raw_payload_text(raw: Any) -> tuple[str, int]:
    if isinstance(raw, str):
        text = raw
    else:
        text = json.dumps(raw, ensure_ascii=False, default=str)
    data = text.encode("utf-8", errors="replace")
    if len(data) <= _RAW_PAYLOAD_MAX_BYTES:
        return text, 0
    clipped = data[:_RAW_PAYLOAD_MAX_BYTES].decode("utf-8", errors="ignore")
    return clipped, 1


def _session_id_guess(source: str, raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    if source == "cursor":
        value = raw.get("conversation_id") or raw.get("session_id") or raw.get("generation_id")
    else:
        value = raw.get("session_id")
    return str(value) if value not in (None, "") else None


def _raw_kind(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    value = raw.get("hook_event_name") or raw.get("hook") or raw.get("event") or raw.get("raw_kind")
    return str(value) if value not in (None, "") else None


def _agent_version(raw: Any) -> str | None:
    if not isinstance(raw, dict):
        return None
    value = (
        raw.get("agent_version")
        or raw.get("cursor_version")
        or raw.get("claude_version")
        or raw.get("codex_version")
        or raw.get("cli_version")
    )
    return str(value) if value not in (None, "") else None


def _raw_received_at(raw: Any) -> str:
    if isinstance(raw, dict):
        value = raw.get("timestamp") or raw.get("ts") or raw.get("created_at")
        if value not in (None, ""):
            return str(value)
    return _now()


def append_raw_ingest(
    source: str,
    raw: Any,
    *,
    origin: str = "hook",
    status: str = "pending",
    projection_error: str | None = None,
) -> int:
    payload, truncated = _raw_payload_text(raw)
    now = _now()
    received_at = _raw_received_at(raw)
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO raw_ingest_events (source, origin, received_at, session_id_guess,"
            " raw_kind, raw_payload, raw_payload_truncated, raw_hash, parser_version,"
            " agent_version, status, projection_error, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                source,
                origin,
                received_at,
                _session_id_guess(source, raw),
                _raw_kind(raw),
                payload,
                truncated,
                _raw_hash(payload),
                __version__,
                _agent_version(raw),
                status,
                projection_error,
                now,
            ),
        )
        return int(cur.lastrowid)


def mark_raw_ingest(
    raw_ingest_id: int,
    status: str,
    *,
    event_id: int | None = None,
    projection_error: str | None = None,
) -> None:
    with _write_lock, _connect() as conn:
        conn.execute(
            "UPDATE raw_ingest_events SET status = ?, event_id = ?, projection_error = ?"
            " WHERE id = ?",
            (status, event_id, projection_error, raw_ingest_id),
        )


def raw_ingest_events(limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 500))
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM raw_ingest_events ORDER BY id ASC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def record_malformed_ingest(
    source: str,
    raw_text: str,
    *,
    origin: str = "hook",
    error: str | None = None,
) -> dict[str, Any]:
    raw_id = append_raw_ingest(
        source,
        raw_text,
        origin=origin,
        status="malformed",
        projection_error=error,
    )
    return {
        "ok": True,
        "raw_ingest_id": raw_id,
        "raw_status": "malformed",
        "session_id": None,
        "event_id": None,
    }


def record_ingest(source: str, raw: dict[str, Any]) -> dict[str, Any]:
    raw_id = append_raw_ingest(source, raw, origin="import" if raw.get("_import") else "hook")
    try:
        norm = normalize(source, raw)
        if should_ignore_event(norm):
            mark_raw_ingest(raw_id, "ignored")
            return {
                "ok": True,
                "ignored": True,
                "raw_ingest_id": raw_id,
                "raw_status": "ignored",
                "session_id": norm["session_id"],
                "event_id": None,
                "hook": norm["hook"],
                "category": norm.get("category"),
            }
        session_id, event_id, inserted = record_event(
            norm, raw, raw_ingest_id=raw_id, return_status=True
        )
    except Exception as exc:
        mark_raw_ingest(raw_id, "failed", projection_error=str(exc))
        return {
            "ok": True,
            "raw_ingest_id": raw_id,
            "raw_status": "failed",
            "session_id": _session_id_guess(source, raw),
            "event_id": None,
            "error": str(exc),
        }

    raw_status = "projected" if inserted else "duplicate"
    mark_raw_ingest(raw_id, raw_status, event_id=event_id)
    return {
        "ok": True,
        "raw_ingest_id": raw_id,
        "raw_status": raw_status,
        "session_id": session_id,
        "event_id": event_id,
        "hook": norm["hook"],
        "category": norm.get("category"),
        "ignored": False,
        "duplicate": not inserted,
    }


def record_event(
    norm: dict[str, Any],
    raw: dict[str, Any],
    *,
    raw_ingest_id: int | None = None,
    return_status: bool = False,
) -> tuple[str, int] | tuple[str, int, bool]:
    sid = norm["session_id"]
    ts = norm["ts"]
    origin = "import" if raw.get("_import") else "hook"
    explicit_dk = raw.get("_dedup_key")
    dk = str(explicit_dk) if explicit_dk else _dedup_key(raw)

    with _write_lock, _connect() as conn:
        if explicit_dk:
            # Import path: dedup on (session_id, dedup_key) with no time window.
            dup = conn.execute(
                "SELECT id FROM events WHERE session_id = ? AND dedup_key = ? LIMIT 1",
                (sid, dk),
            ).fetchone()
        else:
            # Live hook path: 5s payload-hash window (Cursor double-posts).
            cutoff = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
            dup = conn.execute(
                "SELECT id FROM events WHERE session_id = ? AND dedup_key = ? AND created_at >= ?"
                " ORDER BY id DESC LIMIT 1",
                (sid, dk, cutoff),
            ).fetchone()
        if dup is not None:
            event_id = int(dup["id"])
            if raw_ingest_id is not None:
                conn.execute(
                    "UPDATE raw_ingest_events SET status = 'duplicate', event_id = ?"
                    " WHERE id = ?",
                    (event_id, raw_ingest_id),
                )
            return (sid, event_id, False) if return_status else (sid, event_id)

        row = conn.execute("SELECT id FROM sessions WHERE id = ?", (sid,)).fetchone()
        if row is None or norm["hook"] in _SESSION_START_HOOKS:
            if row is None:
                conn.execute(
                    "INSERT INTO sessions (id, source, cwd, started_at, status, created_at)"
                    " VALUES (?, ?, ?, ?, 'active', ?)",
                    (sid, norm["source"], norm["cwd"], ts, _now()),
                )
            elif norm["hook"] in _SESSION_START_HOOKS:
                conn.execute(
                    "UPDATE sessions SET status = 'active', cwd = COALESCE(?, cwd)"
                    " WHERE id = ?",
                    (norm["cwd"], sid),
                )
        elif norm["cwd"]:
            conn.execute(
                "UPDATE sessions SET cwd = COALESCE(cwd, ?) WHERE id = ?",
                (norm["cwd"], sid),
            )

        # Imported events carry historical timestamps; ensure the session's
        # started_at reflects the earliest event we've seen.
        if origin == "import":
            conn.execute(
                "UPDATE sessions SET started_at = ? WHERE id = ?"
                " AND (started_at IS NULL OR ? < started_at)",
                (ts, sid, ts),
            )

        if norm["hook"] in _SESSION_END_HOOKS:
            conn.execute(
                "UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?",
                (ts, sid),
            )

        cur = conn.execute(
            _EVENT_INSERT_SQL, _event_params(norm, raw, dk, ts, origin, raw_ingest_id)
        )

        if (
            norm["source"] == "cursor"
            and norm["hook"] == "preToolUse"
            and norm.get("tool") in ("Task", "Subagent")
            and norm.get("target")
        ):
            conn.execute(
                "UPDATE events SET phase = 'superseded'"
                " WHERE session_id = ? AND source = 'cursor'"
                " AND hook = 'subagentStart' AND target = ? AND phase = 'start'",
                (sid, norm["target"]),
            )

        # Hook data wins: if a live event arrives for a session that the importer
        # had also ingested (timing race), drop the imported approximation and
        # reset the session's start to the real events. No-op after the first.
        if origin == "hook":
            purged = conn.execute(
                "DELETE FROM events WHERE session_id = ? AND origin = 'import'", (sid,)
            ).rowcount
            if purged:
                bounds = conn.execute(
                    "SELECT MIN(ts) mn FROM events WHERE session_id = ?", (sid,)
                ).fetchone()
                if bounds and bounds["mn"]:
                    conn.execute(
                        "UPDATE sessions SET started_at = ? WHERE id = ?",
                        (bounds["mn"], sid),
                    )

        event_id = int(cur.lastrowid)
        return (sid, event_id, True) if return_status else (sid, event_id)


def _duration_seconds(first: Any, last: Any) -> float | None:
    first_dt = _parse_ts(first)
    last_dt = _parse_ts(last)
    if first_dt is None or last_dt is None:
        return None
    return round((last_dt - first_dt).total_seconds(), 2)


def _summary_title(detail: Any) -> str | None:
    if not detail:
        return None
    text = str(detail).strip().replace("\n", " ")
    return text if len(text) <= 80 else text[:79] + "…"


def _first_prompt(conn: sqlite3.Connection, session_id: str) -> str | None:
    row = conn.execute(
        "SELECT detail FROM events WHERE session_id=? AND category='prompt' ORDER BY id ASC LIMIT 1",
        (session_id,),
    ).fetchone()
    return _summary_title(row["detail"] if row else None)


def _category_counts(conn: sqlite3.Connection, session_id: str) -> dict[str, int]:
    rows = conn.execute(
        "SELECT category, COUNT(*) AS n FROM events WHERE session_id=? AND category IS NOT NULL"
        " GROUP BY category",
        (session_id,),
    ).fetchall()
    return {r["category"]: r["n"] for r in rows}


def _approval_review_origin(conn: sqlite3.Connection, session_id: str) -> str | None:
    rows = conn.execute(
        "SELECT detail FROM events"
        " WHERE session_id=? AND category='prompt' AND detail LIKE ?"
        " ORDER BY id ASC",
        (session_id, f"{_APPROVAL_REVIEW_PREFIX}%"),
    ).fetchall()
    for row in rows:
        origin = _approval_review_origin_from_text(row["detail"])
        if origin and origin != session_id:
            return origin
    return None


def _session_link_item(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    link_type: str = "approval_review",
    label: str | None = None,
) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        return None
    agg = conn.execute(
        "SELECT COUNT(*) AS events, MAX(ts) AS last_ts"
        " FROM events WHERE session_id = ?",
        (session_id,),
    ).fetchone()
    # Subagent sessions rarely have a user prompt; fall back to the label the
    # importer derived from the parent's Task launch.
    title = _first_prompt(conn, row["id"]) or label
    return {
        "type": link_type,
        "session_id": row["id"],
        "source": row["source"],
        "status": _live_status(agg["last_ts"]),
        "started_at": _format_ts(row["started_at"]) or str(row["started_at"] or ""),
        "last_activity": _format_ts(agg["last_ts"]),
        "event_count": agg["events"] or 0,
        "title": title,
        "label": label,
    }


def _session_links(conn: sqlite3.Connection, session_id: str) -> dict[str, list[dict[str, Any]]]:
    """Parent/child links for a session, unified across providers.

    Two link kinds feed the same structure (and the same inline-merge path):
    ``approval_review`` (Codex, derived from the parent id embedded in the
    review prompt) and ``subagent`` (Cursor/Claude, derived from the on-disk
    transcript nesting and stored on ``sessions.parent_session_id``)."""
    parents: list[dict[str, Any]] = []
    origin = _approval_review_origin(conn, session_id)
    if origin:
        item = _session_link_item(conn, origin, link_type="approval_review")
        if item:
            parents.append(item)
    self_row = conn.execute(
        "SELECT parent_session_id, subagent_label FROM sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    if self_row and self_row["parent_session_id"]:
        item = _session_link_item(
            conn,
            self_row["parent_session_id"],
            link_type="subagent",
            label=self_row["subagent_label"],
        )
        if item:
            parents.append(item)

    children: list[dict[str, Any]] = []
    seen: set[str] = set()
    rows = conn.execute(
        "SELECT session_id, detail, MIN(ts) AS first_ts FROM events"
        " WHERE category='prompt' AND detail LIKE ?"
        " GROUP BY session_id, detail"
        " ORDER BY first_ts ASC",
        (f"{_APPROVAL_REVIEW_PREFIX}%",),
    ).fetchall()
    for row in rows:
        review_session_id = row["session_id"]
        if review_session_id == session_id or review_session_id in seen:
            continue
        if _approval_review_origin_from_text(row["detail"]) != session_id:
            continue
        item = _session_link_item(conn, review_session_id, link_type="approval_review")
        if item:
            children.append(item)
            seen.add(review_session_id)
    # Subagent children: sessions whose stored parent is this one.
    for crow in conn.execute(
        "SELECT id, subagent_label, started_at FROM sessions"
        " WHERE parent_session_id = ? ORDER BY started_at ASC, id ASC",
        (session_id,),
    ).fetchall():
        child_id = crow["id"]
        if child_id == session_id or child_id in seen:
            continue
        item = _session_link_item(
            conn, child_id, link_type="subagent", label=crow["subagent_label"]
        )
        if item:
            children.append(item)
            seen.add(child_id)

    return {"parents": parents, "children": children}


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
    # Per-model token sums for cost calculation.
    model_rows = conn.execute(
        "SELECT model,"
        " COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,"
        " COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw"
        " FROM events WHERE session_id = ? AND model IS NOT NULL AND model != ''"
        " GROUP BY model",
        (row["id"],),
    ).fetchall()
    cost_usd = 0.0
    has_cost = False
    for mr in model_rows:
        c = cost_for(mr["model"], mr["i"], mr["o"], mr["cr"], mr["cw"])
        if c is not None:
            cost_usd += c
            has_cost = True
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
        "tokens": _tokens_dict(tok),
        "cost_usd": round(cost_usd, 6),
        "has_cost": has_cost,
    }


def _batched_session_summaries(
    conn: sqlite3.Connection, rows: list[sqlite3.Row]
) -> list[dict[str, Any]]:
    if not rows:
        return []
    session_ids = [r["id"] for r in rows]
    placeholders = ",".join("?" for _ in session_ids)

    category_counts: dict[str, dict[str, int]] = {sid: {} for sid in session_ids}
    for r in conn.execute(
        f"SELECT session_id, category, COUNT(*) AS n FROM events"
        f" WHERE session_id IN ({placeholders}) AND category IS NOT NULL"
        f" GROUP BY session_id, category",
        session_ids,
    ).fetchall():
        category_counts.setdefault(r["session_id"], {})[r["category"]] = r["n"]

    model_rows_by_session: dict[str, list[sqlite3.Row]] = {sid: [] for sid in session_ids}
    for r in conn.execute(
        f"SELECT session_id, model,"
        f" COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,"
        f" COALESCE(SUM(cache_read_tokens),0) cr,"
        f" COALESCE(SUM(cache_write_tokens),0) cw"
        f" FROM events"
        f" WHERE session_id IN ({placeholders})"
        f" AND model IS NOT NULL AND model != ''"
        f" GROUP BY session_id, model"
        f" ORDER BY session_id, model",
        session_ids,
    ).fetchall():
        model_rows_by_session.setdefault(r["session_id"], []).append(r)

    summaries: list[dict[str, Any]] = []
    for row in rows:
        last_ts = row["last_ts"]
        model_rows = model_rows_by_session.get(row["id"], [])
        cost_usd = 0.0
        has_cost = False
        for mr in model_rows:
            c = cost_for(mr["model"], mr["i"], mr["o"], mr["cr"], mr["cw"])
            if c is not None:
                cost_usd += c
                has_cost = True
        summaries.append(
            {
                "id": row["id"],
                "source": row["source"],
                "cwd": row["cwd"],
                "models": [mr["model"] for mr in model_rows],
                "archived": bool(row["archived"]),
                "status": _live_status(last_ts),
                "started_at": _format_ts(row["started_at"]) or str(row["started_at"] or ""),
                "ended_at": _format_ts(row["ended_at"]),
                "last_activity": _format_ts(last_ts),
                "event_count": row["event_count"] or 0,
                "tool_count": row["tool_count"] or 0,
                "duration_seconds": _duration_seconds(row["first_ts"], last_ts),
                "title": _summary_title(row["prompt_detail"]),
                "category_counts": category_counts.get(row["id"], {}),
                "tokens": _tokens_from_parts(row["i"], row["o"], row["cr"], row["cw"]),
                "cost_usd": round(cost_usd, 6),
                "has_cost": has_cost,
            }
        )
    return summaries


def _resolve_tz(tz: str | None) -> ZoneInfo | None:
    if not tz or not tz.strip():
        return None
    try:
        return ZoneInfo(tz.strip())
    except ZoneInfoNotFoundError:
        return None


def _metrics_time_buckets(
    conn: sqlite3.Connection,
    tz: ZoneInfo | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Bucket event counts by calendar day and clock hour."""
    if tz is None:
        by_day = [
            {"day": r["d"], "events": r["n"]}
            for r in conn.execute(
                "SELECT substr(ts,1,10) d, COUNT(*) n FROM events"
                " WHERE ts IS NOT NULL GROUP BY d ORDER BY d"
            ).fetchall()
        ]
        by_hour = [
            {"hour": int(r["h"]), "events": r["n"]}
            for r in conn.execute(
                "SELECT substr(ts,12,2) h, COUNT(*) n FROM events"
                " WHERE ts IS NOT NULL AND substr(ts,12,2) != '' GROUP BY h ORDER BY h"
            ).fetchall()
        ]
        return by_day, by_hour

    day_counts: dict[str, int] = {}
    hour_counts: dict[int, int] = {}
    for r in conn.execute("SELECT ts FROM events WHERE ts IS NOT NULL"):
        dt = _parse_ts(r["ts"])
        if dt is None:
            continue
        local = dt.astimezone(tz)
        day = local.strftime("%Y-%m-%d")
        day_counts[day] = day_counts.get(day, 0) + 1
        hour = local.hour
        hour_counts[hour] = hour_counts.get(hour, 0) + 1
    by_day = [{"day": d, "events": n} for d, n in sorted(day_counts.items())]
    by_hour = [{"hour": h, "events": n} for h, n in sorted(hour_counts.items())]
    return by_day, by_hour


def metrics(tz: str | None = None) -> dict[str, Any]:
    """Cross-session aggregates for the metrics dashboard."""
    zone = _resolve_tz(tz)
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
        tokens = _tokens_dict(tok)

        by_day, by_hour = _metrics_time_buckets(conn, zone)
        busiest_day = max(by_day, key=lambda x: x["events"]) if by_day else None
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
        model_rows_raw = rows(
            "SELECT model, COUNT(*) n, SUM(output_tokens) o,"
            " COALESCE(SUM(input_tokens),0) i_tok,"
            " COALESCE(SUM(output_tokens),0) o_tok,"
            " COALESCE(SUM(cache_read_tokens),0) cr_tok,"
            " COALESCE(SUM(cache_write_tokens),0) cw_tok,"
            " COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)"
            " + COALESCE(SUM(cache_read_tokens),0) + COALESCE(SUM(cache_write_tokens),0) t"
            " FROM events"
            " WHERE model IS NOT NULL AND model != '' GROUP BY model ORDER BY n DESC"
        )
        # Collapse raw model-id variants that mean the same model (e.g.
        # claude-opus-4-8 and claude-opus-4-8-thinking-medium) onto one
        # normalized key, so the breakdown shows one row per real model with
        # combined events/tokens/cost instead of duplicate-looking rows.
        agg: dict[str, dict[str, int]] = {}
        for r in model_rows_raw:
            key = normalize_model(r["model"]) or r["model"]
            a = agg.setdefault(
                key, {"events": 0, "out": 0, "i": 0, "o": 0, "cr": 0, "cw": 0, "total": 0}
            )
            a["events"] += r["n"]
            a["out"] += r["o"] or 0
            a["i"] += r["i_tok"]
            a["o"] += r["o_tok"]
            a["cr"] += r["cr_tok"]
            a["cw"] += r["cw_tok"]
            a["total"] += r["t"] or 0
        cost_total = 0.0
        unpriced_models: list[str] = []
        by_model: list[dict[str, Any]] = []
        for key, a in sorted(agg.items(), key=lambda kv: -kv[1]["events"]):
            c = cost_for(key, a["i"], a["o"], a["cr"], a["cw"])
            if c is not None:
                cost_total += c
            else:
                unpriced_models.append(key)
            by_model.append({
                "model": key,
                "events": a["events"],
                "output_tokens": a["out"],
                "total_tokens": a["total"],
                "cost": round(c, 6) if c is not None else None,
            })
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

        cat_lookup = {r["category"]: r["events"] for r in by_category}

        fun = {
            "busiest_day": busiest_day,
            "peak_hour": peak_hour,
            "shell_commands": cat_lookup.get("shell", 0),
            "files_edited": cat_lookup.get("file_edit", 0),
            "files_read": cat_lookup.get("file_read", 0),
            "files_touched": one(
                "SELECT COUNT(DISTINCT target) n FROM events"
                " WHERE category IN ('file_edit','file_read') AND target IS NOT NULL"
            )["n"],
            "web_calls": cat_lookup.get("web", 0),
            "mcp_calls": cat_lookup.get("mcp", 0),
            "prompts": cat_lookup.get("prompt", 0),
            "responses": cat_lookup.get("response", 0),
            "thoughts": cat_lookup.get("thought", 0),
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
                mt = a.get("media_type")
                ext = a.get("extension") or Path(str(a.get("name") or "")).suffix.lstrip(".")
                raw_type = mt or ext
                if raw_type:
                    fmt = raw_type.split("/")[-1].upper() if "/" in raw_type else str(raw_type).upper()
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
            "cost": {
                "total": round(cost_total, 6),
                "by_model": [
                    {
                        "model": m["model"],
                        "tokens": m["total_tokens"],
                        "cost": m["cost"],
                    }
                    for m in by_model
                ],
                "unpriced_models": unpriced_models,
            },
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


def set_subagent_links(links: list[dict[str, Any]]) -> int:
    """Record child→parent subagent relationships.

    The bridge derives these deterministically from the on-disk transcript
    nesting (``.../<parent>/subagents/<child>.jsonl``), so a subagent's session
    embeds under the parent that launched it instead of orphaning as a
    title-less top-level session. Best-effort: a link is applied only once both
    the child session exists and the parent differs from the child. Idempotent.
    Returns the number of links newly applied or updated."""
    applied = 0
    with _write_lock, _connect() as conn:
        for link in links or []:
            child = str(link.get("child") or "").strip()
            parent = str(link.get("parent") or "").strip()
            if not child or not parent or child == parent:
                continue
            if conn.execute("SELECT 1 FROM sessions WHERE id = ?", (child,)).fetchone() is None:
                continue
            label = link.get("label")
            cur = conn.execute(
                "UPDATE sessions SET parent_session_id = ?,"
                " subagent_label = COALESCE(?, subagent_label)"
                " WHERE id = ?"
                " AND (parent_session_id IS NULL OR parent_session_id != ?"
                "      OR (? IS NOT NULL AND COALESCE(subagent_label,'') != ?))",
                (parent, label, child, parent, label, label or ""),
            )
            if cur.rowcount:
                applied += 1
    return applied


def export_sessions(
    *,
    session_ids: list[str] | None = None,
    source: str | None = None,
    cwd: str | None = None,
    models: list[str] | None = None,
    started_after: str | None = None,
    started_before: str | None = None,
    ended_after: str | None = None,
    ended_before: str | None = None,
    status: str | None = None,
    min_tokens: int | None = None,
    min_cost: float | None = None,
    min_events: int | None = None,
    limit: int = 10000,
) -> list[dict[str, Any]]:
    """Filtered session export. Returns full session summaries matching all
    supplied filters (AND logic). No limit cap — the caller decides."""
    clauses: list[str] = []
    params: list[Any] = []

    if session_ids:
        placeholders = ",".join("?" for _ in session_ids)
        clauses.append(f"s.id IN ({placeholders})")
        params.extend(session_ids)
    if source:
        clauses.append("s.source = ?")
        params.append(source)
    if cwd:
        clauses.append("s.cwd LIKE ?")
        params.append(f"%{cwd}%")
    if started_after:
        clauses.append("s.started_at >= ?")
        params.append(started_after)
    if started_before:
        clauses.append("s.started_at <= ?")
        params.append(started_before)
    if ended_after:
        clauses.append("s.ended_at >= ?")
        params.append(ended_after)
    if ended_before:
        clauses.append("s.ended_at <= ?")
        params.append(ended_before)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)

    with _connect() as conn:
        rows = conn.execute(
            f"SELECT s.id, s.source, s.cwd, s.started_at, s.ended_at,"
            f" s.status, s.archived, s.created_at,"
            f" e.event_count, e.tool_count, e.first_ts, e.last_ts,"
            f" e.i, e.o, e.cr, e.cw,"
            f" (SELECT fp.detail FROM events fp"
            f"  WHERE fp.session_id = s.id AND fp.category = 'prompt'"
            f"  ORDER BY fp.id ASC LIMIT 1) AS prompt_detail"
            f" FROM sessions s"
            f" JOIN ("
            f"   SELECT session_id,"
            f"     COUNT(*) AS event_count,"
            f"     SUM(CASE WHEN tool IS NOT NULL THEN 1 ELSE 0 END) AS tool_count,"
            f"     MIN(ts) AS first_ts,"
            f"     MAX(ts) AS last_ts,"
            f"     COALESCE(SUM(input_tokens),0) AS i,"
            f"     COALESCE(SUM(output_tokens),0) AS o,"
            f"     COALESCE(SUM(cache_read_tokens),0) AS cr,"
            f"     COALESCE(SUM(cache_write_tokens),0) AS cw"
            f"   FROM events"
            f"   GROUP BY session_id"
            f"   HAVING SUM(CASE WHEN category IS NOT NULL AND category != 'lifecycle' THEN 1 ELSE 0 END) > 0"
            f" ) e ON e.session_id = s.id"
            f" {where}"
            f" ORDER BY COALESCE(s.ended_at, e.last_ts, s.started_at) DESC"
            f" LIMIT ?",
            params,
        ).fetchall()
        summaries = _batched_session_summaries(conn, rows)

    if status:
        summaries = [s for s in summaries if s["status"] == status]
    if min_tokens is not None:
        summaries = [s for s in summaries if s["tokens"]["total"] >= min_tokens]
    if min_cost is not None:
        summaries = [s for s in summaries if s["cost_usd"] >= min_cost]
    if min_events is not None:
        summaries = [s for s in summaries if s["event_count"] >= min_events]
    if models:
        model_set = {m.lower() for m in models}
        summaries = [
            s for s in summaries
            if any(m.lower() in model_set for m in s["models"])
        ]
    return summaries


def _export_event_row(row: sqlite3.Row) -> dict[str, Any]:
    """Full event row for export — includes token counts and payload."""
    out: dict[str, Any] = {
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
        "tokens": {
            "input": row["input_tokens"] or 0,
            "output": row["output_tokens"] or 0,
            "cache_read": row["cache_read_tokens"] or 0,
            "cache_write": row["cache_write_tokens"] or 0,
        },
        "attachments": json.loads(row["attachments"]) if row["attachments"] else None,
    }
    if row["payload"]:
        try:
            out["payload"] = json.loads(row["payload"])
        except (json.JSONDecodeError, TypeError):
            out["payload"] = None
    return out


def _export_events(session_id: str) -> list[dict[str, Any]]:
    """Full event list for export with token counts and payloads."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE session_id=? ORDER BY ts ASC, id ASC",
            (session_id,),
        ).fetchall()
    return [_export_event_row(r) for r in rows]


def enrich_sessions(
    summaries: list[dict[str, Any]],
    include: list[str],
) -> list[dict[str, Any]]:
    """Attach additional detail sections to each session summary.

    Supported include keys: events, components, conversation, clarifications.
    """
    if not include:
        return summaries
    want = set(include)
    for s in summaries:
        sid = s["id"]
        cached_events: list[dict[str, Any]] | None = None

        if "events" in want:
            cached_events = _export_events(sid)
            s["events"] = cached_events

        if "components" in want:
            s["components"] = session_components(sid)

        if "conversation" in want:
            if cached_events is None:
                cached_events = _export_events(sid)
            s["conversation"] = [
                {
                    "role": e["category"],
                    "ts": e["ts"],
                    "content": e.get("detail"),
                    "model": e.get("model"),
                    "tool": e.get("tool"),
                    "target": e.get("target"),
                    "duration_ms": e.get("duration_ms"),
                    "tokens": e.get("tokens"),
                    "attachments": e.get("attachments"),
                }
                for e in cached_events
                if e.get("category") in (
                    "prompt", "response", "thought", "plan",
                    "question", "file_edit", "file_read",
                    "shell", "mcp", "web", "context_read",
                    "memory", "subagent",
                )
            ]

        if "clarifications" in want:
            from .session_read import build_clarifications

            with _connect() as conn:
                ev_rows = conn.execute(
                    "SELECT id, category, detail, ts, hook, tool FROM events"
                    " WHERE session_id=? ORDER BY ts ASC, id ASC",
                    (sid,),
                ).fetchall()
            clars, _ = build_clarifications(ev_rows)
            s["clarifications"] = clars
    return summaries


def list_sessions(
    limit: int = 50,
    status: str | None = None,
    source: str | None = None,
    q: str | None = None,
    archived: bool = False,
) -> list[dict[str, Any]]:
    clauses: list[str] = ["s.archived = ?"]
    params: list[Any] = [1 if archived else 0]
    # Subagent sessions embed under their parent, so they don't list standalone.
    clauses.append("s.parent_session_id IS NULL")
    if source:
        clauses.append("s.source = ?")
        params.append(source)
    if q:
        clauses.append("(s.id LIKE ? OR s.cwd LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%"])
    where = f"WHERE {' AND '.join(clauses)}"
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT s.id, s.source, s.cwd, s.started_at, s.ended_at,"
            f" s.status, s.archived, s.created_at,"
            f" e.event_count, e.tool_count, e.first_ts, e.last_ts,"
            f" e.i, e.o, e.cr, e.cw,"
            f" (SELECT fp.detail FROM events fp"
            f"  WHERE fp.session_id = s.id AND fp.category = 'prompt'"
            f"  ORDER BY fp.id ASC LIMIT 1) AS prompt_detail"
            f" FROM sessions s"
            f" JOIN ("
            f"   SELECT session_id,"
            f"     COUNT(*) AS event_count,"
            f"     SUM(CASE WHEN tool IS NOT NULL THEN 1 ELSE 0 END) AS tool_count,"
            f"     MIN(ts) AS first_ts,"
            f"     MAX(ts) AS last_ts,"
            f"     COALESCE(SUM(input_tokens),0) AS i,"
            f"     COALESCE(SUM(output_tokens),0) AS o,"
            f"     COALESCE(SUM(cache_read_tokens),0) AS cr,"
            f"     COALESCE(SUM(cache_write_tokens),0) AS cw"
            f"   FROM events"
            f"   GROUP BY session_id"
            f"   HAVING SUM(CASE WHEN category IS NOT NULL AND category != 'lifecycle' THEN 1 ELSE 0 END) > 0"
            f" ) e ON e.session_id = s.id"
            f" {where}"
            f" ORDER BY COALESCE(s.ended_at, e.last_ts, s.started_at) DESC"
            f" LIMIT ?",
            params,
        ).fetchall()
        summaries = _batched_session_summaries(conn, rows)
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
    out: dict[str, Any] = {
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
    }
    # The raw payload blob is large (~half the session response) and unused by
    # the dashboard — only composer_mode is needed, so extract it and drop the
    # rest from the wire.
    if row["payload"]:
        try:
            body = json.loads(row["payload"])
        except (json.JSONDecodeError, TypeError):
            body = {}
        mode = body.get("composer_mode")
        if isinstance(mode, str) and mode != "agent":
            out["composer_mode"] = mode
    return out


def attach_to_prompt(
    session_id: str,
    text: str | None,
    attachments: list[dict],
    timestamp: Any | None = None,
) -> bool:
    """Merge file/image metadata onto the matching prompt event."""
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
        if row is None and text:
            clean_text = _clean_upload_wrapper_text(text)
            candidates = conn.execute(
                "SELECT id, detail, attachments FROM events"
                " WHERE session_id=? AND category='prompt'"
                " ORDER BY id DESC LIMIT 50",
                (session_id,),
            ).fetchall()
            for candidate in candidates:
                if _clean_upload_wrapper_text(candidate["detail"]) == clean_text:
                    row = candidate
                    break
        if row is None and timestamp:
            row = conn.execute(
                "SELECT id, attachments FROM events"
                " WHERE session_id=? AND category='prompt' AND ts=?"
                " ORDER BY id DESC LIMIT 1",
                (session_id, timestamp),
            ).fetchone()
        if row is None and timestamp:
            target_ts = _parse_ts(timestamp)
            if target_ts is not None:
                candidates = conn.execute(
                    "SELECT id, ts, attachments FROM events"
                    " WHERE session_id=? AND category='prompt'"
                    " ORDER BY ts DESC LIMIT 30",
                    (session_id,),
                ).fetchall()
                best: sqlite3.Row | None = None
                best_delta = 999999.0
                for candidate in candidates:
                    candidate_ts = _parse_ts(candidate["ts"])
                    if candidate_ts is None:
                        continue
                    delta = abs((candidate_ts - target_ts).total_seconds())
                    if delta < best_delta:
                        best = candidate
                        best_delta = delta
                if best is not None and best_delta <= 5:
                    row = best
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


def timeline(session_id: str) -> list[dict[str, Any]]:
    from .session_read import build_timeline_items

    return build_timeline_items(session_id)


def events_list(session_id: str) -> list[dict[str, Any]]:
    """Every stored event, one row per hook fire (no start/end merging)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE session_id=? ORDER BY ts ASC, id ASC",
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


def get_session_detail(session_id: str) -> dict[str, Any] | None:
    from .session_read import build_session_detail

    return build_session_detail(session_id)


def get_event_detail(session_id: str, event_id: int) -> dict[str, Any] | None:
    """Full detail + attachments for a single event (lazy-loaded by the UI when
    a truncated event is selected)."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT detail, attachments FROM events WHERE session_id=? AND id=?",
            (session_id, event_id),
        ).fetchone()
    if row is None:
        return None
    return {
        "id": event_id,
        "detail": row["detail"],
        "attachments": json.loads(row["attachments"]) if row["attachments"] else None,
    }


def get_session(session_id: str) -> dict[str, Any] | None:
    return get_session_detail(session_id)


def session_origins() -> dict[str, str]:
    """Return the dominant origin per session: 'hook' if any hook events exist,
    else 'import'. Used by the bridge to skip already-hooked sessions."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT session_id,"
            " MAX(CASE WHEN origin = 'hook' OR origin IS NULL THEN 1 ELSE 0 END) AS has_hook"
            " FROM events GROUP BY session_id"
        ).fetchall()
    return {
        r["session_id"]: "hook" if r["has_hook"] else "import"
        for r in rows
    }


def import_summary() -> dict[str, Any]:
    """Stats about transcript-imported data."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(DISTINCT session_id) AS sessions,"
            " COALESCE(SUM(input_tokens), 0) AS input_tok,"
            " COALESCE(SUM(output_tokens), 0) AS output_tok,"
            " COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tok,"
            " COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tok,"
            " MIN(ts) AS earliest,"
            " MAX(ts) AS latest"
            " FROM events WHERE origin = 'import'"
        ).fetchone()
        by_source = conn.execute(
            "SELECT source, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS events"
            " FROM events WHERE origin = 'import' GROUP BY source"
        ).fetchall()
    total_tok = (
        (row["input_tok"] or 0) + (row["output_tok"] or 0)
        + (row["cache_read_tok"] or 0) + (row["cache_write_tok"] or 0)
    )
    return {
        "sessions": row["sessions"] or 0,
        "tokens": {
            "input": row["input_tok"] or 0,
            "output": row["output_tok"] or 0,
            "cache_read": row["cache_read_tok"] or 0,
            "cache_write": row["cache_write_tok"] or 0,
            "total": total_tok,
        },
        "earliest": row["earliest"],
        "latest": row["latest"],
        "by_source": [
            {"source": r["source"], "sessions": r["sessions"], "events": r["events"]}
            for r in by_source
        ],
    }


def set_question_answer(
    session_id: str,
    title: str | None,
    qids: list[str],
    response: dict[str, Any],
) -> int:
    """Merge a recovered answer onto stored AskQuestion event(s).

    The collector runs in Docker without access to the agent transcript files,
    and stored transcript paths are host-absolute — so answer recovery from the
    agent's follow-up prose happens on the host (the bridge) and is pushed here.
    Matches the question by its (title, question-ids) signature and only fills
    events whose response is still blank, so a real answer is never overwritten.
    """
    if not session_id or not isinstance(response, dict) or not response.get("answers"):
        return 0
    response = dict(response)
    response.setdefault("answer_source", "assistant_summary")
    wanted = (str(title or ""), tuple(str(q) for q in qids))
    updated = 0
    with _write_lock, _connect() as conn:
        rows = conn.execute(
            "SELECT id, detail FROM events WHERE session_id = ?"
            " AND tool IN ('AskUserQuestion', 'AskQuestion', 'request_user_input')"
            " AND hook IN ('PostToolUse', 'postToolUse')",
            (session_id,),
        ).fetchall()
        for row in rows:
            obj = _question_response_obj(row["detail"])
            if obj is None:
                continue
            inp = obj.get("input") if isinstance(obj.get("input"), dict) else {}
            if not inp or _question_signature(inp) != wanted:
                continue
            existing = obj.get("response")
            # Any non-empty response is a real answer (dict with answers, or a
            # plain string from the tool result) — only fill blanks.
            if existing:
                continue
            obj["response"] = response
            conn.execute(
                "UPDATE events SET detail = ? WHERE id = ?",
                (json.dumps(obj, indent=2, ensure_ascii=False, default=str), row["id"]),
            )
            updated += 1
    return updated


def clear_recovered_answers() -> int:
    """Blank out heuristically-recovered AskQuestion answers (those tagged
    ``answer_source: assistant_summary``) so they can be re-derived cleanly.

    Real answers carried in the tool result (Claude/Codex) are never tagged
    this way, so they are left intact."""
    cleared = 0
    with _write_lock, _connect() as conn:
        rows = conn.execute(
            "SELECT id, detail FROM events"
            " WHERE tool IN ('AskUserQuestion', 'AskQuestion', 'request_user_input')"
            " AND hook IN ('PostToolUse', 'postToolUse')"
        ).fetchall()
        for row in rows:
            obj = _question_response_obj(row["detail"])
            if obj is None:
                continue
            resp = obj.get("response")
            if isinstance(resp, dict) and resp.get("answer_source") == "assistant_summary":
                obj["response"] = {}
                conn.execute(
                    "UPDATE events SET detail = ? WHERE id = ?",
                    (json.dumps(obj, indent=2, ensure_ascii=False, default=str), row["id"]),
                )
                cleared += 1
    return cleared


def reset_imported() -> dict[str, Any]:
    """Drop all transcript-imported events and any sessions left with no events.

    Live hook data (origin 'hook' or NULL) is untouched. Used by ``cot
    reimport`` to clear out a previous import before re-ingesting transcripts
    with the current parsers.
    """
    with _write_lock, _connect() as conn:
        events = conn.execute(
            "SELECT COUNT(*) n FROM events WHERE origin = 'import'"
        ).fetchone()["n"]
        conn.execute("DELETE FROM events WHERE origin = 'import'")
        cur = conn.execute(
            "DELETE FROM sessions WHERE NOT EXISTS ("
            " SELECT 1 FROM events e WHERE e.session_id = sessions.id)"
        )
        deleted_sessions = cur.rowcount
    result = {
        "deleted_events": int(events or 0),
        "deleted_sessions": int(deleted_sessions or 0),
    }
    record_audit_event("import.reset", target="import", detail=result)
    return result


def _week_start(value: Any) -> str:
    dt = _parse_ts(value) or datetime.now(timezone.utc)
    return (dt.date() - timedelta(days=dt.weekday())).isoformat()


def drift_report() -> dict[str, Any]:
    """Weekly source-level ingest drift metrics.

    Projected events provide the current unknown-rate signal. Raw ledger rows
    add health counts for input that was ignored, malformed, duplicated, or
    failed before it became a timeline event.
    """
    with _connect() as conn:
        event_rows = conn.execute(
            "SELECT source, ts, category, hook, tool FROM events"
        ).fetchall()
        raw_rows = conn.execute(
            "SELECT source, received_at, status FROM raw_ingest_events"
        ).fetchall()

    buckets: dict[tuple[str, str], dict[str, Any]] = {}

    def bucket(source: str | None, period: str) -> dict[str, Any]:
        key = (source or "unknown", period)
        if key not in buckets:
            buckets[key] = {
                "source": key[0],
                "period_start": period,
                "total_events": 0,
                "other_events": 0,
                "_unknown_hooks": {},
                "_unknown_tools": {},
                "raw_status_counts": {},
            }
        return buckets[key]

    for row in event_rows:
        b = bucket(row["source"], _week_start(row["ts"]))
        b["total_events"] += 1
        if row["category"] == "other":
            b["other_events"] += 1
            hook = row["hook"] or "unknown"
            tool = row["tool"] or "unknown"
            b["_unknown_hooks"][hook] = b["_unknown_hooks"].get(hook, 0) + 1
            b["_unknown_tools"][tool] = b["_unknown_tools"].get(tool, 0) + 1

    for row in raw_rows:
        b = bucket(row["source"], _week_start(row["received_at"]))
        status = row["status"] or "unknown"
        counts = b["raw_status_counts"]
        counts[status] = counts.get(status, 0) + 1

    weeks: list[dict[str, Any]] = []
    for b in buckets.values():
        total = int(b["total_events"] or 0)
        other = int(b["other_events"] or 0)

        def top(counter: dict[str, int], key: str) -> list[dict[str, Any]]:
            return [
                {key: name, "events": count}
                for name, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))[:5]
            ]

        weeks.append(
            {
                "source": b["source"],
                "period_start": b["period_start"],
                "total_events": total,
                "other_events": other,
                "other_rate": round(other / total, 4) if total else 0.0,
                "top_unknown_hooks": top(b["_unknown_hooks"], "hook"),
                "top_unknown_tools": top(b["_unknown_tools"], "tool"),
                "raw_status_counts": dict(sorted(b["raw_status_counts"].items())),
            }
        )

    prior_rates = {
        (row["source"], row["period_start"]): row["other_rate"]
        for row in weeks
    }
    for row in weeks:
        prior = (
            datetime.fromisoformat(row["period_start"]).date() - timedelta(days=7)
        ).isoformat()
        row["previous_other_rate"] = prior_rates.get((row["source"], prior))

    weeks.sort(key=lambda row: (row["period_start"], row["source"]), reverse=True)
    return {"generated_at": _now(), "weeks": weeks}


def import_quality() -> dict[str, Any]:
    """Per-source ingestion quality + coverage, so regressions are visible and
    the "which agent logs what" picture is explicit rather than implied.

    Reports, per source: event count, how many are tool calls, how many fell
    through to ``other`` (and the percentage), and token/model coverage. The
    token coverage doubles as the per-agent capability table (e.g. Cursor logs
    no tokens, so its coverage is ~0 by data, not by bug)."""
    with _connect() as conn:
        src_rows = conn.execute(
            "SELECT source,"
            " COUNT(*) events,"
            " SUM(CASE WHEN tool IS NOT NULL AND tool != '' THEN 1 ELSE 0 END) tool_events,"
            " SUM(CASE WHEN category = 'other' THEN 1 ELSE 0 END) other,"
            " SUM(CASE WHEN model IS NOT NULL AND model != '' THEN 1 ELSE 0 END) with_model,"
            " SUM(CASE WHEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0)"
            "  +COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0) > 0"
            "  THEN 1 ELSE 0 END) with_tokens"
            " FROM events GROUP BY source ORDER BY events DESC"
        ).fetchall()
        cat_rows = conn.execute(
            "SELECT category, COUNT(*) n FROM events WHERE category IS NOT NULL"
            " GROUP BY category ORDER BY n DESC"
        ).fetchall()
        origin_rows = conn.execute(
            "SELECT origin, COUNT(*) n FROM events GROUP BY origin"
        ).fetchall()

    def pct(part: Any, whole: Any) -> float:
        whole = int(whole or 0)
        return round(100.0 * int(part or 0) / whole, 1) if whole else 0.0

    by_source = [
        {
            "source": r["source"],
            "events": r["events"] or 0,
            "tool_events": r["tool_events"] or 0,
            "other": r["other"] or 0,
            "other_pct": pct(r["other"], r["events"]),
            "with_model": r["with_model"] or 0,
            "with_tokens": r["with_tokens"] or 0,
            "token_coverage_pct": pct(r["with_tokens"], r["events"]),
        }
        for r in src_rows
    ]
    return {
        "generated_at": _now(),
        "by_source": by_source,
        "by_category": [{"category": r["category"], "events": r["n"]} for r in cat_rows],
        "by_origin": {r["origin"] or "hook": r["n"] for r in origin_rows},
    }


def complete_imported_sessions() -> dict[str, Any]:
    """Mark import-only sessions as completed.

    Transcripts don't carry lifecycle-end events so imported sessions
    stay 'active' forever.  This closes them using the timestamp of
    their most recent event as ended_at.
    """
    with _write_lock, _connect() as conn:
        rows = conn.execute(
            "SELECT s.id, MAX(e.ts) AS last_ts"
            " FROM sessions s"
            " JOIN events e ON e.session_id = s.id"
            " WHERE s.status = 'active'"
            "   AND NOT EXISTS ("
            "     SELECT 1 FROM events e2"
            "     WHERE e2.session_id = s.id AND (e2.origin = 'hook' OR e2.origin IS NULL)"
            "   )"
            " GROUP BY s.id"
        ).fetchall()
        for r in rows:
            conn.execute(
                "UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?",
                (r["last_ts"], r["id"]),
            )
    return {"completed": len(rows)}


def stats() -> dict[str, Any]:
    with _connect() as conn:
        by_source = {
            r["source"]: r["n"]
            for r in conn.execute(
                "SELECT source, COUNT(*) AS n FROM sessions GROUP BY source"
            ).fetchall()
        }
        sessions = sum(by_source.values())
        # Effective status is recency-derived, so count live sessions from each
        # session's most recent event rather than the stored flag.
        event_rows = conn.execute(
            "SELECT session_id, MAX(ts) AS last_ts,"
            " COUNT(*) AS events,"
            " SUM(CASE WHEN tool IS NOT NULL THEN 1 ELSE 0 END) AS tools,"
            " (julianday(MAX(ts)) - julianday(MIN(ts))) * 86400 AS duration"
            " FROM events GROUP BY session_id"
        ).fetchall()
        active = sum(1 for r in event_rows if _live_status(r["last_ts"]) == "active")
        by_status = {"active": active, "completed": max(sessions - active, 0)}
        events = sum(r["events"] or 0 for r in event_rows)
        tool_calls = sum(r["tools"] or 0 for r in event_rows)
        durations = [r["duration"] for r in event_rows if r["duration"] is not None]
        avg_duration = round(sum(durations) / len(durations), 2) if durations else None
        return {
            "sessions": sessions,
            "events": events,
            "tool_calls": tool_calls,
            "active_sessions": active,
            "avg_duration_seconds": avg_duration,
            "by_source": by_source,
            "by_status": by_status,
        }

#!/usr/bin/env python3
"""Capture sanitized Codex live/history data into Core Ingest fixtures.

The live fixture comes from Cot's local SQLite collector database. The history
fixture comes from the matching Codex rollout JSONL file under ~/.codex.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any

REPO = Path(__file__).resolve().parent.parent
FIXTURE_ROOT = REPO / "backend" / "tests" / "fixtures" / "core_ingest"
sys.path.insert(0, str(REPO / "backend" / "tests"))

from core_ingest_contract import fixture_from_selector, refresh_snapshot  # noqa: E402

BASE_TS = datetime(2026, 6, 1, 10, 0, 0, tzinfo=timezone.utc)
LIVE_SELECTOR = "codex/live/golden-session"
HISTORY_SELECTOR = "codex/history/golden-session"

SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{16,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b"),
)
PATH_KEYS = {
    "cwd",
    "workdir",
    "path",
    "file_path",
    "notebook_path",
    "transcript_path",
    "target",
}
TEXT_KEYS = {
    "prompt": "Sanitized user prompt for the Codex Golden Session.",
    "response": "Sanitized Codex response for the Golden Session.",
    "thought": "Sanitized Codex reasoning for the Golden Session.",
    "text": "Sanitized transcript text for the Codex Golden Session.",
    "message": "Sanitized event message.",
    "last_agent_message": "Sanitized final agent message.",
    "justification": "Sanitized approval justification.",
}
OUTPUT_TEXT_KEYS = {
    "output",
    "tool_response",
}
DROP_KEYS = {
    "encrypted_content",
    "internal_chat_message_metadata_passthrough",
    "base_instructions",
    "dynamic_tools",
    "tools",
    "rate_limits",
}


def _now_z() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _default_db_path() -> Path:
    return Path.home() / ".cot" / "cot.db"


def _default_codex_root() -> Path:
    return Path.home() / ".codex"


def _connect_readonly(path: Path) -> sqlite3.Connection:
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _format_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _fixture_session_id(selector: str) -> str:
    fixture = fixture_from_selector(selector)
    return fixture.session_id


def _session_id_from_codex_path(path: Path) -> str | None:
    match = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", path.stem)
    return match.group(1) if match else None


def _recent_db_sessions(db_path: Path, limit: int) -> list[sqlite3.Row]:
    if not db_path.exists():
        return []
    with _connect_readonly(db_path) as conn:
        return conn.execute(
            """
            SELECT
              e.session_id,
              s.cwd,
              MIN(e.ts) AS first_ts,
              MAX(e.ts) AS last_ts,
              COUNT(*) AS events,
              SUM(CASE WHEN e.origin = 'hook' OR e.origin IS NULL THEN 1 ELSE 0 END) AS hook_events,
              SUM(CASE WHEN e.origin = 'import' THEN 1 ELSE 0 END) AS import_events
            FROM events e
            LEFT JOIN sessions s ON s.id = e.session_id
            WHERE e.source = 'codex'
            GROUP BY e.session_id, s.cwd
            ORDER BY last_ts DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()


def _recent_rollouts(codex_root: Path, limit: int) -> list[Path]:
    sessions = codex_root / "sessions"
    if not sessions.exists():
        return []
    files = [p for p in sessions.glob("**/*.jsonl") if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:limit]


def _print_candidates(db_path: Path, codex_root: Path, limit: int) -> int:
    print(f"Cot DB: {db_path}")
    sessions = _recent_db_sessions(db_path, limit)
    if sessions:
        print("\nRecent Codex collector sessions:")
        for row in sessions:
            transcript = _find_rollout_for_session(
                str(row["session_id"]),
                codex_root,
                live_payloads=_live_payloads(db_path, str(row["session_id"]), allow_empty=True),
            )
            marker = "history=yes" if transcript else "history=no"
            print(
                f"  {row['session_id']}  events={row['events']} hook={row['hook_events'] or 0} "
                f"import={row['import_events'] or 0} last={row['last_ts']} {marker}"
            )
    else:
        print("\nNo Codex collector sessions found.")

    rollouts = _recent_rollouts(codex_root, limit)
    if rollouts:
        print(f"\nRecent Codex rollout files under {codex_root / 'sessions'}:")
        for path in rollouts:
            sid = _session_id_from_codex_path(path) or path.stem
            stat = path.stat()
            mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            print(f"  {sid}  modified={_format_z(mtime)} size={stat.st_size} path={path}")
    else:
        print(f"\nNo Codex rollout JSONL files found under {codex_root / 'sessions'}.")
    return 0


def _live_payloads(db_path: Path, session_id: str, *, allow_empty: bool = False) -> list[dict[str, Any]]:
    if not db_path.exists():
        raise SystemExit(f"Cot DB not found: {db_path}")
    with _connect_readonly(db_path) as conn:
        rows = conn.execute(
            """
            SELECT payload
            FROM events
            WHERE session_id = ?
              AND source = 'codex'
              AND (origin = 'hook' OR origin IS NULL)
            ORDER BY ts ASC, id ASC
            """,
            (session_id,),
        ).fetchall()
    payloads: list[dict[str, Any]] = []
    for row in rows:
        try:
            obj = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            payloads.append(obj)
    if not payloads and not allow_empty:
        raise SystemExit(f"No live hook-origin Codex payloads found for session {session_id}")
    return payloads


def _find_rollout_for_session(
    session_id: str,
    codex_root: Path,
    *,
    live_payloads: list[dict[str, Any]],
) -> Path | None:
    for payload in live_payloads:
        raw = payload.get("transcript_path")
        if isinstance(raw, str) and raw:
            path = Path(raw).expanduser()
            if path.exists():
                return path

    sessions = codex_root / "sessions"
    if not sessions.exists():
        return None
    matches = list(sessions.glob(f"**/rollout-*-{session_id}.jsonl"))
    if not matches:
        matches = list(sessions.glob(f"**/*{session_id}*.jsonl"))
    if not matches:
        return None
    matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0]


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            print(f"Skipping invalid JSONL line {path}:{lineno}", file=sys.stderr)
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def _scrub_secrets(value: str) -> str:
    out = value
    for pattern in SECRET_PATTERNS:
        out = pattern.sub("[REDACTED_SECRET]", out)
    return out


def _pathish(value: str) -> bool:
    return (
        "\\" in value
        or "/" in value
        or bool(re.match(r"^[A-Za-z]:", value))
    )


def _scrub_paths(value: str, *, cwd: Path | None, home: Path) -> str:
    out = value.replace("\\", "/")
    home_s = str(home).replace("\\", "/")
    if cwd is not None:
        cwd_s = str(cwd).replace("\\", "/")
        if cwd_s and cwd_s in out:
            out = out.replace(cwd_s, "/workspace/cot")
    if home_s and home_s in out:
        out = out.replace(home_s, "/home/user")
    out = re.sub(r"[A-Za-z]:/Users/[^/\\\s\"']+", "/home/user", out)
    out = re.sub(r"[A-Za-z]:/", "/", out)
    return out


def _sanitize_command(value: str, *, cwd: Path | None, home: Path) -> str:
    out = _scrub_secrets(value)
    return _scrub_paths(out, cwd=cwd, home=home)


def _sanitize_patch(value: str, *, cwd: Path | None, home: Path) -> str:
    if "*** Begin Patch" not in value:
        return value
    out = _scrub_secrets(value)
    return _scrub_paths(out, cwd=cwd, home=home)


def _sanitize_json_string(value: str, *, cwd: Path | None, home: Path, redact_text: bool) -> str:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return value
    sanitized = _sanitize_obj(parsed, cwd=cwd, home=home, redact_text=redact_text)
    return json.dumps(sanitized, ensure_ascii=False, separators=(",", ":"))


def _sanitize_str(
    key: str,
    value: str,
    *,
    cwd: Path | None,
    home: Path,
    redact_text: bool,
) -> str:
    if "*** Begin Patch" in value:
        return _sanitize_patch(value, cwd=cwd, home=home)
    if key in ("command", "cmd"):
        return _sanitize_command(value, cwd=cwd, home=home)
    if key in ("cwd", "workdir"):
        return "/workspace/cot"
    if key in ("url", "uri"):
        return "https://example.invalid/sanitized"
    if key in ("query", "search_term"):
        return "sanitized search query"
    if key in ("arguments", "input") and value.lstrip().startswith("{"):
        return _sanitize_json_string(value, cwd=cwd, home=home, redact_text=redact_text)
    if redact_text and key in OUTPUT_TEXT_KEYS:
        return "Sanitized tool output."
    if redact_text and key in TEXT_KEYS:
        return TEXT_KEYS[key]

    out = _scrub_secrets(value)
    if key in PATH_KEYS or _pathish(out):
        out = _scrub_paths(out, cwd=cwd, home=home)
    return out


def _sanitize_key(key: str, *, cwd: Path | None, home: Path) -> str:
    out = _scrub_secrets(key)
    if _pathish(out):
        out = _scrub_paths(out, cwd=cwd, home=home)
    return out


def _sanitize_obj(
    obj: Any,
    *,
    cwd: Path | None,
    home: Path,
    redact_text: bool,
) -> Any:
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for key, value in obj.items():
            if key in DROP_KEYS:
                continue
            out_key = _sanitize_key(str(key), cwd=cwd, home=home)
            if key in ("session_id", "conversation_id") and isinstance(value, str):
                # The caller overwrites fixture-specific session ids after this pass.
                out[out_key] = value
                continue
            if isinstance(value, str):
                out[out_key] = _sanitize_str(key, value, cwd=cwd, home=home, redact_text=redact_text)
            else:
                out[out_key] = _sanitize_obj(value, cwd=cwd, home=home, redact_text=redact_text)
        return out
    if isinstance(obj, list):
        return [_sanitize_obj(item, cwd=cwd, home=home, redact_text=redact_text) for item in obj]
    if isinstance(obj, str):
        return _sanitize_str("", obj, cwd=cwd, home=home, redact_text=redact_text)
    return obj


def _normalize_timestamps(rows: list[dict[str, Any]], *, fill_missing: bool = False) -> list[dict[str, Any]]:
    source_times = [_parse_ts(row.get("timestamp")) for row in rows if row.get("timestamp")]
    source_times = [dt for dt in source_times if dt is not None]
    first = min(source_times) if source_times else None
    out: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        cloned = json.loads(json.dumps(row, ensure_ascii=False))
        ts = _parse_ts(cloned.get("timestamp"))
        if ts is not None and first is not None:
            cloned["timestamp"] = _format_z(BASE_TS + (ts - first))
        elif fill_missing:
            cloned["timestamp"] = _format_z(BASE_TS + timedelta(seconds=index))
        out.append(cloned)
    return out


def _parser_relevant_history_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Preserve the rollout envelope; the bridge decides which rows to ingest."""
    return rows


def _set_session_ids(rows: list[dict[str, Any]], session_id: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        cloned = json.loads(json.dumps(row, ensure_ascii=False))
        if "session_id" in cloned:
            cloned["session_id"] = session_id
        if "conversation_id" in cloned:
            cloned["conversation_id"] = session_id
        out.append(cloned)
    return out


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows),
        encoding="utf-8",
    )


def _update_metadata(selector: str, *, captured_at: str, notes: str) -> None:
    fixture = fixture_from_selector(selector)
    path = fixture.path / "metadata.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    metadata.update(
        {
            "agent_version": metadata.get("agent_version") or "unknown",
            "captured_at": captured_at,
            "notes": notes,
            "platform": "sanitized-local",
            "sanitizer_version": "capture-codex-golden-session-v1",
            "session_id": fixture.session_id,
        }
    )
    path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _capture(args: argparse.Namespace) -> int:
    db_path = Path(args.db).expanduser()
    codex_root = Path(args.codex_root).expanduser()
    live_fixture = fixture_from_selector(args.live_fixture)
    history_fixture = fixture_from_selector(args.history_fixture)

    if args.history_only and args.live_only:
        raise SystemExit("--history-only and --live-only cannot be used together")

    live_rows = [] if args.history_only else _live_payloads(db_path, args.session_id)
    cwd = None
    for row in live_rows:
        raw_cwd = row.get("cwd")
        if isinstance(raw_cwd, str) and raw_cwd:
            cwd = Path(raw_cwd).expanduser()
            break

    rollout_path = None
    if not args.live_only:
        rollout_path = Path(args.history_path).expanduser() if args.history_path else _find_rollout_for_session(
            args.session_id,
            codex_root,
            live_payloads=live_rows,
        )
        if rollout_path is None or not rollout_path.exists():
            raise SystemExit(
                f"Could not find a Codex rollout JSONL for session {args.session_id}. "
                "Pass --history-path explicitly."
            )

    home = Path.home()
    captured_at = _format_z(BASE_TS)

    if not args.history_only:
        sanitized_live = [
            _sanitize_obj(row, cwd=cwd, home=home, redact_text=args.redact_text)
            for row in live_rows
        ]
        sanitized_live = _set_session_ids(
            _normalize_timestamps(sanitized_live, fill_missing=False),
            live_fixture.session_id,
        )
        _write_jsonl(live_fixture.input_path, sanitized_live)
        _update_metadata(
            args.live_fixture,
            captured_at=captured_at,
            notes="Generated from a local Codex live collector session; review input.jsonl before committing.",
        )
        print(f"wrote {live_fixture.input_path.relative_to(REPO)} ({len(sanitized_live)} rows)")

    if not args.live_only:
        assert rollout_path is not None
        history_rows = _read_jsonl(rollout_path)
        if not args.include_non_parser_lines:
            history_rows = _parser_relevant_history_rows(history_rows)
        sanitized_history = [
            _sanitize_obj(row, cwd=cwd, home=home, redact_text=args.redact_text)
            for row in history_rows
        ]
        sanitized_history = _normalize_timestamps(sanitized_history, fill_missing=False)
        _write_jsonl(history_fixture.input_path, sanitized_history)
        _update_metadata(
            args.history_fixture,
            captured_at=captured_at,
            notes="Generated from a local Codex rollout JSONL; review input.jsonl before committing.",
        )
        print(f"wrote {history_fixture.input_path.relative_to(REPO)} ({len(sanitized_history)} rows)")
        print(f"source rollout: {rollout_path}")

    if args.refresh:
        if not args.history_only:
            refresh_snapshot(live_fixture)
            print(f"refreshed {live_fixture.expected_path.relative_to(REPO)}")
        if not args.live_only:
            refresh_snapshot(history_fixture)
            print(f"refreshed {history_fixture.expected_path.relative_to(REPO)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Capture sanitized Codex Golden Session fixture data."
    )
    parser.add_argument("--db", default=str(_default_db_path()), help="Cot SQLite DB path")
    parser.add_argument("--codex-root", default=str(_default_codex_root()), help="Codex home/root directory")
    parser.add_argument("--list", action="store_true", help="List recent Codex session candidates")
    parser.add_argument("--limit", type=int, default=12, help="Candidate rows to list")
    parser.add_argument("--session-id", help="Source Codex session id to capture")
    parser.add_argument("--history-path", help="Explicit rollout JSONL path for history fixture")
    parser.add_argument("--live-fixture", default=LIVE_SELECTOR, help="Live fixture selector")
    parser.add_argument("--history-fixture", default=HISTORY_SELECTOR, help="History fixture selector")
    parser.add_argument("--history-only", action="store_true", help="Only write the rollout history fixture")
    parser.add_argument("--live-only", action="store_true", help="Only write the live hook fixture")
    parser.add_argument("--include-non-parser-lines", action="store_true", help="Keep rollout lines ignored by the current bridge parser")
    parser.add_argument("--redact-text", action="store_true", help="Replace prompt/response/thought/output text with placeholders")
    parser.add_argument("--refresh", action="store_true", help="Refresh expected projection snapshots after writing inputs")
    args = parser.parse_args(argv)

    if args.list:
        return _print_candidates(Path(args.db).expanduser(), Path(args.codex_root).expanduser(), args.limit)
    if not args.session_id:
        parser.error("--session-id is required unless --list is used")
    return _capture(args)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""End-to-end smoke test for the full ingest pipe.

Drives the *real* bridge binary (`bridge/cot hook <agent>`) with canned hook
payloads for Claude, Cursor, and Codex, pointed at a running collector, then
asserts the API surfaces the results. This exercises the whole chain in one
command: bridge stdin parsing -> POST /v1/ingest -> normalize -> db -> the
`/v1/sessions`, session-detail timeline, and `/v1/insights` reads.

Usage:
    python3 scripts/smoke_e2e.py [endpoint]

The endpoint defaults to $COT_ENDPOINT, then http://127.0.0.1:31399 (the
scratch-collector port `just smoke` uses — never the live 31337). Exits
non-zero on the first failed expectation.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BRIDGE = REPO / "bridge" / "cot"

ENDPOINT = (
    (sys.argv[1] if len(sys.argv) > 1 else None)
    or os.environ.get("COT_ENDPOINT")
    or "http://127.0.0.1:31399"
).rstrip("/")

# Canned hook payloads per agent. Kept minimal but representative of a real
# session: a lifecycle open, a prompt, a tool round-trip, and a close.
PAYLOADS: dict[str, list[dict]] = {
    "claude": [
        {"session_id": "SMOKE-claude", "hook_event_name": "SessionStart",
         "source": "startup", "cwd": "/tmp/smoke", "transcript_path": "/tmp/smoke-claude.jsonl"},
        {"session_id": "SMOKE-claude", "hook_event_name": "UserPromptSubmit",
         "prompt": "run the tests", "cwd": "/tmp/smoke"},
        {"session_id": "SMOKE-claude", "hook_event_name": "PreToolUse",
         "tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "cwd": "/tmp/smoke"},
        {"session_id": "SMOKE-claude", "hook_event_name": "PostToolUse",
         "tool_name": "Bash", "tool_input": {"command": "pytest -q"},
         "tool_response": {"stdout": "ok"}, "cwd": "/tmp/smoke"},
        {"session_id": "SMOKE-claude", "hook_event_name": "Stop", "cwd": "/tmp/smoke"},
    ],
    "cursor": [
        {"session_id": "SMOKE-cursor", "hook_event_name": "beforeSubmitPrompt",
         "prompt": "hello from cursor", "cwd": "/tmp/smoke"},
    ],
    "codex": [
        {"session_id": "SMOKE-codex", "hook_event_name": "SessionStart", "cwd": "/tmp/smoke"},
        {"session_id": "SMOKE-codex", "hook_event_name": "UserPromptSubmit",
         "prompt": "hello from codex", "cwd": "/tmp/smoke"},
    ],
}

FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    mark = "ok " if cond else "FAIL"
    print(f"  {mark} {msg}")
    if not cond:
        FAILURES.append(msg)


def _get(path: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(f"{ENDPOINT}{path}", timeout=5) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, {}
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        print(f"  !! GET {path} failed: {exc}", file=sys.stderr)
        return 0, {}


def _drive(agent: str, payload: dict) -> None:
    """Feed one payload to the real bridge exactly as an agent hook would."""
    subprocess.run(
        [sys.executable, str(BRIDGE), "hook", agent],
        input=json.dumps(payload).encode("utf-8"),
        env={**os.environ, "COT_ENDPOINT": ENDPOINT},
        capture_output=True,
        timeout=15,
    )


def _wait_healthy(attempts: int = 30) -> bool:
    for _ in range(attempts):
        status, _ = _get("/health")
        if status == 200:
            return True
        time.sleep(1)
    return False


def _sessions_by_id() -> dict[str, dict]:
    _, body = _get("/v1/sessions?limit=500")
    return {s["id"]: s for s in body.get("sessions", [])}


def main() -> int:
    print(f"cot smoke: endpoint {ENDPOINT}")
    if not BRIDGE.exists():
        print(f"bridge not found at {BRIDGE}", file=sys.stderr)
        return 2
    if not _wait_healthy():
        print(f"collector never became healthy at {ENDPOINT}", file=sys.stderr)
        return 2

    print("driving bridge with canned payloads...")
    for agent, events in PAYLOADS.items():
        for ev in events:
            _drive(agent, ev)

    # Ingest is synchronous, but give async response-emit threads a moment.
    time.sleep(1)

    print("asserting API surfaces the pipe output:")
    sessions = _sessions_by_id()
    check("SMOKE-claude" in sessions, "claude session created")
    check("SMOKE-cursor" in sessions, "cursor session created")
    check("SMOKE-codex" in sessions, "codex session created")

    claude = sessions.get("SMOKE-claude", {})
    check(claude.get("source") == "claude", "claude session tagged source=claude")
    check(claude.get("event_count", 0) >= 4, f"claude has >=4 events (got {claude.get('event_count')})")

    status, detail = _get("/v1/sessions/SMOKE-claude")
    tl = detail.get("timeline") if isinstance(detail, dict) else None
    check(status == 200 and isinstance(tl, list) and len(tl) > 0,
          f"claude timeline non-empty (status {status}, len {len(tl) if isinstance(tl, list) else 'n/a'})")

    status, ins = _get("/v1/insights")
    check(status == 200 and "insights" in ins and "counts" in ins,
          f"insights endpoint returns expected shape (status {status})")

    print()
    if FAILURES:
        print(f"SMOKE FAILED: {len(FAILURES)} check(s) failed")
        return 1
    print("SMOKE PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

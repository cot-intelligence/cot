"""cot plugin for Hermes Agent: forwards observer hooks to the local cot bridge.

Install to ~/.hermes/plugins/cot/ and enable with ``hermes plugins enable cot``.
id: cot.observability

Every callback only queues a payload and returns None, so no hook ever changes
what Hermes does. One worker thread pipes queued payloads into
``~/.cot/bin/cot hook hermes`` in order; the bridge spools when the collector
is down. Stdlib only: this runs inside Hermes's own interpreter.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BRIDGE = os.environ.get("COT_BRIDGE") or str(Path.home() / ".cot" / "bin" / "cot")
_BRIDGE_TIMEOUT_S = 5  # longer than the bridge's own three-second HTTP timeout
_DRAIN_AT_EXIT_S = 3
_MAX_TEXT = 64 * 1024

_queue: queue.Queue[bytes | None] = queue.Queue(maxsize=5000)
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()
# Approval hooks carry a gateway session_key, not a session_id; attribute them
# to the session this process last reported on.
_last_session: str | None = None
# Hermes finalizes session ids that never ran a turn (a startup that failed);
# only end sessions this process has reported on.
_seen: set[str] = set()


def _iso(ts: Any = None) -> str:
    if isinstance(ts, (int, float)) and ts > 0:
        return datetime.fromtimestamp(ts, timezone.utc).isoformat()
    return datetime.now(timezone.utc).isoformat()


def _cwd() -> str:
    # The terminal tool runs in TERMINAL_CWD when set; otherwise Hermes's cwd.
    return os.environ.get("TERMINAL_CWD") or os.getcwd()


def _text(value: Any) -> Any:
    if isinstance(value, str) and len(value) > _MAX_TEXT:
        return value[:_MAX_TEXT] + "\n…[truncated by cot]"
    return value


def _jsonable(value: Any) -> Any:
    try:
        json.dumps(value)
        return _text(value)
    except (TypeError, ValueError):
        return _text(str(value))


def _run() -> None:
    while True:
        body = _queue.get()
        if body is None:
            return
        try:
            subprocess.run(
                [BRIDGE, "hook", "hermes"], input=body, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=_BRIDGE_TIMEOUT_S, check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass  # cot not installed or stalled: never surface into Hermes


def _ensure_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="cot-forwarder", daemon=True)
            _worker.start()


def _drain() -> None:
    deadline = time.monotonic() + _DRAIN_AT_EXIT_S
    while not _queue.empty() and time.monotonic() < deadline:
        time.sleep(0.05)


atexit.register(_drain)


def _send(session_id: Any, hook: str, key: str | None = None, **fields: Any) -> None:
    global _last_session
    sid = str(session_id or _last_session or "")
    if not sid:
        return
    _last_session = sid
    _seen.add(sid)
    payload = {
        "session_id": sid,
        "hook_event_name": hook,
        "origin": "hook",
        "cwd": _cwd(),
        "timestamp": _iso(),
        **{k: _jsonable(v) for k, v in fields.items() if v is not None},
    }
    if key:
        payload["_dedup_key"] = f"hermes:{sid}:{key}"
    try:
        _queue.put_nowait(json.dumps(payload, default=str).encode("utf-8"))
    except queue.Full:
        return
    _ensure_worker()


# --- hook callbacks -----------------------------------------------------------


def _on_session_start(session_id=None, model=None, platform=None, **kw):
    _send(session_id, "SessionStart", "session", model=model, platform=platform)


def _on_pre_llm_call(session_id=None, user_message=None, turn_id=None, model=None, platform=None, **kw):
    if isinstance(user_message, str) and user_message.strip():
        _send(session_id, "UserPromptSubmit", f"prompt:{turn_id}" if turn_id else None,
              prompt=user_message, model=model, turn_id=turn_id, platform=platform)


def _result_status(result: Any) -> str | None:
    # A command the approval gate refused reports status "error"; its result
    # says "blocked".
    if isinstance(result, str) and result.startswith("{"):
        try:
            parsed = json.loads(result)
        except ValueError:
            return None
        if isinstance(parsed, dict) and isinstance(parsed.get("status"), str):
            return parsed["status"]
    return None


def _on_post_tool_call(tool_name=None, args=None, result=None, session_id=None, tool_call_id=None,
                       turn_id=None, duration_ms=None, status=None, error_type=None,
                       error_message=None, **kw):
    if _result_status(result) == "blocked":
        status = "blocked"
    failed = status in ("error", "blocked", "cancelled")
    _send(session_id, "PostToolUseFailure" if failed else "PostToolUse",
          f"tool:end:{tool_call_id}" if tool_call_id else None,
          tool_name=tool_name, tool_input=args if isinstance(args, dict) else {"args": args},
          tool_response=error_message if failed and error_message else result,
          tool_use_id=tool_call_id, turn_id=turn_id, duration_ms=duration_ms,
          tool_status=status, error_type=error_type)


def _on_post_llm_call(session_id=None, assistant_response=None, turn_id=None, model=None, **kw):
    if isinstance(assistant_response, str) and assistant_response.strip():
        _send(session_id, "afterAgentResponse", f"response:{turn_id}" if turn_id else None,
              response=assistant_response, model=model, turn_id=turn_id)


def _on_interim_message(session_id=None, text=None, turn_id=None, iteration=None, model=None, **kw):
    # Assistant text written alongside tool calls, before the turn's final answer.
    if isinstance(text, str) and text.strip():
        _send(session_id, "afterAgentResponse", f"interim:{turn_id}:{iteration}" if turn_id else None,
              response=text, model=model, turn_id=turn_id)


def _on_post_api_request(session_id=None, api_request_id=None, model=None, response_model=None,
                         usage=None, api_duration=None, finish_reason=None, turn_id=None,
                         response=None, **kw):
    message = response.get("assistant_message") if isinstance(response, dict) else None
    thought = None
    if isinstance(message, dict):
        thought = message.get("reasoning") or message.get("reasoning_content")
    if isinstance(thought, str) and thought.strip():
        _send(session_id, "afterAgentThought", f"thought:{api_request_id}" if api_request_id else None,
              thought=thought, model=response_model or model, turn_id=turn_id)
    if not isinstance(usage, dict):
        return
    tokens = {
        "input_tokens": usage.get("input_tokens") or 0,
        "output_tokens": usage.get("output_tokens") or 0,
        "cache_read_tokens": usage.get("cache_read_tokens") or 0,
        "cache_write_tokens": usage.get("cache_write_tokens") or 0,
        "reasoning_tokens": usage.get("reasoning_tokens") or 0,
    }
    _send(session_id, "ModelUsage", f"usage:{api_request_id}" if api_request_id else None,
          model=response_model or model, usage=tokens, finish_reason=finish_reason, turn_id=turn_id,
          duration_ms=int(api_duration * 1000) if isinstance(api_duration, (int, float)) else None)


def _on_subagent_start(parent_session_id=None, child_session_id=None, child_role=None,
                       child_goal=None, **kw):
    _send(parent_session_id, "SubagentStart", f"subagent:start:{child_session_id}",
          subagent_id=child_session_id, subagent_type=child_role, description=child_goal)
    _send(child_session_id, "SessionStart", "session", parent_session_id=parent_session_id,
          session_title=child_goal)


def _on_subagent_stop(parent_session_id=None, child_session_id=None, child_role=None,
                      child_status=None, child_summary=None, duration_ms=None, **kw):
    _send(parent_session_id, "SubagentStop", f"subagent:stop:{child_session_id}",
          subagent_id=child_session_id, subagent_type=child_role, status=child_status,
          summary=child_summary, duration_ms=duration_ms)
    # Hermes never finalizes a delegated child session; its return ends it.
    if child_session_id:
        _send(child_session_id, "SessionEnd", "session:end", reason=child_status)


def _on_post_compaction(session_id=None, kind=None, reason=None, before_tokens=None,
                        after_tokens=None, messages_removed=None, **kw):
    _send(session_id, "PostCompact", None, kind=kind, reason=reason, before_tokens=before_tokens,
          after_tokens=after_tokens, messages_removed=messages_removed)


def _on_pre_approval_request(command=None, description=None, pattern_key=None, surface=None, **kw):
    _send(None, "PermissionRequest", None, tool_name="terminal",
          tool_input={"command": command}, description=description,
          pattern_key=pattern_key, surface=surface)


def _on_session_end(session_id=None, completed=None, interrupted=None, failed=None,
                    turn_exit_reason=None, model=None, turn_id=None, **kw):
    # Fires at the end of every turn, not once per session.
    _send(session_id, "Stop", f"stop:{turn_id}" if turn_id else None, completed=completed,
          interrupted=interrupted or None, error=turn_exit_reason if failed else None,
          turn_exit_reason=turn_exit_reason, model=model)


def _on_session_finalize(session_id=None, reason=None, **kw):
    if session_id and str(session_id) in _seen:
        _send(session_id, "SessionEnd", "session:end", reason=reason)


HOOKS = {
    "on_session_start": _on_session_start,
    "pre_llm_call": _on_pre_llm_call,
    "post_tool_call": _on_post_tool_call,
    "post_llm_call": _on_post_llm_call,
    "on_interim_message": _on_interim_message,
    "post_api_request": _on_post_api_request,
    "subagent_start": _on_subagent_start,
    "subagent_stop": _on_subagent_stop,
    "post_compaction": _on_post_compaction,
    "pre_approval_request": _on_pre_approval_request,
    "on_session_end": _on_session_end,
    "on_session_finalize": _on_session_finalize,
}


def _guard(fn):
    def callback(*args: Any, **kwargs: Any) -> None:
        try:
            fn(**kwargs)
        except Exception:  # noqa: BLE001 - observability must never break the agent
            pass
        return None
    callback.__name__ = fn.__name__
    return callback


def register(ctx) -> None:
    for name, fn in HOOKS.items():
        ctx.register_hook(name, _guard(fn))

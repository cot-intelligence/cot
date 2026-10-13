"""OTLP/HTTP ingest: spans and log events from agents cot has no hook for."""

from __future__ import annotations

import gzip
import json
import struct

from fastapi.testclient import TestClient

from app import db, main, otlp, store

NS = 1_791_900_000_000_000_000  # 2026-10-13


# --- a minimal protobuf encoder, enough to build OTLP requests ------------------


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _ld(num: int, payload: bytes) -> bytes:
    return _varint(num << 3 | 2) + _varint(len(payload)) + payload


def _fixed64(num: int, n: int) -> bytes:
    return _varint(num << 3 | 1) + struct.pack("<Q", n)


def _vint(num: int, n: int) -> bytes:
    return _varint(num << 3) + _varint(n & 0xFFFFFFFFFFFFFFFF)


def _any(v) -> bytes:
    if isinstance(v, bool):
        return _vint(2, int(v))
    if isinstance(v, int):
        return _vint(3, v)
    if isinstance(v, float):
        return _fixed64(4, struct.unpack("<Q", struct.pack("<d", v))[0])
    return _ld(1, str(v).encode())


def _kv(k: str, v) -> bytes:
    return _ld(1, k.encode()) + _ld(2, _any(v))


def _resource(service: str) -> bytes:
    """Resource message: its attributes."""
    return _ld(1, _kv("service.name", service))


def _span(name: str, attrs: dict, *, trace=b"\x01" * 16, span=b"\x02" * 8, start=NS, end=NS + 2_000_000, error=False) -> bytes:
    body = _ld(1, trace) + _ld(2, span) + _ld(5, name.encode()) + _fixed64(7, start) + _fixed64(8, end)
    body += b"".join(_ld(9, _kv(k, v)) for k, v in attrs.items())
    if error:
        body += _ld(15, _ld(2, b"boom") + _vint(3, 2))
    return body


def _traces(service: str, *spans: bytes) -> bytes:
    scope = _ld(1, _ld(1, b"test")) + b"".join(_ld(2, s) for s in spans)
    return _ld(1, _ld(1, _resource(service)) + _ld(2, scope))


def _log(event: str, attrs: dict, t: int = NS) -> bytes:
    body = _fixed64(1, t) + _ld(5, _any(event)) + b"".join(_ld(6, _kv(k, v)) for k, v in attrs.items())
    return body


def _logs(service: str, *records: bytes) -> bytes:
    scope = _ld(1, _ld(1, b"test")) + b"".join(_ld(2, r) for r in records)
    return _ld(1, _ld(1, _resource(service)) + _ld(2, scope))


def _client() -> TestClient:
    return TestClient(main.app, base_url="http://127.0.0.1")


def _events(sid: str) -> list[dict]:
    with store.read() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT e.*, s.source AS session_source FROM events e JOIN sessions s ON s.id = e.session_id"
            " WHERE e.session_id = ? ORDER BY e.ts, e.id",
            (sid,),
        )]


# --- decoding -------------------------------------------------------------------


def test_protobuf_and_json_decode_to_the_same_records():
    pb = _traces("gemini-cli", _span("execute_tool run_shell_command", {
        "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "run_shell_command",
        "gen_ai.conversation.id": "conv-1", "n": -3, "ok": True, "ratio": 0.5,
    }))
    js = json.dumps({"resourceSpans": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "gemini-cli"}}]},
        "scopeSpans": [{"scope": {"name": "test"}, "spans": [{
            "traceId": "01" * 16, "spanId": "02" * 8, "name": "execute_tool run_shell_command",
            "startTimeUnixNano": str(NS), "endTimeUnixNano": str(NS + 2_000_000),
            "attributes": [
                {"key": "gen_ai.operation.name", "value": {"stringValue": "execute_tool"}},
                {"key": "gen_ai.tool.name", "value": {"stringValue": "run_shell_command"}},
                {"key": "gen_ai.conversation.id", "value": {"stringValue": "conv-1"}},
                {"key": "n", "value": {"intValue": "-3"}},
                {"key": "ok", "value": {"boolValue": True}},
                {"key": "ratio", "value": {"doubleValue": 0.5}},
            ],
        }]}],
    }]}).encode()
    a = otlp.decode(pb, "application/x-protobuf", None, "traces")
    b = otlp.decode(js, "application/json", None, "traces")
    assert a == b
    assert a[0]["attrs"]["n"] == -3 and a[0]["attrs"]["ok"] is True and a[0]["attrs"]["ratio"] == 0.5
    assert a[0]["resource"]["service.name"] == "gemini-cli"
    assert otlp.decode(gzip.compress(pb), "application/x-protobuf", "gzip", "traces") == a


def test_garbage_is_a_400_not_a_crash(fresh_db):
    r = _client().post("/v1/traces", content=b"\x0a\xff\xff", headers={"content-type": "application/x-protobuf"})
    assert r.status_code == 400


# --- mapping --------------------------------------------------------------------


def test_claude_code_log_events_become_a_session(fresh_db):
    req = _logs(
        "claude-code",
        _log("claude_code.user_prompt", {"session.id": "cc-1", "prompt": "fix the build", "prompt_length": 13}, NS),
        _log("claude_code.api_request", {
            "session.id": "cc-1", "model": "claude-sonnet-4-5", "input_tokens": 12, "output_tokens": 300,
            "cache_read_tokens": 40_000, "cache_creation_tokens": 900, "cost_usd": 0.02, "duration_ms": 1800,
        }, NS + 1_000_000_000),
        _log("claude_code.tool_result", {
            "session.id": "cc-1", "tool_name": "Bash", "success": "false", "duration_ms": 420,
            "tool_parameters": json.dumps({"command": "npm run build"}), "error": "exit 1",
        }, NS + 2_000_000_000),
        _log("claude_code.tool_decision", {"session.id": "cc-1", "tool_name": "Bash", "decision": "accept"}, NS + 3),
    )
    r = _client().post("/v1/logs", content=req, headers={"content-type": "application/x-protobuf"})
    assert r.status_code == 200 and r.content == b""

    events = _events("cc-1")
    # The decision event is not one cot keeps.
    assert [e["category"] for e in events] == ["prompt", "lifecycle", "shell"]
    assert events[0]["session_source"] == "claude"
    assert events[0]["detail"] == "fix the build"
    usage = events[1]
    assert usage["model"] == "claude-sonnet-4-5"
    assert (usage["input_tokens"], usage["output_tokens"], usage["cache_read_tokens"], usage["cache_write_tokens"]) == (12, 300, 40_000, 900)
    tool = events[2]
    assert tool["status"] == "error" and tool["target"] == "npm run build" and tool["duration_ms"] == 420

    # A retried export is not stored twice.
    _client().post("/v1/logs", content=req, headers={"content-type": "application/x-protobuf"})
    assert len(_events("cc-1")) == 3
    summary = db.list_sessions_page()[0][0]
    assert summary["tokens"]["total"] == 12 + 300 + 40_000 + 900


def test_genai_spans_from_an_unknown_agent_keep_its_name(fresh_db):
    req = _traces(
        "github-copilot",
        _span("chat gpt-5", {
            "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5", "gen_ai.conversation.id": "cp-1",
            "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 50,
        }, span=b"\x03" * 8),
        _span("invoke_agent copilot", {
            "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": "cp-1",
            "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 50,
        }, span=b"\x04" * 8),
        _span("execute_tool read_file", {
            "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read_file", "gen_ai.conversation.id": "cp-1",
            "gen_ai.tool.call.arguments": json.dumps({"path": "src/a.ts"}),
        }, span=b"\x05" * 8, start=NS + 5_000_000, end=NS + 9_000_000, error=True),
        _span("some internal span", {"gen_ai.conversation.id": "cp-1"}, span=b"\x06" * 8),
    )
    r = _client().post("/v1/traces", content=req, headers={"content-type": "application/x-protobuf"})
    assert r.status_code == 200

    events = _events("cp-1")
    assert {e["session_source"] for e in events} == {"github-copilot"}
    # invoke_agent rolls up its chat spans, so only the chat span's tokens count.
    assert sum(e["input_tokens"] or 0 for e in events) == 1000
    # Agent tool names map onto the ones cot classifies.
    tool = next(e for e in events if e["tool"] == "Read")
    assert tool["category"] == "file_read" and tool["target"] == "src/a.ts"
    assert tool["status"] == "error" and tool["duration_ms"] == 4


def test_json_body_gets_a_json_reply_and_metrics_are_accepted(fresh_db):
    doc = {"resourceLogs": [{
        "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "codex_cli_rs"}}]},
        "scopeLogs": [{"logRecords": [{
            "timeUnixNano": str(NS), "body": {"stringValue": "codex.user_prompt"},
            "attributes": [
                {"key": "conversation.id", "value": {"stringValue": "cx-1"}},
                {"key": "prompt_length", "value": {"intValue": "42"}},
            ],
        }]}],
    }]}
    r = _client().post("/v1/logs", json=doc)
    assert r.status_code == 200 and r.json() == {}
    [event] = _events("cx-1")
    assert event["session_source"] == "codex"
    # Prompt text redacted at the source: say so instead of storing nothing.
    assert event["detail"] == "[prompt not exported, 42 chars]"
    assert _client().post("/v1/metrics", content=b"\x00", headers={"content-type": "application/x-protobuf"}).status_code == 200


def test_a_busy_db_asks_the_exporter_to_retry(fresh_db, monkeypatch):
    import sqlite3

    def locked(records):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(main, "_ingest_otlp", locked)
    req = _logs("claude-code", _log("claude_code.user_prompt", {"session.id": "x"}))
    r = _client().post("/v1/logs", content=req, headers={"content-type": "application/x-protobuf"})
    assert r.status_code == 503 and r.headers["retry-after"] == "2"

"""OpenTelemetry (OTLP/HTTP) ingest for agents cot has no hook or plugin for.

Point an agent's exporter at the collector
(``OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:31337``) and its spans and log
events arrive on ``/v1/traces`` and ``/v1/logs``, JSON or protobuf, optionally
gzipped. Metrics are accepted and dropped: the events carry the same numbers
per request.

Three kinds of record become cot events; everything else is acknowledged and
skipped:

* a **prompt**: ``*.user_prompt`` log events (Claude Code, Codex, Gemini CLI)
* a **tool call**: ``*.tool_result`` / ``*.tool_call`` log events, or a
  GenAI ``execute_tool`` span
* **model usage**: ``*.api_request`` / ``*.api_response`` log events, Codex's
  completed ``sse_event``, or a GenAI span with ``gen_ai.usage.*`` tokens

Each becomes the same hook-shaped body the bridge posts, so it is stored,
categorized and counted the same way. Span and record ids make the dedup key,
so a retried export is not stored twice. Most agents redact prompt and tool
content in OTel unless told otherwise; what arrives is what is stored. Hooks
stay the full-content path: export OTel from an agent cot already hooks and its
events count twice.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
import struct
from datetime import datetime, timezone
from typing import Any, Iterator

MAX_BODY_BYTES = 20 * 1024 * 1024
MAX_INFLATED_BYTES = 64 * 1024 * 1024

# service.name values of agents cot also knows natively.
_KNOWN_SERVICES = {
    "claude-code": "claude",
    "claude_code": "claude",
    "codex": "codex",
    "codex_cli_rs": "codex",
    "codex-cli": "codex",
    "codex_exec": "codex",
    "opencode": "opencode",
}


# Tool names OTel-only agents use, as the tool cot's classifier knows, with the
# input keys to copy across (theirs -> Claude Code's). Gemini CLI first, then
# Copilot in VS Code; anything else is stored under its own name.
_TOOLS: dict[str, tuple[str, dict[str, str]]] = {
    "run_shell_command": ("Bash", {"command": "command"}),
    "read_file": ("Read", {"absolute_path": "file_path", "filePath": "file_path", "path": "file_path"}),
    "write_file": ("Write", {"file_path": "file_path", "absolute_path": "file_path"}),
    "replace": ("Edit", {"file_path": "file_path", "absolute_path": "file_path"}),
    "glob": ("Glob", {"pattern": "pattern"}),
    "search_file_content": ("Grep", {"pattern": "pattern"}),
    "web_fetch": ("WebFetch", {"url": "url", "prompt": "prompt"}),
    "google_web_search": ("WebSearch", {"query": "query"}),
    "run_in_terminal": ("Bash", {"command": "command"}),
    "create_file": ("Write", {"filePath": "file_path"}),
    "replace_string_in_file": ("Edit", {"filePath": "file_path"}),
    "grep_search": ("Grep", {"query": "pattern"}),
    "file_search": ("Glob", {"query": "pattern"}),
}


def _tool(name: str, args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    known = _TOOLS.get(name)
    if known is None:
        return name, args
    canonical, keys = known
    out = dict(args)
    for theirs, ours in keys.items():
        if theirs in args and ours not in out:
            out[ours] = args[theirs]
    return canonical, out


# --- Protobuf wire format -------------------------------------------------------


class ProtobufError(ValueError):
    pass


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = 0
    out = 0
    while True:
        if i >= len(buf):
            raise ProtobufError("truncated varint")
        b = buf[i]
        i += 1
        out |= (b & 0x7F) << shift
        if not b & 0x80:
            return out, i
        shift += 7
        if shift > 63:
            raise ProtobufError("varint too long")


def _fields(buf: bytes) -> Iterator[tuple[int, int, Any]]:
    """(field number, wire type, value) for each field in a message. Length-
    delimited values are bytes; varints and fixed widths are ints."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            val, i = _varint(buf, i)
        elif wt == 1:
            if i + 8 > len(buf):
                raise ProtobufError("truncated fixed64")
            val = struct.unpack_from("<Q", buf, i)[0]
            i += 8
        elif wt == 2:
            n, i = _varint(buf, i)
            if i + n > len(buf):
                raise ProtobufError("truncated bytes")
            val = buf[i:i + n]
            i += n
        elif wt == 5:
            if i + 4 > len(buf):
                raise ProtobufError("truncated fixed32")
            val = struct.unpack_from("<I", buf, i)[0]
            i += 4
        else:
            raise ProtobufError(f"unsupported wire type {wt}")
        yield num, wt, val


def _pb_any(buf: bytes) -> Any:
    for num, _wt, val in _fields(buf):
        if num == 1:
            return val.decode("utf-8", errors="replace")
        if num == 2:
            return bool(val)
        if num == 3:
            return val - (1 << 64) if val >= 1 << 63 else val
        if num == 4:
            return struct.unpack("<d", struct.pack("<Q", val))[0]
        if num == 5:
            return [_pb_any(v) for n, _w, v in _fields(val) if n == 1]
        if num == 6:
            return _pb_attrs([v for n, _w, v in _fields(val) if n == 1])
        if num == 7:
            return val.hex()
    return None


def _pb_attrs(kvs: list[bytes]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for kv in kvs:
        key, value = None, None
        for num, _wt, val in _fields(kv):
            if num == 1:
                key = val.decode("utf-8", errors="replace")
            elif num == 2:
                value = _pb_any(val)
        if key is not None:
            out[key] = value
    return out


def _pb_resource(buf: bytes) -> dict[str, Any]:
    return _pb_attrs([v for n, _w, v in _fields(buf) if n == 1])


def _pb_scope_name(buf: bytes) -> str | None:
    for num, _wt, val in _fields(buf):
        if num == 1:
            return val.decode("utf-8", errors="replace")
    return None


def _pb_span(buf: bytes) -> dict[str, Any]:
    span: dict[str, Any] = {"kind": "span", "attrs": {}}
    attrs: list[bytes] = []
    for num, _wt, val in _fields(buf):
        if num == 1:
            span["trace_id"] = val.hex()
        elif num == 2:
            span["span_id"] = val.hex()
        elif num == 5:
            span["name"] = val.decode("utf-8", errors="replace")
        elif num == 7:
            span["start_ns"] = val
        elif num == 8:
            span["end_ns"] = val
        elif num == 9:
            attrs.append(val)
        elif num == 15:
            for n, _w, v in _fields(val):
                if n == 2:
                    span["status_message"] = v.decode("utf-8", errors="replace")
                elif n == 3:
                    span["status_code"] = v
    span["attrs"] = _pb_attrs(attrs)
    return span


def _pb_log(buf: bytes) -> dict[str, Any]:
    rec: dict[str, Any] = {"kind": "log"}
    attrs: list[bytes] = []
    for num, _wt, val in _fields(buf):
        if num == 1:
            rec["start_ns"] = val
        elif num == 11:
            rec.setdefault("observed_ns", val)
        elif num == 5:
            rec["body"] = _pb_any(val)
        elif num == 6:
            attrs.append(val)
        elif num == 9:
            rec["trace_id"] = val.hex()
        elif num == 10:
            rec["span_id"] = val.hex()
        elif num == 12:
            rec["name"] = val.decode("utf-8", errors="replace")
    rec["attrs"] = _pb_attrs(attrs)
    return rec


def _pb_records(buf: bytes, signal: str) -> list[dict[str, Any]]:
    """ExportTraceServiceRequest / ExportLogsServiceRequest into flat records."""
    out: list[dict[str, Any]] = []
    for num, _wt, rs in _fields(buf):
        if num != 1:
            continue
        resource: dict[str, Any] = {}
        scopes: list[bytes] = []
        for n, _w, v in _fields(rs):
            if n == 1:
                resource = _pb_resource(v)
            elif n == 2:
                scopes.append(v)
        for scope_buf in scopes:
            scope = None
            for n, _w, v in _fields(scope_buf):
                if n == 1:
                    scope = _pb_scope_name(v)
                elif n == 2:
                    rec = _pb_span(v) if signal == "traces" else _pb_log(v)
                    out.append({**rec, "resource": resource, "scope": scope})
    return out


# --- OTLP/JSON ------------------------------------------------------------------


def _get(obj: dict[str, Any], camel: str) -> Any:
    """OTLP/JSON is camelCase; some exporters write snake_case."""
    if camel in obj:
        return obj[camel]
    return obj.get(re.sub(r"(?<!^)(?=[A-Z])", "_", camel).lower())


def _js_any(v: Any) -> Any:
    if not isinstance(v, dict):
        return v
    for k in ("stringValue", "string_value"):
        if k in v:
            return v[k]
    for k in ("boolValue", "bool_value"):
        if k in v:
            return bool(v[k])
    for k in ("intValue", "int_value"):
        if k in v:
            try:
                return int(v[k])
            except (TypeError, ValueError):
                return v[k]
    for k in ("doubleValue", "double_value"):
        if k in v:
            return float(v[k])
    arr = _get(v, "arrayValue")
    if isinstance(arr, dict):
        return [_js_any(x) for x in arr.get("values") or []]
    kvl = _get(v, "kvlistValue")
    if isinstance(kvl, dict):
        return _js_attrs(kvl.get("values") or [])
    b = _get(v, "bytesValue")
    if b is not None:
        return b
    return None


def _js_attrs(kvs: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for kv in kvs or []:
        if isinstance(kv, dict) and "key" in kv:
            out[str(kv["key"])] = _js_any(kv.get("value"))
    return out


def _js_int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _js_id(v: Any) -> str | None:
    # OTLP/JSON ids are hex strings; tolerate empty ones.
    return str(v).lower() if v else None


def _js_records(doc: dict[str, Any], signal: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    top = "resourceSpans" if signal == "traces" else "resourceLogs"
    inner = "scopeSpans" if signal == "traces" else "scopeLogs"
    leaf = "spans" if signal == "traces" else "logRecords"
    for rs in _get(doc, top) or []:
        if not isinstance(rs, dict):
            continue
        resource = _js_attrs((_get(rs, "resource") or {}).get("attributes"))
        for ss in _get(rs, inner) or []:
            if not isinstance(ss, dict):
                continue
            scope = (_get(ss, "scope") or {}).get("name")
            for r in _get(ss, leaf) or []:
                if not isinstance(r, dict):
                    continue
                rec: dict[str, Any] = {
                    "kind": "span" if signal == "traces" else "log",
                    "resource": resource,
                    "scope": scope,
                    "attrs": _js_attrs(r.get("attributes")),
                    "trace_id": _js_id(_get(r, "traceId")),
                    "span_id": _js_id(_get(r, "spanId")),
                }
                if signal == "traces":
                    status = r.get("status") or {}
                    rec.update({
                        "name": r.get("name"),
                        "start_ns": _js_int(_get(r, "startTimeUnixNano")),
                        "end_ns": _js_int(_get(r, "endTimeUnixNano")),
                        "status_code": _js_int(status.get("code")) if not isinstance(status.get("code"), str)
                        else {"STATUS_CODE_OK": 1, "STATUS_CODE_ERROR": 2}.get(status.get("code"), 0),
                        "status_message": status.get("message"),
                    })
                    for k in ("status_code", "status_message"):
                        if not rec[k]:
                            del rec[k]  # unset, as in a protobuf body
                else:
                    rec.update({
                        "name": _get(r, "eventName"),
                        "start_ns": _js_int(_get(r, "timeUnixNano")) or None,
                        "observed_ns": _js_int(_get(r, "observedTimeUnixNano")),
                        "body": _js_any(r.get("body")),
                    })
                out.append(rec)
    return out


# --- Decoding -------------------------------------------------------------------


def decode(body: bytes, content_type: str | None, content_encoding: str | None, signal: str) -> list[dict[str, Any]]:
    """An OTLP/HTTP request body into flat records. Raises ValueError when it
    cannot be read."""
    if (content_encoding or "").lower() == "gzip" or body[:2] == b"\x1f\x8b":
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(body)) as gz:
                body = gz.read(MAX_INFLATED_BYTES + 1)
        except OSError as exc:
            raise ValueError(f"bad gzip body: {exc}") from exc
        if len(body) > MAX_INFLATED_BYTES:
            raise ValueError("body too large once inflated")
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype == "application/json" or (not ctype and body[:1] in (b"{", b"[")):
        try:
            doc = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"bad JSON body: {exc}") from exc
        return _js_records(doc if isinstance(doc, dict) else {}, signal)
    return _pb_records(body, signal)


# --- Mapping to cot events ------------------------------------------------------


def _source(resource: dict[str, Any]) -> str:
    name = str(resource.get("service.name") or "").strip().lower()
    if name in _KNOWN_SERVICES:
        return _KNOWN_SERVICES[name]
    slug = re.sub(r"[^a-z0-9]+", "-", name).strip("-")[:40]
    return slug if slug and slug != "unknown-service" else "otel"


def _event_name(rec: dict[str, Any]) -> str:
    attrs = rec["attrs"]
    name = rec.get("name") or attrs.get("event.name")
    if not name and isinstance(rec.get("body"), str):
        name = rec["body"]
    return str(name or "")


def _first(attrs: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = attrs.get(k)
        if v not in (None, ""):
            return v
    return None


def _int(v: Any) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _iso(ns: int | None) -> str | None:
    if not ns:
        return None
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).isoformat()


def _truthy(v: Any) -> bool | None:
    if isinstance(v, bool):
        return v
    if v is None:
        return None
    return str(v).strip().lower() in ("1", "true", "yes", "ok", "success")


def _json_arg(v: Any) -> dict[str, Any]:
    if isinstance(v, dict):
        return v
    if isinstance(v, str) and v.strip().startswith("{"):
        try:
            parsed = json.loads(v)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _usage(attrs: dict[str, Any]) -> dict[str, int] | None:
    usage = {
        "input_tokens": _int(_first(attrs, "gen_ai.usage.input_tokens", "input_tokens", "input_token_count")),
        "output_tokens": _int(_first(attrs, "gen_ai.usage.output_tokens", "output_tokens", "output_token_count")),
        "cache_read_input_tokens": _int(_first(
            attrs, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_input_tokens",
            "cache_read_tokens", "cached_content_token_count", "cached_token_count",
        )),
        "cache_creation_input_tokens": _int(_first(
            attrs, "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_creation_input_tokens",
            "cache_creation_tokens",
        )),
    }
    usage = {k: v for k, v in usage.items() if v}
    return usage or None


def _kind(rec: dict[str, Any], name: str) -> str | None:
    attrs = rec["attrs"]
    op = str(attrs.get("gen_ai.operation.name") or "").lower()
    short = name.rsplit(".", 1)[-1].lower()
    if short in ("user_prompt",):
        return "prompt"
    if short in ("tool_result", "tool_call") or op == "execute_tool":
        return "tool"
    if short in ("api_request", "api_response") or (
        short == "sse_event" and str(attrs.get("event.kind") or "") == "response.completed"
    ):
        return "usage"
    # Not invoke_agent: an agent span rolls up its chat spans' usage.
    if rec["kind"] == "span" and _usage(attrs) and op in ("", "chat", "text_completion", "generate_content", "embeddings"):
        return "usage"
    return None


def to_bodies(records: list[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    """(source, hook-shaped body) for every record cot keeps, oldest first."""
    out: list[tuple[int, str, dict[str, Any]]] = []
    for rec in records:
        attrs = {**rec.get("attrs", {})}
        name = _event_name(rec)
        kind = _kind(rec, name)
        if kind is None:
            continue
        resource = rec.get("resource") or {}
        source = _source(resource)
        sid = _first(attrs, "session.id", "gen_ai.conversation.id", "conversation.id", "thread.id") or rec.get("trace_id") or "otel-unknown"
        start_ns = rec.get("start_ns") or rec.get("observed_ns") or 0
        ts = _first(attrs, "event.timestamp") or _iso(start_ns)
        rid = f"{rec.get('trace_id') or ''}:{rec.get('span_id') or ''}"
        if rid == ":":
            # Logs without span context: the record itself is its identity.
            rid = hashlib.sha1(
                json.dumps([name, start_ns, attrs], sort_keys=True, default=str).encode(), usedforsecurity=False
            ).hexdigest()
        body: dict[str, Any] = {
            "session_id": str(sid),
            "timestamp": ts,
            "cwd": _first(attrs, "cwd", "process.cwd", "workspace.path") or resource.get("process.cwd"),
            "_otel": {"service": resource.get("service.name"), "name": name, "scope": rec.get("scope")},
            "_dedup_key": f"otel:{kind}:{rid}",
        }
        model = _first(attrs, "gen_ai.response.model", "gen_ai.request.model", "model")
        if model:
            body["model"] = str(model)
        if kind == "prompt":
            text = _first(attrs, "prompt", "gen_ai.prompt")
            length = _first(attrs, "prompt_length")
            body.update({
                "hook_event_name": "UserPromptSubmit",
                "prompt": text if text else f"[prompt not exported{f', {length} chars' if length else ''}]",
            })
        elif kind == "tool":
            ok = _truthy(_first(attrs, "success"))
            failed = ok is False or rec.get("status_code") == 2 or bool(_first(attrs, "error", "error.type"))
            duration = _int(_first(attrs, "duration_ms"))
            if duration is None and rec.get("end_ns") and rec.get("start_ns"):
                duration = int((rec["end_ns"] - rec["start_ns"]) / 1e6)
            tool_name, tool_input = _tool(
                str(_first(attrs, "gen_ai.tool.name", "tool_name", "function_name", "tool.name") or rec.get("name") or "tool"),
                _json_arg(_first(attrs, "gen_ai.tool.call.arguments", "tool_parameters", "function_args", "arguments", "tool_input")),
            )
            body.update({
                "hook_event_name": "PostToolUseFailure" if failed else "PostToolUse",
                "tool_name": tool_name,
                "tool_input": tool_input,
                "tool_response": _first(attrs, "gen_ai.tool.call.result", "output", "tool_result", "error") or "",
                "duration_ms": duration,
            })
            error = _first(attrs, "error", "error.type") or rec.get("status_message")
            if failed and error:
                body["error"] = error
        else:
            body.update({
                "hook_event_name": "ModelUsage",
                "usage": _usage(attrs) or {},
                "duration_ms": _int(_first(attrs, "duration_ms")),
            })
            cost = _first(attrs, "cost_usd")
            if cost is not None:
                body["reported_cost_usd"] = cost
        out.append((start_ns, source, body))
    out.sort(key=lambda t: t[0])
    return [(src, body) for _ns, src, body in out]

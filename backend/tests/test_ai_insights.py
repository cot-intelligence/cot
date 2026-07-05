"""Tests for the BYOK AI-insights layer (app/ai_insights.py).

Covers outbound masking + payload caps, provider request shaping (urlopen
patched by hand), env-key precedence, run_analysis persistence, endpoint
error mapping, and that /v1/settings never leaks the raw key.

Runnable with pytest or directly: ``python3 backend/tests/test_ai_insights.py``.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_TMP = tempfile.mkdtemp(prefix="cot-ai-insights-test-")

sys.path.insert(0, _BACKEND)
os.environ["COT_DB_PATH"] = os.path.join(_TMP, "bootstrap.db")

from datetime import datetime, timedelta, timezone  # noqa: E402

from app import ai_insights, db, main  # noqa: E402

_NOW = datetime.now(timezone.utc)

FAKE_ANT_KEY = "sk-ant-" + "a1B2" * 8  # matches the Anthropic secret pattern
FAKE_OAI_KEY = "sk-" + "z9Y8" * 10


def _ts(minutes_ago: float = 0.0, days_ago: float = 0.0) -> str:
    return (_NOW - timedelta(minutes=minutes_ago, days=days_ago)).isoformat()


_case_counter = 0


def _fresh_db() -> None:
    global _case_counter
    _case_counter += 1
    os.environ["COT_DB_PATH"] = os.path.join(_TMP, f"case{_case_counter}.db")
    db.init_db()
    for var in ("COT_ANTHROPIC_API_KEY", "COT_OPENAI_API_KEY", "COT_DISABLE_LLM"):
        os.environ.pop(var, None)


def _session(sid: str) -> None:
    with db._connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, source, cwd, started_at, status,"
            " archived, created_at) VALUES (?, 'claude', '/proj', ?, 'active', 0, ?)",
            (sid, _ts(days_ago=1), db._now()),
        )


def _event(sid: str, *, category: str, detail: str | None = None,
           ts: str | None = None) -> int:
    _session(sid)
    with db._connect() as conn:
        cur = conn.execute(
            "INSERT INTO events (session_id, source, hook, tool, phase, ts, category,"
            " detail, created_at) VALUES (?, 'claude', 'Stop', NULL, 'end', ?, ?, ?, ?)",
            (sid, ts or _ts(), category, detail, db._now()),
        )
        return cur.lastrowid


class _FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _patch_urlopen(response_body: dict, capture: list) -> object:
    """Replace urllib.request.urlopen with a capturing fake; returns original."""
    original = urllib.request.urlopen

    def fake(req, timeout=None):
        capture.append(req)
        return _FakeResponse(json.dumps(response_body).encode("utf-8"))

    urllib.request.urlopen = fake
    return original


_ANALYSIS_JSON = {
    "summary": "Agents are busy.",
    "sections": {
        "usage": [{"title": "Lots of retries", "detail": "d", "recommendation": "r",
                   "severity": "warn"}],
        "security": [],
        "cost": [],
    },
}


def _anthropic_response(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def _openai_response(text: str) -> dict:
    return {"choices": [{"message": {"content": text}}]}


# --- masking and payload -------------------------------------------------------

def test_mask_text_masks_secrets():
    masked = ai_insights.mask_text(
        f"key {FAKE_ANT_KEY} and ghp_{'A' * 36} and AKIA{'B' * 16} end"
    )
    assert FAKE_ANT_KEY not in masked
    assert "ghp_" + "A" * 36 not in masked
    assert "AKIA" + "B" * 16 not in masked
    assert "******" in masked


def test_build_payload_masks_and_caps():
    _fresh_db()
    for n in range(ai_insights.MAX_EXCERPTS + 10):
        _event("s1", category="thought", detail=f"thinking about step {n} " + "x" * 2000)
    _event("s1", category="response", detail=f"here is your key: {FAKE_ANT_KEY}")
    payload = ai_insights.build_payload(30)
    serialized = json.dumps(payload)
    assert FAKE_ANT_KEY not in serialized
    assert len(payload["excerpts"]) == ai_insights.MAX_EXCERPTS
    assert all(len(e["text"]) <= ai_insights.MAX_EXCERPT_CHARS for e in payload["excerpts"])
    assert len(payload["findings"]) <= ai_insights.MAX_FINDINGS
    assert payload["counts"]["excerpts"] == ai_insights.MAX_EXCERPTS


def test_build_payload_windowing_excludes_old_events():
    _fresh_db()
    _event("s1", category="thought", detail="ancient thought", ts=_ts(days_ago=30))
    _event("s1", category="thought", detail="fresh thought", ts=_ts(minutes_ago=5))
    payload = ai_insights.build_payload(7)
    texts = [e["text"] for e in payload["excerpts"]]
    assert texts == ["fresh thought"]


# --- config resolution ----------------------------------------------------------

def test_resolve_config_env_precedence():
    _fresh_db()
    db.set_setting("ai_api_key", "db-key-value")
    os.environ["COT_ANTHROPIC_API_KEY"] = "env-key-value"
    cfg = ai_insights.resolve_config()
    assert cfg is not None
    assert cfg.api_key == "env-key-value" and cfg.key_source == "env"
    os.environ.pop("COT_ANTHROPIC_API_KEY")
    cfg = ai_insights.resolve_config()
    assert cfg is not None
    assert cfg.api_key == "db-key-value" and cfg.key_source == "db"
    db.set_setting("ai_api_key", "")
    assert ai_insights.resolve_config() is None


def test_resolve_config_model_defaults_and_override():
    _fresh_db()
    db.set_setting("ai_api_key", "k")
    cfg = ai_insights.resolve_config()
    assert cfg.provider == "anthropic" and cfg.model == ai_insights.DEFAULT_MODELS["anthropic"]
    db.set_setting("ai_provider", "openai")
    cfg = ai_insights.resolve_config()
    assert cfg.provider == "openai" and cfg.model == ai_insights.DEFAULT_MODELS["openai"]
    db.set_setting("ai_model", "my-custom-model")
    assert ai_insights.resolve_config().model == "my-custom-model"


# --- provider adapters -----------------------------------------------------------

def test_provider_request_shape_anthropic():
    _fresh_db()
    captured: list = []
    original = _patch_urlopen(_anthropic_response("hello"), captured)
    try:
        cfg = ai_insights.AiConfig("anthropic", FAKE_ANT_KEY, "claude-sonnet-5", "db")
        text = ai_insights._call_anthropic(cfg, '{"x":1}')
    finally:
        urllib.request.urlopen = original
    assert text == "hello"
    req = captured[0]
    assert req.full_url == ai_insights.ANTHROPIC_URL
    assert req.get_header("X-api-key") == FAKE_ANT_KEY
    assert req.get_header("Anthropic-version") == "2023-06-01"
    body = json.loads(req.data.decode("utf-8"))
    assert body["model"] == "claude-sonnet-5"
    assert body["max_tokens"] == ai_insights.MAX_OUTPUT_TOKENS
    assert body["messages"][0]["content"] == '{"x":1}'


def test_provider_request_shape_openai():
    _fresh_db()
    captured: list = []
    original = _patch_urlopen(_openai_response("hi"), captured)
    try:
        cfg = ai_insights.AiConfig("openai", FAKE_OAI_KEY, "gpt-4o", "db")
        text = ai_insights._call_openai(cfg, '{"x":1}')
    finally:
        urllib.request.urlopen = original
    assert text == "hi"
    req = captured[0]
    assert req.full_url == ai_insights.OPENAI_URL
    assert req.get_header("Authorization") == f"Bearer {FAKE_OAI_KEY}"
    body = json.loads(req.data.decode("utf-8"))
    assert body["model"] == "gpt-4o"
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][0]["role"] == "system"


# --- result parsing --------------------------------------------------------------

def test_parse_result_valid_fenced_and_invalid():
    parsed = ai_insights.parse_result(json.dumps(_ANALYSIS_JSON))
    assert parsed["summary"] == "Agents are busy."
    assert parsed["sections"]["usage"][0]["severity"] == "warn"

    fenced = "```json\n" + json.dumps(_ANALYSIS_JSON) + "\n```"
    assert ai_insights.parse_result(fenced)["summary"] == "Agents are busy."

    bad_severity = json.dumps({"summary": "s", "sections": {"usage": [
        {"title": "t", "detail": "d", "recommendation": "r", "severity": "apocalyptic"}
    ]}})
    assert ai_insights.parse_result(bad_severity)["sections"]["usage"][0]["severity"] == "info"

    try:
        ai_insights.parse_result("not json at all")
        assert False, "expected AiProviderError"
    except ai_insights.AiProviderError:
        pass


# --- run_analysis and endpoints ---------------------------------------------------

def test_run_analysis_persists_ok_row():
    _fresh_db()
    db.set_setting("ai_api_key", "k")
    _event("s1", category="thought", detail="pondering")
    captured: list = []
    original = _patch_urlopen(_anthropic_response(json.dumps(_ANALYSIS_JSON)), captured)
    try:
        analysis = ai_insights.run_analysis(30)
    finally:
        urllib.request.urlopen = original
    assert analysis["status"] == "ok"
    assert analysis["result"]["summary"] == "Agents are busy."
    rows = db.list_ai_analyses()
    assert len(rows) == 1 and rows[0]["id"] == analysis["id"]
    assert rows[0]["input_summary"]["excerpts"] == 1


def test_run_analysis_provider_error_persists_error_row():
    _fresh_db()
    db.set_setting("ai_api_key", "k")
    original = urllib.request.urlopen

    def fail(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 401, "unauthorized", {}, io.BytesIO(b'{"error":"bad key"}')
        )

    urllib.request.urlopen = fail
    try:
        try:
            ai_insights.run_analysis(30)
            assert False, "expected AiProviderError"
        except ai_insights.AiProviderError:
            pass
    finally:
        urllib.request.urlopen = original
    rows = db.list_ai_analyses()
    assert len(rows) == 1 and rows[0]["status"] == "error"
    assert "401" in rows[0]["error"]


def test_analyze_endpoint_maps_errors():
    from fastapi import HTTPException

    _fresh_db()
    try:
        main.analyze_insights(main.AnalyzeRequest(days=30))
        assert False, "expected 409"
    except HTTPException as exc:
        assert exc.status_code == 409

    os.environ["COT_DISABLE_LLM"] = "1"
    try:
        main.analyze_insights(main.AnalyzeRequest(days=30))
        assert False, "expected 403"
    except HTTPException as exc:
        assert exc.status_code == 403
    finally:
        os.environ.pop("COT_DISABLE_LLM")

    db.set_setting("ai_api_key", "k")
    original = urllib.request.urlopen

    def fail(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 500, "boom", {}, io.BytesIO(b""))

    urllib.request.urlopen = fail
    try:
        try:
            main.analyze_insights(main.AnalyzeRequest(days=30))
            assert False, "expected 502"
        except HTTPException as exc:
            assert exc.status_code == 502
    finally:
        urllib.request.urlopen = original


def test_settings_endpoint_never_returns_key():
    _fresh_db()
    db.set_setting("ai_api_key", FAKE_ANT_KEY)
    settings = main.get_settings()
    serialized = json.dumps(settings)
    assert FAKE_ANT_KEY not in serialized
    assert settings["ai_configured"] is True
    assert settings["ai_key_source"] == "db"
    assert settings["ai_key_masked"] and "******" in settings["ai_key_masked"]


def test_settings_update_validates_and_audits_without_key():
    from fastapi import HTTPException

    _fresh_db()

    class _FakeRequest:
        def __init__(self, body: dict):
            self._body = body

        async def json(self):
            return self._body

        async def body(self):
            return json.dumps(self._body).encode("utf-8")

    import asyncio

    result = asyncio.run(
        main.update_settings(_FakeRequest({
            "ai_provider": "openai", "ai_api_key": FAKE_OAI_KEY, "ai_model": "gpt-4o-mini",
        }))
    )
    assert result["ai_provider"] == "openai"
    assert result["ai_model"] == "gpt-4o-mini"
    assert FAKE_OAI_KEY not in json.dumps(result)
    audit = json.dumps(db.audit_events())
    assert FAKE_OAI_KEY not in audit

    try:
        asyncio.run(main.update_settings(_FakeRequest({"ai_provider": "gemini"})))
        assert False, "expected 400"
    except HTTPException as exc:
        assert exc.status_code == 400

    # Empty string clears the key.
    asyncio.run(main.update_settings(_FakeRequest({"ai_api_key": ""})))
    assert main.get_settings()["ai_configured"] is False


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    sys.exit(1 if failures else 0)

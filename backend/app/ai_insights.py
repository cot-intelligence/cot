"""BYOK AI insights — optional LLM layer over the rule-based findings.

Implements the layer sketched in ``insights.py``: an explicit, user-triggered
analysis that sends rule findings, a metrics snapshot, and secret-masked
excerpts of agent thoughts/responses to the user's own provider (Anthropic or
OpenAI) and returns structured usage/security/cost insights.

Guarantees:
- Nothing leaves the machine unless the user configured a key AND pressed the
  button (``POST /v1/insights/analyze`` — never polled).
- ``mask_text`` is the single choke point: every outbound string passes
  through the ``insights.SECRET_PATTERNS`` masking before serialization, and
  the serialized payload is masked once more.
- ``COT_DISABLE_LLM=1`` hard-disables the feature regardless of stored keys.
- The API key is read from env (``COT_ANTHROPIC_API_KEY`` /
  ``COT_OPENAI_API_KEY``, taking precedence) or the settings table; it is
  never echoed into results, audit rows, or error messages.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from . import __version__, db, insights, store

PROVIDERS = ("anthropic", "openai")
DEFAULT_MODELS = {"anthropic": "claude-sonnet-5", "openai": "gpt-4o"}
ENV_KEYS = {"anthropic": "COT_ANTHROPIC_API_KEY", "openai": "COT_OPENAI_API_KEY"}
ENV_ENDPOINTS = {
    "anthropic": "COT_ANTHROPIC_ENDPOINT",
    "openai": "COT_OPENAI_ENDPOINT",
}

MAX_FINDINGS = 50
MAX_EXCERPTS = 40
MAX_EXCERPT_CHARS = 1500
REQUEST_TIMEOUT = 120  # seconds; provider calls run 10-60s
MAX_OUTPUT_TOKENS = 2000

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_ENDPOINTS = {"anthropic": ANTHROPIC_URL, "openai": OPENAI_URL}

SYSTEM_PROMPT = """You are an analyst for "cot", a local observability tool for AI coding agents (Claude Code, Cursor, Codex). You receive a JSON payload with:
- "findings": rule-based issues already detected locally (pillars: usability, cost, security)
- "metrics": aggregate usage statistics (sessions, events, tokens, cost, tools, models)
- "excerpts": recent agent thought/response excerpts (secret-masked, truncated)

Synthesize interesting, actionable insights the rules alone cannot see: recurring themes in how the agents work, wasted effort, risky habits, cost drivers, and concrete recommendations.

Respond with STRICT JSON only — no prose, no markdown fences — matching exactly:
{
  "summary": "2-4 sentence executive summary across all sessions",
  "sections": {
    "usage": [{"title": str, "detail": str, "recommendation": str, "severity": "info"|"warn"|"critical"}],
    "security": [...same shape...],
    "cost": [...same shape...]
  }
}
Each section: 1-4 items, most important first. Severity reflects impact. Keep titles short; details concrete (reference actual numbers/patterns from the payload); recommendations actionable."""


class AiDisabledError(RuntimeError):
    """LLM layer hard-disabled via COT_DISABLE_LLM."""


class AiNotConfiguredError(RuntimeError):
    """No API key available for the selected provider."""


class AiProviderError(RuntimeError):
    """Provider call or response parsing failed (message is pre-masked)."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class AiConfig:
    provider: str
    api_key: str
    model: str
    key_source: str  # 'env' | 'db'
    endpoint: str | None = None


def env_disabled() -> bool:
    return os.environ.get("COT_DISABLE_LLM") in ("1", "true", "yes")


def stored_provider() -> str:
    provider = (db.get_setting("ai_provider") or "anthropic").strip().lower()
    return provider if provider in PROVIDERS else "anthropic"


def default_model(provider: str) -> str:
    return DEFAULT_MODELS.get(provider, DEFAULT_MODELS["anthropic"])


def default_endpoint(provider: str) -> str:
    return DEFAULT_ENDPOINTS.get(provider, DEFAULT_ENDPOINTS["anthropic"])


def endpoint_setting_key(provider: str) -> str:
    return f"ai_{provider}_endpoint"


def stored_endpoint(provider: str) -> str | None:
    return (db.get_setting(endpoint_setting_key(provider)) or "").strip() or None


def resolve_endpoint(provider: str) -> str:
    env_endpoint = os.environ.get(ENV_ENDPOINTS[provider], "").strip()
    return env_endpoint or stored_endpoint(provider) or default_endpoint(provider)


def provider_call_endpoint(provider: str, endpoint: str | None) -> str:
    """Final URL to call. OpenAI-compatible proxies often ask for just /v1."""
    raw = (endpoint or default_endpoint(provider)).rstrip("/")
    if provider == "openai" and raw.endswith("/v1"):
        return f"{raw}/chat/completions"
    if provider == "anthropic" and raw.endswith("/v1"):
        return f"{raw}/messages"
    return raw


def resolve_config() -> AiConfig | None:
    """Effective provider/key/model, or None when no key is configured."""
    provider = stored_provider()
    env_key = os.environ.get(ENV_KEYS[provider], "").strip()
    if env_key:
        key, source = env_key, "env"
    else:
        key = (db.get_setting("ai_api_key") or "").strip()
        source = "db"
    if not key:
        return None
    model = (db.get_setting("ai_model") or "").strip() or default_model(provider)
    endpoint = resolve_endpoint(provider)
    return AiConfig(provider=provider, api_key=key, model=model, key_source=source, endpoint=endpoint)


def mask_text(text: str) -> str:
    """Mask every known secret shape; the single outbound choke point."""
    for pat, _severity, _kind in insights.SECRET_PATTERNS:
        text = pat.sub(lambda m: insights.mask_secret(m.group(0)), text)
    return text


def build_payload(days: int = 30) -> dict[str, Any]:
    computed = insights.compute_insights(days)
    findings = [
        {
            "id": f.get("rule_id") or f.get("id"),
            "pillar": f["pillar"],
            "severity": f["severity"],
            "title": mask_text(str(f.get("title") or "")),
            "detail": mask_text(str(f.get("detail") or "")),
            "recommendation": mask_text(str(f.get("recommendation") or "")),
        }
        for f in computed["insights"]
        if f.get("status") == "active"
    ][:MAX_FINDINGS]

    m = db.metrics()
    metrics_snapshot = {
        "totals": m.get("totals"),
        "tokens": m.get("tokens"),
        "cost": {
            "total": (m.get("cost") or {}).get("total"),
            "by_model": (m.get("cost") or {}).get("by_model"),
        },
        "by_source": m.get("by_source"),
        "by_category": m.get("by_category"),
        "by_tool": (m.get("by_tool") or [])[:10],
        "fun": m.get("fun"),
    }

    cutoff = insights.cutoff_iso(days)
    sql = (
        "SELECT session_id, ts, category, detail FROM events"
        " WHERE category IN ('thought', 'response')"
        " AND detail IS NOT NULL AND detail != ''"
    )
    params: list[Any] = []
    if cutoff:
        sql += " AND ts >= ?"
        params.append(cutoff)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(MAX_EXCERPTS)
    with store.read() as conn:
        rows = conn.execute(sql, params).fetchall()
    excerpts = [
        {
            "category": r["category"],
            "ts": r["ts"],
            "session": str(r["session_id"])[:8],
            "text": mask_text(str(r["detail"]))[:MAX_EXCERPT_CHARS],
        }
        for r in rows
    ]

    payload = {
        "window_days": days,
        "findings": findings,
        "metrics": metrics_snapshot,
        "excerpts": excerpts,
        "counts": {"findings": len(findings), "excerpts": len(excerpts)},
    }
    # Belt and braces: mask the fully serialized payload once more so nothing
    # assembled from metrics/labels can slip a secret through.
    return json.loads(mask_text(json.dumps(payload, ensure_ascii=False, default=str)))


def _post_json(url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": f"cot/{__version__}",
            **headers,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        raise AiProviderError(
            f"provider returned HTTP {exc.code}: {mask_text(detail)}", status=exc.code
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AiProviderError(f"provider unreachable: {exc}") from exc


def _call_anthropic(cfg: AiConfig, payload_json: str) -> str:
    data = _post_json(
        provider_call_endpoint("anthropic", cfg.endpoint),
        {"x-api-key": cfg.api_key, "anthropic-version": "2023-06-01"},
        {
            "model": cfg.model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": payload_json}],
        },
    )
    for block in data.get("content") or []:
        if block.get("type") == "text":
            return str(block.get("text") or "")
    raise AiProviderError("provider response contained no text content")


def _call_openai(cfg: AiConfig, payload_json: str) -> str:
    data = _post_json(
        provider_call_endpoint("openai", cfg.endpoint),
        {"Authorization": f"Bearer {cfg.api_key}"},
        {
            "model": cfg.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": payload_json},
            ],
            "response_format": {"type": "json_object"},
            "max_tokens": MAX_OUTPUT_TOKENS,
        },
    )
    choices = data.get("choices") or []
    if choices and choices[0].get("message"):
        return str(choices[0]["message"].get("content") or "")
    raise AiProviderError("provider response contained no choices")


_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$")
_SEVERITIES = ("info", "warn", "critical")


def parse_result(text: str) -> dict[str, Any]:
    """Validate/coerce the model output into the expected shape."""
    cleaned = _FENCE_RE.sub("", text.strip())
    try:
        raw = json.loads(cleaned)
    except (json.JSONDecodeError, TypeError) as exc:
        raise AiProviderError(f"model returned unparseable JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise AiProviderError("model returned JSON that is not an object")
    sections_in = raw.get("sections")
    sections_in = sections_in if isinstance(sections_in, dict) else {}
    sections: dict[str, list[dict[str, str]]] = {}
    for key in ("usage", "security", "cost"):
        items_in = sections_in.get(key)
        items: list[dict[str, str]] = []
        for item in items_in if isinstance(items_in, list) else []:
            if not isinstance(item, dict):
                continue
            severity = str(item.get("severity") or "info").lower()
            items.append(
                {
                    "title": str(item.get("title") or "").strip(),
                    "detail": str(item.get("detail") or "").strip(),
                    "recommendation": str(item.get("recommendation") or "").strip(),
                    "severity": severity if severity in _SEVERITIES else "info",
                }
            )
        sections[key] = [i for i in items if i["title"]]
    result = {"summary": str(raw.get("summary") or "").strip(), "sections": sections}
    if not result["summary"] and not any(sections.values()):
        raise AiProviderError("model returned an empty analysis")
    return result


def run_analysis(days: int = 30) -> dict[str, Any]:
    """Build payload, call the provider, persist and return the analysis row."""
    if env_disabled():
        raise AiDisabledError("AI insights are disabled via COT_DISABLE_LLM")
    cfg = resolve_config()
    if cfg is None:
        raise AiNotConfiguredError("no API key configured for AI insights")
    payload = build_payload(days)
    payload_json = json.dumps(payload, ensure_ascii=False)
    input_summary = {
        **payload["counts"],
        "payload_bytes": len(payload_json.encode("utf-8")),
    }
    call = _call_anthropic if cfg.provider == "anthropic" else _call_openai
    try:
        result = parse_result(call(cfg, payload_json))
    except AiProviderError as exc:
        db.insert_ai_analysis(
            cfg.provider, cfg.model, days, input_summary, None,
            status="error", error=str(exc),
        )
        raise
    row_id = db.insert_ai_analysis(
        cfg.provider, cfg.model, days, input_summary, result
    )
    analysis = db.get_ai_analysis(row_id)
    assert analysis is not None
    return analysis

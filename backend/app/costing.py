"""Token cost estimation from bundled model pricing.

Pricing values are dollars per million tokens. The bundled table is copied from
SafeDep Gryph's Apache-2.0 pricing data, which is generated from models.dev.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

PRICING_PATH = Path(__file__).with_name("pricing") / "models.json"
PRICING_SOURCE = "safedep/gryph pricing/models.json"
PRICING_SOURCE_URL = "https://github.com/safedep/gryph/blob/main/pricing/models.json"
PRICING_LICENSE = "Apache-2.0"

_DATE_SUFFIX = re.compile(r"-\d{8}$")
_DASH_VERSION = re.compile(r"(\d)-(\d)")  # 3-5 → 3.5
_PROVIDER_PREFIXES = ("anthropic/", "openai/", "google/", "meta/", "mistral/")
_ALIASES = {
    # Cot's synthetic demo event used this before OpenAI's canonical model id
    # settled in the pricing table.
    "gpt-5.5-codex": "gpt-5-codex",
}


@lru_cache(maxsize=1)
def _pricing() -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(PRICING_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(data, list):
        return out
    for entry in data:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        cost = entry.get("cost")
        if isinstance(model_id, str) and isinstance(cost, dict):
            out[model_id] = {
                "id": model_id,
                "name": entry.get("name") if isinstance(entry.get("name"), str) else model_id,
                "input": _num(cost.get("input")),
                "output": _num(cost.get("output")),
                "cache_read": _num(cost.get("cache_read")),
                "cache_write": _num(cost.get("cache_write")),
            }
    return out


def _num(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else 0.0


def _tokens(row: dict[str, Any]) -> dict[str, int]:
    return {
        "input": int(row.get("input_tokens") or 0),
        "output": int(row.get("output_tokens") or 0),
        "cache_read": int(row.get("cache_read_tokens") or 0),
        "cache_write": int(row.get("cache_write_tokens") or 0),
    }


def _has_cache_pricing(prices: dict[str, dict[str, Any]], key: str) -> bool:
    entry = prices.get(key)
    if not entry:
        return False
    return entry.get("cache_read", 0) > 0 or entry.get("cache_write", 0) > 0


def normalize_model_id(model_id: str | None) -> str | None:
    if not model_id:
        return None
    prices = _pricing()
    alias = _ALIASES.get(model_id, model_id)
    stripped = _DATE_SUFFIX.sub("", alias)

    # Collect all candidate matches.  We also try the "dot-version" variant
    # because some registries use e.g. claude-3.5-sonnet while the API id
    # uses claude-3-5-sonnet.
    candidates: list[str] = []
    bases = [alias]
    if stripped != alias:
        bases.append(stripped)
    dotted = _DASH_VERSION.sub(r"\1.\2", stripped)
    if dotted != stripped:
        bases.append(dotted)
    for base in bases:
        if base in prices and base not in candidates:
            candidates.append(base)
    for prefix in _PROVIDER_PREFIXES:
        for base in bases:
            c = prefix + base
            if c in prices and c not in candidates:
                candidates.append(c)
    for canonical in prices:
        _, _, tail = canonical.partition("/")
        if tail in (stripped, dotted) and canonical not in candidates:
            candidates.append(canonical)

    if not candidates:
        return None
    # Prefer entries that include cache pricing (many bare-id entries in the
    # bundled table have cache_read/cache_write zeroed out).
    for c in candidates:
        if _has_cache_pricing(prices, c):
            return c
    return candidates[0]


def estimate_model_cost(row: dict[str, Any]) -> dict[str, Any]:
    model = row.get("model") if isinstance(row.get("model"), str) else None
    canonical = normalize_model_id(model)
    token_counts = _tokens(row)
    total_tokens = sum(token_counts.values())
    price = _pricing().get(canonical or "")
    if not price:
        return {
            "model": model,
            "pricing_model": None,
            "pricing_found": False,
            "input_tokens": token_counts["input"],
            "output_tokens": token_counts["output"],
            "cache_read_tokens": token_counts["cache_read"],
            "cache_write_tokens": token_counts["cache_write"],
            "total_tokens": total_tokens,
            "input_usd": 0.0,
            "output_usd": 0.0,
            "cache_read_usd": 0.0,
            "cache_write_usd": 0.0,
            "total_usd": 0.0,
        }

    input_usd = token_counts["input"] * price["input"] / 1_000_000
    output_usd = token_counts["output"] * price["output"] / 1_000_000
    cache_read_usd = token_counts["cache_read"] * price["cache_read"] / 1_000_000
    cache_write_usd = token_counts["cache_write"] * price["cache_write"] / 1_000_000
    return {
        "model": model,
        "pricing_model": price["id"],
        "pricing_found": True,
        "input_tokens": token_counts["input"],
        "output_tokens": token_counts["output"],
        "cache_read_tokens": token_counts["cache_read"],
        "cache_write_tokens": token_counts["cache_write"],
        "total_tokens": total_tokens,
        "input_usd": input_usd,
        "output_usd": output_usd,
        "cache_read_usd": cache_read_usd,
        "cache_write_usd": cache_write_usd,
        "total_usd": input_usd + output_usd + cache_read_usd + cache_write_usd,
    }


def estimate_cost(rows: list[dict[str, Any]]) -> dict[str, Any]:
    models = [estimate_model_cost(row) for row in rows]
    priced_tokens = sum(m["total_tokens"] for m in models if m["pricing_found"])
    unpriced_tokens = sum(m["total_tokens"] for m in models if not m["pricing_found"])
    total_usd = sum(m["total_usd"] for m in models)
    return {
        "total_usd": total_usd,
        "currency": "USD",
        "priced_tokens": priced_tokens,
        "unpriced_tokens": unpriced_tokens,
        "models": models,
        "pricing": {
            "source": PRICING_SOURCE,
            "source_url": PRICING_SOURCE_URL,
            "license": PRICING_LICENSE,
            "unit": "USD per 1M tokens",
            "model_count": len(_pricing()),
        },
    }

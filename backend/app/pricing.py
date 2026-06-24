"""Cache-aware cost calculation from stored token counts.

All rates are **USD per 1,000,000 tokens**. The bundled ``pricing.json`` works
fully offline; an optional background refresh can pull updated rates.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

_PRICING_PATH = Path(__file__).with_name("pricing.json")

_rates: dict[str, dict[str, float]] = {}
_unknown_logged: set[str] = set()

# Strip provider prefixes and date suffixes from raw model ids.
_PREFIX_RE = re.compile(r"^(anthropic/|openai/|google/|fireworks/|us\.anthropic\.|aws/)")
_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")
# Claude-family: claude-<family>-<major>-<minor> kept as-is (different minors have different prices)
_CLAUDE_RE = re.compile(r"^(claude-(?:opus|sonnet|haiku|fable)-\d+-\d+)")
# Claude 3.x legacy: claude-3-5-sonnet-20241022 → claude-3-5-sonnet
_CLAUDE3_RE = re.compile(r"^(claude-3(?:-\d)?-(?:opus|sonnet|haiku))")
# Alternate naming: claude-<version>-<family> (e.g. claude-4.5-sonnet)
_CLAUDE_ALT_RE = re.compile(r"^claude-[\d.]+-(?:opus|sonnet|haiku|fable)$")
# Remap claude-<version>-<family> → claude-<family>-<major>
_CLAUDE_ALT_REMAP_RE = re.compile(r"^claude-([\d.]+)-(opus|sonnet|haiku|fable)$")
# Trailing noise: [1m], -thinking-high, etc.
_TRAILING_NOISE_RE = re.compile(r"(\[.*\]|-thinking(?:-\w+)?)$")
# GPT routing variants: gpt-5.5-codex → gpt-5.5, gpt-5.5-medium → gpt-5.5
# Only for models with a dot-version (5.4+); gpt-5-codex is a distinct model.
_GPT_VARIANT_RE = re.compile(r"^(gpt-\d+\.\d+)-(codex|medium)$")
# Composer fast variant: composer-2.5-fast → composer-2.5
_COMPOSER_FAST_RE = re.compile(r"^(composer-[\d.]+)-fast$")


def _load_bundled() -> dict[str, dict[str, float]]:
    try:
        with _PRICING_PATH.open() as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _ensure_loaded() -> dict[str, dict[str, float]]:
    global _rates
    if not _rates:
        _rates = _load_bundled()
    return _rates


def normalize_model(model: str | None) -> str | None:
    """Canonicalize a raw model id for pricing lookup."""
    if not model or not isinstance(model, str):
        return None
    m = model.strip().lower()
    if not m or m == "default":
        return None
    m = _PREFIX_RE.sub("", m)
    m = _DATE_SUFFIX_RE.sub("", m)
    m = _TRAILING_NOISE_RE.sub("", m)
    # claude-opus-4-8 → claude-opus-4
    cm = _CLAUDE_RE.match(m)
    if cm:
        return cm.group(1)
    # claude-3-5-sonnet-latest → claude-3-5-sonnet
    cm3 = _CLAUDE3_RE.match(m)
    if cm3:
        return cm3.group(1)
    # claude-4.5-sonnet → claude-sonnet-4-5 (alternate naming)
    alt = _CLAUDE_ALT_REMAP_RE.match(m)
    if alt:
        version = alt.group(1).replace(".", "-")
        family = alt.group(2)
        return f"claude-{family}-{version}"
    # gpt-5.5-codex → gpt-5.5 (codex is a routing variant, same model pricing)
    gpt = _GPT_VARIANT_RE.match(m)
    if gpt:
        return gpt.group(1)
    # composer-2.5-fast → composer-2.5 (fast is a tier, not a different model)
    comp = _COMPOSER_FAST_RE.match(m)
    if comp:
        return comp.group(1)
    return m


def cost_for(
    model: str | None,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float | None:
    """Compute USD cost for one event/aggregation, cache-aware.

    Returns ``None`` when the (normalized) model has no pricing entry so callers
    can distinguish "unpriced" from "$0.00".
    """
    norm = normalize_model(model)
    if norm is None:
        return None
    rates = _ensure_loaded()
    entry = rates.get(norm)
    if entry is None:
        if norm not in _unknown_logged:
            _unknown_logged.add(norm)
            _log.debug("No pricing entry for model %r (normalized from %r)", norm, model)
        return None
    return (
        input_tokens * entry.get("input", 0)
        + output_tokens * entry.get("output", 0)
        + cache_read_tokens * entry.get("cache_read", 0)
        + cache_write_tokens * entry.get("cache_write", 0)
    ) / 1_000_000


def set_rates(rates: dict[str, dict[str, float]]) -> None:
    """Replace the in-memory rate table (e.g. after a background refresh)."""
    global _rates
    _rates = dict(rates)
    _unknown_logged.clear()


def known_models() -> list[str]:
    """Return the list of model keys that have pricing entries."""
    return list(_ensure_loaded().keys())

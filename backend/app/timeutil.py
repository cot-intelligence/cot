"""Timestamp normalization shared across Collector modules."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


_ACTIVE_WINDOW_SECONDS = 600


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_ts(value: Any) -> datetime | None:
    """Parse stored ISO or legacy epoch timestamps into aware datetimes."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 1e11 else value
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def format_ts(value: Any) -> str | None:
    """Serialize a stored timestamp as an ISO string for Collector responses."""
    parsed = parse_ts(value)
    return parsed.isoformat() if parsed else None


def duration_seconds(first: Any, last: Any) -> float | None:
    first_dt = parse_ts(first)
    last_dt = parse_ts(last)
    if first_dt is None or last_dt is None:
        return None
    return round((last_dt - first_dt).total_seconds(), 2)


def live_status(last_ts: Any) -> str:
    """Return effective Session status from recency of its last Event."""
    parsed = parse_ts(last_ts)
    if parsed is None:
        return "completed"
    age = (datetime.now(timezone.utc) - parsed).total_seconds()
    return "active" if age <= _ACTIVE_WINDOW_SECONDS else "completed"

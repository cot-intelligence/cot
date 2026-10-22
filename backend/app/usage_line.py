"""The one-line usage summary behind ``cot statusline``: today's spend and the
current session's cost.

Context size is left to the agent: cot records tokens per response, and one
response can span many model requests, so their sum is not the context."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from . import db, store
from .pricing import cost_for


def _cost(rows: list[Any]) -> float:
    total = 0.0
    for r in rows:
        c = cost_for(r["model"], r["i"], r["o"], r["cr"], r["cw"])
        total += c or 0.0
    return total


_SUMS = (
    "SELECT model, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,"
    " COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw FROM events"
)


def _fmt_usd(v: float) -> str:
    return f"${v:,.2f}"


def summary(session_id: str | None = None, tz: str | None = None) -> dict[str, Any]:
    zone = db.resolve_tz(tz) or datetime.now().astimezone().tzinfo or timezone.utc
    midnight = datetime.now(zone).replace(hour=0, minute=0, second=0, microsecond=0)
    since = midnight.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    out: dict[str, Any] = {"today_usd": 0.0, "session_usd": None, "model": None, "sessions_today": 0}
    with store.read() as conn:
        out["today_usd"] = round(_cost(conn.execute(
            f"{_SUMS} WHERE ts >= ? AND model IS NOT NULL AND model != '' GROUP BY model", (since,)
        ).fetchall()), 4)
        out["sessions_today"] = conn.execute(
            "SELECT COUNT(*) FROM session_stats WHERE last_ts >= ? AND content_count > 0", (since,)
        ).fetchone()[0]
        if session_id:
            out["session_usd"] = round(_cost(conn.execute(
                f"{_SUMS} WHERE session_id = ? AND model IS NOT NULL AND model != '' GROUP BY model", (session_id,)
            ).fetchall()), 4)
            last = conn.execute(
                "SELECT model FROM events WHERE session_id = ? AND model IS NOT NULL AND model != ''"
                " ORDER BY ts DESC LIMIT 1",
                (session_id,),
            ).fetchone()
            out["model"] = last["model"] if last else None
    parts = []
    if out["session_usd"] is not None:
        parts.append(f"session {_fmt_usd(out['session_usd'])}")
    parts.append(f"today {_fmt_usd(out['today_usd'])}")
    out["line"] = "cot · " + " · ".join(parts)
    return out

"""One read of the event store, shaped for the insight rules.

Every rule used to open the shared connection and issue its own ``SELECT`` over
``events``/``sessions`` (33 scans across 17 rules). This module does that read
*once* and hands rules a typed, in-memory :class:`Snapshot`. Rules then become
pure functions of the snapshot (``fn(snapshot) -> findings``) — testable with
plain data and no temporary SQLite database.

Scope semantics preserved from the old ``_scope`` helper: the working set is
non-archived events, optionally windowed (``cutoff``) and optionally narrowed to
one session. Two rules need data *outside* that working set — those extra views
are materialized alongside it:

* ``session_last_ts`` — last activity per session across *all* events (session
  liveness for ``stalled_clarifications``; the old code ran a per-session
  ``MAX(ts)`` with no window/archived filter).
* ``session_tool_calls`` — tool-call count per session across *all* events
  (``model_mismatch``'s second, unscoped query).
* ``trend_events`` — the last 14 days of priced events regardless of the
  window (``trend_anomaly`` deliberately ignores the compute window).
"""

from __future__ import annotations

from dataclasses import dataclass, field, fields
from datetime import datetime, timedelta, timezone
from typing import Any, TypedDict

from . import db

_TREND_DAYS = 14


class InsightInputs(TypedDict):
    """The store's one read for the insight rules (see ``db.read_insight_inputs``).

    A typed handoff between the store and the snapshot builder: raw event dicts
    plus the cross-cutting per-session views, before shaping into :class:`Event`
    / :class:`Snapshot`.
    """

    events: list[dict[str, Any]]
    session_last_ts: dict[str, Any]
    session_tool_calls: dict[str, int]
    trend_events: list[dict[str, Any]]

# Token columns are summed like SQL ``COALESCE(SUM(x), 0)`` — a NULL cell
# contributes 0, so coerce on the way in and rule code never sees None.
_TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")


@dataclass(frozen=True)
class Event:
    """A single collected event, joined to its session's cwd.

    Supports mapping-style access (``e["target"]``, ``"id" in e.keys()``) so the
    existing evidence builder and ``db.build_clarifications`` keep working
    unchanged against snapshot rows.
    """

    id: int
    session_id: str
    ts: Any
    category: str | None = None
    tool: str | None = None
    target: str | None = None
    status: str | None = None
    hook: str | None = None
    title: str | None = None
    detail: str | None = None
    model: str | None = None
    duration_ms: int | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cwd: str | None = None

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)

    def keys(self) -> tuple[str, ...]:
        return _EVENT_FIELDS


_EVENT_FIELDS = tuple(f.name for f in fields(Event))


@dataclass
class Snapshot:
    """Everything the rules read, materialized once.

    ``events`` are ordered by ``(session_id, ts, id)`` so streak/sequence rules
    (retry loops, read-then-exfil) can scan them directly.
    """

    events: list[Event]
    session_id: str | None = None
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    session_last_ts: dict[str, Any] = field(default_factory=dict)
    session_tool_calls: dict[str, int] = field(default_factory=dict)
    trend_events: list[Event] = field(default_factory=list)


def _event_from_row(row: Any) -> Event:
    return Event(
        id=row["id"],
        session_id=row["session_id"],
        ts=row["ts"],
        category=row["category"],
        tool=row["tool"],
        target=row["target"],
        status=row["status"],
        hook=row["hook"],
        title=row["title"],
        detail=row["detail"],
        model=row["model"],
        duration_ms=row["duration_ms"],
        input_tokens=row["input_tokens"] or 0,
        output_tokens=row["output_tokens"] or 0,
        cache_read_tokens=row["cache_read_tokens"] or 0,
        cache_write_tokens=row["cache_write_tokens"] or 0,
        cwd=row["cwd"],
    )


def build_snapshot(*, cutoff: str | None, session_id: str | None) -> Snapshot:
    """Read the event store once (via :func:`db.read_insight_inputs`) and shape
    it into a :class:`Snapshot`.

    ``cutoff`` is an ISO lower bound on ``ts`` (None = no window); ``session_id``
    narrows to one session (per-session mode). ``trend_anomaly`` is
    aggregate-only, so its 14-day slice is fetched only outside session mode.
    """
    now = datetime.now(timezone.utc)
    trend_since = None if session_id else (now - timedelta(days=_TREND_DAYS)).isoformat()

    data = db.read_insight_inputs(cutoff=cutoff, session_id=session_id, trend_since=trend_since)
    return Snapshot(
        events=[_event_from_row(r) for r in data["events"]],
        session_id=session_id,
        now=now,
        session_last_ts=data["session_last_ts"],
        session_tool_calls=data["session_tool_calls"],
        trend_events=[_event_from_row(r) for r in data["trend_events"]],
    )

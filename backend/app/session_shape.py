"""Session shape: what kind of sessions you run, and how many at once.

Archetypes are relative to the user's own history: a "deep" session is long for
you, not long by a fixed clock, so one person's twenty-minute habit and
another's three-hour one each split sensibly. Small floors keep a fresh install
with a handful of sessions from calling a two-minute run a marathon.

Durations and concurrency count active stretches, not a session's whole span: a session left
open overnight is idle, so its events are split wherever they go quiet for
``IDLE_GAP_S``.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from . import db, store

IDLE_GAP_S = 300
ARCHETYPES = ("automation", "quick", "standard", "deep", "marathon")
# Floors (seconds) under the percentile cut points, and the fewest sessions a
# baseline needs before percentiles are trusted over the floors alone.
_QUICK_FLOOR_S = 180
_DEEP_FLOOR_S = 1200
_MARATHON_FLOOR_S = 5400
_MIN_BASELINE = 20

_DURATION_BINS = [(0, 60), (60, 300), (300, 900), (900, 1800), (1800, 3600), (3600, 7200), (7200, None)]
_DURATION_LABELS = ["<1m", "1–5m", "5–15m", "15–30m", "30–60m", "1–2h", "2h+"]
_COUNT_BINS = [(0, 1), (1, 2), (2, 4), (4, 8), (8, 16), (16, 32), (32, None)]
_COUNT_LABELS = ["0", "1", "2–3", "4–7", "8–15", "16–31", "32+"]


def _epoch(ts: str | None) -> float:
    if not ts:
        return 0.0
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return 0.0


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]


def _histogram(values: list[float], bins: list[tuple[float, float | None]], labels: list[str]) -> list[dict[str, Any]]:
    counts = [0] * len(bins)
    for v in values:
        for i, (lo, hi) in enumerate(bins):
            if v >= lo and (hi is None or v < hi):
                counts[i] += 1
                break
    return [{"label": label, "count": c} for label, c in zip(labels, counts)]


def _rows() -> list[Any]:
    with store.read() as conn:
        return conn.execute(
            "SELECT s.id, s.source, st.first_ts, st.last_ts, st.tool_count,"
            " (SELECT COUNT(*) FROM events p WHERE p.session_id = s.id AND p.category = 'prompt') AS prompts"
            " FROM sessions s JOIN session_stats st ON st.session_id = s.id"
            " WHERE st.content_count > 0 AND s.archived = 0 AND s.parent_session_id IS NULL"
            " AND (s.import_root_id IS NULL OR s.import_root_id = s.id)"
        ).fetchall()


def _stretches(session_ids: set[str]) -> dict[str, list[tuple[float, float]]]:
    """Each session's active stretches, read from the covering index (no event bodies)."""
    stamps: dict[str, list[float]] = defaultdict(list)
    with store.read() as conn:
        for sid, ts in conn.execute("SELECT session_id, ts FROM events INDEXED BY idx_events_session_agg"):
            if sid in session_ids:
                stamps[sid].append(_epoch(ts))
    out = {}
    for sid, ts in stamps.items():
        ts.sort()
        # A lone event is still a minute of work.
        out[sid] = [(a, max(b, a + 60)) for a, b in segments(ts)]
    return out


def thresholds(durations: list[float]) -> dict[str, float]:
    """Duration cut points (seconds) for quick / deep / marathon from a baseline."""
    if len(durations) < _MIN_BASELINE:
        return {"quick": _QUICK_FLOOR_S, "deep": _DEEP_FLOOR_S, "marathon": _MARATHON_FLOOR_S}
    return {
        "quick": max(_pct(durations, 0.25), _QUICK_FLOOR_S),
        "deep": max(_pct(durations, 0.75), _DEEP_FLOOR_S),
        "marathon": max(_pct(durations, 0.95), _MARATHON_FLOOR_S),
    }


def archetype(duration: float, prompts: int, cuts: dict[str, float]) -> str:
    if prompts == 0:
        return "automation"
    if duration >= cuts["marathon"]:
        return "marathon"
    if duration >= cuts["deep"]:
        return "deep"
    if duration <= cuts["quick"] and prompts <= 2:
        return "quick"
    return "standard"


def segments(stamps: list[float], gap: float = IDLE_GAP_S) -> list[tuple[float, float]]:
    """Split sorted event times into active stretches wherever they go quiet for ``gap``."""
    out: list[tuple[float, float]] = []
    for t in stamps:
        if out and t - out[-1][1] <= gap:
            out[-1] = (out[-1][0], t)
        else:
            out.append((t, t))
    return out


def _concurrency(spans: list[tuple[float, float]], since: float, now: float, bucket_s: int) -> dict[str, Any]:
    n = max(1, int((now - since) // bucket_s) + 1)
    edges = sorted([(a, 1) for a, _b in spans] + [(b, -1) for _a, b in spans], key=lambda e: (e[0], e[1]))
    peak = [0] * n
    active_s = [0.0] * n
    busy = overlap = 0.0
    cur = overall = 0
    prev = since

    def run(lo: float, hi: float, level: int) -> None:
        # Spread [lo, hi) at ``level`` running sessions over the buckets it crosses.
        nonlocal busy, overlap
        if hi <= lo or level <= 0:
            return
        busy += hi - lo
        if level >= 2:
            overlap += hi - lo
        i = int((lo - since) // bucket_s)
        while i < n and since + i * bucket_s < hi:
            a, b = max(lo, since + i * bucket_s), min(hi, since + (i + 1) * bucket_s)
            if b > a:
                active_s[i] += (b - a) * level
                peak[i] = max(peak[i], level)
            i += 1

    for t, d in edges:
        t = min(max(t, since), now)
        run(prev, t, cur)
        prev = t
        cur += d
        overall = max(overall, cur)
    run(prev, now, cur)
    return {
        "bucket_s": bucket_s,
        "peak": overall,
        "active_hours": round(busy / 3600, 1),
        "agent_hours": round(sum(active_s) / 3600, 1),
        # Of the time anything was running, the share when two or more were.
        "overlap_share": round(overlap / busy, 3) if busy else 0.0,
        "buckets": [
            {"t": datetime.fromtimestamp(since + i * bucket_s, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "peak": peak[i], "agent_minutes": round(active_s[i] / 60, 1)}
            for i in range(n)
        ],
    }


def kinds() -> dict[str, dict[str, Any]]:
    """Every listed session's kind and active seconds, for the Sessions filter."""
    baseline = _rows()
    stretches = _stretches({r["id"] for r in baseline})
    active = {sid: sum(b - a for a, b in sp) for sid, sp in stretches.items()}
    cuts = thresholds([active.get(r["id"], 0.0) for r in baseline if (r["prompts"] or 0) > 0])
    return {
        r["id"]: {"kind": archetype(active.get(r["id"], 0.0), r["prompts"] or 0, cuts), "active_s": round(active.get(r["id"], 0.0))}
        for r in baseline
    }


def report(days: int = 30, tz: str | None = None) -> dict[str, Any]:
    days = max(1, days)
    zone = db.resolve_tz(tz) or timezone.utc
    now = datetime.now(timezone.utc)
    bucket_s = 3600 if days <= 7 else 86400
    # Buckets start on a local hour or midnight, so a day bar is the viewer's day.
    local = (now - timedelta(days=days)).astimezone(zone).replace(minute=0, second=0, microsecond=0)
    if bucket_s == 86400:
        local = local.replace(hour=0)
    since_dt = local.astimezone(timezone.utc)
    since = since_dt.timestamp()

    baseline = _rows()
    stretches = _stretches({r["id"] for r in baseline})
    active = {sid: sum(b - a for a, b in sp) for sid, sp in stretches.items()}
    cuts = thresholds([active.get(r["id"], 0.0) for r in baseline if (r["prompts"] or 0) > 0])
    window = [r for r in baseline if _epoch(r["last_ts"]) >= since]

    kinds: Counter[str] = Counter()
    examples: dict[str, list[dict[str, Any]]] = defaultdict(list)
    hours = [0] * 24
    for r in window:
        dur = active.get(r["id"], 0.0)
        kind = archetype(dur, r["prompts"] or 0, cuts)
        kinds[kind] += 1
        examples[kind].append({"session_id": r["id"], "active_s": round(dur), "prompts": r["prompts"], "source": r["source"]})
        hours[datetime.fromtimestamp(_epoch(r["first_ts"]), timezone.utc).astimezone(zone).hour] += 1

    durations = [active.get(r["id"], 0.0) for r in window]
    prompts = [float(r["prompts"] or 0) for r in window]
    tools_per_turn = [(r["tool_count"] or 0) / max(1, r["prompts"] or 0) for r in window]
    spans = [sp for r in window for sp in stretches.get(r["id"], []) if sp[1] >= since]
    return {
        "days": days,
        "sessions": len(window),
        "baseline_sessions": len(baseline),
        "thresholds": {k: round(v) for k, v in cuts.items()},
        "archetypes": [
            {"kind": k, "count": kinds.get(k, 0),
             "examples": sorted(examples.get(k, []), key=lambda e: e["active_s"], reverse=True)[:5]}
            for k in ARCHETYPES
        ],
        "distributions": {
            "duration": _histogram(durations, _DURATION_BINS, _DURATION_LABELS),
            "prompts": _histogram(prompts, _COUNT_BINS, _COUNT_LABELS),
            "tools_per_turn": _histogram(tools_per_turn, _COUNT_BINS, _COUNT_LABELS),
        },
        "medians": {
            "active_s": round(_pct(durations, 0.5)),
            "prompts": _pct(prompts, 0.5),
            "tools_per_turn": round(_pct(tools_per_turn, 0.5), 1),
        },
        "start_hours": hours,
        "concurrency": _concurrency(spans, since, now.timestamp(), bucket_s),
    }

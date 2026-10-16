from __future__ import annotations

from pathlib import Path

from app import db, store


_TS = [
    "2026-03-01T18:29:59.999Z",  # 23:59 in Kolkata: still 1 March there
    "2026-03-01T18:30:00.000Z",  # 00:00 in Kolkata: 2 March
    "2026-03-01T18:14:00+00:00",  # 23:59 in Kathmandu (+05:45)
    "2026-03-01T18:15:00.5+00:00",  # 00:00 in Kathmandu
    "2026-03-02T09:00:00+05:30",  # not UTC text: parsed row by row
    "2026-03-02T03:00:00",  # naive: treated as UTC
]


def _seed() -> None:
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, started_at, status, created_at, cwd)"
            " VALUES ('s1', 'claude', ?, 'completed', ?, '/p')",
            (_TS[0], _TS[0]),
        )
        for i, ts in enumerate(_TS):
            store.insert_event(
                conn,
                session_id="s1",
                source="claude",
                ts=ts,
                category="file_read" if i % 2 else "shell",
                target=f"/p/f{i % 3}",
                tool="Read",
                status="error" if i == 0 else "ok",
                model="claude-opus-4-8",
                attachments=[{"kind": "image", "size_bytes": 10}] if i == 1 else None,
            )


def _expected(tz: str) -> tuple[list[dict], list[dict]]:
    zone = db._resolve_tz(tz)
    days: dict[str, int] = {}
    hours: dict[int, int] = {}
    for ts in _TS:
        local = db.parse_ts(ts).astimezone(zone)
        days[local.strftime("%Y-%m-%d")] = days.get(local.strftime("%Y-%m-%d"), 0) + 1
        hours[local.hour] = hours.get(local.hour, 0) + 1
    return (
        [{"day": d, "events": n} for d, n in sorted(days.items())],
        [{"hour": h, "events": n} for h, n in sorted(hours.items())],
    )


def test_local_time_buckets_match_per_row_conversion(fresh_db: Path):
    _seed()
    for tz in ("Asia/Kolkata", "Asia/Kathmandu", "America/New_York", "UTC"):
        m = db.metrics(tz)
        assert (m["by_day"], m["by_hour"]) == _expected(tz), tz


def test_breakdowns_same_with_and_without_metrics_indexes(fresh_db: Path):
    _seed()
    before = db.metrics("UTC")
    db.ensure_metrics_indexes()
    after = db.metrics("UTC")
    assert before == after
    assert after["totals"]["errors"] == 1
    assert after["fun"]["files_touched"] == 3
    assert after["attachments"]["images"] == 1
    with store.read() as conn:
        plan = " ".join(
            r[3]
            for r in conn.execute(
                "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE status IN ('error','blocked')"
            )
        )
    assert "idx_events_metrics" in plan

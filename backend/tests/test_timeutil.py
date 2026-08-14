from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import timeutil


def test_parse_ts_normalizes_legacy_epochs_and_naive_iso_values():
    assert timeutil.parse_ts(1_767_225_600_000) == datetime(
        2026, 1, 1, tzinfo=timezone.utc
    )
    assert timeutil.parse_ts("2026-01-01T00:00:00") == datetime(
        2026, 1, 1, tzinfo=timezone.utc
    )
    assert timeutil.parse_ts("not-a-timestamp") is None


def test_duration_seconds_uses_normalized_timestamps():
    assert timeutil.duration_seconds(
        "2026-01-01T00:00:00Z", "2026-01-01T00:00:01.239Z"
    ) == 1.24
    assert timeutil.duration_seconds("bad", "2026-01-01T00:00:01Z") is None


def test_live_status_uses_ten_minute_activity_window():
    current = datetime.now(timezone.utc)
    assert timeutil.live_status((current - timedelta(seconds=599)).isoformat()) == "active"
    assert timeutil.live_status((current - timedelta(seconds=601)).isoformat()) == "completed"
    assert timeutil.live_status(None) == "completed"

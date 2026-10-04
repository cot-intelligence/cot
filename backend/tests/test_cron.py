"""Cron schedules for passive transcript import: parse, next run, plain-English description."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app import cron


def _at(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "expr, after, expected",
    [
        ("*/15 * * * *", "2026-10-03T10:07:00", "2026-10-03T10:15:00"),
        ("*/15 * * * *", "2026-10-03T10:45:00", "2026-10-03T11:00:00"),
        ("0 * * * *", "2026-10-03T10:00:00", "2026-10-03T11:00:00"),
        ("0 9 * * *", "2026-10-03T09:30:00", "2026-10-04T09:00:00"),
        ("30 18 * * 1-5", "2026-10-03T19:00:00", "2026-10-05T18:30:00"),  # Sat -> Mon
        ("0 0 1 * *", "2026-10-03T00:00:00", "2026-11-01T00:00:00"),
        ("0 6,18 * * *", "2026-10-03T07:00:00", "2026-10-03T18:00:00"),
        ("0 */6 * * *", "2026-10-03T07:00:00", "2026-10-03T12:00:00"),
        ("0 9 * * 0", "2026-10-03T10:00:00", "2026-10-04T09:00:00"),  # Sunday as 0
        ("0 9 * * 7", "2026-10-03T10:00:00", "2026-10-04T09:00:00"),  # Sunday as 7
    ],
)
def test_next_run(expr, after, expected):
    assert cron.next_run(expr, _at(after)) == _at(expected)


def test_day_of_month_and_week_are_ored_like_classic_cron():
    # "the 15th, or any Monday": 2026-10-05 is a Monday, before the 15th.
    assert cron.next_run("0 9 15 * 1", _at("2026-10-03T00:00:00")) == _at("2026-10-05T09:00:00")


@pytest.mark.parametrize(
    "expr",
    ["", "* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "a b c d e", "5-1 * * * *", "* * 31 2 *"],
)
def test_invalid_expressions_are_rejected(expr):
    with pytest.raises(cron.CronError):
        cron.parse(expr)
        cron.next_run(expr, _at("2026-10-03T00:00:00"))


@pytest.mark.parametrize(
    "expr, text",
    [
        ("*/15 * * * *", "Every 15 minutes"),
        ("* * * * *", "Every minute"),
        ("0 * * * *", "Every hour"),
        ("0 */6 * * *", "Every 6 hours"),
        ("0 9 * * *", "Every day at 09:00"),
        ("30 18 * * 1-5", "Weekdays at 18:30"),
        ("0 9 * * 0", "Every Sunday at 09:00"),
        ("0 0 1 * *", "On day 1 of every month at 00:00"),
    ],
)
def test_describe(expr, text):
    assert cron.describe(expr) == text


def test_describe_falls_back_to_the_expression_for_unusual_schedules():
    assert cron.describe("5,10 3 * 2 *") == "Cron: 5,10 3 * 2 *"


def test_presets_are_all_valid():
    for p in cron.PRESETS:
        cron.parse(p["cron"])
        assert cron.describe(p["cron"]) == p["label"]

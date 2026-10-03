"""Five-field cron schedules for passive transcript import.

Supports what people actually write: ``*``, numbers, lists (``1,15``), ranges
(``1-5``) and steps (``*/15``, ``0-30/10``). Day-of-week takes 0-7 with 0 and 7
both Sunday. As in classic cron, when both day-of-month and day-of-week are
restricted, a day matches if either does. Times are evaluated in the collector's
local timezone unless the caller passes an aware datetime in another zone.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

# Simple-English choices shown first in the UI; ``label`` is exactly what
# :func:`describe` returns for ``cron``, so a custom entry that matches a preset
# reads the same.
PRESETS: list[dict[str, str]] = [
    {"id": "15m", "label": "Every 15 minutes", "cron": "*/15 * * * *"},
    {"id": "30m", "label": "Every 30 minutes", "cron": "*/30 * * * *"},
    {"id": "1h", "label": "Every hour", "cron": "0 * * * *"},
    {"id": "6h", "label": "Every 6 hours", "cron": "0 */6 * * *"},
    {"id": "daily", "label": "Every day at 09:00", "cron": "0 9 * * *"},
    {"id": "weekdays", "label": "Weekdays at 18:00", "cron": "0 18 * * 1-5"},
]

DEFAULT_CRON = "0 * * * *"

_FIELDS = (("minute", 0, 59), ("hour", 0, 23), ("day of month", 1, 31), ("month", 1, 12), ("day of week", 0, 7))
_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
# Far enough to cross any leap-day-only schedule; a valid spec that never fires
# (e.g. Feb 31) is rejected at parse time instead.
_HORIZON_DAYS = 366 * 5


class CronError(ValueError):
    """The expression isn't a valid five-field cron schedule."""


@dataclass(frozen=True)
class Spec:
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 = Sunday
    dom_any: bool
    dow_any: bool


def _field(text: str, name: str, lo: int, hi: int) -> tuple[frozenset[int], bool]:
    out: set[int] = set()
    for part in text.split(","):
        if not part:
            raise CronError(f"empty value in {name}")
        base, _, step_s = part.partition("/")
        step = 1
        if step_s:
            if not step_s.isdigit() or int(step_s) == 0:
                raise CronError(f"bad step '{step_s}' in {name}")
            step = int(step_s)
        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            a, _, b = base.partition("-")
            if not (a.isdigit() and b.isdigit()):
                raise CronError(f"bad range '{base}' in {name}")
            start, end = int(a), int(b)
            if start > end:
                raise CronError(f"range '{base}' runs backwards in {name}")
        elif base.isdigit():
            start = int(base)
            end = hi if step_s else start
        else:
            raise CronError(f"'{base}' isn't a number in {name}")
        if start < lo or end > hi:
            raise CronError(f"{name} must be between {lo} and {hi}")
        out.update(range(start, end + 1, step))
    return frozenset(out), text == "*"


def parse(expr: str) -> Spec:
    parts = (expr or "").split()
    if len(parts) != 5:
        raise CronError("a cron schedule has five fields: minute hour day-of-month month day-of-week")
    vals = [_field(p, *f) for p, f in zip(parts, _FIELDS)]
    weekdays = frozenset(0 if d == 7 else d for d in vals[4][0])
    spec = Spec(vals[0][0], vals[1][0], vals[2][0], vals[3][0], weekdays, vals[2][1], vals[4][1])
    # A day-of-month that no chosen month has (Feb 30) would never run.
    if spec.dow_any and not spec.dom_any:
        longest = {1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}
        if not any(d <= longest[m] for m in spec.months for d in spec.days):
            raise CronError("that day never occurs in the chosen months")
    return spec


def _day_ok(spec: Spec, d: datetime) -> bool:
    if d.month not in spec.months:
        return False
    dom = d.day in spec.days
    dow = (d.isoweekday() % 7) in spec.weekdays
    if spec.dom_any and spec.dow_any:
        return True
    if spec.dom_any:
        return dow
    if spec.dow_any:
        return dom
    return dom or dow


def next_run(expr: str | Spec, after: datetime) -> datetime:
    """The first matching minute strictly after ``after`` (seconds dropped)."""
    spec = parse(expr) if isinstance(expr, str) else expr
    t = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    end = t + timedelta(days=_HORIZON_DAYS)
    hours = sorted(spec.hours)
    minutes = sorted(spec.minutes)
    while t < end:
        if not _day_ok(spec, t):
            t = (t + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        h = next((x for x in hours if x >= t.hour), None)
        if h is None:
            t = (t + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if h > t.hour:
            t = t.replace(hour=h, minute=0)
        m = next((x for x in minutes if x >= t.minute), None)
        if m is None:
            t = (t + timedelta(hours=1)).replace(minute=0)
            continue
        return t.replace(minute=m)
    raise CronError("that schedule never runs")


def _step_of(values: frozenset[int], lo: int, hi: int) -> int | None:
    """N when ``values`` is exactly every Nth value from ``lo``; else None."""
    s = sorted(values)
    if len(s) < 2 or s[0] != lo:
        return None
    step = s[1] - s[0]
    return step if s == list(range(lo, hi + 1, step)) else None


def describe(expr: str) -> str:
    """Plain English for common shapes; anything else reads back as the expression."""
    spec = parse(expr)
    fallback = f"Cron: {' '.join(expr.split())}"
    all_m = len(spec.minutes) == 60
    all_h = len(spec.hours) == 24
    every_day = spec.dom_any and spec.dow_any and len(spec.months) == 12
    if not every_day and not (len(spec.months) == 12 and (spec.dom_any or spec.dow_any)):
        return fallback
    if every_day and all_h:
        if all_m:
            return "Every minute"
        step = _step_of(spec.minutes, 0, 59)
        if step:
            return f"Every {step} minutes"
        if spec.minutes == frozenset({0}):
            return "Every hour"
        return fallback
    if len(spec.minutes) != 1:
        return fallback
    minute = next(iter(spec.minutes))
    if every_day and minute == 0 and not all_h:
        step = _step_of(spec.hours, 0, 23)
        if step:
            return f"Every {step} hours"
    if len(spec.hours) != 1:
        return fallback
    at = f"{next(iter(spec.hours)):02d}:{minute:02d}"
    if every_day:
        return f"Every day at {at}"
    if spec.dom_any:
        if spec.weekdays == frozenset({1, 2, 3, 4, 5}):
            return f"Weekdays at {at}"
        if len(spec.weekdays) == 1:
            return f"Every {_DAYS[next(iter(spec.weekdays))]} at {at}"
        return fallback
    if spec.dow_any and len(spec.days) == 1:
        return f"On day {next(iter(spec.days))} of every month at {at}"
    return fallback

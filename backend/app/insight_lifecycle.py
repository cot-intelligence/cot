"""Persistence seam for insight-finding lifecycle.

Reconciliation (``insights._reconcile``) used to hold a live ``sqlite3``
connection and inline every ``INSERT``/``UPDATE`` against ``insight_findings``.
This module defines the small :class:`FindingsStore` interface reconcile depends
on, so its logic (new / re-detected / auto-resolved) is expressed against an
interface and can be driven by a fake store in tests.

The concrete, SQLite-backed implementation lives in the store itself
(``db.InsightFindingsRepo``); the insights layer no longer opens a connection or
writes SQL directly.
"""

from __future__ import annotations

from typing import Any, Mapping, Protocol


class FindingsStore(Protocol):
    """Persistence operations the lifecycle reconcile depends on."""

    def load(self) -> Mapping[str, Any]:
        """Return all stored findings keyed by fingerprint."""

    def insert(self, finding: Mapping[str, Any], now: str) -> None:
        """Persist a newly-detected finding as ``active`` (first_seen = now)."""

    def refresh(self, finding: Mapping[str, Any], status: str, now: str) -> None:
        """Update a re-detected finding's snapshot and ``last_seen``."""

    def resolve(self, fingerprint: str, now: str) -> Mapping[str, Any]:
        """Mark a finding ``resolved`` and return its refreshed row."""

    def commit(self) -> None:
        """Flush pending writes."""

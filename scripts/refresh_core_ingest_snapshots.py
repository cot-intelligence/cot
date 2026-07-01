#!/usr/bin/env python3
"""Refresh Core Ingest Golden Session projection snapshots."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "backend" / "tests"))

from core_ingest_contract import (  # noqa: E402
    fixture_from_selector,
    iter_core_ingest_fixtures,
    refresh_snapshot,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate Core Ingest expected UI projection snapshots."
    )
    parser.add_argument(
        "--fixture",
        action="append",
        help=(
            "Fixture selector relative to backend/tests/fixtures/core_ingest, "
            "for example codex/live/golden-session. May be repeated."
        ),
    )
    args = parser.parse_args(argv)

    fixtures = (
        [fixture_from_selector(selector) for selector in args.fixture]
        if args.fixture
        else list(iter_core_ingest_fixtures())
    )
    if not fixtures:
        print("No Core Ingest fixtures found.", file=sys.stderr)
        return 1

    for fixture in fixtures:
        refresh_snapshot(fixture)
        print(f"refreshed {fixture.expected_path.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

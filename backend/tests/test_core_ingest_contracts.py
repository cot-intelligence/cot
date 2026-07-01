"""Core Ingest Golden Session contract tests."""

from __future__ import annotations

from core_ingest_contract import (
    assert_projection_matches_snapshot,
    iter_core_ingest_fixtures,
)


def test_codex_golden_session_projection_contracts():
    fixtures = list(iter_core_ingest_fixtures(agent="codex"))
    assert fixtures, "Expected at least one Codex Core Ingest fixture"

    for fixture in fixtures:
        assert_projection_matches_snapshot(fixture)


def _run_all() -> int:
    failed = 0
    for fixture in iter_core_ingest_fixtures(agent="codex"):
        try:
            assert_projection_matches_snapshot(fixture)
            print(f"PASS {fixture.name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fixture.name}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())

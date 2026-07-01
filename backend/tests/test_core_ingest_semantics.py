"""Core Ingest semantic invariant tests for Codex Golden Sessions.

The snapshot contract in ``test_core_ingest_contracts`` proves the whole UI
Ingest Projection has not *changed*; these tests prove the projection is still
*correct* on the specific "major ingest break" criteria from the core ingest
test contracts ADR. Each test names one invariant, so a failure says which part
of the session story broke instead of handing back a 2000-line JSON diff. They
also survive a snapshot refresh: even if a bad projection is baked into the
expected snapshot, a dropped prompt or a miscategorized tool call still fails
here.

Runnable with pytest or directly: ``python backend/tests/test_core_ingest_semantics.py``.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from core_ingest_contract import (
    CoreIngestFixture,
    iter_core_ingest_fixtures,
    render_projection,
)


def _codex_fixtures() -> list[CoreIngestFixture]:
    fixtures = list(iter_core_ingest_fixtures(agent="codex"))
    assert fixtures, "Expected at least one Codex Core Ingest fixture"
    return fixtures


def _category_counts(projection: dict[str, Any]) -> Counter:
    return Counter(e.get("category") for e in projection["events"])


def test_conversation_events_survive_ingest():
    """Prompts, responses, and thoughts must not silently disappear."""
    for fixture in _codex_fixtures():
        counts = _category_counts(render_projection(fixture))
        for cat in ("prompt", "response", "thought"):
            assert counts.get(cat, 0) > 0, (
                f"{fixture.name}: no '{cat}' events survived ingest "
                f"(category counts: {dict(counts)})"
            )


def test_no_events_fall_into_other():
    """Known Codex events must land in a real category, never the 'other' bucket."""
    for fixture in _codex_fixtures():
        proj = render_projection(fixture)
        stray = [e for e in proj["events"] if e.get("category") == "other"]
        assert not stray, (
            f"{fixture.name}: {len(stray)} event(s) miscategorized as 'other' "
            f"(e.g. tool={stray[0].get('tool')!r} title={stray[0].get('title')!r})"
        )


def test_tool_like_events_keep_target_and_status():
    """Tool-like events must keep their target and status so the UI can render them."""
    for fixture in _codex_fixtures():
        proj = render_projection(fixture)
        for cat in ("shell", "file_edit", "tool", "web", "mcp"):
            for e in (ev for ev in proj["events"] if ev.get("category") == cat):
                assert e.get("target"), f"{fixture.name}: {cat} event lost its target: {e}"
                assert e.get("status"), f"{fixture.name}: {cat} event lost its status: {e}"


def test_timeline_pairs_start_and_end_spans():
    """Completed work must merge into a span, and nothing may be both ongoing and ended."""
    for fixture in _codex_fixtures():
        timeline = render_projection(fixture)["timeline"]
        merged = [
            t
            for t in timeline
            if t.get("phase") == "start"
            and t.get("end_ts")
            and t.get("duration_ms") is not None
        ]
        assert merged, (
            f"{fixture.name}: no start/end spans merged — start/end pairing is broken"
        )
        for t in timeline:
            ongoing = bool(t.get("ongoing"))
            ended = t.get("end_ts") is not None
            assert ongoing != ended, (
                f"{fixture.name}: timeline item is both ongoing and ended "
                f"(ongoing={ongoing}, end_ts={t.get('end_ts')!r}): {t.get('title')!r}"
            )


def test_components_reflect_events():
    """Derived UI components must agree with the underlying event stream."""
    for fixture in _codex_fixtures():
        proj = render_projection(fixture)
        counts = _category_counts(proj)
        components = proj["components"]
        assert components["prompt_count"] == counts.get("prompt", 0), (
            f"{fixture.name}: prompt_count {components['prompt_count']} != "
            f"{counts.get('prompt', 0)} prompt events"
        )
        assert components["response_count"] == counts.get("response", 0), (
            f"{fixture.name}: response_count {components['response_count']} != "
            f"{counts.get('response', 0)} response events"
        )
        assert components["shell_count"] == counts.get("shell", 0), (
            f"{fixture.name}: shell_count {components['shell_count']} != "
            f"{counts.get('shell', 0)} shell events"
        )
        edited = {e.get("target") for e in proj["events"] if e.get("category") == "file_edit"}
        component_paths = {f["path"] for f in components["files_edited"]}
        assert component_paths == edited, (
            f"{fixture.name}: files_edited {component_paths} != file_edit targets {edited}"
        )


def test_session_identity_and_ordering():
    """The projection must be for the requested session and ordered by time."""
    for fixture in _codex_fixtures():
        proj = render_projection(fixture)
        assert proj["summary"]["id"] == fixture.session_id, (
            f"{fixture.name}: summary id {proj['summary']['id']!r} != {fixture.session_id!r}"
        )
        timestamps = [e.get("ts") for e in proj["events"]]
        assert timestamps == sorted(timestamps), (
            f"{fixture.name}: events are not in timestamp order"
        )


def test_reingest_is_idempotent():
    """Re-ingesting the same session must not duplicate or alter the projection:
    import idempotency for the history path, live duplicate suppression for the
    live path. A snapshot ingests once and can never catch this."""
    for fixture in _codex_fixtures():
        once = render_projection(fixture, passes=1)
        twice = render_projection(fixture, passes=2)
        assert twice == once, (
            f"{fixture.name}: re-ingest changed the projection — "
            f"import idempotency / live duplicate suppression is broken"
        )


_TESTS = [
    test_conversation_events_survive_ingest,
    test_no_events_fall_into_other,
    test_tool_like_events_keep_target_and_status,
    test_timeline_pairs_start_and_end_spans,
    test_components_reflect_events,
    test_session_identity_and_ordering,
    test_reingest_is_idempotent,
]


def _run_all() -> int:
    failed = 0
    for test in _TESTS:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {test.__name__}: {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())

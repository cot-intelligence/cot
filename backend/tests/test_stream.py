"""Tests for the live-update plumbing: the in-process revision counter that the
SSE endpoint reports and the presence of the /v1/stream route.

Runnable with pytest or directly: ``python3 backend/tests/test_stream.py``.
"""

from __future__ import annotations

import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)

sys.path.insert(0, _BACKEND)
os.environ["COT_DB_PATH"] = os.path.join(tempfile.mkdtemp(prefix="cot-stream-test-"), "s.db")

from app import main  # noqa: E402


def test_bump_revision_advances_counter():
    before = main._revision
    main._bump_revision()
    assert main._revision == before + 1
    main._bump_revision()
    assert main._revision == before + 2


def test_changed_sessions_names_sessions_or_none():
    start = main._revision
    main._bump_revision("b")
    main._bump_revision("a")
    main._bump_revision("b")
    assert main._changed_sessions(start, main._revision) == ["a", "b"]
    mid = main._revision
    main._bump_revision()  # not tied to a session: the client must refetch broadly
    assert main._changed_sessions(mid, main._revision) is None
    # Older than the buffer remembers: unknown.
    assert main._changed_sessions(main._revision - 10_000, main._revision) is None


def test_stream_route_registered():
    paths = {getattr(r, "path", None) for r in main.app.routes}
    assert "/v1/stream" in paths


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")


if __name__ == "__main__":
    _run_all()

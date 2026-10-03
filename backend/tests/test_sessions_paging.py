"""Sessions list paging: offset + has_more over the newest-first list."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import db, store, timeutil  # noqa: F401  (db before main: import cycle)


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _client() -> TestClient:
    from app.main import app

    return TestClient(app, base_url="http://127.0.0.1")


def _seed(n: int, cwd=lambda i: "/code/proj") -> list[str]:
    ids = [f"sess-{i:03d}" for i in range(n)]
    with store.write() as conn:
        for i, sid in enumerate(ids):
            ts = f"2026-09-01T10:{i // 60:02d}:{i % 60:02d}+00:00"
            conn.execute(
                "INSERT INTO sessions (id, source, cwd, started_at, status, created_at)"
                " VALUES (?, 'claude', ?, ?, 'done', ?)",
                (sid, cwd(i), ts, timeutil.now()),
            )
            store.insert_event(conn, session_id=sid, source="claude", ts=ts, created_at=timeutil.now(),
                               hook="UserPromptSubmit", category="prompt", detail=f"task {i}")
            # Event counts rise with i, so sort=events is the reverse of age.
            for k in range(i):
                store.insert_event(conn, session_id=sid, source="claude", ts=ts, created_at=timeutil.now(),
                                   hook="PostToolUse", tool="Bash", phase="instant", category="shell",
                                   target=f"echo {k}", title="Shell command")
    return ids[::-1]  # newest first


def test_pages_cover_every_session_once():
    newest_first = _seed(7)
    client = _client()
    seen, offset = [], 0
    while True:
        body = client.get("/v1/sessions", params={"limit": 3, "offset": offset}).json()
        assert body["total"] == 7
        seen += [s["id"] for s in body["sessions"]]
        offset += 3
        if not body["has_more"]:
            break
    assert seen == newest_first


def test_has_more_is_false_on_an_exact_last_page():
    _seed(3)
    body = _client().get("/v1/sessions", params={"limit": 3}).json()
    assert len(body["sessions"]) == 3 and body["has_more"] is False


def _ids(**params) -> list[str]:
    return [s["id"] for s in _client().get("/v1/sessions", params=params).json()["sessions"]]


def test_search_matches_the_title_across_every_page():
    _seed(30)
    # sess-003's title is its first prompt, "task 3"; it sits far past the first page.
    body = _client().get("/v1/sessions", params={"limit": 5, "q": "task 3"}).json()
    assert [x["id"] for x in body["sessions"]] == ["sess-003"] and body["total"] == 1
    assert _ids(limit=5, q="sess-02") == [f"sess-{n:03d}" for n in range(29, 24, -1)]


def test_project_and_ids_filters_apply_before_paging():
    _seed(6, cwd=lambda i: "/code/alpha" if i % 2 else "/code/beta")
    body = _client().get("/v1/sessions", params={"limit": 2, "project": "alpha"}).json()
    assert body["total"] == 3 and body["has_more"] is True
    assert _ids(limit=50, project="alpha") == ["sess-005", "sess-003", "sess-001"]
    assert _ids(limit=50, ids="sess-000,sess-004") == ["sess-004", "sess-000"]
    assert _client().get("/v1/sessions", params={"ids": ""}).json()["total"] == 0


def test_sorting_happens_before_paging():
    _seed(5)
    assert _ids(limit=2, sort="events") == ["sess-004", "sess-003"]
    assert _ids(limit=2, sort="events", order="asc") == ["sess-000", "sess-001"]
    assert _ids(limit=2, offset=2, sort="events", order="asc") == ["sess-002", "sess-003"]
    assert _ids(limit=2, order="asc") == ["sess-000", "sess-001"]


def test_projects_lists_every_project_with_counts():
    _seed(5, cwd=lambda i: "/code/alpha" if i < 3 else "/code/beta/")
    body = _client().get("/v1/sessions/projects").json()
    assert body["projects"] == [{"project": "alpha", "sessions": 3}, {"project": "beta", "sessions": 2}]

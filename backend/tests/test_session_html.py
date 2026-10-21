"""Branded HTML session export (app/session_html.py): renders the story, masks
secrets and home paths, and is served by the export endpoint."""

from __future__ import annotations

from pathlib import Path

from app import session_html, store, timeutil


def _seed() -> str:
    sid = "sess-html-1"
    home = str(Path.home())
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
            " VALUES (?, 'claude', ?, ?, 'active', 0, ?)",
            (sid, f"{home}/proj", timeutil.now(), timeutil.now()),
        )
        for category, phase, target, detail in (
            ("prompt", "start", None, "Fix it. My key is sk-ant-" + "a1B2" * 8),
            ("shell", "instant", f"cat {home}/proj/.env && ls /tmp/claude-501/-Users-someone-Dev/x", None),
            ("response", "instant", None, "Done:\n- one\n- two\n\n```\ncode <b>\n```"),
        ):
            store.insert_event(
                conn, session_id=sid, source="claude", hook="Stop", phase=phase, ts=timeutil.now(),
                category=category, target=target, detail=detail, created_at=timeutil.now(),
            )
    return sid


def test_render_masks_and_structures(fresh_db):
    page = session_html.render(_seed())
    assert page is not None and page.startswith("<!doctype html>")
    assert "a1B2a1B2a1B2" not in page
    assert str(Path.home()) not in page and "someone" not in page
    assert "<ul><li>one</li><li>two</li></ul>" in page
    assert "<pre>code &lt;b&gt;</pre>" in page
    assert "cot<i>.</i>" in page and "Turn 01" in page


def test_export_endpoint_serves_html(fresh_db):
    from fastapi.testclient import TestClient

    from app import main

    sid = _seed()
    client = TestClient(main.app, base_url="http://127.0.0.1")
    res = client.get(f"/v1/sessions/{sid}/export", params={"format": "html"})
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/html")
    assert "attachment" in res.headers["content-disposition"]
    assert client.get("/v1/sessions/missing/export", params={"format": "html"}).status_code == 404

"""Branded HTML session export (app/session_html.py): renders the full
timeline, suggests possible secrets without hiding anything, and redacts only
what the person picks."""

from __future__ import annotations

from app import session_html, store, timeutil

KEY = "sk-ant-" + "a1B2" * 8


def _seed() -> str:
    sid = "sess-html-1"
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
            " VALUES (?, 'claude', '/proj', ?, 'active', 0, ?)",
            (sid, timeutil.now(), timeutil.now()),
        )
        for category, target, detail in (
            ("prompt", None, f"Fix it. My key is {KEY}"),
            ("thought", None, "Thinking about Acme Corp"),
            ("shell", "psql", '{"command": "psql postgres://admin:s3cr3tpw@db.local/app", "response": {"stdout": "ok"}}'),
            ("response", None, "Done for Acme Corp:\n- one\n- two\n\n```\ncode <b>\n```"),
        ):
            store.insert_event(
                conn, session_id=sid, source="claude", hook="Stop", phase="instant", ts=timeutil.now(),
                category=category, target=target, detail=detail, created_at=timeutil.now(),
            )
    return sid


def test_nothing_hidden_by_default_and_suggestions_listed(fresh_db):
    sid = _seed()
    page = session_html.render(sid)
    assert page is not None and KEY in page and "s3cr3tpw" in page
    assert "<ul><li>one</li><li>two</li></ul>" in page and "<pre>code &lt;b&gt;</pre>" in page
    found = session_html.scan(sid)
    kinds = {f["kind"] for f in found}
    assert {"API token", "Password in a URL"} <= kinds
    assert all(KEY not in f["context"] and "s3cr3tpw" not in f["preview"] for f in found)


def test_redacts_picked_suggestions_and_own_terms(fresh_db):
    sid = _seed()
    url = next(f for f in session_html.scan(sid) if f["kind"] == "Password in a URL")
    page = session_html.render(sid, redact=[url["id"]], terms=["acme corp"])
    assert "s3cr3tpw" not in page and KEY in page
    assert "Acme Corp" not in page and "[redacted]" in page


def test_options_drop_thinking_and_output(fresh_db):
    sid = _seed()
    page = session_html.render(sid, opts=session_html.Options(thoughts=False, outputs=False))
    assert "Thinking about" not in page and "s3cr3tpw" not in page


def test_endpoints(fresh_db):
    from fastapi.testclient import TestClient

    from app import main

    sid = _seed()
    client = TestClient(main.app, base_url="http://127.0.0.1")
    found = client.get(f"/v1/sessions/{sid}/export/scan").json()["suggestions"]
    res = client.post(f"/v1/sessions/{sid}/export/html", json={"redact": [f["id"] for f in found], "terms": []})
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/html")
    assert KEY not in res.text and "s3cr3tpw" not in res.text
    assert client.get(f"/v1/sessions/{sid}/export", params={"format": "html"}).status_code == 200
    assert client.get("/v1/sessions/missing/export/scan").status_code == 404


def test_finder_catches_passwords_and_tokens():
    cases = {
        "export DB_PASSWORD=hunter2hunter": "hunter2hunter",
        "const authToken = 'q8Zr2LmP0xWv'": "q8Zr2LmP0xWv",
        'curl -H "Authorization: Bearer abcDEF123456789xyz" https://x': "abcDEF123456789xyz",
        "mysql --password=Tr0ub4dor --user=a": "Tr0ub4dor",
        '{"api_key": "k_9f8e7d6c5b4a"}': "k_9f8e7d6c5b4a",
        "npm_aBcDeFgHiJkLmNoPqRsTuV123456": "npm_aBcDeFgHiJkLmNoPqRsTuV123456",
        "blob: Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdI": "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdI",
    }
    for text, secret in cases.items():
        assert any(secret in v for _k, v in session_html.find_secrets(text)), text
    pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE\n-----END OPENSSH PRIVATE KEY-----"
    assert session_html.find_secrets(pem)[0][0] == "Private key"


def test_finder_ignores_ordinary_text():
    for text in (
        "commit 9f26e3d1a7c4b2e0f1d3c5b7a9e8f6d4c2b0a1e3",
        '"session_id": "9f26e3d1-e7f0-41e2-8c80-e46c458f6652"',
        '{"input_tokens": 1200, "token_count": 5}',
        '"cache_write_tokens": row["cw"]',
        "def build_timeline_items_from_events(events):",
        "password = $DB_PASSWORD",
        "S=/private/tmp/claude-501/-Users-someone-Dev-cot-intelligence/2067b252-aa3f/scratchpad",
        "# First pass: group turn boundaries",
        "useQuery({ queryKey: ['x'] })",
        "a multi-thousand-token system prompt",
    ):
        assert session_html.find_secrets(text) == [], text

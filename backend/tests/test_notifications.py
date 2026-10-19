"""New findings land in the notifications inbox; the first pass doesn't flood it."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import db, insights, main


def _finding(fp: str, severity: str = "critical", **extra) -> dict:
    return {
        "fingerprint": fp, "id": "rule", "pillar": "security", "tier": 1, "severity": severity,
        "title": f"Finding {fp}", "detail": "d", "recommendation": "Rotate the key.", "evidence": [], **extra,
    }


def test_new_findings_notify_after_the_first_pass(fresh_db: Path, monkeypatch):
    rules_output: list[dict] = [_finding("old")]
    monkeypatch.setattr(insights, "_dedup", lambda fs: fs)

    def reconcile() -> None:
        with db.insight_findings_repo() as store:
            insights._reconcile(store, [dict(f) for f in rules_output])

    reconcile()  # first pass: history, not news
    assert db.list_notifications()["items"] == []

    rules_output += [_finding("new"), _finding("quiet", severity="info"), _finding("mine", severity="info", user_rule=True)]
    reconcile()
    reconcile()  # re-detection doesn't notify again
    items = db.list_notifications()["items"]
    assert [i["title"] for i in items] == ["Finding mine", "Finding new"]
    assert items[1]["href"] == "#/findings?pillar=security&f=new"
    assert items[1]["body"] == "Rotate the key."

    client = TestClient(main.app, base_url="http://127.0.0.1")
    inbox = client.get("/v1/notifications").json()
    assert inbox["unread"] == 2 and inbox["notify_desktop"] is True
    first_id = min(i["id"] for i in inbox["items"])
    assert [i["id"] for i in client.get(f"/v1/notifications?after={first_id - 1}").json()["items"]] == sorted(i["id"] for i in inbox["items"])
    assert client.post("/v1/notifications/read", json={"ids": [first_id]}).json()["unread"] == 1
    assert client.post("/v1/notifications/read").json()["unread"] == 0
    client.put("/v1/settings", json={"notify_desktop": False})
    assert client.get("/v1/notifications").json()["notify_desktop"] is False


def test_old_finding_links_point_at_the_finding(fresh_db: Path):
    """Notifications queued before links named the finding open it too."""
    with db.store.write() as conn:
        db._insert_notification(conn, kind="finding", title="t", now="2026-10-01T00:00:00Z",
                                href="#/findings?pillar=cost", dedup_key="finding:abc123")
        db._insert_notification(conn, kind="finding", title="u", now="2026-10-01T00:00:00Z",
                                href="#/findings", dedup_key="finding:def456")
    hrefs = sorted(i["href"] for i in db.list_notifications()["items"])
    assert hrefs == ["#/findings?f=def456", "#/findings?pillar=cost&f=abc123"]


def test_single_evidence_findings_open_the_event(fresh_db: Path, monkeypatch):
    """A finding about one command opens that command in its session; one with
    several pieces of evidence opens the finding, which lists them."""
    monkeypatch.setattr(insights, "_dedup", lambda fs: fs)
    one = _finding("one", evidence=[{"session_id": "s1", "event_id": 42}])
    many = _finding("many", evidence=[{"session_id": "s1", "event_id": 1}, {"session_id": "s2", "event_id": 2}])
    whole = _finding("whole", evidence=[{"session_id": "s3"}])
    out: list[dict] = [_finding("old")]

    def reconcile() -> None:
        with db.insight_findings_repo() as store:
            insights._reconcile(store, [dict(f) for f in out])

    reconcile()  # first pass is history
    out += [one, many, whole]
    reconcile()
    hrefs = {i["title"]: i["href"] for i in db.list_notifications()["items"]}
    assert hrefs == {"Finding one": "#/session/s1?e=42", "Finding many": "#/findings?pillar=security&f=many",
                     "Finding whole": "#/session/s3"}

    # An older notification for the same finding is pointed at the event too.
    with db.store.write() as conn:
        conn.execute("UPDATE notifications SET href = '#/findings?pillar=security' WHERE dedup_key = 'finding:one'")
    assert {i["title"]: i["href"] for i in db.list_notifications()["items"]}["Finding one"] == "#/session/s1?e=42"

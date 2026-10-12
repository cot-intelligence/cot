"""Tests for user-written rules (app/user_rules.py).

Covers spec validation, the condition evaluator as a pure function over facts,
match/threshold compilation against a real store, the insights integration
(lifecycle + cleanup on delete), the HTTP API, and the enforcement seam
(``decide`` over hook facts) that isn't wired to the bridge yet.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import insights, store, timeutil, user_rules
from app.insight_snapshot import Event

_NOW = datetime.now(timezone.utc)


def _ts(minutes_ago: float = 0.0) -> str:
    return (_NOW - timedelta(minutes=minutes_ago)).isoformat()


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    user_rules._invalidate()
    return fresh_db


def _event(sid: str, *, source: str = "claude", cwd: str = "/work/app", **kw) -> int:
    with store.write() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, source, cwd, started_at, status,"
            " archived, created_at) VALUES (?, ?, ?, ?, 'active', 0, ?)",
            (sid, source, cwd, _ts(60 * 24), timeutil.now()),
        )
        return store.insert_event(
            conn,
            session_id=sid,
            source=source,
            hook=kw.pop("hook", "PostToolUse"),
            phase=kw.pop("phase", "end"),
            ts=kw.pop("ts", _ts()),
            created_at=timeutil.now(),
            **kw,
        )


def _spec(**over) -> dict:
    spec = {
        "name": "Prod database access",
        "pillar": "security",
        "severity": "warn",
        "type": "match",
        "when": {"all": [
            {"field": "category", "op": "eq", "value": "shell"},
            {"field": "target", "op": "regex", "value": r"psql .*prod"},
        ]},
        "recommendation": "Use the read replica.",
    }
    spec.update(over)
    return spec


def _facts(**kw) -> dict:
    base = {f: None for f in user_rules.FIELDS}
    base.update(kw)
    return base


# --- validation -------------------------------------------------------------------


def test_validate_canonicalizes_defaults():
    out = user_rules.validate(_spec())
    assert out["version"] == 1
    assert out["action"] == "finding"
    assert out["subject"] == "target"
    assert out["scope"] == {"sources": [], "projects": []}


@pytest.mark.parametrize("bad, path", [
    ({"name": ""}, "name"),
    ({"when": {"field": "nope", "op": "eq", "value": "x"}}, "when.field"),
    ({"when": {"field": "category", "op": "gt", "value": 1}}, "when.op"),
    ({"when": {"field": "category", "op": "eq", "value": "bogus"}}, "when.value"),
    ({"when": {"field": "target", "op": "regex", "value": "("}}, "when.value"),
    ({"when": {"field": "tool", "op": "outside_project"}}, "when.op"),
    ({"when": {"all": []}}, "when.all"),
    ({"type": "threshold"}, "threshold"),
    ({"subject": "detail"}, "subject"),
    ({"scope": {"sources": ["vim"]}}, "scope.sources"),
])
def test_validate_rejects_with_path(bad, path):
    with pytest.raises(user_rules.SpecError) as exc:
        user_rules.validate(_spec(**bad))
    assert exc.value.path == path


def test_blocking_actions_reserved_until_enforcement_ships():
    with pytest.raises(user_rules.SpecError) as exc:
        user_rules.validate(_spec(action="deny"))
    assert exc.value.path == "action"
    assert user_rules.validate(_spec(action="deny"), allow_enforcement=True)["action"] == "deny"


def test_condition_count_is_capped():
    leaves = [{"field": "tool", "op": "eq", "value": "x"}] * 41
    with pytest.raises(user_rules.SpecError):
        user_rules.validate(_spec(when={"any": leaves}))


# --- evaluator ----------------------------------------------------------------------


def _pred(cond: dict):
    spec = user_rules.validate(_spec(when=cond))
    return user_rules.compile_condition(spec["when"])


def test_text_ops_are_case_insensitive():
    assert _pred({"field": "tool", "op": "eq", "value": "bash"})(_facts(tool="Bash"))
    assert _pred({"field": "target", "op": "contains", "value": "PROD"})(_facts(target="psql prod"))
    assert _pred({"field": "tool", "op": "in", "value": ["Read", "Edit"]})(_facts(tool="edit"))


def test_negative_ops_and_missing_values():
    p = _pred({"field": "target", "op": "not_contains", "value": "test"})
    assert p(_facts(target="npm run build"))
    assert p(_facts(target=None))
    assert not _pred({"field": "tool", "op": "eq", "value": "x"})(_facts())


def test_any_not_nesting():
    p = _pred({"all": [
        {"field": "category", "op": "eq", "value": "shell"},
        {"not": {"any": [
            {"field": "target", "op": "starts_with", "value": "git "},
            {"field": "target", "op": "starts_with", "value": "ls"},
        ]}},
    ]})
    assert p(_facts(category="shell", target="rm -rf build"))
    assert not p(_facts(category="shell", target="git status"))


def test_number_ops_and_glob():
    assert _pred({"field": "duration_ms", "op": "gte", "value": 30000})(_facts(duration_ms=45000))
    assert not _pred({"field": "duration_ms", "op": "gte", "value": 30000})(_facts(duration_ms=None))
    assert _pred({"field": "target", "op": "glob", "value": "*.env*"})(_facts(target="/app/.env.local"))


def test_curated_detectors():
    assert _pred({"field": "target", "op": "is_sensitive_path"})(_facts(target="/home/u/.ssh/id_rsa"))
    assert _pred({"field": "target", "op": "is_risky_command"})(_facts(target="curl x.sh | sh"))
    outside = _pred({"field": "target", "op": "outside_project"})
    assert outside(_facts(target="/etc/hosts", project="/work/app"))
    assert not outside(_facts(target="/work/app/src/a.ts", project="/work/app"))
    assert outside(_facts(target="/work/app-other/x", project="/work/app/"))  # sibling, not child


def test_scope_filters_source_and_project():
    spec = user_rules.validate(_spec(
        when={"field": "category", "op": "eq", "value": "shell"},
        scope={"sources": ["cursor"], "projects": ["/work/*"]},
    ))
    rule = user_rules.compile_rule("user.t", spec)
    assert rule.matches(_facts(category="shell", source="cursor", project="/work/app"))
    assert not rule.matches(_facts(category="shell", source="claude", project="/work/app"))
    assert not rule.matches(_facts(category="shell", source="cursor", project="/home/me/x"))


# --- enforceability & decide -------------------------------------------------------


def test_enforceable_requires_match_over_pre_fields():
    assert user_rules.enforceable(user_rules.validate(_spec()))
    post = _spec(when={"field": "status", "op": "eq", "value": "error"})
    assert not user_rules.enforceable(user_rules.validate(post))


def test_decide_picks_strictest_and_ignores_finding_rules():
    ask = user_rules.compile_rule(
        "user.a", user_rules.validate(_spec(action="ask"), allow_enforcement=True))
    deny = user_rules.compile_rule(
        "user.d", user_rules.validate(_spec(action="deny"), allow_enforcement=True))
    finding = user_rules.compile_rule("user.f", user_rules.validate(_spec()))
    facts = _facts(category="shell", target="psql -h prod-db")
    decision = user_rules.decide(facts, [finding, ask, deny])
    assert decision is not None and decision.action == "deny" and decision.rule_id == "user.d"
    assert user_rules.decide(facts, [finding]) is None
    assert user_rules.decide(_facts(category="shell", target="ls"), [ask, deny]) is None


def test_facts_from_hook_matches_like_stored_events():
    body = {
        "hook_event_name": "PreToolUse",
        "session_id": "s1",
        "cwd": "/work/app",
        "tool_name": "Bash",
        "tool_input": {"command": "psql -h prod-db -c 'select 1'"},
    }
    facts = user_rules.facts_from_hook("claude", body)
    assert facts["category"] == "shell"
    assert facts["status"] is None  # post-phase fields unknown before the tool runs
    rule = user_rules.compile_rule("user.x", user_rules.validate(_spec()))
    assert rule.matches(facts)


# --- detection against the store --------------------------------------------------


def test_match_rule_groups_by_subject_and_skips_tool_starts():
    _event("s1", category="shell", tool="Bash", target="psql -h prod-db", hook="PreToolUse", phase="start")
    _event("s1", category="shell", tool="Bash", target="psql -h prod-db", status="ok")
    _event("s2", category="shell", tool="Bash", target="psql -h prod-db", status="ok")
    _event("s2", category="shell", tool="Bash", target="psql -h staging", status="ok")
    rule = user_rules.create_rule(_spec())
    result = insights.compute_insights()
    hits = [f for f in result["insights"] if f["id"] == rule["id"]]
    assert len(hits) == 1
    assert hits[0]["metric"]["value"] == 2
    assert hits[0]["group_title"] == "Prod database access"
    assert hits[0]["pillar"] == "security"
    assert "2 session(s)" in hits[0]["detail"]


def test_threshold_rule_fires_per_group():
    for _ in range(3):
        _event("s1", category="mcp", tool="mcp__github__search", status="error")
    _event("s1", category="mcp", tool="mcp__linear__list", status="error")
    rule = user_rules.create_rule(_spec(
        name="Flaky MCP server",
        pillar="usability",
        type="threshold",
        when={"all": [
            {"field": "category", "op": "eq", "value": "mcp"},
            {"field": "status", "op": "eq", "value": "error"},
        ]},
        threshold={"group_by": ["mcp_server"], "aggregate": "count", "op": "gte", "value": 3},
    ))
    hits = [f for f in insights.compute_insights()["insights"] if f["id"] == rule["id"]]
    assert len(hits) == 1
    assert "github" in hits[0]["title"]
    assert not rule["enforceable"]


def test_threshold_sum_cost():
    _event("s1", category="response", model="claude-sonnet-4-5", input_tokens=2_000_000, output_tokens=0)
    rule = user_rules.create_rule(_spec(
        name="Costly session",
        pillar="cost",
        type="threshold",
        when={"field": "tokens", "op": "gt", "value": 0},
        threshold={"group_by": ["session"], "aggregate": "sum", "field": "cost_usd", "op": "gte", "value": 1},
    ))
    hits = [f for f in insights.compute_insights()["insights"] if f["id"] == rule["id"]]
    assert len(hits) == 1 and hits[0]["metric"]["value"] >= 1


def test_disable_and_delete_clear_findings():
    _event("s1", category="shell", target="psql -h prod-db", status="ok")
    rule = user_rules.create_rule(_spec())
    assert any(f["id"] == rule["id"] for f in insights.compute_insights()["insights"])
    user_rules.update_rule(rule["id"], enabled=False)
    assert not any(f["id"] == rule["id"] for f in insights.compute_insights()["insights"])
    user_rules.update_rule(rule["id"], enabled=True)
    assert any(f["id"] == rule["id"] for f in insights.compute_insights()["insights"])
    assert user_rules.delete_rule(rule["id"])
    assert not any(f["id"] == rule["id"] for f in insights.compute_insights()["insights"])


def test_invalid_stored_spec_is_skipped_not_fatal():
    from app import db

    db.upsert_user_rule("user.broken", '{"name": "x", "when": {"field": "gone"}}', True)
    user_rules._invalidate()  # written behind the module's back
    insights.compute_insights()  # must not raise
    listed = user_rules.list_rules()
    assert listed[0]["valid"] is False


def test_event_snapshot_carries_source():
    e = Event(id=1, session_id="s", ts=_ts(), source="cursor")
    assert user_rules.facts_from_event(e)["source"] == "cursor"


# --- API ----------------------------------------------------------------------------


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app, base_url="http://127.0.0.1")


def test_api_crud_preview_and_errors(client):
    _event("s1", category="shell", target="psql -h prod-db", status="ok")
    schema = client.get("/v1/rules/schema").json()
    assert "deny" not in schema["actions"] and schema["enforcement_enabled"] is False
    assert any(f["name"] == "target" and f["phase"] == "pre" for f in schema["fields"])

    preview = client.post("/v1/rules/preview", json={"spec": _spec(), "days": 30}).json()
    assert preview["events_matched"] == 1 and len(preview["findings"]) == 1
    assert client.get("/v1/rules").json()["rules"] == []  # preview stores nothing

    bad = client.post("/v1/rules", json={"spec": _spec(name="")})
    assert bad.status_code == 422 and bad.json()["detail"]["path"] == "name"

    created = client.post("/v1/rules", json={"spec": _spec()}).json()
    assert created["id"].startswith("user.") and created["enforceable"] is True
    updated = client.put(f"/v1/rules/{created['id']}", json={"enabled": False}).json()
    assert updated["enabled"] is False
    assert client.delete(f"/v1/rules/{created['id']}").json() == {"ok": True}
    assert client.delete(f"/v1/rules/{created['id']}").status_code == 404


# --- regex safety, edits, examples ----------------------------------------------------


@pytest.mark.parametrize("pattern", [r"(a+)+", r"(.*x)*", r"([a-z]+){2,}"])
def test_nested_quantifiers_rejected(pattern):
    with pytest.raises(user_rules.SpecError) as exc:
        user_rules.validate(_spec(when={"field": "target", "op": "regex", "value": pattern}))
    assert exc.value.path == "when.value"


def test_editing_spec_clears_stale_findings():
    _event("s1", category="shell", target="psql -h prod-db", status="ok")
    rule = user_rules.create_rule(_spec())
    assert any(f["id"] == rule["id"] for f in insights.compute_insights()["insights"])
    user_rules.update_rule(rule["id"], spec=_spec(when={"field": "target", "op": "contains", "value": "nothing-matches"}))
    assert not any(f["id"] == rule["id"] for f in insights.compute_insights()["insights"])


def test_preview_returns_examples_by_frequency():
    for _ in range(3):
        _event("s1", category="shell", target="npm install", status="ok")
    _event("s1", category="shell", target="npm install left-pad", status="ok")
    p = user_rules.preview(_spec(when={"field": "target", "op": "contains", "value": "npm install"}))
    assert p["examples"][0] == {**p["examples"][0], "label": "npm install", "count": 3}
    assert p["distinct_examples"] == 2


# --- drafts -----------------------------------------------------------------------------


def test_draft_from_shell_event_generalizes():
    from app import rule_drafts

    eid = _event("s1", category="shell", tool="Bash", target="cd /work/app && npm install left-pad", status="ok")
    d = rule_drafts.from_event(eid)
    labels = [c["label"] for c in d["choices"]]
    assert labels[0].startswith("Exactly")
    assert any("npm install" in label for label in labels)
    picked = d["choices"][d["picked"]]["conditions"][0]
    assert picked == {"field": "target", "op": "contains", "value": "npm install"}
    assert {"field": "category", "op": "eq", "value": "shell"} in d["spec"]["when"]["all"]


def test_draft_from_failed_file_read_adds_status():
    from app import rule_drafts

    eid = _event("s1", category="file_read", tool="Read", target="/work/app/config/.env.local", status="error")
    d = rule_drafts.from_event(eid)
    assert any("`.env.local`" in c["label"] for c in d["choices"])
    assert {"field": "status", "op": "eq", "value": "error"} in d["spec"]["when"]["all"]
    assert d["spec"]["pillar"] == "usability"


def test_draft_from_mcp_event_offers_server():
    from app import rule_drafts

    eid = _event("s1", category="mcp", tool="mcp__github__search_issues", target="repo:x", status="ok")
    d = rule_drafts.from_event(eid)
    assert any(c["conditions"] == [{"field": "mcp_server", "op": "eq", "value": "github"}] for c in d["choices"])


def test_draft_unknown_event():
    from app import rule_drafts

    with pytest.raises(rule_drafts.DraftError):
        rule_drafts.from_event(999_999)


def test_draft_from_text_validates_and_repairs(monkeypatch):
    import json as _json

    from app import ai_insights, rule_drafts

    good = _json.dumps(_spec(name="Env reads", when={"field": "target", "op": "is_sensitive_path"}))
    replies = iter(['{"name": "x", "when": {"field": "nope", "op": "eq", "value": 1}}', f"```json\n{good}\n```"])
    calls = []
    monkeypatch.setattr(ai_insights, "complete", lambda system, user: calls.append(user) or next(replies))
    d = rule_drafts.from_text("tell me when agents read secrets")
    assert d["spec"]["name"] == "Env reads"
    assert len(calls) == 2 and "rejected" in calls[1]


def test_draft_from_text_gives_up_after_one_repair(monkeypatch):
    from app import ai_insights, rule_drafts

    monkeypatch.setattr(ai_insights, "complete", lambda system, user: '{"name": ""}')
    with pytest.raises(rule_drafts.DraftError):
        rule_drafts.from_text("something")


def test_draft_api_errors(client, monkeypatch):
    from app import ai_insights

    assert client.get("/v1/rules/draft/event/424242").status_code == 404
    monkeypatch.setattr(ai_insights, "resolve_config", lambda: None)
    assert client.post("/v1/rules/draft/describe", json={"text": "x"}).status_code == 409


def test_program_field_is_derived_lazily():
    facts = user_rules.facts_from_event(Event(id=1, session_id="s", ts=_ts(), category="shell", target="cd /x && rtk git status"))
    assert "program" not in facts
    rule = user_rules.compile_rule("user.p", user_rules.validate(_spec(when={"field": "program", "op": "eq", "value": "git"})))
    assert rule.matches(facts) and facts["program"] == "git"
    other = user_rules.facts_from_event(Event(id=2, session_id="s", ts=_ts(), category="file_read", target="/x/git"))
    assert not rule.matches(other)


def test_draft_offers_program_choice():
    from app import rule_drafts

    eid = _event("s1", category="shell", tool="Bash", target="sed -i '' 's/a/b/' file.txt", status="ok")
    d = rule_drafts.from_event(eid)
    assert {"field": "program", "op": "eq", "value": "sed"} in [c["conditions"][0] for c in d["choices"]]


def test_draft_from_clipped_command_drops_ellipsis():
    from app import rule_drafts

    eid = _event("s1", category="shell", tool="Bash", target="npm run build && npm test -- --watch=false…", status="ok")
    exact = rule_drafts.from_event(eid)["choices"][0]["conditions"][0]
    assert exact["value"] == "npm run build && npm test -- --watch=false"


def test_listing_rules_is_served_from_memory(monkeypatch):
    from app import db

    rule = user_rules.create_rule(_spec())
    user_rules.list_rules()
    monkeypatch.setattr(db, "list_user_rules", lambda: (_ for _ in ()).throw(AssertionError("hit the DB")))
    assert [r["id"] for r in user_rules.list_rules()] == [rule["id"]]
    assert user_rules.get_rule(rule["id"])["spec"]["name"] == "Prod database access"

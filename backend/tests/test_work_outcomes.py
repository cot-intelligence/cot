"""Recent edits, outcomes, session shape, tool-error recovery and the status line."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone

import pytest

from app import edits, outcomes, recovery, session_shape, store, timeutil, usage_line


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _ts(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _session(sid: str, cwd: str = "/p", source: str = "claude") -> None:
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
            (sid, source, cwd, _ts(600), timeutil.now()),
        )


def _event(sid: str, minutes_ago: float, **kw) -> None:
    with store.write() as conn:
        store.insert_event(conn, session_id=sid, source=kw.pop("source", "claude"), ts=_ts(minutes_ago),
                           created_at=timeutil.now(), **kw)


def _edit(sid: str, minutes_ago: float, path: str, inp: dict, status: str = "ok", tool: str = "Edit") -> None:
    _event(sid, minutes_ago, hook="PostToolUse", tool=tool, phase="end", category="file_edit",
           target=path, status=status, detail=json.dumps({"input": inp}))


def _shell(sid: str, minutes_ago: float, command: str, status: str = "ok") -> None:
    _event(sid, minutes_ago, hook="PostToolUse", tool="Bash", phase="end", category="shell",
           target=command, status=status, detail=json.dumps({"command": command}))


def test_line_delta_reads_each_agents_edit_shape():
    assert edits.line_delta(json.dumps({"input": {"old_string": "a\nb", "new_string": "a\nb\nc\n"}})) == (3, 2)
    assert edits.line_delta(json.dumps({"input": {"edits": [{"old_string": "x", "new_string": "y\nz"}]}})) == (2, 1)
    assert edits.line_delta(json.dumps({"input": {"content": "1\n2\n3\n"}})) == (3, 0)
    patch = "*** Begin Patch\n*** Update File: f\n@@\n-old\n+new\n+more\n*** End Patch"
    assert edits.line_delta(json.dumps({"input": {"command": patch}})) == (2, 1)
    assert edits.line_delta("not json") == (0, 0)


def test_recent_edits_group_by_file_newest_first():
    _session("s1")
    _session("s2", cwd="/q", source="cursor")
    _edit("s1", 30, "/p/src/a.py", {"old_string": "x", "new_string": "x\ny"})
    _edit("s1", 20, "/p/src/a.py", {"old_string": "y", "new_string": "z"})
    _edit("s2", 10, "/q/b.md", {"content": "hi\n"}, tool="Write")
    _edit("s1", 5, "/p/src/c.py", {"old_string": "1", "new_string": "2"}, status="error")
    feed = edits.recent(7)
    assert [f["relative"] for f in feed["items"]] == ["src/c.py", "b.md", "src/a.py"]
    a = feed["items"][2]
    assert (a["edits"], a["added"], a["removed"]) == (2, 3, 2)
    # A failed edit counts as a touch but changes no lines.
    assert (feed["items"][0]["failed"], feed["items"][0]["added"]) == (1, 0)
    assert feed["totals"]["projects"] == 2
    assert {f["path"] for f in edits.recent(7, project="/q")["items"]} == {"/q/b.md"}


def _row(command: str, out: str = "", cwd: str = "/p") -> dict:
    return {"id": 1, "session_id": "s", "ts": _ts(1), "cwd": cwd, "command": command,
            "payload": json.dumps({"tool_response": {"stdout": out}})}


def test_shipped_items_parse_each_step_of_a_command():
    kinds = lambda c, o="": [i["kind"] for i in outcomes._items_from(_row(c, o))]  # noqa: E731
    assert kinds("git add . && git commit -m 'x' && git push", "[main abc1234] x") == ["commit", "push"]
    assert kinds("rtk git -C repo commit -am fix", "abc1234 fix") == ["commit"]
    assert kinds("gh pr create --fill; gh pr merge 3 --squash") == ["pr", "merge"]
    assert kinds("gh pr view 3 && git status") == []
    assert kinds("git log | grep commit") == []
    # The exit status was hidden behind a pipe; the output says it didn't happen.
    assert kinds("git push 2>&1 | tail -3", "fatal: Could not read from remote repository.") == []
    assert kinds("git commit -m x", "nothing to commit, working tree clean") == []


def test_shipped_items_carry_links_and_titles():
    pr = outcomes._items_from(_row('gh pr create --title "Add X" --base main',
                                   "https://github.com/acme/app/pull/42\n"))[0]
    assert (pr["url"], pr["number"], pr["title"], pr["base"]) == ("https://github.com/acme/app/pull/42", 42, "Add X", "main")
    merge = outcomes._items_from(_row("R=acme/app; gh pr merge 42 --repo $R --squash"))[0]
    assert merge["url"] == "https://github.com/acme/app/pull/42"
    commit = outcomes._items_from(_row('git commit -m "fix: thing"', "[feat/x 1a2b3c4] fix: thing\n 1 file changed"))[0]
    assert (commit["sha"], commit["branch"], commit["title"]) == ("1a2b3c4", "feat/x", "fix: thing")
    push = outcomes._items_from(_row("git push", "To github.com:acme/app.git\n   1a2b3c4..5d6e7f8  main -> main\n"))[0]
    assert push["url"] == "https://github.com/acme/app/compare/1a2b3c4...5d6e7f8" and push["branch"] == "main"
    # Cursor wraps its output in a JSON string; rtk prints "ok <sha>" for a quiet commit.
    cursor = {**_row("git commit -m x"), "payload": json.dumps({"tool_output": json.dumps({"output": "ok 1 file changed\n9f8e7d6 x\n"})})}
    assert outcomes._items_from(cursor)[0]["sha"] == "9f8e7d6"
    assert outcomes._items_from(_row("rtk git commit -qm y", "ok a1ec536\n"))[0]["sha"] == "a1ec536"
    # No link found: the item still points at the call that did it.
    bare = outcomes._items_from(_row("git commit -m 'only the message'"))[0]
    assert bare["url"] is None and bare["title"] == "only the message" and bare["event_id"] == 1


def test_outcomes_count_shell_actions_per_session_and_project():
    _session("s1")
    _session("s2", cwd="/q")
    _shell("s1", 10, "git add -A && git commit -m one")  # no output recorded: counted from the command
    _shell("s1", 9, "git push origin HEAD")
    _shell("s2", 8, "gh pr create --fill")
    _shell("s2", 7, "git commit -m nope", status="error")
    rows = outcomes.per_session(7, include_git=False)
    assert (rows["s1"]["commits"], rows["s1"]["pushes"]) == (1, 1)
    assert rows["s2"]["prs_opened"] == 1 and rows["s2"]["commits"] == 0
    summary = outcomes.summary(7, include_git=False)
    assert summary["totals"]["sessions_shipped"] == 2
    assert {p["project"] for p in summary["projects"]} == {"/p", "/q"}


def test_git_commits_go_to_the_session_running_when_made(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com", "PATH": "/usr/bin:/bin:/opt/homebrew/bin"}
    subprocess.run(["git", "init", "-q", str(repo)], check=True, env=env)
    (repo / "f.txt").write_text("a\nb\nc\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True, env=env)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "init"], check=True, env=env)
    _session("s1", cwd=str(repo))
    _event("s1", 30, hook="UserPromptSubmit", category="prompt", detail="go")
    _event("s1", 0, hook="Stop", category="response", detail="done")
    got = outcomes.per_session(7, include_git=True)["s1"]
    assert (got["git_commits"], got["added"], got["files"]) == (1, 3, 1)


def test_active_time_splits_on_idle_gaps():
    assert session_shape.segments([0, 60, 120, 1000, 1030]) == [(0, 120), (1000, 1030)]


def test_archetypes_use_floors_until_there_is_a_baseline():
    cuts = session_shape.thresholds([100.0] * 5)
    assert session_shape.archetype(0, 0, cuts) == "automation"
    assert session_shape.archetype(60, 1, cuts) == "quick"
    assert session_shape.archetype(600, 4, cuts) == "standard"
    assert session_shape.archetype(cuts["deep"], 4, cuts) == "deep"
    assert session_shape.archetype(cuts["marathon"] + 1, 9, cuts) == "marathon"
    # With enough history the cut points follow it.
    longer = session_shape.thresholds([float(i * 600) for i in range(1, 41)])
    assert longer["deep"] > cuts["deep"]


def test_session_shape_counts_overlapping_sessions():
    _session("a")
    _session("b")
    for m in (60, 58, 56, 54):
        _event("a", m, hook="UserPromptSubmit", category="prompt", detail="x")
        _event("b", m - 1, hook="UserPromptSubmit", category="prompt", detail="y")
    report = session_shape.report(1)
    assert report["sessions"] == 2
    assert report["concurrency"]["peak"] == 2
    assert 0 < report["concurrency"]["overlap_share"] <= 1
    assert sum(a["count"] for a in report["archetypes"]) == 2


def _tool(sid: str, m: float, tool: str, target: str, status: str, error: str | None = None) -> None:
    _event(sid, m, hook="PostToolUse", tool=tool, phase="end", category="shell", target=target, status=status,
           payload={"error": error} if error else None)


def test_recovery_chains_classify_what_came_next():
    _session("s")
    _tool("s", 10, "Bash", "npm test", "error", "exit 1")
    _tool("s", 9, "Bash", "npm test -- --fix", "ok")       # same tool, new input → recovered (tweak)
    _tool("s", 8, "Read", "/p/a", "error", "missing")
    _tool("s", 7, "Grep", "foo", "error")                   # a search finding nothing is skipped
    _tool("s", 6, "Bash", "ls /p", "ok")                    # another tool working is not a fix
    _tool("s", 5, "Read", "/p/a", "ok")                     # same call again → recovered (retry)
    _tool("s", 4, "Edit", "/p/b", "error", "stale")
    _tool("s", 3, "Bash", "cat /p/b", "ok")                 # only worked around → moved on
    got = recovery.for_session("s")
    assert [c["outcome"] for c in got["chains"]] == ["recovered", "recovered", "moved_on"]
    assert got["chains"][0]["recovered_by"] == "tweak"
    assert [s["kind"] for s in got["chains"][1]["steps"]] == ["switch", "retry"]
    assert got["chains"][0]["error"] == "exit 1"
    _session("t")
    _tool("t", 2, "Bash", "make", "error", "boom")          # nothing after it → abandoned
    summary = recovery.summary(1)
    assert (summary["failures"], summary["recovered"], summary["moved_on"], summary["abandoned"]) == (4, 2, 1, 1)
    assert summary["abandoned_recent"][0]["tool"] == "Bash"


def test_statusline_sums_today_and_the_session():
    _session("s")
    _event("s", 1, hook="Stop", category="response", model="claude-sonnet-4-5", input_tokens=1_000_000, output_tokens=0)
    got = usage_line.summary("s")
    assert got["session_usd"] == got["today_usd"] > 0
    assert got["line"].startswith("cot · session $")


def test_machine_label_rides_on_imported_events():
    from fastapi.testclient import TestClient

    from app import db, main

    client = TestClient(main.app, base_url="http://127.0.0.1")
    body = {"session_id": "m1", "hook_event_name": "UserPromptSubmit", "prompt": "hi", "_import": True,
            "_dedup_key": "k1", "_machine": "devbox"}
    assert client.post("/v1/ingest/claude", json=body).status_code == 200
    client.post("/v1/ingest/claude", json={"session_id": "m2", "hook_event_name": "UserPromptSubmit", "prompt": "yo"})
    by_id = {s["id"]: s for s in db.list_sessions()}
    assert by_id["m1"]["machine"] == "devbox"
    assert "machine" not in by_id["m2"]


def test_semantic_search_ranks_by_vector_and_fuses_with_keywords(monkeypatch):
    from array import array

    from app import semantic

    monkeypatch.setenv("COT_EMBEDDINGS_URL", "http://embed.test/v1")
    monkeypatch.setenv("COT_EMBEDDINGS_MODEL", "m")
    monkeypatch.setenv("COT_EMBEDDINGS_DIM", "16")
    vocab = ["deploy", "staging", "kubernetes", "cooking", "pasta", "recipe"]

    def fake_embed(texts, cfg):
        out = []
        for t in texts:
            v = [float(t.lower().count(w)) for w in vocab] + [0.0] * 10
            out.append(semantic._normalize(v if any(v) else [1.0] + [0.0] * 15, cfg["dim"]))
        return out

    monkeypatch.setattr(semantic, "embed", fake_embed)
    _session("s")
    _event("s", 3, hook="UserPromptSubmit", category="prompt", detail="deploy the service to staging kubernetes")
    _event("s", 2, hook="Stop", category="response", detail="a pasta recipe for cooking")
    cfg = semantic.config()
    semantic._ensure_table()
    assert semantic.index_once(cfg) == 2
    assert semantic.index_once(cfg) == 0  # nothing new
    got = semantic.search("kubernetes staging", 2)
    assert got["results"][0]["category"] == "prompt" and got["indexed"] == 2
    assert isinstance(semantic._index["vecs"], array)
    hybrid = semantic.search("pasta", 2, mode="hybrid")
    assert hybrid["results"][0]["category"] == "response"
    assert semantic.status()["indexed"] == 2


def test_semantic_search_is_off_without_config(monkeypatch):
    from app import semantic

    monkeypatch.delenv("COT_EMBEDDINGS_URL", raising=False)
    assert semantic.config() is None
    assert semantic.search("x")["enabled"] is False
    assert semantic.status() == {"enabled": False}


def test_finding_flags_tools_whose_failures_go_unfixed():
    from app import insights

    # One chain per session: repeated failures inside a session are one unfixed chain.
    for i in range(6):
        _session(f"s{i}")
        _tool(f"s{i}", 30, "Read", f"/p/missing{i}", "error", "no such file")
        _tool(f"s{i}", 29, "Bash", f"cat /p/other{i}", "ok")    # worked around, never fixed
    _session("s")
    _tool("s", 20, "Edit", "/p/a", "error", "stale")
    _tool("s", 19, "Edit", "/p/a", "ok")                          # fixed: too few to flag anyway
    found = [f for f in insights.compute_insights(1)["insights"] if f["id"] == "usability.unfixed_failures"]
    assert [f["title"] for f in found] == ["Read failures usually aren't fixed"]
    assert found[0]["severity"] == "critical" and found[0]["metric"]["value"] == 0
    assert "worked around 6" in found[0]["detail"] and "gave up" not in found[0]["detail"]


def test_sessions_filter_by_kind():
    from fastapi.testclient import TestClient

    from app import main

    _session("quick1")
    _event("quick1", 5, hook="UserPromptSubmit", category="prompt", detail="hi")
    _session("auto1")
    _event("auto1", 5, hook="PostToolUse", tool="Bash", phase="end", category="shell", target="ls", status="ok")
    client = TestClient(main.app, base_url="http://127.0.0.1")
    page = client.get("/v1/sessions", params={"kind": "quick"}).json()
    assert [s["id"] for s in page["sessions"]] == ["quick1"] and page["sessions"][0]["kind"] == "quick"
    assert [s["id"] for s in client.get("/v1/sessions", params={"kind": "automation"}).json()["sessions"]] == ["auto1"]
    assert client.get("/v1/sessions", params={"kind": "marathon"}).json()["total"] == 0
    assert client.get("/v1/sessions/kinds").json()["counts"]["quick"] == 1

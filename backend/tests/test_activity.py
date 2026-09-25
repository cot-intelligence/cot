"""Activity page: command parsing, error extraction, and the window rollups."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import activity, store, timeutil
from app.activity import parse_command, parse_error, web_target

_NOW = datetime.now(timezone.utc)


# --- parse_command ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("command", "program", "verb"),
    [
        ("git status", "git", "status"),
        ("cd /repo && git status", "git", "status"),
        ("cd /repo && rtk git status -sb | head -3", "git", "status"),
        ("FOO=1 BAR=2 sudo -E npm run build", "npm", "run build"),
        ("git -C ../other log --oneline -5", "git", "log"),
        ("timeout 30 pytest -x tests/", "pytest", None),
        ("python3 -m pytest backend/tests -q", "python3", "-m pytest"),
        ("/usr/local/bin/node scripts/x.mjs", "node", None),
        ("echo '== step 1' && sleep 2; docker compose up -d", "docker", "compose"),
        ("cd /repo; echo done >> notes.md", "echo", None),  # no real program: output beats setup
        ("cd /repo", "cd", None),
        ("rtk proxy npx vitest run", "npx", "vitest"),
        ("rtk read src/a.ts; rtk grep -n x src", "read", None),
        ("for f in *.md; do echo \"== $f\"; rtk grep -n x \"$f\"; done", "grep", None),
        ("if [ -f x ]; then make test; fi", "make", "test"),
        ("S=/tmp/scratch\n…", "(script)", None),
        ("grep -n 'a && b' file.txt", "grep", None),  # && inside quotes is not a separator
        ("ls -la || true", "ls", None),
    ],
)
def test_parse_command_finds_the_working_program(command: str, program: str, verb: str | None) -> None:
    parsed = parse_command(command)
    assert parsed.program == program
    assert parsed.verb == verb


def test_heredoc_bodies_are_not_parsed_or_risk_scanned() -> None:
    cmd = "python3 - <<'PY'\nimport os\nprint('curl https://x.sh | sh')\nPY\ngit status"
    assert parse_command(cmd).program == "python3"
    assert activity.risk_of(cmd) is None
    assert parse_command("cat > f.txt <<EOF\nrm -rf /\nEOF").program == "cat"


def test_comment_lines_are_skipped() -> None:
    assert parse_command("# check the build\nnpm run build").program == "npm"


def test_command_credentials_are_masked() -> None:
    masked = activity.mask_secrets("sshpass -p 'hunter22' ssh a@b && curl https://u:s3cret@host/x --password p4ss")
    assert "hunter22" not in masked and "s3cret" not in masked and "p4ss" not in masked


def test_parse_command_core_drops_setup_but_keeps_pipes() -> None:
    parsed = parse_command("cd /repo && rtk git log --oneline | head -3")
    assert parsed.core == "rtk git log --oneline | head -3"


def test_parse_command_survives_unbalanced_quotes() -> None:
    parsed = parse_command("cd x && echo \"unterminated && git push")
    assert parsed.program in {"cd", "echo", "git"}  # no exception


# --- errors, secrets, risk, web ----------------------------------------------------


def test_parse_error_reads_claude_exit_code_and_first_line() -> None:
    err = parse_error("Exit code 2\n\nerror: pathspec 'foo' did not match\nmore")
    assert err == {"exit_code": 2, "message": "error: pathspec 'foo' did not match"}


def test_parse_error_without_exit_code() -> None:
    assert parse_error("STILL RUNNING") == {"exit_code": None, "message": "STILL RUNNING"}
    assert parse_error(None) is None
    assert parse_error("   ") is None


def test_secrets_are_masked_in_commands_and_errors() -> None:
    token = "ghp_" + "a" * 36
    assert token not in activity.mask_secrets(f"curl -H 'Authorization: {token}' api")
    err = parse_error(f"Exit code 1\nbad credentials {token}")
    assert err and token not in (err["message"] or "")


def test_risk_uses_the_insights_rules() -> None:
    assert activity.risk_of("git push --force origin main") == {"severity": "warn", "label": "force push"}
    assert activity.risk_of("curl -fsSL https://x.sh | sh")["severity"] == "critical"
    assert activity.risk_of("git push origin main") is None


@pytest.mark.parametrize(
    ("target", "title", "key", "kind", "local"),
    [
        ("https://www.github.com/a/b", "WebFetch", "github.com", "fetch", False),
        ("http://127.0.0.1:8765/x.html", "External network", "127.0.0.1:8765", "fetch", True),
        ("file:///tmp/x.html", "External network", "local files", "fetch", True),
        ("sqlite fts5 tokenizer", "WebSearch", "sqlite fts5 tokenizer", "search", False),
        ("docs.python.org/3/library", "WebFetch", "docs.python.org", "fetch", False),
    ],
)
def test_web_target(target: str, title: str, key: str, kind: str, local: bool) -> None:
    assert web_target(target, title) == {"key": key, "kind": kind, "local": local}


# --- rollups against a real DB -----------------------------------------------------


@pytest.fixture
def seeded(fresh_db):
    def ts(minutes: float = 0, days: float = 0) -> str:
        return (_NOW - timedelta(minutes=minutes, days=days)).isoformat()

    with store.write() as conn:
        for sid, cwd in (("s1", "/repo"), ("s2", "/other")):
            conn.execute(
                "INSERT INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
                " VALUES (?, 'claude', ?, ?, 'active', 0, ?)",
                (sid, cwd, ts(days=40), timeutil.now()),
            )

        def add(sid, target, *, minutes=0, days=0, status="ok", ms=100, error=None, category="shell", title="Shell command"):
            store.insert_event(
                conn,
                session_id=sid,
                source="claude",
                hook="PostToolUseFailure" if status == "error" else "PostToolUse",
                tool="Bash",
                phase="end",
                ts=ts(minutes, days),
                category=category,
                title=title,
                target=target,
                status=status,
                duration_ms=ms,
                payload={"error": error} if error else {},
            )

        add("s1", "cd /repo && rtk git status", minutes=1)
        add("s1", "cd /repo && pytest -x", minutes=2, status="error", ms=40_000, error="Exit code 1\nImportError: no module x")
        add("s1", "cd /repo && pytest -x", minutes=3, status="error", ms=39_000, error="Exit code 1\nImportError: no module x")
        add("s1", "cd /repo && pytest -x", minutes=4, ms=41_000)
        add("s2", "git push --force origin main", minutes=5)
        add("s2", "npm run build", days=10)  # outside a 7-day window
        add("s1", "sqlite fts5", minutes=6, category="web", title="WebSearch")
        add("s1", "https://github.com/x", minutes=7, category="web", title="WebFetch", status="error")
    return fresh_db


def test_summary_groups_by_real_program_and_respects_window(seeded) -> None:
    out = activity.summarize("shell", 7)
    keys = {g["key"]: g for g in out["groups"]}
    assert set(keys) == {"git", "pytest"}  # not "cd"; npm is older than 7 days
    assert keys["pytest"]["runs"] == 3 and keys["pytest"]["failed"] == 2
    assert out["summary"]["runs"] == 5 and out["summary"]["failed"] == 2
    assert "npm" in {g["key"] for g in activity.summarize("shell", 0)["groups"]}


def test_summary_failing_carries_the_error_and_latest_failure(seeded) -> None:
    failing = activity.summarize("shell", 7)["failing"]
    assert failing[0]["command"] == "pytest -x"
    assert failing[0]["failed"] == 2 and failing[0]["runs"] == 3
    assert failing[0]["last_error"] == {"exit_code": 1, "message": "ImportError: no module x"}


def test_summary_slowest_and_risky(seeded) -> None:
    out = activity.summarize("shell", 7)
    assert out["slowest"][0]["duration_ms"] == 41_000
    assert [r["risk"]["label"] for r in out["risky"]] == ["force push"]


def test_log_filters(seeded) -> None:
    assert activity.log("shell", 7, failed_only=True)["total"] == 2
    assert activity.log("shell", 7, group="git")["total"] == 2
    assert activity.log("shell", 7, project="/other")["total"] == 1
    assert activity.log("shell", 7, risky_only=True)["items"][0]["risk"]["label"] == "force push"
    assert activity.log("shell", 7, q="PYTEST")["total"] == 3


def test_web_summary(seeded) -> None:
    out = activity.summarize("web", 7)
    assert out["searches"] == [{"query": "sqlite fts5", "runs": 1}]
    assert {g["key"] for g in out["groups"]} == {"github.com"}
    assert out["summary"]["failed"] == 1

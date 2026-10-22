"""The projects list groups sessions by project and reads each folder's git details."""

from __future__ import annotations

from pathlib import Path

from app import db, repo_info, store


def _session(conn, sid: str, cwd: str, started: str, source: str = "claude") -> None:
    conn.execute(
        "INSERT INTO sessions (id, source, cwd, started_at, status, created_at) VALUES (?, ?, ?, ?, 'completed', ?)",
        (sid, source, cwd, started, started),
    )
    store.insert_event(conn, session_id=sid, source=source, ts=started, category="prompt", detail=f"prompt {sid}")


def _repo(root: Path, branch: str = "main") -> Path:
    git = root / ".git"
    (git / "logs").mkdir(parents=True)
    (git / "HEAD").write_text(f"ref: refs/heads/{branch}\n")
    (git / "config").write_text(
        '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/x.git\n'
        '[remote "origin"]\n\turl = https://me:ghp_secret@github.com/acme/alpha.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    )
    (git / "logs" / "HEAD").write_text(
        "0000 1111 Me <me@x> 1760000000 +0000\tclone: from github.com\n"
        "1111 2222 Me <me@x> 1760600000 +0530\tcommit: Add the thing\n"
        "2222 3333 Me <me@x> 1760700000 +0530\tcheckout: moving from main to main\n"
    )
    (root / "package.json").write_text("{}")
    return git


def test_describe_reads_branch_remote_and_last_commit(tmp_path: Path):
    _repo(tmp_path / "alpha")
    info = repo_info.describe(str(tmp_path / "alpha"))
    assert info["exists"] is True
    assert info["stacks"] == ["Node"]
    git = info["git"]
    assert git["branch"] == "main"
    assert git["remote"] == "github.com/acme/alpha"  # origin wins, credentials dropped
    assert git["last_commit"] == {"at": 1760600000, "subject": "Add the thing"}
    assert git["worktree_of"] is None


def test_describe_follows_a_worktree_to_its_repo(tmp_path: Path):
    main_git = _repo(tmp_path / "alpha")
    wt_git = main_git / "worktrees" / "alpha-fix"
    (wt_git / "logs").mkdir(parents=True)
    (wt_git / "HEAD").write_text("ref: refs/heads/fix/thing\n")
    (wt_git / "commondir").write_text("../..\n")
    wt = tmp_path / "alpha-fix"
    wt.mkdir()
    (wt / ".git").write_text(f"gitdir: {wt_git}\n")
    git = repo_info.describe(str(wt))["git"]
    assert git["branch"] == "fix/thing"
    assert git["worktree_of"] == "alpha"
    assert git["remote"] == "github.com/acme/alpha"


def test_describe_missing_folder_and_plain_folder(tmp_path: Path):
    assert repo_info.describe(str(tmp_path / "gone")) == {"exists": False}
    (tmp_path / "plain").mkdir()
    assert repo_info.describe(str(tmp_path / "plain")) == {"exists": True, "git": None, "stacks": []}


def test_display_remote_shapes():
    assert repo_info.display_remote("git@github.com:acme/alpha.git") == "github.com/acme/alpha"
    assert repo_info.display_remote("ssh://git@gitlab.com:2222/a/b/c.git") == "gitlab.com/a/b/c"
    assert repo_info.display_remote("https://tok@bitbucket.org/a/b") == "bitbucket.org/a/b"


def test_project_list_groups_by_name_newest_folder_first(fresh_db: Path, tmp_path: Path):
    _repo(tmp_path / "alpha")
    with store.write() as conn:
        _session(conn, "a1", "/elsewhere/alpha", "2026-10-01T10:00:00Z")
        _session(conn, "a2", str(tmp_path / "alpha"), "2026-10-15T10:00:00Z", source="codex")
        _session(conn, "b1", "/work/beta", "2026-10-10T11:00:00Z")
    projects = db.project_list(0)
    assert [p["name"] for p in projects] == ["alpha", "beta"]
    alpha = projects[0]
    assert alpha["sessions"] == 2
    assert alpha["agents"] == {"claude": 1, "codex": 1}
    assert alpha["paths"][0] == str(tmp_path / "alpha")
    assert alpha["first_seen"].startswith("2026-10-01")
    assert alpha["location"]["git"]["branch"] == "main"
    assert projects[1]["location"] == {"exists": False}


def test_describe_skips_macos_protected_folders(monkeypatch, tmp_path: Path):
    from app import folders

    monkeypatch.setattr(folders.sys, "platform", "darwin")
    monkeypatch.setattr(folders, "homes", lambda: [tmp_path])
    monkeypatch.setattr(folders, "allowed", lambda: False)
    _repo(tmp_path / "Documents" / "alpha")
    assert repo_info.describe(str(tmp_path / "Documents" / "alpha")) == {"exists": None}
    assert repo_info.describe(str(tmp_path / "Dev")) == {"exists": False}
    # Turned on in Settings › Privacy, the folder is read like any other.
    monkeypatch.setattr(folders, "allowed", lambda: True)
    assert repo_info.describe(str(tmp_path / "Documents" / "alpha"))["exists"] is True

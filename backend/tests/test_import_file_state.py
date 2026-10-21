"""Transcript file identity: unchanged files are skipped unopened, replaced or
rewritten ones are re-read from the start, and the passive import runs the
bridge in the collector's own process."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

from app import passive


@pytest.fixture
def bridge(monkeypatch, tmp_path):
    """The collector's bridge module with its ~/.cot state in a temp dir, and
    the one the passive import loads."""
    monkeypatch.setenv("HOME", str(tmp_path))
    module = passive._load_bridge()
    monkeypatch.setattr(passive, "_load_bridge", lambda: module)
    state = tmp_path / "state"
    monkeypatch.setattr(module, "STATE_DIR", state)
    monkeypatch.setattr(module, "IMPORT_OFFSETS_PATH", state / "import_offsets.json")
    monkeypatch.setattr(module, "IMPORT_FILE_STATE_PATH", state / "import_file_state.json")
    monkeypatch.setattr(module, "IMPORT_PARSER_VERSION_PATH", state / "import_parser_version")
    monkeypatch.setattr(module, "SPOOL_PATH", state / "spool.jsonl")
    monkeypatch.setattr(module, "_FILE_STATE", {})
    return module


@pytest.fixture
def opens(bridge, monkeypatch):
    """Count transcript opens."""
    count = {"n": 0}
    real = bridge._open_rb_nofollow

    def counting(path):
        count["n"] += 1
        return real(path)

    monkeypatch.setattr(bridge, "_open_rb_nofollow", counting)
    return count


def _write(path: Path, lines: list[str]) -> None:
    path.write_text("".join(line + "\n" for line in lines))


def test_unchanged_file_is_skipped_without_opening(bridge, opens, tmp_path):
    f = tmp_path / "t.jsonl"
    _write(f, ['{"a": 1}', '{"a": 2}'])
    offsets: dict = {}
    lines, offsets[str(f)] = bridge._import_read_new_lines(f, offsets)
    assert len(lines) == 2 and opens["n"] == 1
    assert bridge._import_read_new_lines(f, offsets) == ([], offsets[str(f)])
    assert opens["n"] == 1


def test_append_reads_only_new_lines(bridge, tmp_path):
    f = tmp_path / "t.jsonl"
    _write(f, ['{"a": 1}'])
    offsets: dict = {}
    _, offsets[str(f)] = bridge._import_read_new_lines(f, offsets)
    with f.open("a") as fh:
        fh.write('{"a": 2}\n')
    lines, _ = bridge._import_read_new_lines(f, offsets)
    assert lines == ['{"a": 2}']


def test_rewrite_at_same_size_rereads_from_start(bridge, tmp_path):
    f = tmp_path / "t.jsonl"
    _write(f, ['{"a": 1}', '{"a": 2}'])
    offsets: dict = {}
    _, offsets[str(f)] = bridge._import_read_new_lines(f, offsets)
    with f.open("r+") as fh:  # same inode, same size, new bytes
        fh.write('{"b": 9}\n{"b": 8}\n')
    st = f.stat()
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))
    with f.open("a") as fh:
        fh.write('{"c": 3}\n')
    lines, _ = bridge._import_read_new_lines(f, offsets)
    assert lines == ['{"b": 9}', '{"b": 8}', '{"c": 3}']


def test_replaced_file_rereads_from_start(bridge, tmp_path):
    f = tmp_path / "t.jsonl"
    _write(f, ['{"a": 1}', '{"a": 2}'])
    offsets: dict = {}
    _, offsets[str(f)] = bridge._import_read_new_lines(f, offsets)
    replacement = tmp_path / "new.jsonl"
    _write(replacement, ['{"z": 1}', '{"z": 2}', '{"z": 3}'])
    os.replace(replacement, f)  # new inode at the same path
    lines, _ = bridge._import_read_new_lines(f, offsets)
    assert lines == ['{"z": 1}', '{"z": 2}', '{"z": 3}']


def test_identity_is_ignored_when_an_older_bridge_moved_the_offset(bridge, tmp_path):
    f = tmp_path / "t.jsonl"
    _write(f, ['{"a": 1}'])
    offsets: dict = {}
    _, offsets[str(f)] = bridge._import_read_new_lines(f, offsets)
    with f.open("a") as fh:
        fh.write('{"a": 2}\n')
    offsets[str(f)] = f.stat().st_size  # an older bridge consumed the append
    with f.open("a") as fh:
        fh.write('{"a": 3}\n')
    lines, _ = bridge._import_read_new_lines(f, offsets)
    assert lines == ['{"a": 3}']


def test_state_saves_atomically_and_round_trips(bridge, tmp_path):
    f = tmp_path / "t.jsonl"
    _write(f, ['{"a": 1}'])
    offsets = bridge._import_offsets_load()
    _, offsets[str(f)] = bridge._import_read_new_lines(f, offsets)
    bridge._import_offsets_save(offsets)
    state = bridge.STATE_DIR
    assert sorted(p.name for p in state.iterdir()) == ["import_file_state.json", "import_offsets.json"]
    assert json.loads((state / "import_offsets.json").read_text()) == offsets
    assert bridge._import_offsets_load() == offsets
    assert bridge._FILE_STATE[str(f)]["offset"] == offsets[str(f)]


def _claude_home(root: Path) -> Path:
    sid = "33333333-3333-4333-8333-333333333333"
    folder = root / ".claude" / "projects" / "-proj"
    folder.mkdir(parents=True)
    lines = [{"type": "user", "uuid": "p", "sessionId": sid, "cwd": "/proj",
              "timestamp": "2026-06-01T00:00:00Z", "message": {"role": "user", "content": "go"}}]
    for t in range(20):
        lines.append({"type": "assistant", "uuid": f"a{t}", "sessionId": sid,
                      "timestamp": f"2026-06-01T00:{t + 1:02d}:00Z",
                      "message": {"role": "assistant", "content": [
                          {"type": "text", "text": f"step {t}"},
                          {"type": "tool_use", "id": f"t{t}", "name": "Bash", "input": {"command": "ls"}},
                      ]}})
        lines.append({"type": "user", "uuid": f"r{t}", "sessionId": sid,
                      "timestamp": f"2026-06-01T00:{t + 1:02d}:30Z",
                      "message": {"role": "user", "content": [
                          {"type": "tool_result", "tool_use_id": f"t{t}", "content": "ok"}]}})
    path = folder / f"{sid}.jsonl"
    path.write_text("".join(json.dumps(x) + "\n" for x in lines))
    old = path.stat().st_mtime - 3600  # quiet, so the import doesn't hold it back
    os.utime(path, (old, old))
    return root


def test_passive_import_runs_in_process(bridge, fresh_db, monkeypatch, tmp_path):
    home = _claude_home(tmp_path / "home")
    monkeypatch.setenv("COT_IMPORT_HOME", str(home))
    # Per-pass calls that go over HTTP to the collector; none is up in tests.
    monkeypatch.setattr(passive, "self_url", "http://127.0.0.1:9")
    monkeypatch.setattr(bridge, "_reindex_if_parser_changed", lambda: False)
    monkeypatch.setattr(bridge, "_fetch_session_origins", lambda: {})
    monkeypatch.setattr(bridge, "_recover_questions", lambda: 0)
    monkeypatch.setattr(bridge, "_sync_subagent_links", lambda agents, verbose=False: 0)
    changed: list = []
    monkeypatch.setattr(passive, "on_ingest", changed.append)
    passive._state.clear()

    got = passive._import_agent("claude")

    conn = sqlite3.connect(fresh_db)
    stored = conn.execute("SELECT count(*) FROM events WHERE session_id LIKE '3333%'").fetchone()[0]
    conn.close()
    assert got["events"] > 40 and stored > 40
    assert changed and set(changed) == {"33333333-3333-4333-8333-333333333333"}
    assert passive._state["agents"]["claude"]["files_total"] == 1
    assert bridge._INGEST_SINK is None and bridge._PROGRESS_SINK is None
    # A second pass finds nothing new.
    assert passive._import_agent("claude")["events"] == 0

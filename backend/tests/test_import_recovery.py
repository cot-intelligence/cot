"""The transcript import recovers sessions it read before but cot lost, never
brings back a deleted session, and reads Cursor's unterminated last line."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
from pathlib import Path

from app import db

REPO = Path(__file__).resolve().parents[2]
SID = "567ad2cf-959b-41c6-8033-39c9223fdfa0"


def _load(name: str, path: Path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load("cot_bridge_import_recovery_test", REPO / "bridge" / "cot")


def _cursor_transcript(home: Path, *, final_newline: bool) -> Path:
    path = home / ".cursor" / "projects" / "p" / "agent-transcripts" / SID / f"{SID}.jsonl"
    path.parent.mkdir(parents=True)
    lines = [
        {"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>fix it</user_query>"}]}},
        {"role": "assistant", "message": {"content": [{"type": "text", "text": "Fixed."}]}},
    ]
    path.write_text("\n".join(json.dumps(line) for line in lines) + ("\n" if final_newline else ""))
    return path


def _run(monkeypatch, tmp_path, offsets: dict, origins: dict) -> list[dict]:
    posted: list[dict] = []
    monkeypatch.setenv("COT_CURSOR_HOME", str(tmp_path / ".cursor"))
    monkeypatch.setattr(bridge, "_safe_transcript_root", lambda root: root)
    monkeypatch.setattr(bridge, "_post", lambda url, payload: posted.append(payload))
    bridge._import_agent("cursor", None, offsets, origins, verbose=False)
    return posted


def test_reads_cursor_last_line_without_newline(tmp_path, monkeypatch):
    path = _cursor_transcript(tmp_path, final_newline=False)
    offsets: dict = {}
    posted = _run(monkeypatch, tmp_path, offsets, {"other": "import"})
    assert any("Fixed." in json.dumps(p) for p in posted)
    assert offsets[str(path)] == path.stat().st_size


def test_partial_last_line_waits(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text('{"a": 1}\n{"b": ')
    lines, offset = bridge._import_read_new_lines(path, {})
    assert lines == ['{"a": 1}'] and offset == len('{"a": 1}\n')


def test_rereads_a_session_cot_lost(tmp_path, monkeypatch):
    path = _cursor_transcript(tmp_path, final_newline=True)
    done = path.stat().st_size
    # Read before, but the session is gone from cot.
    assert _run(monkeypatch, tmp_path, {str(path): done}, {"other": "import"})
    # Still in cot: nothing new to read.
    assert not _run(monkeypatch, tmp_path, {str(path): done}, {SID: "import"})
    # No origins (collector didn't answer): don't re-read everything.
    assert not _run(monkeypatch, tmp_path, {str(path): done}, {})


def test_never_reimports_a_deleted_session(tmp_path, monkeypatch):
    path = _cursor_transcript(tmp_path, final_newline=True)
    assert not _run(monkeypatch, tmp_path, {str(path): path.stat().st_size}, {SID: "deleted"})
    assert not _run(monkeypatch, tmp_path, {}, {SID: "deleted"})


def test_origins_report_deleted_sessions(fresh_db):
    db.record_audit_event("session.deleted", target="gone")
    assert db.session_origins()["gone"] == "deleted"

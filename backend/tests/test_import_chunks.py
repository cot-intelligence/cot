"""Large transcripts import a chunk at a time with the same result as one
read, and line-keyed dedup stays file-wide across appends and chunks."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def bridge(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    loader = importlib.machinery.SourceFileLoader("cot_bridge_chunks_under_test", str(_REPO / "bridge" / "cot"))
    spec = importlib.util.spec_from_loader("cot_bridge_chunks_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    monkeypatch.setenv("COT_IMPORT_HOME", str(tmp_path))
    return module


def _capture(bridge, monkeypatch) -> list[dict]:
    sent: list[dict] = []

    class Poster:
        def __init__(self, url):
            pass

        def add(self, payload):
            sent.append(payload)

        def flush(self):
            pass

    monkeypatch.setattr(bridge, "_ImportPoster", Poster)
    return sent


def _cursor_line(text: str) -> str:
    return json.dumps({"role": "user", "message": {"content": [
        {"type": "text", "text": f"<user_query>\n{text}\n</user_query>"}]}}) + "\n"


def _cursor_file(home: Path) -> Path:
    d = home / ".cursor" / "projects" / "p" / "agent-transcripts"
    d.mkdir(parents=True)
    return d / "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"


def _claude_file(home: Path, turns: int) -> Path:
    sid = "44444444-4444-4444-8444-444444444444"
    d = home / ".claude" / "projects" / "-p"
    d.mkdir(parents=True)
    lines = [{"type": "user", "uuid": "p", "sessionId": sid, "timestamp": "2026-06-01T00:00:00Z",
              "message": {"role": "user", "content": "go"}}]
    for t in range(turns):
        lines.append({"type": "assistant", "uuid": f"a{t}", "sessionId": sid,
                      "timestamp": "2026-06-01T00:01:00Z",
                      "message": {"role": "assistant", "content": [
                          {"type": "text", "text": f"step {t} " + "x" * 200},
                          {"type": "tool_use", "id": f"t{t}", "name": "Bash", "input": {"command": "ls"}}]}})
        lines.append({"type": "user", "uuid": f"r{t}", "sessionId": sid, "timestamp": "2026-06-01T00:01:30Z",
                      "message": {"role": "user", "content": [
                          {"type": "tool_result", "tool_use_id": f"t{t}", "content": "ok " * 50}]}})
    f = d / f"{sid}.jsonl"
    f.write_text("".join(json.dumps(x) + "\n" for x in lines))
    return f


def _keys(sent: list[dict]) -> list:
    return [(p.get("hook_event_name"), p.get("_dedup_key"), p.get("tool_name"), p.get("prompt"),
             json.dumps(p.get("tool_response"), sort_keys=True)) for p in sent]


def test_chunked_import_matches_one_read(bridge, monkeypatch, tmp_path):
    f = _claude_file(tmp_path, turns=200)
    assert f.stat().st_size > 100_000
    sent = _capture(bridge, monkeypatch)
    bridge._import_agent("claude", None, {}, {}, verbose=False)
    whole = _keys(sent)
    sent.clear()
    bridge._FILE_STATE.clear()
    monkeypatch.setattr(bridge, "_IMPORT_CHUNK_BYTES", 4096)
    offsets: dict = {}
    bridge._import_agent("claude", None, offsets, {}, verbose=False)
    assert _keys(sent) == whole and len(whole) > 400
    assert offsets[str(f)] == f.stat().st_size


def test_cursor_append_keeps_file_wide_line_keys(bridge, monkeypatch, tmp_path):
    f = _cursor_file(tmp_path)
    f.write_text(_cursor_line("first") + _cursor_line("second"))
    sent = _capture(bridge, monkeypatch)
    offsets: dict = {}
    bridge._import_agent("cursor", None, offsets, {}, verbose=False)
    with f.open("a") as fh:
        fh.write(_cursor_line("third"))
    bridge._import_agent("cursor", None, offsets, {}, verbose=False)
    keys = {p["prompt"]: p["_dedup_key"] for p in sent}
    assert keys["third"].endswith(":2:prompt"), keys
    assert len(set(keys.values())) == 3


def test_line_numbers_count_from_the_file_for_offsets_without_them(bridge, monkeypatch, tmp_path):
    """Offsets written before line counts were kept are counted once."""
    f = _cursor_file(tmp_path)
    f.write_text(_cursor_line("first") + "\n" + _cursor_line("second"))
    offsets = {str(f): f.stat().st_size}  # an older bridge read both prompts
    with f.open("a") as fh:
        fh.write(_cursor_line("third"))
    sent = _capture(bridge, monkeypatch)
    bridge._import_agent("cursor", None, offsets, {}, verbose=False)
    assert [p["_dedup_key"].rsplit(":", 2)[-2] for p in sent] == ["2"]


def test_line_longer_than_a_chunk_is_read_whole(bridge, monkeypatch, tmp_path):
    f = _cursor_file(tmp_path)
    f.write_text(_cursor_line("before") + _cursor_line("big " + "z" * 20_000) + _cursor_line("after"))
    monkeypatch.setattr(bridge, "_IMPORT_CHUNK_BYTES", 4096)
    sent = _capture(bridge, monkeypatch)
    offsets: dict = {}
    lines, offset, _, more = bridge._import_read_chunk(f, offsets)
    assert lines and more  # the long line comes back alone, with more behind it
    bridge._import_agent("cursor", None, {}, {}, verbose=False)
    assert [p["prompt"][:3] for p in sent] == ["bef", "big", "aft"]
    assert sent[2]["_dedup_key"].endswith(":2:prompt")


def test_line_past_the_line_cap_is_skipped_not_wedged(bridge, monkeypatch, tmp_path):
    f = _cursor_file(tmp_path)
    f.write_text(_cursor_line("before") + json.dumps({"blob": "z" * 3_000_000}) + "\n" + _cursor_line("after"))
    monkeypatch.setattr(bridge, "_IMPORT_CHUNK_BYTES", 4096)
    monkeypatch.setattr(bridge, "_MAX_LINE_BYTES", 1024 * 1024)
    sent = _capture(bridge, monkeypatch)
    offsets: dict = {}
    bridge._import_agent("cursor", None, offsets, {}, verbose=False)
    assert [p["prompt"] for p in sent] == ["before", "after"]
    assert sent[1]["_dedup_key"].endswith(":2:prompt")
    assert offsets[str(f)] == f.stat().st_size


def test_invalid_utf8_does_not_shift_the_offset(bridge, tmp_path):
    f = tmp_path / "t.jsonl"
    f.write_bytes(b'{"a": "\xff\xfe"}\n{"b": 1}\n')
    offsets: dict = {}
    lines, offset, first, more = bridge._import_read_chunk(f, offsets)
    assert len(lines) == 2 and offset == f.stat().st_size and first == 0 and not more


def test_large_files_are_no_longer_skipped(bridge, monkeypatch, tmp_path):
    f = _claude_file(tmp_path, turns=50)
    monkeypatch.setattr(bridge, "_MAX_TRANSCRIPT_BYTES", 1024)  # the old whole-file cap
    sent = _capture(bridge, monkeypatch)
    bridge._import_agent("claude", None, {}, {}, verbose=False)
    assert len(sent) > 100


def test_unicode_line_separator_inside_a_string_stays_one_line(bridge, tmp_path):
    f = tmp_path / "t.jsonl"
    f.write_text(json.dumps({"text": "a\u2028b"}, ensure_ascii=False) + "\n" + '{"n": 2}\n')
    lines, _, _, _ = bridge._import_read_chunk(f, {})
    assert [json.loads(x) for x in lines] == [{"text": "a\u2028b"}, {"n": 2}]

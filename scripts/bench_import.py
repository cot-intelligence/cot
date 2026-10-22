#!/usr/bin/env python3
"""Time `cot import` end to end against a throwaway collector.

Starts a collector on a free port with a temp HOME and temp DB, copies
transcripts in (or generates synthetic ones), then times three passes with the
real bridge: a full import, a repeat pass with nothing new, and a pass after
appending lines to one transcript. Prints wall time, events stored, events/s,
DB size and peak RSS of both processes.

Never touches the live collector (31337), ~/.cot or the transcripts it copies.

    python3 scripts/bench_import.py                          # synthetic set
    python3 scripts/bench_import.py --sessions 200 --turns 80
    python3 scripts/bench_import.py --transcripts ~/.claude/projects
    python3 scripts/bench_import.py --bridge /path/to/older/cot   # compare bridges
    python3 scripts/bench_import.py --in-process   # the collector's passive path

Paste the table into PRs that touch the import path.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
BRIDGE = REPO / "bridge" / "cot"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _clean_env(home: Path, port: int, journal: str) -> dict[str, str]:
    """The caller's environment minus any COT_* setting, pointed at the sandbox."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("COT_")}
    env.update(
        HOME=str(home),
        COT_DB_PATH=str(home / ".cot" / "cot.db"),
        COT_PORT=str(port),
        COT_ENDPOINT=f"http://127.0.0.1:{port}",
        COT_DB_JOURNAL_MODE=journal,
    )
    return env


def _synthetic(projects: Path, sessions: int, turns: int) -> None:
    """Claude-shaped transcripts: a prompt, then per turn an assistant message
    with thinking, text and a tool call, and the tool result."""
    for s in range(sessions):
        sid = str(uuid.UUID(int=s + 1))
        folder = projects / f"-bench-project-{s % 7}"
        folder.mkdir(parents=True, exist_ok=True)
        lines = [{
            "type": "user", "uuid": f"{sid}-p", "sessionId": sid, "cwd": f"/bench/project-{s % 7}",
            "timestamp": f"2026-06-01T00:{s % 60:02d}:00Z",
            "message": {"role": "user", "content": f"bench prompt {s}"},
        }]
        for t in range(turns):
            ts = f"2026-06-01T{(t // 60) % 24:02d}:{t % 60:02d}:{s % 60:02d}Z"
            tool_id = f"toolu_{s}_{t}"
            lines.append({
                "type": "assistant", "uuid": f"{sid}-a{t}", "sessionId": sid, "timestamp": ts,
                "message": {"role": "assistant", "model": "claude-sonnet-4-5", "content": [
                    {"type": "thinking", "thinking": f"step {t} " + "reasoning " * 20},
                    {"type": "text", "text": f"Running step {t}"},
                    {"type": "tool_use", "id": tool_id, "name": "Bash",
                     "input": {"command": f"echo step {t}"}},
                ], "usage": {"input_tokens": 1200, "output_tokens": 80}},
            })
            lines.append({
                "type": "user", "uuid": f"{sid}-r{t}", "sessionId": sid, "timestamp": ts,
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": tool_id,
                     "content": "output line\n" * 30, "is_error": False},
                ]},
            })
        (folder / f"{sid}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")


def _rss_kb(pid: int) -> int:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True)
        return int(out.stdout.strip() or 0)
    except (OSError, ValueError):
        return 0


class _PeakRss:
    """Samples a process's RSS every 200 ms on a background thread."""

    def __init__(self, pid: int) -> None:
        self.pid, self.peak, self._stop = pid, 0, threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            self.peak = max(self.peak, _rss_kb(self.pid))
            self._stop.wait(0.2)

    def stop(self) -> int:
        self._stop.set()
        self._thread.join()
        return self.peak


def _db_bytes(home: Path) -> int:
    db = home / ".cot" / "cot.db"
    return sum(p.stat().st_size for p in db.parent.glob(db.name + "*") if p.is_file())


def _events(home: Path) -> int:
    conn = sqlite3.connect(f"file:{home / '.cot' / 'cot.db'}?mode=ro", uri=True)
    try:
        return conn.execute("SELECT count(*) FROM events").fetchone()[0]
    finally:
        conn.close()


# The passive path: the collector's own importer, writing to the DB directly.
# It runs in its own process here so its memory is measured on its own, and
# skips the active-session hold-back so every pass sees the whole archive.
_IN_PROCESS = (
    "import sys; from app import passive; passive.ACTIVE_WINDOW_MIN = 0; "
    "passive.self_url = sys.argv[1]; print(passive._import_agent('claude'))"
)


def _run_import(bridge: Path, env: dict[str, str], collector_rss: _PeakRss, in_process: bool) -> dict:
    before = _events(Path(env["HOME"]))
    collector_rss.peak = 0
    started = time.perf_counter()
    cmd = ([sys.executable, "-c", _IN_PROCESS, env["COT_ENDPOINT"]] if in_process
           else [sys.executable, str(bridge), "import", "--agent", "claude"])
    proc = subprocess.Popen(
        cmd, cwd=BACKEND, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    bridge_rss = _PeakRss(proc.pid)
    _, err = proc.communicate()
    wall = time.perf_counter() - started
    if proc.returncode:
        sys.exit(f"cot import failed ({proc.returncode}):\n{err[-2000:]}")
    added = _events(Path(env["HOME"])) - before
    return {
        "wall": wall, "events": added, "rate": added / wall if wall else 0,
        "db": _db_bytes(Path(env["HOME"])), "bridge_rss": bridge_rss.stop(),
        "collector_rss": collector_rss.peak,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--transcripts", type=Path, help="Claude projects folder to copy in (read-only)")
    ap.add_argument("--sessions", type=int, default=40, help="synthetic sessions (default 40)")
    ap.add_argument("--turns", type=int, default=60, help="synthetic tool turns per session (default 60)")
    ap.add_argument("--append", type=int, default=200, help="lines appended before the third pass")
    ap.add_argument("--bridge", type=Path, default=BRIDGE, help="bridge script to time (default: this repo's)")
    ap.add_argument("--in-process", action="store_true",
                    help="time the collector's in-process import instead of `cot import`")
    ap.add_argument("--journal", choices=["wal", "delete"], default="wal",
                    help="SQLite journal mode (default wal, as the desktop app runs)")
    ap.add_argument("--keep", action="store_true", help="keep the sandbox folder for inspection")
    args = ap.parse_args()

    sandbox = Path(tempfile.mkdtemp(prefix="cot-bench-"))
    home = sandbox / "home"
    projects = home / ".claude" / "projects"
    (home / ".cot").mkdir(parents=True)
    if args.transcripts:
        shutil.copytree(args.transcripts.expanduser(), projects,
                        ignore=shutil.ignore_patterns("*.tmp"))
    else:
        _synthetic(projects, args.sessions, args.turns)
    files = sorted(projects.glob("**/*.jsonl"))
    source_bytes = sum(p.stat().st_size for p in files)

    port = _free_port()
    env = _clean_env(home, port, args.journal)
    collector = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
         "--port", str(port), "--log-level", "warning"],
        cwd=BACKEND, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.time() + 60
        while True:
            try:
                urllib.request.urlopen(f"{env['COT_ENDPOINT']}/health", timeout=1).read()
                break
            except OSError:
                if collector.poll() is not None or time.time() > deadline:
                    sys.exit(f"collector never became healthy:\n{(collector.stderr.read() or '')[-2000:]}")
                time.sleep(0.25)
        collector_rss = _PeakRss(collector.pid)

        rows = [("full import", _run_import(args.bridge, env, collector_rss, args.in_process)),
                ("repeat, nothing new", _run_import(args.bridge, env, collector_rss, args.in_process))]

        # Grow the largest transcript with copies of its own tail, as a live
        # session would. Claude dedups on each line's uuid, so the copies get
        # fresh ones to count as new.
        target = max(files, key=lambda p: p.stat().st_size)
        tail = []
        for line in target.read_text().splitlines()[-args.append:]:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict) and obj.get("uuid"):
                obj["uuid"] = str(uuid.uuid4())
            tail.append(json.dumps(obj))
        with target.open("a") as fh:
            fh.write("\n".join(tail) + "\n")
        rows.append((f"append {len(tail)} lines", _run_import(args.bridge, env, collector_rss, args.in_process)))
        collector_rss.stop()
    finally:
        collector.terminate()
        try:
            collector.wait(timeout=10)
        except subprocess.TimeoutExpired:
            collector.kill()

    print(f"importer: {'in-process (direct DB writes)' if args.in_process else args.bridge}")
    print(f"source: {len(files)} transcripts, {source_bytes / 1e6:.1f} MB, journal {args.journal}")
    print(f"{'pass':<22} {'wall s':>8} {'events':>9} {'events/s':>9} {'db MB':>8} {'bridge MB':>10} {'collector MB':>13}")
    for label, r in rows:
        print(f"{label:<22} {r['wall']:>8.2f} {r['events']:>9} {r['rate']:>9.0f} "
              f"{r['db'] / 1e6:>8.1f} {r['bridge_rss'] / 1024:>10.0f} {r['collector_rss'] / 1024:>13.0f}")
    if args.keep:
        print(f"sandbox kept at {sandbox}")
    else:
        shutil.rmtree(sandbox, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

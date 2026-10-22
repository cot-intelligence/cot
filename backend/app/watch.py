"""Import transcripts as they're written, instead of waiting for the schedule.

When passive mode is on, a filesystem watcher (FSEvents on macOS, inotify on
Linux, via ``watchdog``) sees transcript writes under each agent's folder. A
burst of writes is debounced, then the changed agents are imported in-process
with live sessions included (``passive.import_now``). The scheduled pass still
runs as before: it does the analysis, covers agents that keep a database rather
than transcripts (OpenCode, Hermes), and catches anything a dropped event missed.

Without ``watchdog`` installed, or with COT_PASSIVE_WATCH=0, nothing is
watched and the schedule alone imports, as before.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import passive

# Writes this close together are one burst: an agent appends many lines per turn.
DEBOUNCE_S = 1.5
# How long to wait before retrying when a scheduled pass holds the import lock.
BUSY_RETRY_S = 5.0
# Transcript folders under each agent's root. Agents missing here keep a
# database (OpenCode, Hermes) and are left to the schedule.
_WATCH_DIRS = {"claude": "projects", "cursor": "projects", "codex": "sessions"}


class Watcher:
    """Collects changed agents from filesystem events and imports them once
    writes have been quiet for ``debounce_s``."""

    def __init__(self, importer: Callable[[list[str]], bool] | None = None,
                 debounce_s: float = DEBOUNCE_S) -> None:
        self._import = importer or passive.import_now
        self.debounce_s = debounce_s
        self._pending: set[str] = set()
        self._last_event = 0.0
        self._cond = threading.Condition()
        self._observer: Any = None
        self.roots: dict[str, Path] = {}

    def notify(self, agent: str) -> None:
        with self._cond:
            self._pending.add(agent)
            self._last_event = time.monotonic()
            self._cond.notify()

    def _take_quiet_batch(self, stop: threading.Event) -> set[str]:
        """Block until some agents changed and writes have gone quiet."""
        with self._cond:
            while not stop.is_set():
                if self._pending:
                    wait = self._last_event + self.debounce_s - time.monotonic()
                    if wait <= 0:
                        batch, self._pending = self._pending, set()
                        return batch
                    self._cond.wait(wait)
                else:
                    self._cond.wait(1.0)
        return set()

    def run_once(self, stop: threading.Event) -> None:
        batch = self._take_quiet_batch(stop)
        if not batch:
            return
        cfg = passive.config()
        agents = [a for a in cfg["agents"] if a in batch] if cfg["enabled"] else []
        if agents and not self._import(agents):
            # A scheduled pass is running; try again once it's had a moment.
            stop.wait(BUSY_RETRY_S)
            for agent in agents:
                self.notify(agent)

    def start(self, stop: threading.Event | None = None) -> bool:
        """Watch every readable transcript folder. False when ``watchdog`` is
        missing or nothing could be watched."""
        try:
            from watchdog.events import FileSystemEventHandler
            from watchdog.observers import Observer
        except ImportError:
            return False

        watcher = self

        class _Handler(FileSystemEventHandler):
            def __init__(self, agent: str) -> None:
                self.agent = agent

            def on_any_event(self, event: Any) -> None:
                if event.is_directory or event.event_type not in ("created", "modified", "moved"):
                    return
                path = getattr(event, "dest_path", "") or event.src_path
                if str(path).endswith(".jsonl"):
                    watcher.notify(self.agent)

        observer = Observer()
        for agent, sub in _WATCH_DIRS.items():
            root = passive.transcript_root(agent) / sub
            try:
                resolved = root.resolve(strict=True)
                resolved.relative_to(passive._import_home().resolve(strict=True))  # noqa: SLF001
            except (OSError, ValueError):
                continue
            observer.schedule(_Handler(agent), str(resolved), recursive=True)
            self.roots[agent] = resolved
        if not self.roots:
            return False
        observer.daemon = True
        observer.start()
        self._observer = observer
        stop = stop or threading.Event()

        def loop() -> None:
            while not stop.is_set():
                try:
                    self.run_once(stop)
                except Exception:  # noqa: BLE001 - keep the watcher alive
                    stop.wait(BUSY_RETRY_S)

        threading.Thread(target=loop, daemon=True, name="cot-transcript-watch").start()
        return True

    def stop(self) -> None:
        if self._observer is not None:
            self._observer.stop()


def start() -> Watcher | None:
    """Start the watcher unless COT_PASSIVE_WATCH=0 (tests) or COT_PASSIVE_SCHEDULER=0."""
    if os.environ.get("COT_PASSIVE_WATCH", "1") == "0" or os.environ.get("COT_PASSIVE_SCHEDULER", "1") == "0":
        return None
    watcher = Watcher()
    return watcher if watcher.start() else None

"""Which project folders the collector may read.

Several features look inside a session's project folder: git history for
Shipped, the tech stack for Projects, memory files and rules for context cost,
project-level skills and MCP config for Extensions. On macOS, Desktop,
Documents, Downloads, iCloud Drive and external or network volumes are
protected: the first read from any of them makes macOS ask whether cot may
access that folder, out of the blue. So those folders are left alone unless
the person turns on ``read_protected_folders`` in Settings › Privacy, which
asks macOS straight away (see ``request_access``) so the prompt comes with a
reason. Elsewhere, and on other platforms, every folder is readable.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

from . import db

SETTING = "read_protected_folders"
# Relative to the home folder; iCloud Drive lives in Library/Mobile Documents.
PROTECTED = ("Desktop", "Documents", "Downloads", "Library/Mobile Documents")

_cache: dict[str, float | bool] = {"at": -1e9, "on": False}
_CACHE_S = 5.0


def homes() -> list[Path]:
    """The home folder project paths are under. A sandboxed desktop build runs
    with its own HOME and reads the person's real one from COT_IMPORT_HOME."""
    out = [Path.home()]
    real = os.environ.get("COT_IMPORT_HOME")
    if real and Path(real) not in out:
        out.insert(0, Path(real))
    return out


def protected_roots() -> list[Path]:
    return [h / d for h in homes() for d in PROTECTED]


def protected(path: str | os.PathLike[str] | None) -> bool:
    """Whether macOS guards ``path``: under a protected home folder or a mounted volume."""
    if sys.platform != "darwin" or not path:
        return False
    p = Path(path)
    if p.parts[:2] == ("/", "Volumes"):
        return True
    return any(p == root or root in p.parents for root in protected_roots())


def allowed() -> bool:
    """Whether the person turned on reading protected folders (cached briefly:
    this is asked once per project folder in tight loops)."""
    now = time.monotonic()
    if now - float(_cache["at"]) > _CACHE_S:
        _cache.update(at=now, on=db.get_setting(SETTING) == "1")
    return bool(_cache["on"])


def readable(path: str | os.PathLike[str] | None) -> bool:
    """Whether the collector may look inside ``path`` at all."""
    return bool(path) and (not protected(path) or allowed())


def set_allowed(on: bool) -> None:
    db.set_setting(SETTING, "1" if on else "0")
    _cache.update(at=time.monotonic(), on=on)
    db.record_audit_event("settings.privacy.protected_folders", target=SETTING, detail={"enabled": on})
    if on:
        request_access()


def sessions_in_protected() -> int:
    """How many sessions ran in a protected folder: what turning this on adds."""
    if sys.platform != "darwin":
        return 0
    prefixes = [str(r) for r in protected_roots()] + ["/Volumes"]
    clause = " OR ".join("cwd = ? OR cwd LIKE ? ESCAPE '\\'" for _ in prefixes)
    params: list[str] = []
    for p in prefixes:
        params += [p, p.replace("%", r"\%").replace("_", r"\_") + "/%"]
    from . import store

    with store.read() as conn:
        row = conn.execute(f"SELECT COUNT(*) FROM sessions WHERE {clause}", params).fetchone()
    return int(row[0] or 0)


def request_access() -> None:
    """Touch each protected folder that holds a session's project, off-thread,
    so macOS asks now (once per folder), while the person is looking at the
    switch they just turned on, rather than later in the middle of something."""
    from . import store

    def run() -> None:
        try:
            with store.read() as conn:
                cwds = [r[0] for r in conn.execute("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL")]
        except Exception:  # noqa: BLE001 - best effort
            return
        for root in protected_roots():
            if any(c == str(root) or c.startswith(str(root) + os.sep) for c in cwds):
                try:
                    os.listdir(root)
                except OSError:
                    pass

    threading.Thread(target=run, name="cot-protected-folders", daemon=True).start()

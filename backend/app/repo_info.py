"""What a project's folder looks like on disk: whether it is still there, its git
branch, remote and last commit, and which stacks it uses.

Reads the files directly instead of running git, so the projects list stays cheap
with many projects and works where git isn't installed. The collector may not see
the folder at all (a container, another machine, a deleted checkout); then only
``exists: False`` comes back.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from . import folders

# Marker files at the project root, and the stack each one means.
_STACK_MARKERS = (
    ("package.json", "Node"),
    ("pyproject.toml", "Python"),
    ("requirements.txt", "Python"),
    ("setup.py", "Python"),
    ("Cargo.toml", "Rust"),
    ("go.mod", "Go"),
    ("Gemfile", "Ruby"),
    ("pom.xml", "Java"),
    ("build.gradle", "Java"),
    ("build.gradle.kts", "Kotlin"),
    ("Package.swift", "Swift"),
    ("composer.json", "PHP"),
    ("mix.exs", "Elixir"),
    ("deno.json", "Deno"),
    ("Dockerfile", "Docker"),
)


def _stacks(root: Path) -> list[str]:
    try:
        names = set(os.listdir(root))
    except OSError:
        return []
    out: list[str] = []
    for marker, stack in _STACK_MARKERS:
        if marker in names and stack not in out:
            out.append(stack)
    if "Swift" not in out and any(n.endswith(".xcodeproj") for n in names):
        out.append("Swift")
    return out


def _find_git(path: Path) -> tuple[Path, Path] | None:
    """The working tree root and its .git (a directory, or a worktree's file) for ``path``."""
    home = Path.home()
    for d in (path, *path.parents):
        dot = d / ".git"
        if dot.exists():
            return d, dot
        if d == home:
            break
    return None


def _read(p: Path, limit: int = 65536) -> str:
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


def _tail(p: Path, size: int = 8192) -> str:
    try:
        with open(p, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - size))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def _origin_url(config: str) -> str | None:
    """The first remote's url, preferring origin, from a git config file."""
    remotes: dict[str, str] = {}
    current: str | None = None
    for line in config.splitlines():
        s = line.strip()
        m = re.match(r'^\[remote\s+"([^"]+)"\]', s)
        if m:
            current = m.group(1)
            continue
        if s.startswith("["):
            current = None
            continue
        if current and current not in remotes:
            m = re.match(r"^url\s*=\s*(.+)$", s)
            if m:
                remotes[current] = m.group(1).strip()
    return remotes.get("origin") or next(iter(remotes.values()), None)


def display_remote(url: str) -> str:
    """``host/owner/repo`` for a remote url, with any credentials dropped."""
    u = url.strip()
    m = re.match(r"^[\w+.-]+://(?:[^@/]*@)?([^/:]+)(?::\d+)?/(.+)$", u)
    if m:
        host, rest = m.groups()
    else:
        m = re.match(r"^(?:[^@]+@)?([^:/]+):(.+)$", u)  # scp-style git@host:owner/repo
        if not m:
            return re.sub(r"//[^@/]*@", "//", u)
        host, rest = m.groups()
    rest = re.sub(r"\.git/?$", "", rest.strip("/"))
    return f"{host}/{rest}"


def _last_commit(gitdir: Path) -> dict[str, Any] | None:
    """The newest commit in HEAD's reflog: when, and its subject."""
    for line in reversed(_tail(gitdir / "logs" / "HEAD").splitlines()):
        head, _, message = line.partition("\t")
        if not message.startswith("commit"):
            continue
        m = re.search(r"> (\d+) [+-]\d{4}$", head)
        if not m:
            continue
        return {"at": int(m.group(1)), "subject": message.split(": ", 1)[-1].strip()[:200]}
    return None


def git_info(path: Path) -> dict[str, Any] | None:
    found = _find_git(path)
    if not found:
        return None
    root, dot = found
    gitdir, common, worktree_of = dot, dot, None
    if dot.is_file():
        m = re.match(r"^gitdir:\s*(.+)$", _read(dot, 4096).strip())
        if not m:
            return None
        gitdir = (root / m.group(1)).resolve()
        rel = _read(gitdir / "commondir", 4096).strip()
        common = (gitdir / rel).resolve() if rel else gitdir
        if rel:
            worktree_of = common.parent.name
    head = _read(gitdir / "HEAD", 4096).strip()
    branch = head[len("ref: refs/heads/"):] if head.startswith("ref: refs/heads/") else None
    url = _origin_url(_read(common / "config"))
    return {
        "root": str(root),
        "branch": branch,
        "detached": head[:7] if branch is None and re.fullmatch(r"[0-9a-f]{40,64}", head) else None,
        "remote": display_remote(url) if url else None,
        "worktree_of": worktree_of,
        "last_commit": _last_commit(gitdir),
    }


# macOS asks the user before an app reads these, so a projects list would pop a
# permission prompt per folder. Their projects are listed without disk details.
def describe(cwd: str | None) -> dict[str, Any]:
    """Whether ``cwd`` is on this machine, and if so its git details and stacks.
    ``exists`` is None when the folder is one macOS guards and reading those
    is off (see folders.py)."""
    if not cwd:
        return {"exists": False}
    path = Path(cwd)
    if not folders.readable(path):
        return {"exists": None}
    try:
        if not path.is_dir():
            return {"exists": False}
    except OSError:
        return {"exists": False}
    git = git_info(path)
    stacks = _stacks(path) or (_stacks(Path(git["root"])) if git else [])
    return {"exists": True, "git": git, "stacks": stacks}

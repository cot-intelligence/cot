"""Outcomes: what sessions shipped, in commits, pushes and pull requests.

Two sources. The shell commands agents ran (``git commit``, ``git push``,
``gh pr create``, ``gh pr merge``) are always available, Docker included, and
their recorded output names what they made: the PR url ``gh`` prints, the
``[branch sha] subject`` line of a commit, the range a push sent. When the
collector can see a project's repository on disk, ``git log --numstat`` adds
lines and files changed, and each commit goes to the session in that project
that was running when it was made.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from pathlib import Path

from . import repo_info, store
from .activity import _program_and_args, _split_top_level, _tokens, _verb, strip_heredocs

# A commit lands this long after a session's last event and still counts as its work
# (the agent's final `git commit` is often the last thing it does).
_GRACE_S = 300
_GIT_TIMEOUT_S = 5
_GIT_CACHE_S = 120
_git_cache: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
_git_lock = threading.Lock()


def _since(days: int) -> str | None:
    if days <= 0:
        return None
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")


def _epoch(ts: str | None) -> float:
    if not ts:
        return 0.0
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return 0.0


def _git_log(repo: str, since: str) -> list[dict[str, Any]]:
    """Commits in ``repo`` since ``since``, with line and file counts; [] when git can't read it."""
    key = (repo, since[:13])  # an hour bucket keeps the cache warm across polls
    with _git_lock:
        hit = _git_cache.get(key)
    if hit and time.monotonic() - hit[0] < _GIT_CACHE_S:
        return hit[1]
    commits: list[dict[str, Any]] = []
    try:
        out = subprocess.run(
            ["git", "-C", repo, "log", "--all", f"--since={since}Z", "--numstat", "--format=\x1e%H\x1f%ct\x1f%s"],
            capture_output=True, text=True, timeout=_GIT_TIMEOUT_S, check=False,
        )
        if out.returncode == 0:
            for chunk in out.stdout.split("\x1e"):
                lines = chunk.strip().splitlines()
                if not lines or "\x1f" not in lines[0]:
                    continue
                sha, ct, subject = (lines[0].split("\x1f") + ["", ""])[:3]
                added = removed = files = 0
                for line in lines[1:]:
                    parts = line.split("\t")
                    if len(parts) == 3:
                        files += 1
                        added += int(parts[0]) if parts[0].isdigit() else 0
                        removed += int(parts[1]) if parts[1].isdigit() else 0
                commits.append({"sha": sha, "ts": int(ct or 0), "subject": subject,
                                "added": added, "removed": removed, "files": files})
    except (OSError, subprocess.SubprocessError, ValueError):
        commits = []
    with _git_lock:
        if len(_git_cache) > 256:
            _git_cache.clear()
        _git_cache[key] = (time.monotonic(), commits)
    return commits


def _repo_root(cwd: str) -> str | None:
    if not cwd or not os.path.isdir(cwd):
        return None
    try:
        out = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=_GIT_TIMEOUT_S, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None if out.returncode == 0 else None


def blank() -> dict[str, Any]:
    return {"commits": 0, "pushes": 0, "prs_opened": 0, "prs_merged": 0,
            "git_commits": 0, "added": 0, "removed": 0, "files": 0}


_KEYS = {"commit": "commits", "push": "pushes", "pr": "prs_opened", "merge": "prs_merged"}


def _git_commits(since: str | None, session_id: str | None = None) -> list[tuple[str, dict[str, Any]]]:
    """(session id, commit) for each commit in a readable repo made while one of its sessions ran."""
    clauses, params = ["s.cwd IS NOT NULL", "st.first_ts IS NOT NULL"], []
    if since:
        clauses.append("st.last_ts >= ?")
        params.append(since)
    if session_id:
        clauses.append("s.id = ?")
        params.append(session_id)
    with store.read() as conn:
        sessions = conn.execute(
            "SELECT s.id, s.cwd, st.first_ts, st.last_ts FROM sessions s JOIN session_stats st ON st.session_id = s.id"
            f" WHERE {' AND '.join(clauses)}",
            params,
        ).fetchall()
    by_repo: dict[str, list[tuple[float, float, str]]] = defaultdict(list)
    roots: dict[str, str | None] = {}
    for sess in sessions:
        cwd = sess["cwd"]
        if cwd not in roots:
            roots[cwd] = _repo_root(cwd)
        if roots[cwd]:
            by_repo[roots[cwd]].append((_epoch(sess["first_ts"]), _epoch(sess["last_ts"]) + _GRACE_S, sess["id"]))
    found = []
    for repo, spans in by_repo.items():
        start = min(a for a, _b, _id in spans)
        stamp = datetime.fromtimestamp(start, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
        for c in _git_log(repo, stamp):
            # The latest-starting session that covers the commit time made it.
            owner = max((sp for sp in spans if sp[0] <= c["ts"] <= sp[1]), key=lambda sp: sp[0], default=None)
            if owner is not None:
                found.append((owner[2], {**c, "repo": repo}))
    return found


def per_session(days: int = 30, include_git: bool = True, session_id: str | None = None) -> dict[str, dict[str, Any]]:
    since = _since(days)
    out: dict[str, dict[str, Any]] = defaultdict(blank)
    for it in _command_items(since, session_id):
        out[it["session_id"]][_KEYS[it["kind"]]] += 1
    if not include_git:
        return dict(out)

    for sid, c in _git_commits(since, session_id):
        o = out[sid]
        o["git_commits"] += 1
        o["added"] += c["added"]
        o["removed"] += c["removed"]
        o["files"] += c["files"]
    return dict(out)


def summary(days: int = 30, include_git: bool = True) -> dict[str, Any]:
    rows = per_session(days, include_git)
    totals = blank()
    for o in rows.values():
        for k in totals:
            totals[k] += o[k]
    with store.read() as conn:
        cwds = {r["id"]: r["cwd"] for r in conn.execute(
            f"SELECT id, cwd FROM sessions WHERE id IN ({','.join('?' * len(rows))})", list(rows)
        ).fetchall()} if rows else {}
    projects: dict[str, dict[str, Any]] = {}
    for sid, o in rows.items():
        cwd = cwds.get(sid) or ""
        p = projects.setdefault(cwd, {"project": cwd or None, "project_name": os.path.basename(cwd.rstrip("/")) or None,
                                       "sessions": 0, **blank()})
        p["sessions"] += 1
        for k in blank():
            p[k] += o[k]
    shipped = sum(1 for o in rows.values() if o["commits"] or o["git_commits"] or o["prs_opened"])
    return {
        "days": days,
        "totals": {**totals, "sessions_shipped": shipped},
        "projects": sorted(projects.values(), key=lambda p: (p["git_commits"] + p["commits"], p["added"]), reverse=True),
    }


# --- the shipped items themselves -------------------------------------------------

_PR_URL = re.compile(r"https://[\w.-]+/[\w.-]+/[\w.-]+/(?:pull|merge_requests)/(\d+)")
_COMMIT_LINE = re.compile(r"^\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$", re.M)
# `rtk git commit` condenses git's output to "<sha> <subject>", or "ok <sha>" when quiet.
_SHORT_COMMIT_LINE = re.compile(r"^([0-9a-f]{7,40}) (.+)$", re.M)
_OK_COMMIT_LINE = re.compile(r"^ok ([0-9a-f]{7,40})\s*$", re.M)
_PUSH_TO = re.compile(r"^To (\S+)$", re.M)
_PUSH_REF = re.compile(r"^\s*[+*!=-]?\s*([0-9a-f]{7,40})\.\.\.?([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)", re.M)
_PUSH_NEW = re.compile(r"^\s*\*\s+\[new branch\]\s+(\S+)\s+->\s+(\S+)", re.M)
_remotes: dict[str, str | None] = {}


def _web(remote: str | None) -> str | None:
    """https url of a ``host/owner/repo`` remote (or any git url)."""
    if not remote:
        return None
    shown = repo_info.display_remote(remote) if ("://" in remote or "@" in remote or remote.endswith(".git")) else remote
    return f"https://{shown}" if re.match(r"^[\w.-]+\.[a-z]{2,}/[\w.-]+/[\w.-]+$", shown) else None


def _project_web(cwd: str | None) -> str | None:
    if not cwd:
        return None
    if cwd not in _remotes:
        try:
            info = repo_info.git_info(Path(cwd)) if os.path.isdir(cwd) else None
        except OSError:
            info = None
        _remotes[cwd] = _web(info.get("remote")) if info else None
    return _remotes[cwd]


def _output(payload: str | None) -> str:
    """The text a shell call printed, from whichever field its agent records it in."""
    if not payload:
        return ""
    try:
        body = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(body, dict):
        return ""
    parts: list[str] = []
    for key in ("tool_response", "tool_output", "output", "result", "response"):
        v = body.get(key)
        if isinstance(v, str) and v.lstrip().startswith("{"):
            # Cursor's hook sends tool_output as a JSON string: {"output": "..."}.
            try:
                inner = json.loads(v)
            except json.JSONDecodeError:
                inner = None
            if isinstance(inner, dict):
                v = inner
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, dict):
            parts.extend(str(v[k]) for k in ("stdout", "stderr", "output", "aggregated_output", "content") if isinstance(v.get(k), str))
    return "\n".join(parts)[:20000]


def _flag(args: list[str], *names: str) -> str | None:
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(n + "="):
                return a[len(n) + 1:]
    return None


def _split_args(piece: str) -> list[str]:
    try:
        return shlex.split(piece)
    except ValueError:
        return piece.split()


_ASSIGN = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(\S*)$")
_VAR = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?")
# Output that says the step didn't happen, though the command's exit status was
# hidden (`git push 2>&1 | tail`).
_FAILED = re.compile(r"^(?:fatal:|error: failed to push|! \[(?:remote )?rejected\]|GraphQL: |nothing to commit|"
                     r"nothing added to commit|no changes added to commit|a pull request for branch .* already exists)",
                     re.M | re.I)


def _git_operation(payload: str | None) -> dict[str, Any]:
    if not payload or '"gitOperation"' not in payload:
        return {}
    try:
        op = (json.loads(payload).get("tool_response") or {}).get("gitOperation")
    except (json.JSONDecodeError, AttributeError, TypeError):
        return {}
    return op if isinstance(op, dict) else {}


def _items_from(row: Any) -> list[dict[str, Any]]:
    command, out = row["command"] or "", _output(row["payload"])
    failed = bool(_FAILED.search(out))
    op = _git_operation(row["payload"])
    base = {"session_id": row["session_id"], "event_id": row["id"], "ts": row["ts"], "project": row["cwd"],
            "project_name": os.path.basename((row["cwd"] or "").rstrip("/")) or None, "from": "command"}
    # Where the call ran: the shell's directory carries over between calls, so the
    # hook's own cwd beats the session's.
    here = (row["call_cwd"] if "call_cwd" in row.keys() else None) or row["cwd"] or ""
    env: dict[str, str] = {}
    items: list[dict[str, Any]] = []
    for sep, piece in _split_top_level(strip_heredocs(command, keep_shell=True)):
        if sep == "|":
            continue
        args = [_VAR.sub(lambda m: env.get(m.group(1), m.group(0)), a) for a in _split_args(piece)]
        if len(args) == 1 or (len(args) == 2 and args[0] == "export"):
            m = _ASSIGN.match(" ".join(args))
            if m:
                env[m.group(1)] = m.group(2)
                continue
        r = _program_and_args(_tokens(" ".join(shlex.quote(a) for a in args)))
        if r.program == "cd" and r.args:
            here = os.path.normpath(os.path.join(here, os.path.expanduser(r.args[0])))
            continue
        verb = _verb(r.program, r.args)
        where = here
        if r.program == "git" and _flag(r.args, "-C"):
            where = os.path.normpath(os.path.join(here, os.path.expanduser(_flag(r.args, "-C") or "")))
        web = _project_web(where) or _project_web(here) or _project_web(row["cwd"])
        repo = _flag(args, "--repo", "-R")
        if repo:
            web = _web(repo if "/" in repo and "." in repo.split("/")[0] else f"github.com/{repo}") or web
        if r.program == "gh" and verb == "pr":
            rest = [a for a in r.args if not a.startswith("-")]
            sub = rest[1] if len(rest) > 1 else None
            m = _PR_URL.search(out)
            if sub == "create" and not failed:
                items.append({**base, "kind": "pr", "title": _flag(args, "--title", "-t"),
                              "url": m.group(0) if m else None, "number": int(m.group(1)) if m else None,
                              "branch": _flag(args, "--head", "-H"), "base": _flag(args, "--base", "-B")})
            elif sub == "merge" and not failed:
                target = rest[2] if len(rest) > 2 else None
                m = _PR_URL.search(target or "") or m
                number = int(m.group(1)) if m else int(target) if target and target.isdigit() else None
                url = m.group(0) if m else f"{web}/pull/{number}" if number and web else None
                items.append({**base, "kind": "merge", "title": None, "url": url, "number": number})
        elif r.program == "git" and verb == "commit":
            m = _COMMIT_LINE.search(out)
            short = None if m else _SHORT_COMMIT_LINE.search(out)
            quiet = None if m or short else _OK_COMMIT_LINE.search(out)
            sha = m.group(2) if m else short.group(1) if short else quiet.group(1) if quiet else None
            if failed and not sha:
                continue
            subject = (m.group(3) if m else short.group(2) if short else None) or _flag(args, "-m", "--message")
            items.append({**base, "kind": "commit", "title": ((subject or "").strip().splitlines() or [""])[0][:200] or None,
                          "sha": sha, "branch": m.group(1) if m else None,
                          "url": f"{web}/commit/{sha}" if web and sha else None})
        elif r.program == "git" and verb == "push" and not failed:
            to = _PUSH_TO.search(out)
            ref = _PUSH_REF.search(out)
            new = None if ref else _PUSH_NEW.search(out)
            remote_web = _web(to.group(1)) if to else web
            branch = (ref.group(4) if ref else new.group(2) if new else None) or (op.get("push") or {}).get("branch")
            url = (f"{remote_web}/compare/{ref.group(1)}...{ref.group(2)}" if ref and remote_web
                   else f"{remote_web}/tree/{branch}" if branch and remote_web else None)
            items.append({**base, "kind": "push", "title": branch, "branch": branch, "url": url,
                          "range": f"{ref.group(1)}..{ref.group(2)}" if ref else None})
    return items


def _command_items(since: str | None, session_id: str | None = None) -> list[dict[str, Any]]:
    clauses = ["e.category = 'shell'", "e.phase IN ('end', 'instant')", "e.status != 'error'",
               "(e.target LIKE '%git%commit%' OR e.target LIKE '%git%push%' OR e.target LIKE '%gh %pr%')"]
    params: list[Any] = []
    if since:
        clauses.append("e.ts >= ?")
        params.append(since)
    if session_id:
        clauses.append("e.session_id = ?")
        params.append(session_id)
    with store.read() as conn:
        rows = conn.execute(
            "SELECT e.id, e.session_id, e.ts, s.cwd, e.payload,"
            " CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.cwd') END AS call_cwd,"
            " CASE WHEN e.target LIKE '%…' AND json_valid(e.detail) THEN json_extract(e.detail, '$.command')"
            " ELSE e.target END AS command"
            " FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
            f" WHERE {' AND '.join(clauses)}",
            params,
        ).fetchall()
    found = [it for r in rows for it in _items_from(r)]
    # A merge names a number; the PR it merged has the title.
    titles = {(it["url"] or "").rstrip("/"): it["title"] for it in found if it["kind"] == "pr" and it.get("url")}
    for it in found:
        if it["kind"] == "merge" and not it.get("title"):
            it["title"] = titles.get((it.get("url") or "").rstrip("/"))
    return found


def items(days: int = 30, project: str | None = None, session_id: str | None = None,
          kind: str | None = None, include_git: bool = True) -> dict[str, Any]:
    """Everything sessions shipped, newest first: PRs, merges, commits and pushes, with links."""
    since = _since(days)
    found = _command_items(since, session_id)

    if include_git:
        # Commits git saw: fill in lines on the ones a command reported, add the rest.
        by_sha = {it["sha"]: it for it in found if it["kind"] == "commit" and it.get("sha")}
        cwds: dict[str, str | None] = {}
        for sid, c in _git_commits(since, session_id):
            hit = next((it for sha, it in by_sha.items() if c["sha"].startswith(sha)), None)
            lines = {"added": c["added"], "removed": c["removed"], "files": c["files"]}
            if hit is not None:
                hit.update(lines, sha=c["sha"])
                continue
            if sid not in cwds:
                with store.read() as conn:
                    row = conn.execute("SELECT cwd FROM sessions WHERE id = ?", (sid,)).fetchone()
                cwds[sid] = row["cwd"] if row else None
            web = _project_web(c["repo"]) or _project_web(cwds[sid])
            found.append({
                "kind": "commit", "session_id": sid, "event_id": None, "from": "git",
                "ts": datetime.fromtimestamp(c["ts"], timezone.utc).isoformat(), "project": cwds[sid],
                "project_name": os.path.basename((cwds[sid] or "").rstrip("/")) or None,
                "title": c["subject"][:200], "sha": c["sha"], "url": f"{web}/commit/{c['sha']}" if web else None, **lines,
            })
    if project:
        found = [it for it in found if it["project"] == project or it["project_name"] == project]
    counts = {k: sum(1 for it in found if it["kind"] == k) for k in ("pr", "merge", "commit", "push")}
    if kind:
        found = [it for it in found if it["kind"] == kind]
    found.sort(key=lambda it: str(it["ts"] or ""), reverse=True)
    return {"days": days, "counts": counts, "items": found}

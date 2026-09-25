"""Activity: what agents ran in the shell and fetched from the web.

Turns raw shell/web events into answers: which programs agents lean on, what
keeps failing (with the error), what is slow, what is risky. Command parsing is
pure and tested; the endpoints aggregate over the requested time window.

Agents rarely run a bare command. They write ``cd /repo && FOO=1 rtk git status
| head``. Grouping on the first word would file all of that under ``cd``, so
:func:`parse_command` finds the statement that does the work and the program
behind any wrappers.
"""

from __future__ import annotations

import re
import shlex
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

from . import db, store
from .insights import RISKY_COMMAND_PATTERNS, SECRET_PATTERNS, mask_secret

# Prefixes that run the real command rather than being it.
_WRAPPERS = {"sudo", "command", "time", "exec", "nohup", "env", "rtk", "caffeinate", "timeout", "nice"}
# Wrappers that take one argument before the command (``timeout 30 cmd``).
_WRAPPERS_WITH_ARG = {"timeout", "nice"}
# Setup statements that are never the point of a chain (last resort only).
_SETUP = {"cd", "pushd", "popd", "export", "source", ".", "set", "unset", "sleep", "true", ":", "wait"}
# Output-only statements: chosen over setup when a chain has nothing else.
_OUTPUT = {"echo", "printf"}
# Shell control flow: `for f in x; do cmd; done` splits into a header, `do cmd`
# and `done`. Headers and closers are skipped; `do`/`then` prefixes are dropped.
_CONTROL = {"for", "while", "until", "if", "elif", "case", "select", "done", "fi", "esac", "}", "{", "function"}
_CONTROL_PREFIX = {"do", "then", "else", "elif", "{", "(", "!"}
# Programs whose first positional argument is a subcommand worth grouping by.
_SUBCOMMANDS = {
    "git", "gh", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "just",
    "uv", "pip", "pip3", "brew", "poetry", "make", "npx", "bunx", "pnpx", "terraform", "helm",
    "systemctl", "launchctl", "defaults", "xcodebuild", "swift", "dotnet", "mvn", "gradle",
}
# Package-script runners: `npm run build` groups as "run build".
_RUNNERS = {"npm", "pnpm", "yarn", "bun"}
# Global options that consume the next token (`git -C path status`).
_OPTS_WITH_VALUE = {"git": {"-C", "-c"}, "docker": {"-H", "--context"}, "kubectl": {"-n", "--namespace", "--context"}}

_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_EXIT_CODE = re.compile(r"exit(?:ed)?(?: with)?(?: code| status)?\s*[:=]?\s*(-?\d+)\.?", re.IGNORECASE)
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"}
_HEREDOC = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")
# Credentials that show up in commands but not in the Insights secret list.
_COMMAND_SECRETS = [
    re.compile(r"(\bsshpass\s+-p\s*)('[^']*'|\"[^\"]*\"|\S+)"),
    re.compile(r"(--password[=\s]+)('[^']*'|\"[^\"]*\"|\S+)"),
    re.compile(r"(://[^/\s:@]+:)([^@\s/]+)(?=@)"),
    re.compile(r"(\bAuthorization:\s*(?:Bearer|Basic|token)\s+)([A-Za-z0-9._~+/=-]{8,})", re.IGNORECASE),
]

MAX_COMMAND_CHARS = 2000


@dataclass(frozen=True)
class ParsedCommand:
    program: str
    """The program that does the work, e.g. ``git`` for ``cd x && rtk git status``."""
    verb: str | None
    """Its subcommand when it has one worth grouping by (``status``, ``run build``)."""
    core: str
    """The command from the working statement on, with setup (``cd … &&``) dropped."""


def _split_top_level(command: str) -> list[tuple[str, str]]:
    """Split on unquoted ``&&``, ``||``, ``;``, ``|`` and newlines.

    Returns ``(separator_before, text)`` pairs so a pipeline stage can be told
    apart from a new statement. Quotes and backslash escapes are respected;
    anything unbalanced just ends up in the last piece.
    """
    parts: list[tuple[str, str]] = []
    buf: list[str] = []
    sep = ""
    quote: str | None = None
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if quote:
            buf.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < n:
                buf.append(command[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            buf.append(ch)
            buf.append(command[i + 1])
            i += 2
            continue
        two = command[i : i + 2]
        if two in ("&&", "||"):
            parts.append((sep, "".join(buf)))
            buf, sep = [], two
            i += 2
            continue
        if ch in (";", "\n"):
            parts.append((sep, "".join(buf)))
            buf, sep = [], ";"
            i += 1
            continue
        if ch == "|":
            parts.append((sep, "".join(buf)))
            buf, sep = [], "|"
            i += 1
            continue
        buf.append(ch)
        i += 1
    parts.append((sep, "".join(buf)))
    return [(s, t.strip()) for s, t in parts if t.strip()]


def strip_heredocs(command: str) -> str:
    """Drop heredoc bodies, keeping the line that opens them.

    ``python3 - <<'PY'`` is followed by a script, not shell: parsing it as
    statements invents programs, and scanning it for risky commands flags
    strings inside the script.
    """
    out: list[str] = []
    end: str | None = None
    for line in command.split("\n"):
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        out.append(line)
        match = _HEREDOC.search(line)
        if match:
            end = match.group(1)
    return "\n".join(out)


def _tokens(text: str) -> list[str]:
    try:
        return shlex.split(text, comments=True, posix=True)
    except ValueError:
        return [t for t in text.split() if not t.startswith("#")]


def _program_and_args(tokens: list[str]) -> tuple[str, list[str]]:
    i = 0
    while i < len(tokens) and tokens[i] in _CONTROL_PREFIX:
        i += 1
    while i < len(tokens) and _ASSIGNMENT.match(tokens[i]):
        i += 1
    while i < len(tokens) and tokens[i] in _WRAPPERS:
        wrapper = tokens[i]
        i += 1
        if wrapper == "rtk" and i < len(tokens) and tokens[i] == "proxy":
            i += 1  # `rtk proxy <cmd>` runs <cmd> unfiltered
        if wrapper in _WRAPPERS_WITH_ARG and i < len(tokens) and not tokens[i].startswith("-"):
            i += 1  # the duration / priority
        while i < len(tokens) and (tokens[i].startswith("-") or _ASSIGNMENT.match(tokens[i])):
            i += 1  # wrapper flags (`sudo -E`) and `env FOO=1`
    if i >= len(tokens) or tokens[i] == "…":
        return "", []
    program = tokens[i].lstrip("(")
    program = program.rsplit("/", 1)[-1] or program
    return program, tokens[i + 1 :]


def _verb(program: str, args: list[str]) -> str | None:
    if program in ("python", "python3") and len(args) >= 2 and args[0] == "-m":
        return f"-m {args[1]}"
    if program not in _SUBCOMMANDS:
        return None
    takes_value = _OPTS_WITH_VALUE.get(program, set())
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in takes_value:
            i += 2
            continue
        if arg.startswith("-"):
            i += 1
            continue
        if program in _RUNNERS and arg == "run" and i + 1 < len(args):
            return f"run {args[i + 1]}"
        return arg
    return None


def parse_command(command: str) -> ParsedCommand:
    """Find the program that does the work in an agent's shell command."""
    text = strip_heredocs((command or "").strip())
    if not text:
        return ParsedCommand(program="", verb=None, core="")
    pieces = _split_top_level(text)
    # Statements start at a non-pipe separator; a pipe continues the statement.
    # Prefer the first real program, then an echo/printf, then setup like `cd`.
    best: tuple[int, int] | None = None  # (tier, index); lower tier wins
    for idx, (sep, piece) in enumerate(pieces):
        if sep == "|":
            continue
        program, _ = _program_and_args(_tokens(piece))
        if not program or program in _CONTROL:
            continue
        tier = 2 if program in _SETUP else 1 if program in _OUTPUT else 0
        if best is None or tier < best[0]:
            best = (tier, idx)
        if tier == 0:
            break
    if best is None:
        # Only assignments / control flow survived (often a clipped command).
        return ParsedCommand(program="(script)", verb=None, core=text)
    chosen = best[1]
    program, args = _program_and_args(_tokens(pieces[chosen][1]))
    core = " ".join(
        (f"{sep} {piece}" if sep and j > chosen else piece) for j, (sep, piece) in enumerate(pieces) if j >= chosen
    )
    return ParsedCommand(program=program, verb=_verb(program, args), core=core)


def mask_secrets(text: str) -> str:
    """Replace anything that looks like a credential with its masked shape."""
    if not text:
        return text
    for pattern, _severity, _label in SECRET_PATTERNS:
        text = pattern.sub(lambda m: mask_secret(m.group(0)), text)
    for pattern in _COMMAND_SECRETS:
        text = pattern.sub(lambda m: m.group(1) + "******", text)
    return text


def risk_of(command: str) -> dict[str, str] | None:
    """The most severe risky-command rule the command matches (same rules as Insights)."""
    best: dict[str, str] | None = None
    shell_only = strip_heredocs(command)
    for pattern, severity, label in RISKY_COMMAND_PATTERNS:
        if pattern.search(shell_only):
            if best is None or (severity == "critical" and best["severity"] != "critical"):
                best = {"severity": severity, "label": label}
    return best


def parse_error(raw: Any) -> dict[str, Any] | None:
    """Exit code and the first line that explains a failure.

    Claude reports ``"Exit code 1\\n<stderr>"``; other agents may only give a
    status. The message is masked like commands are.
    """
    if not raw:
        return None
    lines = [line.strip() for line in str(raw).splitlines() if line.strip()]
    code: int | None = None
    if lines:
        match = _EXIT_CODE.fullmatch(lines[0])
        if match:
            code = int(match.group(1))
            lines = lines[1:]
    message = lines[0][:300] if lines else None
    if code is None and message is None:
        return None
    return {"exit_code": code, "message": mask_secrets(message) if message else None}


def web_target(target: str, title: str | None) -> dict[str, Any]:
    """Domain (or search query) for a web event, and whether it stayed on this machine."""
    raw = (target or "").strip()
    if (title or "") == "WebSearch" or not raw:
        return {"key": raw or (title or "Search"), "kind": "search", "local": False}
    candidate = raw if re.match(r"^[a-z][\w+.-]*://", raw, re.IGNORECASE) else f"https://{raw}"
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return {"key": raw, "kind": "search", "local": False}
    if parts.scheme == "file":
        return {"key": "local files", "kind": "fetch", "local": True}
    host = (parts.hostname or "").lower()
    if not host or "." not in host and host not in _LOCAL_HOSTS:
        return {"key": raw, "kind": "search", "local": False}
    host = host[4:] if host.startswith("www.") else host
    local = host in _LOCAL_HOSTS
    key = f"{host}:{parts.port}" if local and parts.port else host
    return {"key": key, "kind": "fetch", "local": local}


# --- aggregation ---------------------------------------------------------------

WINDOW_DAYS = (1, 7, 30, 0)  # 0 = all time


def _since(days: int) -> str | None:
    if days <= 0:
        return None
    start = datetime.now(timezone.utc) - timedelta(days=days)
    return start.strftime("%Y-%m-%dT%H:%M:%S")


# Finished events never change, so their parsed form is cached by (DB, event
# id). Parsing is the slow part of a rollup (~150µs per command); the SQL is not.
_PARSED: dict[tuple[str, int], dict[str, Any]] = {}
_PARSED_MAX = 100_000


def _item(row: dict[str, Any], category: str) -> dict[str, Any]:
    key = (str(store.path()), row["id"])
    cached = _PARSED.get(key)
    if cached is None:
        cached = _parse_row(row, category)
        if len(_PARSED) >= _PARSED_MAX:
            _PARSED.clear()
        _PARSED[key] = cached
    return {
        "event_id": row["id"],
        "session_id": row["session_id"],
        "ts": row["ts"],
        "source": row["source"],
        "cwd": row["cwd"],
        "duration_ms": row["duration_ms"],
        "failed": row["status"] == "error",
        **cached,
    }


def _parse_row(row: dict[str, Any], category: str) -> dict[str, Any]:
    """The expensive, per-event part of an item: parse, mask, classify."""
    command = (row["target"] or "")[:MAX_COMMAND_CHARS]
    error = parse_error(row.get("error")) if row["status"] == "error" else None
    base: dict[str, Any] = {"error": error}
    if category == "web":
        web = web_target(command, row["title"])
        return {
            **base,
            "target": mask_secrets(command),
            "key": web["key"],
            "kind": web["kind"],
            "local": web["local"],
            "tool": row["title"],
        }
    is_tool = bool(row["title"]) and row["title"] != "Shell command"
    if is_tool:
        # Grep / Glob searches: the "command" is the pattern.
        masked = mask_secrets(command)
        return {
            **base,
            "target": masked,
            "program": row["title"],
            "verb": None,
            "core": masked,
            "tool": row["title"],
            "risk": None,
        }
    parsed = parse_command(command)
    return {
        **base,
        "target": mask_secrets(command),
        "program": parsed.program or "(unknown)",
        "verb": parsed.verb,
        "core": mask_secrets(parsed.core),
        "tool": None,
        "risk": risk_of(command),
    }


def load(category: str, days: int, project: str | None, source: str | None) -> list[dict[str, Any]]:
    rows = db.activity_rows(category, _since(days), project, source)
    return [_item(r, category) for r in rows]


def _ref(item: dict[str, Any]) -> dict[str, Any]:
    return {"session_id": item["session_id"], "event_id": item["event_id"], "ts": item["ts"]}


def summarize(category: str, days: int, project: str | None = None, source: str | None = None) -> dict[str, Any]:
    items = load(category, days, project, source)
    group_key = "key" if category == "web" else "program"

    groups: dict[str, dict[str, Any]] = {}
    verbs: dict[str, Counter[str]] = defaultdict(Counter)
    for it in items:  # newest first
        if category == "web" and it["kind"] == "search":
            continue  # searches get their own list; groups are domains
        key = it[group_key]
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"key": key, "runs": 0, "failed": 0, "total_ms": 0, "last": _ref(it)}
            if category == "web":
                g["local"] = it["local"]
                g["kind"] = it["kind"]
            else:
                g["tool"] = it["tool"]
        g["runs"] += 1
        g["failed"] += it["failed"]
        g["total_ms"] += it["duration_ms"] or 0
        if category == "shell" and it["verb"]:
            verbs[key][it["verb"]] += 1
    top = sorted(groups.values(), key=lambda g: g["runs"], reverse=True)
    for g in top:
        g["verbs"] = [{"key": v, "runs": c} for v, c in verbs[g["key"]].most_common(4)]

    # Same command failing more than once is the signal; one-offs are noise.
    fail_groups: dict[str, dict[str, Any]] = {}
    for it in items:
        if it.get("tool"):
            continue  # a Grep/Glob that matched nothing is not a failure worth chasing
        norm = " ".join((it.get("core") or it["target"]).split())[:300] if category == "shell" else it["key"]
        f = fail_groups.setdefault(norm, {"command": norm, "runs": 0, "failed": 0, "last_error": None, "last": None})
        f["runs"] += 1
        if it["failed"]:
            f["failed"] += 1
            if f["last"] is None:
                f["last"] = _ref(it)
                f["last_error"] = it["error"]
    failing = sorted(
        (f for f in fail_groups.values() if f["failed"] >= 2 or (f["failed"] == 1 and f["runs"] == 1 and f["last_error"])),
        key=lambda f: (f["failed"], f["runs"]),
        reverse=True,
    )[:8]

    timed = [it for it in items if it["duration_ms"]]
    slowest = [
        {"command": it.get("core") or it["target"], "duration_ms": it["duration_ms"], "failed": it["failed"], **_ref(it)}
        for it in sorted(timed, key=lambda it: it["duration_ms"], reverse=True)[:6]
    ]

    risky = [
        {"command": it["core"], "risk": it["risk"], **_ref(it)} for it in items if category == "shell" and it.get("risk")
    ]

    runs = len(items)
    failed = sum(it["failed"] for it in items)
    projects = Counter(it["cwd"] for it in items if it["cwd"])
    sources = Counter(it["source"] for it in items)
    result: dict[str, Any] = {
        "category": category,
        "days": days,
        "summary": {
            "runs": runs,
            "failed": failed,
            "fail_rate": round(failed / runs, 4) if runs else 0,
            "total_ms": sum(it["duration_ms"] or 0 for it in items),
            "sessions": len({it["session_id"] for it in items}),
            "groups": len(groups),
            "risky": len(risky),
        },
        "groups": top[:24],
        "failing": failing,
        "slowest": slowest,
        "risky": risky[:20],
        "projects": [{"cwd": c, "runs": n} for c, n in projects.most_common(40)],
        "sources": [{"source": s, "runs": n} for s, n in sources.most_common()],
    }
    if category == "web":
        searches = Counter(it["key"] for it in items if it["kind"] == "search")
        result["searches"] = [{"query": q, "runs": n} for q, n in searches.most_common(12)]
        result["summary"]["local"] = sum(1 for it in items if it["local"])
    return result


def log(
    category: str,
    days: int,
    project: str | None = None,
    source: str | None = None,
    q: str | None = None,
    group: str | None = None,
    failed_only: bool = False,
    risky_only: bool = False,
    offset: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    items = load(category, days, project, source)
    group_key = "key" if category == "web" else "program"
    needle = (q or "").strip().lower()
    out = [
        it
        for it in items
        if (not group or it[group_key] == group)
        and (not failed_only or it["failed"])
        and (not risky_only or it.get("risk"))
        and (not needle or needle in it["target"].lower())
    ]
    return {"total": len(out), "items": out[offset : offset + limit]}

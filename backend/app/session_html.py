"""One session as a self-contained, cot-branded HTML page: shareable, printable,
and good enough to use as marketing material.

The whole timeline in order: every prompt, reply and thought in full, and every
tool call with its details (the command and its output, the diff, the file that
was read, the MCP call and its result). Tool details sit in collapsible rows
with an "Expand all" switch.

Nothing is hidden automatically: the person decides. :func:`scan` lists what
might be a password or token (labelled values, auth headers, URL credentials,
CLI flags, key blocks, known token prefixes, long random-looking strings) as
suggestions for the export dialog, and :func:`render` redacts only the
suggestions they picked and the words they added.
"""

from __future__ import annotations

import hashlib
import html
import json
import math
import re
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Iterable

from . import __version__, db, session_read, timeutil

# One step's detail beyond this keeps its head and tail (a 2MB file read would
# otherwise dwarf the page).
DETAIL_CHARS = 30000

_AGENT = {"claude": "Claude Code", "cursor": "Cursor", "codex": "Codex", "opencode": "OpenCode", "hermes": "Hermes"}
_CATEGORY = {
    "shell": "Shell", "file_read": "Read", "file_edit": "Edit", "context_read": "Context", "mcp": "MCP",
    "web": "Web", "subagent": "Subagent", "memory": "Memory", "permission": "Permission", "question": "Question",
    "plan": "Plan", "other": "Tool", "compaction": "Compaction",
}
# Flat swatches for the activity bar (Signal Forest, no gradients).
_SWATCH = {
    "shell": "#0f5b3e", "file_edit": "#4e8c6f", "file_read": "#2b5ce6", "mcp": "#b7791f", "web": "#7a5cc2",
    "subagent": "#d97757", "context_read": "#8aa89a", "other": "#a3ada7",
}
_RED = "[redacted]"

# What might be a password or token. Nothing is redacted automatically: these
# become suggestions in the export dialog and the person picks what to hide.
# Each pattern's named group ``s`` is the secret itself.
_FINDERS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?P<s>-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z))", re.S), "Private key"),
    (re.compile(r"\b[a-z][a-z0-9+.-]*://[^/\s:@]+:(?P<s>[^@\s/]+)@", re.I), "Password in a URL"),
    (re.compile(r"(?i)\b(?:(?:proxy-)?authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\\?[\"']?\s*[:=]\s*\\?[\"']?(?:(?:bearer|basic|token)\s+)?(?P<s>[^\s\"',]{6,})"), "Auth header"),
    (re.compile(r"(?i)\b(?:bearer|basic)\s+(?P<s>[A-Za-z0-9._~+/=-]{12,})"), "Bearer token"),
    (re.compile(r"(?i)(?<![\w-])--?(?:password|passwd|pass|pwd|token|api-key|apikey|secret|access-key|auth)(?:=|\s+)(?![\-$<{])(?P<s>\S{4,})"), "Password flag"),
    (re.compile(
        r"(?<![\w.-])(?:(?:[\w.-]*[_.-])?(?i:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|"
        r"auth[_-]?key|client[_-]?secret|private[_-]?key|credentials?|signing[_-]?key)"
        r"|[a-z0-9]+(?:Password|Secret|Token|ApiKey|AccessKey|SecretKey|PrivateKey))(?![\w-])"
        r"\\?[\"']?\s*[:=]\s*\\?[\"']?"
        # A plain word or identifier is prose or code ("First pass: group",
        # token = cached_token); a secret has a digit or a symbol in it.
        r"(?![$<{*\[(]|\d+\b|[A-Za-z_.]+(?![^\s\"',;&}\\)]))(?P<s>[^\s\"',;&}\\)]{4,})"
    ), "Password or secret"),
    (re.compile(r"(?P<s>\b(?:npm_|glpat-|hf_|sk_live_|sk_test_|pk_live_|rk_live_|shpat_|shpss_|dop_v1_|gh[pousr]_|github_pat_|xox[a-z]-|sq0[a-z]{3}-|sk-ant-|sk-|AKIA|ASIA|AIza)[A-Za-z0-9_-]{12,})"), "API token"),
    (re.compile(r"(?P<s>\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})"), "JWT"),
]


_CANDIDATE = re.compile(r"(?<![\w/.-])[A-Za-z0-9+/_=-]{32,}(?![\w/-])")
_WORDY = re.compile(r"[a-z]{6,}|[A-Z][a-z]{4,}")


def _random_looking(s: str) -> bool:
    """A key or token, not a path, identifier or hash: mixed case and digits,
    no word-like runs, and high per-character entropy."""
    if "/" in s.strip("/") and s.count("/") > 2:
        return False
    if _WORDY.search(s):
        return False
    n = len(s)
    upper = sum(c.isupper() for c in s) / n
    lower = sum(c.islower() for c in s) / n
    digit = sum(c.isdigit() for c in s) / n
    if min(upper, lower) < 0.1 or digit < 0.05:
        return False
    counts: dict[str, int] = {}
    for c in s:
        counts[c] = counts.get(c, 0) + 1
    entropy = -sum((k / n) * math.log2(k / n) for k in counts.values())
    return entropy >= 4.0


def find_secrets(text: str) -> list[tuple[str, str]]:
    """(kind, value) for everything in ``text`` that might be a secret."""
    out: list[tuple[str, str]] = []
    for pat, kind in _FINDERS:
        out += [(kind, m.group("s")) for m in pat.finditer(text)]
    out += [("Random-looking string", m.group(0)) for m in _CANDIDATE.finditer(text) if _random_looking(m.group(0))]
    return out


def secret_id(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]


class Redactions:
    """What the person chose to hide: suggested values and their own terms."""

    def __init__(self, values: Iterable[str] = (), terms: Iterable[str] = ()):
        parts = sorted({v for v in values if v}, key=len, reverse=True)
        parts += [t for t in terms if t and t.strip()]
        self._pat = (
            re.compile("|".join(re.escape(p) for p in parts), re.I) if parts else None
        )

    def apply(self, text: str) -> str:
        return self._pat.sub(_RED, text) if self._pat else text


_NONE = Redactions()
_active: ContextVar[Redactions] = ContextVar("redactions", default=_NONE)


def _clean(text: Any) -> str:
    return _active.get().apply(str(text or ""))


def _e(text: Any) -> str:
    return html.escape(_clean(text))


def _fmt_duration(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return "—"
    m = int(seconds // 60)
    if m < 1:
        return f"{int(seconds)}s"
    if m < 60:
        return f"{m}m"
    return f"{m // 60}h {m % 60:02d}m"


def _fmt_tokens(n: Any) -> str:
    if not isinstance(n, (int, float)) or n <= 0:
        return "—"
    for unit, size in (("B", 1e9), ("M", 1e6), ("k", 1e3)):
        if n >= size:
            return f"{n / size:.1f}{unit}"
    return str(int(n))


def _active_seconds(items: list[dict[str, Any]]) -> float | None:
    """Wall time minus idle gaps over 15 minutes: a session left open overnight
    isn't a 14-hour task."""
    stamps = sorted(t for t in (timeutil.parse_ts(i.get("start_ts")) for i in items) if t)
    if len(stamps) < 2:
        return None
    total = 0.0
    for a, b in zip(stamps, stamps[1:]):
        gap = (b - a).total_seconds()
        total += gap if gap <= 900 else 0
    return total


def _paras(text: str) -> str:
    """Plain text to paragraphs; fenced code becomes <pre>. Escaped first."""
    text = text.strip()
    out, code, buf = [], False, []
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            if code:
                out.append(f"<pre>{_e(chr(10).join(buf))}</pre>")
                buf = []
            code = not code
            continue
        if code:
            buf.append(line)
            continue
        out.append(line)
    if code and buf:
        out.append(f"<pre>{_e(chr(10).join(buf))}</pre>")
    rendered: list[str] = []
    para: list[str] = []
    items: list[str] = []
    kind = ""

    def flush() -> None:
        nonlocal para, items, kind
        if para:
            rendered.append(f"<p>{'<br>'.join(_inline(p) for p in para)}</p>")
            para = []
        if items:
            rendered.append(f"<{kind}>{''.join(f'<li>{_inline(i)}</li>' for i in items)}</{kind}>")
            items, kind = [], ""

    for line in out:
        bullet = re.match(r"^\s*[-*]\s+(.*)$", line)
        number = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if line.startswith("<pre>"):
            flush()
            rendered.append(line)
        elif bullet or number:
            want = "ul" if bullet else "ol"
            if para or (kind and kind != want):
                flush()
            kind = want
            items.append((bullet or number).group(1))
        elif not line.strip():
            flush()
        else:
            if items:
                flush()
            para.append(line)
    flush()
    return "".join(rendered)


def _inline(line: str) -> str:
    s = _e(line)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return re.sub(r"^#{1,6}\s+(.*)$", r"<strong>\1</strong>", s)


def _cap(text: str) -> str:
    if len(text) <= DETAIL_CHARS:
        return text
    half = DETAIL_CHARS // 2
    return f"{text[:half]}\n\n… {len(text) - DETAIL_CHARS:,} characters not shown …\n\n{text[-half:]}"


def _block(label: str, text: Any, cls: str = "") -> str:
    body = text if isinstance(text, str) else json.dumps(text, indent=2, ensure_ascii=False)
    body = body.rstrip()
    if not body:
        return ""
    return f'<div class="blk {cls}"><div class="blk-l">{html.escape(label)}</div><pre>{_e(_cap(body))}</pre></div>'


def _diff(old: str, new: str) -> str:
    lines = [f'<span class="del">- {_e(x)}</span>' for x in old.split("\n")] if old else []
    lines += [f'<span class="add">+ {_e(x)}</span>' for x in new.split("\n")] if new else []
    joined = "\n".join(lines)
    if len(joined) > DETAIL_CHARS * 2:
        joined = joined[: DETAIL_CHARS * 2] + "\n…"
    return f'<div class="blk"><div class="blk-l">Change</div><pre class="diff">{joined}</pre></div>'


def _parse(detail: Any) -> Any:
    if isinstance(detail, (dict, list)):
        return detail
    try:
        return json.loads(detail) if isinstance(detail, str) and detail.lstrip()[:1] in "{[" else detail
    except ValueError:
        return detail


def _details(item: dict[str, Any]) -> str:
    """Everything recorded about one tool step, laid out by kind."""
    data = _parse(item.get("detail"))
    if not isinstance(data, dict):
        return _block("Detail", str(data or ""))
    inp = data.get("input") if isinstance(data.get("input"), dict) else {}
    resp = data.get("response")
    out: list[str] = []
    cat = item.get("category")
    if cat == "shell" or "command" in data:
        out.append(_block("Command", data.get("command") or inp.get("command") or ""))
        if isinstance(resp, dict):
            out.append(_block("Output", resp.get("stdout") or resp.get("output") or ""))
            out.append(_block("Errors", resp.get("stderr") or "", "err"))
        elif resp:
            out.append(_block("Output", resp))
    elif cat == "file_edit" and inp:
        if inp.get("old_string") is not None or inp.get("new_string") is not None:
            out.append(_diff(str(inp.get("old_string") or ""), str(inp.get("new_string") or "")))
        for e in inp.get("edits") or []:
            if isinstance(e, dict):
                out.append(_diff(str(e.get("old_string") or ""), str(e.get("new_string") or "")))
        if inp.get("content") is not None:
            out.append(_block("New file", str(inp.get("content"))))
    elif isinstance(data.get("file"), dict):
        out.append(_block("Content", str(data["file"].get("content") or "")))
    else:
        if inp:
            out.append(_block("Input", inp))
        if resp not in (None, {}, ""):
            out.append(_block("Result", resp))
        rest = {k: v for k, v in data.items() if k not in ("input", "response", "session_id", "transcript_path", "cwd", "hook_event_name", "permission_mode")}
        if not out and rest:
            out.append(_block("Detail", rest))
    return "".join(x for x in out if x)


def _clock(ts: Any) -> str:
    dt = timeutil.parse_ts(ts)
    return dt.strftime("%H:%M:%S") if dt else ""


@dataclass(frozen=True)
class Options:
    thoughts: bool = True
    outputs: bool = True


def _event(item: dict[str, Any], agent: str, opts: Options) -> str:
    cat = item.get("category") or "other"
    when = f'<span class="t">{_clock(item.get("start_ts"))}</span>'
    if cat in ("prompt", "response"):
        who = "You" if cat == "prompt" else html.escape(agent)
        return f'<div class="ev">{when}<div class="msg {"you" if cat == "prompt" else "agent"}"><div class="who">{who}</div>{_paras(str(item.get("detail") or ""))}</div></div>'
    if cat == "thought":
        if not opts.thoughts:
            return ""
        return f'<div class="ev">{when}<div class="thought"><div class="who">Thinking</div>{_paras(str(item.get("detail") or ""))}</div></div>'
    label = _CATEGORY.get(cat, cat.replace("_", " ").title())
    tool = item.get("tool") or ""
    target = " ".join(_clean(item.get("target") or item.get("title") or tool).split())
    failed = (item.get("status") or "ok") not in ("ok", "", None)
    dur = item.get("duration_ms")
    dur_s = f'<span class="dur">{dur / 1000:.1f}s</span>' if isinstance(dur, (int, float)) and dur >= 100 else ""
    body = _details(item) if opts.outputs else ""
    head = (
        f'<span class="cat">{html.escape(label)}</span>'
        + (f'<span class="tool">{html.escape(tool)}</span>' if tool and tool.lower() != label.lower() else "")
        + f'<span class="tgt">{html.escape(target)}</span>'
        + ('<span class="bad">failed</span>' if failed else "")
        + dur_s
    )
    if not body:
        return f'<div class="ev">{when}<div class="step{" fail" if failed else ""}"><div class="sum">{head}</div></div></div>'
    return f'<div class="ev">{when}<details class="step{" fail" if failed else ""}"><summary class="sum">{head}</summary><div class="body">{body}</div></details></div>'


class _Collector(Redactions):
    """A dry run's redactions: hides nothing, records what might be secret."""

    def __init__(self) -> None:
        super().__init__()
        self.found: dict[str, dict[str, Any]] = {}

    def apply(self, text: str) -> str:
        for kind, value in find_secrets(text):
            hit = self.found.setdefault(secret_id(value), {"kind": kind, "value": value, "count": 0, "context": _context(text, value)})
            hit["count"] += 1
        return text


def _context(text: str, value: str) -> str:
    """A line around the value, with the value itself elided, so the dialog can
    say where it was without printing the secret again."""
    i = text.find(value)
    before = text[max(0, i - 48):i].split("\n")[-1]
    after = text[i + len(value):i + len(value) + 24].split("\n")[0]
    return f"{before.lstrip()}{_preview(value)}{after.rstrip()}"


def _preview(value: str) -> str:
    v = " ".join(value.split())
    return "••••" if len(v) <= 8 else f"{v[:3]}••••{v[-3:]}"


def scan(session_id: str, opts: Options = Options()) -> list[dict[str, Any]] | None:
    """Possible secrets in what the export would contain, most frequent first."""
    collector = _Collector()
    if _render(session_id, collector, opts) is None:
        return None
    return sorted(
        (
            {"id": sid, "kind": h["kind"], "preview": _preview(h["value"]), "context": h["context"], "count": h["count"]}
            for sid, h in collector.found.items()
        ),
        key=lambda h: (-h["count"], h["kind"]),
    )


def render(session_id: str, redact: Iterable[str] = (), terms: Iterable[str] = (), opts: Options = Options()) -> str | None:
    """The page, hiding the suggestions whose ids are in ``redact`` and every
    occurrence of the person's own ``terms`` (case-insensitive)."""
    redact = set(redact)
    values: list[str] = []
    if redact:
        collector = _Collector()
        _render(session_id, collector, opts)
        values = [h["value"] for sid, h in collector.found.items() if sid in redact]
    return _render(session_id, Redactions(values, terms), opts)


def _render(session_id: str, redactions: Redactions, opts: Options) -> str | None:
    token = _active.set(redactions)
    try:
        return _page(session_id, opts)
    finally:
        _active.reset(token)


def _page(session_id: str, opts: Options) -> str | None:
    rows, _ = db.list_sessions_page(1, ids=[session_id])
    if not rows:
        return None
    s = rows[0]
    items = session_read.build_timeline_items(session_id)

    turns = sum(1 for i in items if i.get("category") == "prompt")

    counts: dict[str, int] = {}
    for item in items:
        cat = item.get("category") or "other"
        if cat in _CATEGORY and cat not in ("question", "plan", "compaction", "permission"):
            counts[cat] = counts.get(cat, 0) + 1
    tool_total = sum(counts.values()) or 1
    edited = len({i.get("target") for i in items if i.get("category") == "file_edit" and i.get("target")})
    active = _active_seconds(items)

    agent = _AGENT.get(s.get("source") or "", s.get("source") or "Agent")
    title = _clean(s.get("title") or "Untitled session").strip()
    project = (s.get("cwd") or "").rstrip("/").split("/")[-1] or "—"
    started = timeutil.parse_ts(s.get("started_at"))
    day = started.strftime("%B %-d, %Y") if started else ""
    models = ", ".join(s.get("models") or []) or "—"
    cost = f"${s['cost_usd']:.2f}" if s.get("has_cost") else "—"

    kpis = [
        ("Active time", _fmt_duration(active if active else s.get("duration_seconds"))),
        ("Turns", str(turns)),
        ("Tool calls", str(s.get("tool_count") or 0)),
        ("Files edited", str(edited)),
        ("Tokens", _fmt_tokens((s.get("tokens") or {}).get("total"))),
        ("Spend", cost),
    ]
    mix = "".join(
        f'<span style="flex:{n};background:{_SWATCH.get(cat, "#a3ada7")}" title="{html.escape(_CATEGORY[cat])} · {n}"></span>'
        for cat, n in sorted(counts.items(), key=lambda kv: -kv[1])
    )
    legend = "".join(
        f'<span><i style="background:{_SWATCH.get(cat, "#a3ada7")}"></i>{html.escape(_CATEGORY[cat])} <b>{round(100 * n / tool_total)}%</b></span>'
        for cat, n in sorted(counts.items(), key=lambda kv: -kv[1])[:6]
    )

    timeline = []
    turn = 0
    for item in items:
        cat = item.get("category")
        if cat in ("lifecycle", "notification", "meta"):
            continue
        if cat == "prompt":
            turn += 1
            timeline.append(f'<div class="turn-h"><span>Turn {turn:02d}</span></div>')
        timeline.append(_event(item, agent, opts))

    kpi_html = "".join(f'<div class="kpi"><div class="label">{k}</div><div class="v">{html.escape(v)}</div></div>' for k, v in kpis)
    return _PAGE.format(
        title=html.escape(title),
        agent=html.escape(agent),
        project=html.escape(project),
        day=html.escape(day),
        models=_e(models),
        kpis=kpi_html,
        mix=mix,
        legend=legend,
        steps=len(items),
        timeline="".join(timeline) or '<p class="empty">Nothing was recorded in this session.</p>',
        version=html.escape(__version__),
        generated=html.escape(timeutil.now()[:10]),
    )


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · cot</title>
<meta name="description" content="A {agent} session recorded with cot: every prompt, reply and tool call, with cost and timing.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@1,6..72,700&display=swap" rel="stylesheet">
<style>
:root {{
  --bg: #f5f6f3; --panel: #ecefe9; --surface: #ffffff; --hot: #0f5b3e; --signal: #16a065; --onhot: #ffffff;
  --fg: rgb(12 26 20); --dim: rgb(12 26 20 / 0.62); --faint: rgb(12 26 20 / 0.42); --line: rgb(12 26 20 / 0.1);
  --alert: #d93a3f; --amber: #b7791f; --cobalt: #2b5ce6;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg: #0a1612; --panel: #0e1d18; --surface: #13261f; --hot: #c8f169; --signal: #c8f169; --onhot: #0a2a1e;
    --fg: rgb(233 240 234); --dim: rgb(233 240 234 / 0.62); --faint: rgb(233 240 234 / 0.42); --line: rgb(233 240 234 / 0.1);
    --alert: #f2555a; --amber: #e5b04a; --cobalt: #7fa2f5;
  }}
}}
* {{ box-sizing: border-box; }}
html {{ -webkit-text-size-adjust: 100%; }}
body {{ margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 Geist, ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }}
.wrap {{ max-width: 880px; margin: 0 auto; padding: 0 24px; }}
.mono, code, pre, .label, .tn, .cat, .dur {{ font-family: 'Geist Mono', ui-monospace, monospace; }}
.label {{ font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }}
header.top {{ border-bottom: 1px solid var(--line); }}
header.top .wrap {{ display: flex; align-items: center; justify-content: space-between; height: 64px; }}
.wordmark {{ font-family: Newsreader, Georgia, serif; font-style: italic; font-weight: 700; font-size: 26px; letter-spacing: -0.02em; color: var(--fg); text-decoration: none; line-height: 1; }}
.wordmark i {{ color: var(--hot); font-style: inherit; }}
.hero {{ padding: 56px 0 32px; }}
.hero h1 {{ margin: 10px 0 12px; font-size: clamp(28px, 4.4vw, 42px); line-height: 1.12; letter-spacing: -0.03em; font-weight: 600; text-wrap: balance; max-width: 26ch; }}
.hero .meta {{ color: var(--dim); font-size: 14px; display: flex; flex-wrap: wrap; gap: 6px 16px; }}
.hero .meta span + span::before {{ content: '·'; margin-right: 16px; color: var(--faint); }}
.kpis {{ display: grid; grid-template-columns: repeat(6, 1fr); background: var(--surface); border: 1px solid var(--line); border-radius: 18px; overflow: hidden; }}
.kpi {{ padding: 18px 18px 20px; border-right: 1px solid var(--line); }}
.kpi:last-child {{ border-right: 0; }}
.kpi .v {{ margin-top: 6px; font-size: 24px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }}
.mixwrap {{ margin: 22px 0 0; }}
.mix {{ display: flex; height: 8px; border-radius: 99px; overflow: hidden; gap: 2px; }}
.legend {{ display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px; font-size: 12.5px; color: var(--dim); }}
.legend i {{ display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 7px; }}
.legend b {{ color: var(--fg); font-weight: 500; font-variant-numeric: tabular-nums; }}
.conv {{ margin: 48px 0 0; }}
.conv-h {{ display: flex; justify-content: space-between; align-items: center; padding-bottom: 14px; border-bottom: 1px solid var(--line); }}
.toggle {{ font: 500 12.5px Geist, sans-serif; color: var(--hot); background: none; border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; cursor: pointer; transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1); }}
.toggle:active {{ transform: scale(0.97); }}
.turn-h {{ margin: 36px 0 14px; display: flex; align-items: center; gap: 12px; font-family: 'Geist Mono', monospace; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); }}
.turn-h::after {{ content: ''; flex: 1; height: 1px; background: var(--line); }}
.ev {{ display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 12px; align-items: start; margin: 6px 0; }}
.ev .t {{ font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--faint); padding-top: 9px; font-variant-numeric: tabular-nums; }}
.msg {{ border-radius: 16px; padding: 14px 18px; max-width: 74ch; margin: 4px 0; }}
.msg .who, .thought .who {{ font-size: 12px; font-weight: 600; margin-bottom: 4px; }}
.msg p, .msg ul, .msg ol, .thought p, .thought ul, .thought ol {{ margin: 0 0 10px; overflow-wrap: anywhere; }}
.msg ul, .msg ol, .thought ul, .thought ol {{ padding-left: 20px; }}
.msg li {{ margin: 2px 0; }}
.msg > :last-child, .thought > :last-child {{ margin-bottom: 0; }}
.you {{ background: var(--hot); color: var(--onhot); }}
.you .who {{ opacity: 0.75; }}
.you code {{ background: rgb(255 255 255 / 0.14); }}
.agent {{ background: var(--surface); border: 1px solid var(--line); }}
.thought {{ max-width: 74ch; padding: 8px 0 8px 2px; color: var(--dim); font-size: 14px; font-style: italic; }}
.thought .who {{ font-style: normal; color: var(--faint); font-weight: 500; }}
code {{ font-size: 0.86em; padding: 1px 5px; border-radius: 5px; background: var(--panel); }}
pre {{ margin: 0 0 10px; padding: 12px 14px; border-radius: 10px; background: var(--panel); font-size: 12.5px; line-height: 1.55; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }}
.you pre {{ background: rgb(0 0 0 / 0.18); }}
.step {{ border-radius: 10px; background: var(--panel); min-width: 0; }}
.step .sum {{ list-style: none; display: flex; align-items: baseline; gap: 10px; padding: 8px 12px; font-size: 12.5px; min-width: 0; }}
details.step .sum {{ cursor: pointer; }}
.step .sum::-webkit-details-marker {{ display: none; }}
details.step .sum::before {{ content: '+'; font-family: 'Geist Mono', monospace; color: var(--hot); width: 10px; flex: none; }}
details.step[open] .sum::before {{ content: '−'; }}
.step .cat {{ font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--dim); flex: none; }}
.step .tool {{ font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--faint); flex: none; }}
.step .tgt {{ font-family: 'Geist Mono', monospace; font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
details.step[open] .tgt {{ white-space: normal; overflow-wrap: anywhere; }}
.step .dur {{ font-family: 'Geist Mono', monospace; font-size: 11px; color: var(--faint); flex: none; }}
.step .bad {{ font-family: 'Geist Mono', monospace; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--alert); flex: none; }}
.step.fail .cat {{ color: var(--alert); }}
.step .body {{ padding: 2px 12px 12px; }}
.blk {{ margin-top: 8px; }}
.blk-l {{ font-family: 'Geist Mono', monospace; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); margin-bottom: 4px; }}
.blk pre {{ margin: 0; background: var(--surface); max-height: 560px; overflow: auto; }}
.blk.err pre {{ color: var(--alert); }}
.diff .del {{ color: var(--alert); }}
.diff .add {{ color: var(--signal); }}
footer {{ margin: 56px 0 0; border-top: 1px solid var(--line); }}
footer .wrap {{ display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; padding: 28px 24px 40px; font-size: 13px; color: var(--dim); }}
footer a {{ color: var(--hot); text-decoration: none; font-weight: 500; }}
.empty {{ color: var(--dim); }}
@media (max-width: 760px) {{
  .kpis {{ grid-template-columns: repeat(3, 1fr); }}
  .kpi:nth-child(3) {{ border-right: 0; }}
  .kpi:nth-child(-n+3) {{ border-bottom: 1px solid var(--line); }}
  .ev {{ grid-template-columns: 1fr; gap: 2px; }}
  .ev .t {{ padding-top: 0; }}
  .step .dur, .step .tool {{ display: none; }}
  .hero {{ padding-top: 36px; }}
}}
@media print {{
  body {{ background: #fff; }}
  .toggle {{ display: none; }}
  .blk pre {{ max-height: none; }}
}}
</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="wordmark" href="https://cot.run">cot<i>.</i></a><span class="label">Session report</span></div></header>
<main class="wrap">
  <section class="hero">
    <div class="label">{agent} session · {project}</div>
    <h1>{title}</h1>
    <div class="meta"><span>{day}</span><span class="mono">{models}</span></div>
  </section>
  <div class="kpis">{kpis}</div>
  <div class="mixwrap"><div class="mix" aria-hidden="true">{mix}</div><div class="legend">{legend}</div></div>
  <section class="conv">
    <div class="conv-h"><span class="label">Timeline · {steps} steps</span><button type="button" id="toggle" class="toggle">Expand all</button></div>
    {timeline}
  </section>
</main>
<footer><div class="wrap"><span>Recorded locally with <a href="https://cot.run">cot</a>, observability for AI coding agents. Nothing left the machine to make this.</span><span class="mono">cot {version} · {generated}</span></div></footer>
<script>
(function () {{
  var b = document.getElementById('toggle'), open = false;
  b.addEventListener('click', function () {{
    open = !open;
    document.querySelectorAll('details.step').forEach(function (d) {{ d.open = open; }});
    b.textContent = open ? 'Collapse all' : 'Expand all';
  }});
  window.addEventListener('beforeprint', function () {{ document.querySelectorAll('details.step').forEach(function (d) {{ d.open = true; }}); }});
}})();
</script>
</body>
</html>
"""

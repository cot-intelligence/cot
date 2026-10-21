"""One session as a self-contained, cot-branded HTML page: shareable, printable,
and good enough to use as marketing material.

It shows the story, not the raw data: the person's prompts and the agent's
replies in full, each turn's tool calls as one line each (no command output or
diffs), the headline numbers, and the latest Analysis of the session if there
is one. Every string goes through ``ai_insights.mask_text`` and the home folder
becomes ``~``, since the file is meant to leave the machine.
"""

from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Any

from . import __version__, ai_insights, analysis_personas, db, session_read, timeutil

TEXT_CHARS = 8000
TOOLS_PER_TURN = 40

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
_HOME = str(Path.home())


def _clean(text: Any) -> str:
    s = ai_insights.mask_text(str(text or ""))
    if _HOME and _HOME != "/":
        s = s.replace(_HOME, "~")
    s = re.sub(r"/(?:Users|home)/[^/\s]+", "~", s)
    # Agents' scratch folders encode the home path as -Users-<name>-.
    return re.sub(r"-(?:Users|home)-[^-/\s]+", "-~", s)


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
    if len(text) > TEXT_CHARS:
        text = text[:TEXT_CHARS].rstrip() + " …"
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


def _step(item: dict[str, Any]) -> str:
    cat = item.get("category") or "other"
    label = _CATEGORY.get(cat, cat.replace("_", " ").title())
    target = _clean(item.get("target") or item.get("title") or item.get("tool") or "")
    target = " ".join(target.split())
    if len(target) > 140:
        target = target[:139] + "…"
    failed = (item.get("status") or "ok") not in ("ok", "", None)
    dur = item.get("duration_ms")
    dur_s = f'<span class="dur">{dur / 1000:.0f}s</span>' if isinstance(dur, (int, float)) and dur >= 1000 else ""
    return (
        f'<li class="step{" fail" if failed else ""}"><span class="cat">{html.escape(label)}</span>'
        f'<span class="tgt">{html.escape(target)}</span>{dur_s}</li>'
    )


def render(session_id: str) -> str | None:
    rows, _ = db.list_sessions_page(1, ids=[session_id])
    if not rows:
        return None
    s = rows[0]
    items = session_read.build_timeline_items(session_id)

    turns: list[list[dict[str, Any]]] = [[]]
    for item in items:
        if item.get("category") == "prompt":
            turns.append([])
        turns[-1].append(item)
    turns = [t for t in turns if any(i.get("category") == "prompt" for i in t)]

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
        ("Turns", str(len(turns))),
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

    conv = []
    for n, turn in enumerate(turns, 1):
        prompt = next(i for i in turn if i.get("category") == "prompt")
        steps = [i for i in turn if i.get("category") in _CATEGORY]
        replies = [i for i in turn if i.get("category") == "response" and str(i.get("detail") or "").strip()]
        block = [
            f'<section class="turn"><div class="tn">Turn {n:02d}</div>',
            f'<div class="msg you"><div class="who">You</div>{_paras(str(prompt.get("detail") or ""))}</div>',
        ]
        if steps:
            shown = steps[:TOOLS_PER_TURN]
            more = len(steps) - len(shown)
            fails = sum(1 for i in steps if (i.get("status") or "ok") not in ("ok", "", None))
            summary = f'{len(steps)} step{"s" if len(steps) != 1 else ""}' + (f' · {fails} failed' if fails else "")
            block.append(
                f'<details class="steps"><summary><span>{agent} worked</span><span class="mono">{summary}</span></summary>'
                f'<ol>{"".join(_step(i) for i in shown)}</ol>'
                + (f'<div class="more">+ {more} more</div>' if more else "")
                + "</details>"
            )
        if replies:
            block.append(f'<div class="msg agent"><div class="who">{html.escape(agent)}</div>{_paras(str(replies[-1].get("detail") or ""))}</div>')
        block.append("</section>")
        conv.append("".join(block))

    analysis_html = ""
    runs = [r for r in db.list_analysis_runs(limit=5, session_id=session_id) if r.get("status") == "ok" and r.get("report")]
    if runs:
        r = runs[0]
        rep = r["report"]
        persona = analysis_personas.PERSONAS.get(r["persona"])
        findings = "".join(
            f'<li><span class="sev {html.escape(f.get("severity") or "info")}">{html.escape(f.get("severity") or "info")}</span>'
            f'<div><strong>{_e(f.get("title"))}</strong><p>{_e(f.get("detail"))}</p></div></li>'
            for f in (rep.get("findings") or [])[:5]
        )
        analysis_html = (
            '<section class="analysis"><div class="label">Analysis · '
            f'{html.escape(persona.name if persona else r["persona"])}</div>'
            f'<h2>{_e(rep.get("title"))}</h2><p class="lead">{_e(rep.get("summary"))}</p>'
            + (f'<ul class="findings">{findings}</ul>' if findings else "")
            + "</section>"
        )

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
        analysis=analysis_html,
        conversation="".join(conv) or '<p class="empty">No prompts were recorded in this session.</p>',
        version=html.escape(__version__),
        generated=html.escape(timeutil.now()[:10]),
    )


_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · cot</title>
<meta name="description" content="A {agent} session recorded with cot: prompts, tool calls, cost and what came of it.">
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
.analysis {{ margin: 40px 0 0; padding: 26px 28px; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; }}
.analysis h2 {{ margin: 8px 0 8px; font-size: 21px; line-height: 1.3; letter-spacing: -0.02em; font-weight: 600; }}
.analysis .lead {{ margin: 0; color: var(--dim); max-width: 70ch; }}
.findings {{ list-style: none; margin: 20px 0 0; padding: 0; display: grid; gap: 12px; }}
.findings li {{ display: grid; grid-template-columns: 74px 1fr; gap: 12px; align-items: start; padding-top: 12px; border-top: 1px solid var(--line); }}
.findings p {{ margin: 2px 0 0; color: var(--dim); font-size: 14px; }}
.sev {{ font-family: 'Geist Mono', monospace; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em; padding: 3px 8px; border-radius: 6px; text-align: center; background: var(--panel); color: var(--cobalt); }}
.sev.warn {{ color: var(--amber); }} .sev.critical {{ color: var(--alert); }}
.conv {{ margin: 48px 0 0; }}
.conv > .label {{ margin-bottom: 16px; }}
.turn {{ position: relative; padding: 24px 0 28px; border-top: 1px solid var(--line); }}
.tn {{ font-size: 11px; color: var(--faint); margin-bottom: 12px; }}
.msg {{ border-radius: 16px; padding: 14px 18px; max-width: 72ch; }}
.msg .who {{ font-size: 12px; font-weight: 600; margin-bottom: 4px; }}
.msg p, .msg ul, .msg ol {{ margin: 0 0 10px; overflow-wrap: anywhere; }}
.msg ul, .msg ol {{ padding-left: 20px; }}
.msg li {{ margin: 2px 0; }}
.msg > :last-child {{ margin-bottom: 0; }}
.you {{ background: var(--hot); color: var(--onhot); }}
.you .who {{ opacity: 0.75; }}
.you code {{ background: rgb(255 255 255 / 0.14); }}
.agent {{ background: var(--surface); border: 1px solid var(--line); margin-top: 12px; }}
code {{ font-size: 0.86em; padding: 1px 5px; border-radius: 5px; background: var(--panel); }}
pre {{ margin: 0 0 10px; padding: 12px 14px; border-radius: 10px; background: var(--panel); font-size: 12.5px; line-height: 1.55; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }}
.you pre {{ background: rgb(0 0 0 / 0.18); }}
.steps {{ margin-top: 12px; max-width: 72ch; border-radius: 14px; background: var(--panel); }}
.steps summary {{ list-style: none; cursor: pointer; display: flex; justify-content: space-between; gap: 12px; padding: 10px 16px; font-size: 13px; color: var(--dim); }}
.steps summary::-webkit-details-marker {{ display: none; }}
.steps summary span:first-child::before {{ content: '+'; display: inline-block; width: 16px; font-family: 'Geist Mono', monospace; color: var(--hot); }}
.steps[open] summary span:first-child::before {{ content: '−'; }}
.steps ol {{ list-style: none; margin: 0; padding: 0 16px 12px; display: grid; gap: 2px; }}
.step {{ display: grid; grid-template-columns: 84px 1fr auto; gap: 10px; font-size: 12.5px; line-height: 1.5; padding: 3px 0; }}
.step .cat {{ font-size: 11px; color: var(--faint); padding-top: 1px; }}
.step .tgt {{ font-family: 'Geist Mono', monospace; font-size: 12px; overflow-wrap: anywhere; }}
.step .dur {{ font-size: 11px; color: var(--faint); }}
.step.fail .cat {{ color: var(--alert); }}
.more {{ padding: 0 16px 12px; font-size: 12px; color: var(--faint); }}
footer {{ margin: 56px 0 0; border-top: 1px solid var(--line); }}
footer .wrap {{ display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; padding: 28px 24px 40px; font-size: 13px; color: var(--dim); }}
footer a {{ color: var(--hot); text-decoration: none; font-weight: 500; }}
.empty {{ color: var(--dim); }}
@media (max-width: 760px) {{
  .kpis {{ grid-template-columns: repeat(3, 1fr); }}
  .kpi:nth-child(3) {{ border-right: 0; }}
  .kpi:nth-child(-n+3) {{ border-bottom: 1px solid var(--line); }}
  .step {{ grid-template-columns: 64px 1fr; }}
  .step .dur {{ display: none; }}
  .hero {{ padding-top: 36px; }}
}}
@media print {{
  body {{ background: #fff; }}
  .steps {{ break-inside: avoid; }}
  .turn {{ break-inside: avoid-page; }}
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
  {analysis}
  <section class="conv"><div class="label">The session</div>{conversation}</section>
</main>
<footer><div class="wrap"><span>Recorded locally with <a href="https://cot.run">cot</a>, observability for AI coding agents. Nothing left the machine to make this.</span><span class="mono">cot {version} · {generated}</span></div></footer>
</body>
</html>
"""

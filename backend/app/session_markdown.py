"""One session as a readable Markdown transcript, for the sessions list's
"Export as Markdown". The JSON export stays the lossless format."""

from __future__ import annotations

from typing import Any

from . import timeutil

_TEXT = {"prompt": "You", "response": "Agent"}


def _fence(text: str) -> str:
    # A fence longer than any backtick run inside the text, so code survives.
    run = longest = 0
    for ch in text:
        run = run + 1 if ch == "`" else 0
        longest = max(longest, run)
    return "`" * max(3, longest + 1)


def _clock(ts: str | None) -> str:
    dt = timeutil.parse_ts(ts)
    return dt.strftime("%H:%M:%S") if dt else ""


def _duration(ms: Any) -> str:
    if not isinstance(ms, (int, float)) or ms <= 0:
        return ""
    s = ms / 1000
    return f"{s:.1f}s" if s < 60 else f"{int(s // 60)}m {int(s % 60)}s"


def render(detail: dict[str, Any]) -> str:
    s = detail.get("summary") or {}
    title = (s.get("title") or "Untitled session").strip()
    lines = [f"# {title}", ""]
    meta = [
        ("Session", f"`{s.get('id')}`"),
        ("Agent", s.get("source")),
        ("Project", f"`{s['cwd']}`" if s.get("cwd") else None),
        ("Models", ", ".join(s.get("models") or []) or None),
        ("Started", s.get("started_at")),
        ("Ended", s.get("ended_at")),
        ("Events", str(s.get("event_count") or 0)),
        ("Spend", f"${s['cost_usd']:.2f}" if s.get("has_cost") else None),
    ]
    lines += [f"- **{k}:** {v}" for k, v in meta if v]
    lines.append("")
    for e in detail.get("events") or []:
        cat = e.get("category")
        text = (e.get("detail") or "").strip()
        when = _clock(e.get("ts"))
        if cat in _TEXT and text:
            lines += [f"## {_TEXT[cat]} · {when}", "", text, ""]
        elif cat == "thought" and text:
            lines += ["<details><summary>Thinking · " + when + "</summary>", "", text, "", "</details>", ""]
        elif cat in ("lifecycle",):
            continue
        else:
            name = e.get("tool") or e.get("title") or cat or "event"
            bits = [f"`{when}`", f"**{name}**"]
            if e.get("target"):
                target = str(e["target"]).replace("\n", " ")
                bits.append(f"`{target[:200]}`")
            status = e.get("status")
            if status and status not in ("ok", "success", "completed"):
                bits.append(f"({status})")
            dur = _duration(e.get("duration_ms"))
            if dur:
                bits.append(f"· {dur}")
            lines.append("- " + " ".join(bits))
            if cat == "plan" and text:
                fence = _fence(text)
                lines += ["", f"{fence}md", text, fence, ""]
    return "\n".join(lines).rstrip() + "\n"

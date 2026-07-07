"""Session detail read model assembly.

This module owns the display contract for session detail reads: stored rows go
in; a provider-neutral timeline view, run windows, linked sessions,
clarifications, and preview metadata come out.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Literal

from . import db

DETAIL_PREVIEW_CHARS = 4000

# Only structured questions count: the agent explicitly asking the user via
# Claude's AskUserQuestion, Cursor's AskQuestion, or Codex's request_user_input.
# We never guess from assistant prose alone.
QUESTION_TOOLS = {"AskUserQuestion", "AskQuestion", "request_user_input"}
QUESTION_END_HOOKS = {"PostToolUse", "postToolUse"}
InlineKind = Literal["approval_review", "reviewed_session", "subagent"]
SUBAGENT_STOP_HOOKS = {"SubagentStop", "subagentStop"}
PRIVATE_ITEM_KEYS = {"_child_session_id", "_run_kind"}
RUN_CONTENT_CATEGORIES = {
    "shell",
    "file_read",
    "file_edit",
    "mcp",
    "web",
    "context_read",
    "memory",
    "response",
    "thought",
    "plan",
    "question",
}


def _coerce_dict(val: Any) -> dict[str, Any]:
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip():
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def parse_questions(detail: Any) -> list[dict[str, Any]]:
    """Return structured sub-questions plus recovered answers, if present."""
    obj = _coerce_dict(detail)
    if not obj:
        return []
    src = obj.get("input") if isinstance(obj.get("input"), dict) else obj
    qs = src.get("questions") if isinstance(src.get("questions"), list) else []
    resp = _coerce_dict(obj.get("response") or obj.get("output"))
    answers = resp.get("answers") if isinstance(resp.get("answers"), dict) else {}
    skipped_raw = resp.get("skipped") or resp.get("skipped_questions") or []
    skipped = {str(v) for v in skipped_raw if v} if isinstance(skipped_raw, list) else set()

    out: list[dict[str, Any]] = []
    for q in qs:
        if not isinstance(q, dict) or not (q.get("question") or q.get("prompt")):
            continue
        ans: str | None = None
        picked = answers.get(q.get("id")) if q.get("id") else None
        if picked is None:
            picked = answers.get(q.get("question")) or answers.get(q.get("prompt"))
        if isinstance(picked, dict) and isinstance(picked.get("answers"), list):
            ans = ", ".join(str(a) for a in picked["answers"] if a)
        elif isinstance(picked, list):
            ans = ", ".join(str(a) for a in picked if a)
        elif isinstance(picked, str):
            ans = picked
        options = [
            str(o.get("label"))
            for o in (q.get("options") or [])
            if isinstance(o, dict) and o.get("label")
        ]
        qid = str(q.get("id") or "")
        out.append(
            {
                "header": q.get("header"),
                "question": str(q.get("question") or q.get("prompt")),
                "options": options,
                "answer": ans or None,
                "skipped": bool(qid and qid in skipped and not ans),
            }
        )
    return out


def _question_text(detail: Any) -> str:
    return " · ".join(q["question"] for q in parse_questions(detail))


def _excerpt(text: str | None, limit: int = 200) -> str:
    if not text:
        return ""
    collapsed = " ".join(str(text).split())
    return collapsed if len(collapsed) <= limit else collapsed[: limit - 1] + "…"


def build_clarifications(
    ev_rows: list[sqlite3.Row],
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    """Annotate structured question events and pair them with answers."""
    questions: list[dict[str, Any]] = []
    pending: dict[str, Any] | None = None

    def _new(row: sqlite3.Row, answered: bool) -> dict[str, Any]:
        return {
            "start_id": row["id"],
            "ts": row["ts"],
            "detail": row["detail"],
            "answered": answered,
            "answer_id": None,
            "answer_ts": None,
            "answer_detail": None,
        }

    for r in ev_rows:
        if r["tool"] in QUESTION_TOOLS:
            if r["hook"] in QUESTION_END_HOOKS:
                if pending is not None:
                    pending["answered"] = True
                    pending["answer_id"] = r["id"]
                    pending["answer_ts"] = r["ts"]
                    pending["answer_detail"] = r["detail"]
                else:
                    pending = _new(r, answered=True)
                questions.append(pending)
                pending = None
            else:
                if pending is not None:
                    questions.append(pending)
                pending = _new(r, answered=False)
    if pending is not None:
        questions.append(pending)

    clarifications: list[dict[str, Any]] = []
    annotations: dict[int, dict[str, Any]] = {}
    for q in questions:
        annotations[q["start_id"]] = {
            "is_question": True,
            "answered": q["answered"],
            "answer_event_id": q["answer_id"],
        }
        if q["answer_id"] is not None:
            annotations[q["answer_id"]] = {"answers_event_id": q["start_id"]}
        clarifications.append(
            {
                "question_event_id": q["start_id"],
                "question_ts": q["ts"],
                "question_excerpt": _excerpt(_question_text(q["detail"])),
                "answer_event_id": q["answer_id"],
                "answer_ts": q["answer_ts"],
                "answer_excerpt": _excerpt(q["answer_detail"]) if q["answer_detail"] else None,
                "answered": q["answered"],
            }
        )
    return clarifications, annotations


def _stamp_clarification_session(clarifications: list[dict[str, Any]], session_id: str) -> None:
    for clarification in clarifications:
        clarification["question_session_id"] = session_id
        if clarification["answer_event_id"] is not None:
            clarification["answer_session_id"] = session_id


def _is_approval_history_dump(detail: str | None) -> bool:
    return str(detail or "").lstrip().startswith(db._APPROVAL_REVIEW_PREFIX)


EMPTY_DETAIL_VALUES = (None, "", {}, [])


def _merge_detail(start_detail: Any, end_detail: Any) -> Any:
    def _load(raw: Any) -> Any:
        if not isinstance(raw, str):
            return raw
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw

    start = _load(start_detail)
    end = _load(end_detail)
    if not isinstance(start, dict) or not isinstance(end, dict):
        return end_detail or start_detail

    merged = dict(start)
    for key, val in end.items():
        if (
            key in ("input", "arguments", "tool_input")
            and isinstance(val, dict)
            and isinstance(merged.get(key), dict)
        ):
            combined = dict(val)
            combined.update({k: v for k, v in merged[key].items() if v not in EMPTY_DETAIL_VALUES})
            merged[key] = combined
        elif val not in EMPTY_DETAIL_VALUES:
            merged[key] = val
    return json.dumps(merged, indent=2, ensure_ascii=False, default=str)


def build_timeline_items(session_id: str) -> list[dict[str, Any]]:
    """Build display timeline items, merging start/end hook pairs into spans."""
    with db._connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE session_id=? ORDER BY ts ASC, id ASC",
            (session_id,),
        ).fetchall()
        events = [db._event_row(r) for r in rows]

    spans: dict[str, dict[str, Any]] = {}
    items: list[dict[str, Any]] = []
    open_subagent_keys: list[str] = []
    pending_subagent_stops: list[dict[str, Any]] = []

    def _is_subagent_stop(event: dict[str, Any]) -> bool:
        return (event.get("hook") or "") in SUBAGENT_STOP_HOOKS

    def _extend(span: dict[str, Any], end_ts: str, status: Any) -> None:
        if (end_ts or "") > (span.get("end_ts") or ""):
            span["end_ts"] = end_ts
            span["ongoing"] = False
            span["duration_ms"] = int((db._duration_seconds(span["start_ts"], end_ts) or 0) * 1000)
            span["status"] = status or span.get("status")

    for event in events:
        category = event.get("category") or "other"
        target = event.get("target") or ""
        phase = event.get("phase") or "instant"
        key = f"{category}::{target}"

        if phase == "superseded":
            continue

        if phase == "start":
            spans[key] = {**event, "start_ts": event["ts"], "end_ts": None, "ongoing": True}
            if category == "subagent":
                open_subagent_keys.append(key)
            continue

        if phase == "end" and key in spans:
            start = spans.pop(key)
            if category == "subagent" and key in open_subagent_keys:
                open_subagent_keys.remove(key)
            duration = event.get("duration_ms") or start.get("duration_ms")
            if duration is None:
                duration = int((db._duration_seconds(start["start_ts"], event["ts"]) or 0) * 1000)
            merged = {
                **start,
                "end_ts": event["ts"],
                "ongoing": False,
                "duration_ms": duration,
                "detail": _merge_detail(start.get("detail"), event.get("detail")),
                "status": event.get("status") or start.get("status"),
            }
            items.append(merged)
            if category == "subagent" and not _is_subagent_stop(event):
                pending_subagent_stops.append(merged)
            continue

        if category == "subagent" and phase == "end":
            if open_subagent_keys:
                start = spans.pop(open_subagent_keys.pop(0))
                duration = int((db._duration_seconds(start["start_ts"], event["ts"]) or 0) * 1000)
                items.append({
                    **start,
                    "end_ts": event["ts"],
                    "ongoing": False,
                    "duration_ms": duration,
                    "status": event.get("status") or start.get("status"),
                })
                continue
            if pending_subagent_stops:
                _extend(pending_subagent_stops.pop(0), event["ts"], event.get("status"))
                continue
            if _is_subagent_stop(event):
                continue

        items.append({**event, "start_ts": event["ts"], "end_ts": event["ts"], "ongoing": False})

    for pending in spans.values():
        items.append({**pending, "end_ts": None})

    items.sort(key=lambda item: item.get("start_ts") or item.get("ts") or "")
    return items


def _fetch_inlined_session_events(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    skip_history_dump: bool,
    inline_kind: InlineKind,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    raw_rows = conn.execute(
        "SELECT * FROM events WHERE session_id=? ORDER BY ts ASC, id ASC",
        (session_id,),
    ).fetchall()
    clarifications, annotations = build_clarifications(raw_rows)
    _stamp_clarification_session(clarifications, session_id)

    out: list[dict[str, Any]] = []
    for row in build_timeline_items(session_id):
        if skip_history_dump and row.get("category") == "prompt" and _is_approval_history_dump(row.get("detail")):
            continue
        item: dict[str, Any] = dict(row)
        item["owner_session_id"] = session_id
        item["provenance"] = inline_kind
        _apply_event_annotations(item, annotations, session_id=session_id, trim_detail=False)
        out.append(item)
    return out, clarifications


def _merge_linked_session_events(
    conn: sqlite3.Connection,
    events: list[dict[str, Any]],
    links: dict[str, list[dict[str, Any]]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    children = links.get("children") or []
    parents = links.get("parents") or []
    if not children and not parents:
        return events, []
    merged = list(events)
    linked_clarifications: list[dict[str, Any]] = []
    for link in children:
        if link.get("type") == "subagent":
            inlined, clarifications = _fetch_inlined_session_events(
                conn, link["session_id"], skip_history_dump=False, inline_kind="subagent"
            )
        else:
            inlined, clarifications = _fetch_inlined_session_events(
                conn,
                link["session_id"],
                skip_history_dump=True,
                inline_kind="approval_review",
            )
        merged.extend(inlined)
        linked_clarifications.extend(clarifications)
    for link in parents:
        if link.get("type") == "subagent":
            continue
        inlined, clarifications = _fetch_inlined_session_events(
            conn, link["session_id"], skip_history_dump=False, inline_kind="reviewed_session"
        )
        merged.extend(inlined)
        linked_clarifications.extend(clarifications)
    merged.sort(key=lambda e: (e.get("ts") or "", e.get("id") or 0))
    linked_clarifications.sort(key=lambda c: (c.get("question_ts") or "", c.get("question_event_id") or 0))
    return merged, linked_clarifications


def _trim_detail_inplace(item: dict[str, Any], session_id: str) -> None:
    detail = item.get("detail")
    if isinstance(detail, str) and len(detail) > DETAIL_PREVIEW_CHARS:
        item["detail"] = detail[:DETAIL_PREVIEW_CHARS]
        item["detail_truncated"] = True
        item["detail_lookup"] = {
            "session_id": item.get("owner_session_id") or session_id,
            "event_id": item["id"],
        }


def _drop_orphan_subagent_stops(
    events: list[dict[str, Any]], timeline_items: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    completed_subagent_ends = {
        item.get("end_ts")
        for item in timeline_items
        if item.get("category") == "subagent" and item.get("end_ts")
    }
    return [
        item
        for item in events
        if not (
            item.get("category") == "subagent"
            and item.get("phase") == "end"
            and item.get("hook") in SUBAGENT_STOP_HOOKS
            and item.get("ts") not in completed_subagent_ends
        )
    ]


def _synthesize_child_subagent_spans(
    events: list[dict[str, Any]],
    timeline_items: list[dict[str, Any]],
    links: dict[str, list[dict[str, Any]]],
    parent_session_id: str,
) -> None:
    children = links.get("children") or []
    if not children:
        return
    by_child: dict[str, list[dict[str, Any]]] = {}
    for ev in events:
        sid = ev.get("owner_session_id")
        if sid and sid != parent_session_id:
            by_child.setdefault(sid, []).append(ev)

    native_spans = [
        it
        for it in timeline_items
        if it.get("category") == "subagent" and not it.get("_child_session_id")
    ]
    claimed: set[int] = set()

    def _start_of(span: dict[str, Any]) -> str:
        return span.get("start_ts") or span.get("ts") or ""

    synthetic_id = -1
    for link in children:
        child_id = link.get("session_id")
        if not child_id:
            continue
        child_events = by_child.get(child_id)
        if not child_events:
            continue
        kind = "subagent" if link.get("type") == "subagent" else "approval_review"
        starts = [
            e.get("start_ts") or e.get("ts")
            for e in child_events
            if (e.get("start_ts") or e.get("ts"))
        ]
        ends = [
            e.get("end_ts") or e.get("ts") or e.get("start_ts")
            for e in child_events
            if (e.get("end_ts") or e.get("ts") or e.get("start_ts"))
        ]
        if not starts:
            continue
        ts_first = min(starts)
        ts_last = max(ends) if ends else ts_first
        if kind == "approval_review":
            label = "Approval review"
        else:
            label = (link.get("title") or link.get("label") or "Subagent").strip() or "Subagent"

        adopt_idx: int | None = None
        if kind == "subagent":
            cands = [i for i in range(len(native_spans)) if i not in claimed]
            le = [i for i in cands if _start_of(native_spans[i]) <= ts_first]
            if le:
                adopt_idx = max(le, key=lambda i: _start_of(native_spans[i]))
            elif cands:
                adopt_idx = min(cands, key=lambda i: _start_of(native_spans[i]))
        if adopt_idx is not None:
            claimed.add(adopt_idx)
            span = native_spans[adopt_idx]
            span["_child_session_id"] = child_id
            span["_run_kind"] = kind
            for event in events:
                if event.get("id") == span.get("id") and event.get("category") == "subagent":
                    event["_child_session_id"] = child_id
                    event["_run_kind"] = kind
            continue

        dur = int((db._duration_seconds(ts_first, ts_last) or 0) * 1000)
        span = {
            "id": synthetic_id,
            "hook": None,
            "tool": None,
            "phase": "start",
            "ts": ts_first,
            "source": link.get("source"),
            "category": "subagent",
            "title": label,
            "detail": None,
            "target": f"child::{child_id}",
            "status": "success",
            "duration_ms": dur,
            "model": None,
            "attachments": None,
            "start_ts": ts_first,
            "end_ts": ts_last,
            "ongoing": False,
            "owner_session_id": parent_session_id,
            "_child_session_id": child_id,
            "_run_kind": kind,
        }
        synthetic_id -= 1
        events.append(dict(span))
        timeline_items.append(dict(span))


def _subagent_label(item: dict[str, Any]) -> str:
    title = str(item.get("title") or "").strip()
    if title and title != "Subagent":
        return title
    target = str(item.get("target") or "").strip()
    if target and not target.startswith(("call_", "toolu_")):
        return target
    return "Subagent"


def _public_item(item: dict[str, Any]) -> dict[str, Any]:
    out = dict(item)
    for key in PRIVATE_ITEM_KEYS:
        out.pop(key, None)
    return out


def _timeline_runs(
    timeline_items: list[dict[str, Any]], events: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    event_by_id = {
        item["id"]: item
        for item in events
        if item.get("category") == "subagent" and isinstance(item.get("id"), int)
    }
    for item in timeline_items:
        if item.get("category") != "subagent" or not (item.get("start_ts") or item.get("ts")):
            continue
        run_item = event_by_id.get(item["id"], item)
        runs.append(
            {
                "id": item["id"],
                "kind": "review"
                if item.get("_run_kind") == "approval_review"
                else "subagent",
                "label": _subagent_label(item),
                "start": item.get("start_ts") or item.get("ts"),
                "end": item.get("end_ts"),
                "status": item.get("status"),
                "duration_ms": item.get("duration_ms"),
                "ongoing": item.get("ongoing") if "ongoing" in item else item.get("end_ts") is None,
                "child_session_id": item.get("_child_session_id"),
                "item": _public_item(run_item),
            }
        )
    runs.sort(key=lambda r: r["start"] or "")
    return runs


def _event_time(item: dict[str, Any]) -> str:
    return item.get("start_ts") or item.get("ts") or ""


def _in_window(ts: str, start: str, end: str | None) -> bool:
    if ts < start:
        return False
    return True if end is None else ts <= end


def _assign_run_membership(events: list[dict[str, Any]], runs: list[dict[str, Any]]) -> None:
    for run in runs:
        run_id = run["id"]
        child_session_id = run.get("child_session_id")
        if child_session_id:
            members = [
                item
                for item in events
                if item.get("owner_session_id") == child_session_id and item.get("id") != run_id
            ]
        else:
            members = [
                item
                for item in events
                if item.get("category") in RUN_CONTENT_CATEGORIES
                and _in_window(_event_time(item), run["start"], run["end"])
            ]
        for item in members:
            item["run_id"] = run_id
            item["run_kind"] = run["kind"]


def _apply_event_annotations(
    item: dict[str, Any],
    annotations: dict[int, dict[str, Any]],
    *,
    session_id: str,
    trim_detail: bool,
) -> None:
    extra = annotations.get(item["id"])
    if extra:
        item.update(extra)
    if item.get("category") == "question":
        item["questions"] = parse_questions(item.get("detail"))
    if trim_detail:
        _trim_detail_inplace(item, session_id)


def build_session_detail(session_id: str) -> dict[str, Any] | None:
    """Return the display-ready session detail read model."""
    with db._connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return None
        summary = db._session_summary(conn, row)
        ev_rows = conn.execute(
            "SELECT id, category, detail, ts, hook, tool FROM events"
            " WHERE session_id=? ORDER BY ts ASC, id ASC",
            (session_id,),
        ).fetchall()
        links = db._session_links(conn, session_id)
        clarifications, annotations = build_clarifications(ev_rows)
        _stamp_clarification_session(clarifications, session_id)
        timeline_items = build_timeline_items(session_id)
        events = [dict(item) for item in timeline_items]

        for item in events:
            item["owner_session_id"] = session_id
            _apply_event_annotations(item, annotations, session_id=session_id, trim_detail=True)
        events, linked_clarifications = _merge_linked_session_events(conn, events, links)
        clarifications.extend(linked_clarifications)
        clarifications.sort(key=lambda c: (c.get("question_ts") or "", c.get("question_event_id") or 0))
        for item in events:
            if item.get("provenance"):
                _trim_detail_inplace(item, item.get("owner_session_id") or session_id)

        _synthesize_child_subagent_spans(events, timeline_items, links, session_id)
        events = _drop_orphan_subagent_stops(events, timeline_items)
        for item in timeline_items:
            item["owner_session_id"] = session_id
            _apply_event_annotations(item, annotations, session_id=session_id, trim_detail=False)
            item["detail"] = None

        components = db.session_components(session_id)

    runs = _timeline_runs(timeline_items, events)
    _assign_run_membership(events, runs)
    return {
        "summary": summary,
        "links": links,
        "components": components,
        "events": [_public_item(item) for item in events],
        # Deprecated compatibility field: the dashboard renders `events` plus
        # `timeline_runs`, but older callers still expect a parent-only list.
        "timeline": [_public_item(item) for item in timeline_items],
        "timeline_runs": runs,
        "clarifications": clarifications,
    }

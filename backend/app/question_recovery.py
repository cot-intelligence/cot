"""Cursor AskQuestion answer recovery.

This module owns the pure question-recovery interface: question tool input plus
the agent's follow-up prose in, recovered structured response out.
"""

from __future__ import annotations

import re
from typing import Any

ANSWER_SOURCE_ASSISTANT_SUMMARY = "assistant_summary"


def _norm_choice(text: object) -> str:
    return " ".join(str(text or "").lower().replace("_", " ").split())


def _contains_positive(haystack: str, needle: str) -> bool:
    if not needle:
        return False
    start = haystack.find(needle)
    if start < 0:
        return False
    before = haystack[max(0, start - 24) : start].split()
    return not any(tok in {"no", "not", "without"} for tok in before[-3:])


def _choice_matches(label: str, option_id: str, response_text: str) -> bool:
    haystack = _norm_choice(response_text)
    candidates = [label, label.split(" (", 1)[0]]
    if " for now" in label:
        candidates.append(label.split(" for now", 1)[0])
    if " — " in label:
        candidates.append(label.split(" — ", 1)[0])
    if any(len(_norm_choice(c)) >= 4 and _contains_positive(haystack, _norm_choice(c)) for c in candidates):
        return True
    oid = _norm_choice(option_id.replace("_", " "))
    # Option ids only count as a match when reasonably long; short ids are
    # often common English words that appear in prose by coincidence.
    if len(oid) >= 8 and _contains_positive(haystack, oid):
        return True
    return False


# The agent states its choice up front; a long deliberation tail can re-mention
# every option and only add ambiguity.
_ANSWER_REGION_CHARS = 700


def _answer_region(text: str) -> str:
    region = str(text or "").strip()
    markers = (
        "\n---",
        "\n## Full picture",
        "\n## Suggested",
        "\n**Suggested roadmap",
        "\n**Still unanswered",
        "\n**Two optional follow-ups",
    )
    for marker in markers:
        idx = region.find(marker)
        if idx >= 0:
            region = region[:idx]
    return region[:_ANSWER_REGION_CHARS]


_TITLE_STOPWORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "then", "with", "your", "you", "for",
        "now", "via", "use", "using", "run", "not", "but", "its", "this",
        "that", "into", "etc", "all", "any", "per", "are", "was", "will",
    }
)


def _option_title(label: str) -> str:
    t = str(label or "")
    for sep in (":", " — ", " - ", " ("):
        if sep in t:
            t = t.split(sep, 1)[0]
    return t.strip()


def _word_tokens(text: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9]+", str(text or "").lower()) if w]


def _title_tokens(title: str) -> list[str]:
    return [w for w in _word_tokens(title) if len(w) >= 3 and w not in _TITLE_STOPWORDS]


def _token_present(tok: str, resp_tokens: list[str]) -> bool:
    for rt in resp_tokens:
        if len(rt) < 3:
            continue
        if rt.startswith(tok) or tok.startswith(rt):
            return True
    return False


_TITLE_MATCH_MIN_RATIO = 0.6


def _unique_title_match(options: list[Any], match_text: str, min_margin: float = 0.2) -> str | None:
    """Recover a paraphrased selection by title-word overlap."""
    resp_tokens = _word_tokens(match_text)
    if not resp_tokens:
        return None
    scored: list[tuple[float, int, str]] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        label = str(opt.get("label") or "").strip()
        option_id_text = str(opt.get("id") or "").strip()
        title_terms = _title_tokens(_option_title(label))
        if len(title_terms) < 2:
            scored.append((0.0, 0, label or option_id_text))
            continue
        present = sum(1 for term in title_terms if _token_present(term, resp_tokens))
        scored.append((present / len(title_terms), present, label or option_id_text))
    if not scored:
        return None
    scored.sort(key=lambda x: (-x[0], -x[1]))
    best_ratio, best_present, best_label = scored[0]
    second_ratio = scored[1][0] if len(scored) > 1 else 0.0
    if (
        best_present >= 2
        and best_ratio >= _TITLE_MATCH_MIN_RATIO
        and best_ratio - second_ratio >= min_margin
    ):
        return best_label
    return None


_DECISION_ANCHORS = re.compile(
    r"\b(?:went with|going with|go with|i'?ll go with|let'?s go with|you chose|"
    r"i chose|we chose|chose|settling on|settle on|decided (?:on|to)|decided|"
    r"picked|selected|opting for|opted for)\b"
    r"|^\s*(?:got it|ok|okay|sounds good|perfect|great)\b[\s,:\u2014-]",
    re.I | re.M,
)
_DECISION_SPAN_CHARS = 200


def _decision_region(text: str) -> str:
    """Concatenate the short spans that follow each decision phrase."""
    s = str(text or "")
    spans = [s[m.start() : m.start() + _DECISION_SPAN_CHARS] for m in _DECISION_ANCHORS.finditer(s)]
    return " ".join(spans)


def _match_question(options: list[Any], region: str, min_margin: float = 0.2) -> list[str]:
    """Match options against a region."""
    labels: list[str] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        label = str(opt.get("label") or "").strip()
        oid = str(opt.get("id") or "").strip()
        if _choice_matches(label, oid, region):
            labels.append(label or oid)
    if not labels:
        single = _unique_title_match(options, region, min_margin)
        if single:
            labels = [single]
    return labels


def recover_cursor_question_response(tool_input: dict[str, Any], response_text: str) -> dict[str, Any]:
    """Recover Cursor AskQuestion selections from the assistant summary.

    Cursor writes the AskQuestion prompt to its transcript, but current hooks do
    not include a tool result. The next assistant response normally names the
    selected option labels. Match only explicit labels/ids so we do not invent
    free-form answers.
    """
    questions = tool_input.get("questions") if isinstance(tool_input.get("questions"), list) else []
    answer_region = _answer_region(response_text)
    decision_region = _decision_region(response_text)
    haystack = _norm_choice(response_text)
    mentions_skip = any(word in haystack for word in ("skipped", "unanswered", "still open"))
    answers: dict[str, dict[str, list[str]]] = {}
    skipped: list[str] = []

    for q in questions:
        if not isinstance(q, dict):
            continue
        qid = str(q.get("id") or "")
        if not qid:
            continue
        options = q.get("options") if isinstance(q.get("options"), list) else []
        labels = _match_question(options, decision_region, 0.15) if decision_region else []
        if not labels:
            labels = _match_question(options, answer_region, 0.25)
        if labels:
            answers[qid] = {"answers": labels}
        elif mentions_skip:
            skipped.append(qid)

    response_payload: dict[str, Any] = {}
    if answers:
        response_payload["answers"] = answers
        response_payload["answer_source"] = ANSWER_SOURCE_ASSISTANT_SUMMARY
    if skipped:
        response_payload["skipped"] = skipped
    return response_payload

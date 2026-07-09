from __future__ import annotations

import asyncio
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import SkipTest

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BACKEND)
_TMP = tempfile.mkdtemp(prefix="cot-question-recovery-test-")

sys.path.insert(0, _BACKEND)
os.environ["COT_DB_PATH"] = os.path.join(_TMP, "bootstrap.db")

from app import db  # noqa: E402
from app.question_recovery import recover_cursor_question_response  # noqa: E402

_case = 0
_HEURISTIC_CASES = [
    {
        "name": "explicit_label",
        "input": {
            "title": "Deploy strategy",
            "questions": [
                {
                    "id": "deploy_path",
                    "question": "How should I deploy?",
                    "options": [
                        {"id": "restart_only", "label": "Restart service only"},
                        {
                            "id": "rebuild_prod",
                            "label": "Rebuild prod image + restart (Recommended)",
                        },
                    ],
                }
            ],
        },
        "prose": (
            "Got it, I chose Rebuild prod image + restart (Recommended). "
            "I will rebuild the image and restart the service now."
        ),
        "expected": {
            "answers": {
                "deploy_path": {
                    "answers": ["Rebuild prod image + restart (Recommended)"],
                }
            },
            "answer_source": "assistant_summary",
        },
    },
    {
        "name": "paraphrased_title",
        "input": {
            "title": "Recovery scope",
            "questions": [
                {
                    "id": "scope",
                    "question": "Which recovery pass should I run?",
                    "options": [
                        {"id": "full_recover", "label": "Full transcript recovery: scan every session"},
                        {"id": "single_owner", "label": "Single owner refactor: collector derives answers"},
                    ],
                }
            ],
        },
        "prose": (
            "I'll go with the single owner refactor so the collector derives answers "
            "from the raw follow-up text."
        ),
        "expected": {
            "answers": {
                "scope": {
                    "answers": ["Single owner refactor: collector derives answers"],
                }
            },
            "answer_source": "assistant_summary",
        },
    },
    {
        "name": "ambiguous",
        "input": {
            "title": "Ambiguous choice",
            "questions": [
                {
                    "id": "choice",
                    "question": "Which option did the user pick?",
                    "options": [
                        {"id": "alpha_path", "label": "Alpha path"},
                        {"id": "beta_path", "label": "Beta path"},
                    ],
                }
            ],
        },
        "prose": "I need one more clarification before choosing.",
        "expected": {},
    },
    {
        "name": "skipped_marker",
        "input": {
            "title": "Follow-up batches",
            "questions": [
                {
                    "id": "batch",
                    "question": "Which follow-up batch should stay open?",
                    "options": [
                        {"id": "ship_now", "label": "Ship now"},
                        {"id": "ask_later", "label": "Ask later"},
                    ],
                }
            ],
        },
        "prose": "This is still open; I do not have enough information to choose.",
        "expected": {
            "skipped": ["batch"],
            "answer_source": "assistant_summary",
        },
    },
    {
        "name": "multi_question",
        "input": {
            "title": "Two clarifications",
            "questions": [
                {
                    "id": "deploy",
                    "question": "How should I deploy?",
                    "options": [
                        {"id": "restart_only", "label": "Restart service only"},
                        {
                            "id": "rebuild_prod",
                            "label": "Rebuild prod image + restart (Recommended)",
                        },
                    ],
                },
                {
                    "id": "notify",
                    "question": "Should I notify after deploying?",
                    "options": [
                        {"id": "silent", "label": "No notification"},
                        {"id": "send_summary", "label": "Send summary to the team"},
                    ],
                },
            ],
        },
        "prose": "I chose Rebuild prod image + restart (Recommended) and Send summary to the team.",
        "expected": {
            "answers": {
                "deploy": {
                    "answers": ["Rebuild prod image + restart (Recommended)"],
                },
                "notify": {
                    "answers": ["Send summary to the team"],
                },
            },
            "answer_source": "assistant_summary",
        },
    },
]


def _fresh() -> str:
    global _case
    _case += 1
    sid = f"question-recovery-{_case}"
    os.environ["COT_DB_PATH"] = os.path.join(_TMP, f"case{_case}.db")
    db.init_db()
    return sid


def _question_input() -> dict:
    return {
        "title": "Deploy strategy",
        "questions": [
            {
                "id": "deploy_path",
                "question": "How should I deploy?",
                "options": [
                    {"id": "restart_only", "label": "Restart service only"},
                    {"id": "rebuild_prod", "label": "Rebuild prod image + restart (Recommended)"},
                ],
            }
        ],
    }


def _post_question_event(
    sid: str,
    *,
    tool_response: object | None = None,
    timestamp: str = "2026-07-08T12:00:00Z",
) -> int:
    result = db.record_ingest(
        "cursor",
        {
            "hook_event_name": "postToolUse",
            "session_id": sid,
            "timestamp": timestamp,
            "tool_name": "AskQuestion",
            "tool_input": _question_input(),
            "tool_response": {} if tool_response is None else tool_response,
        },
    )
    return int(result["event_id"])


def _stored_response(event_id: int) -> object:
    with db._connect() as conn:
        row = conn.execute("SELECT detail FROM events WHERE id = ?", (event_id,)).fetchone()
    assert row is not None
    return json.loads(row["detail"])["response"]


class _Request:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    async def json(self) -> dict:
        return self._payload


def _answer_endpoint(payload: dict) -> dict:
    try:
        from app import main
    except ModuleNotFoundError as exc:
        if exc.name != "fastapi":
            raise
        raise SkipTest(
            "FastAPI is not installed; install backend requirements to run endpoint tests"
        ) from exc
    return asyncio.run(main.set_question_answer(_Request(payload)))  # type: ignore[arg-type]


def _set_answer(payload: dict) -> dict:
    return {
        "ok": True,
        "updated": db.set_question_answer(
            str(payload.get("session_id") or ""),
            payload.get("title"),
            payload.get("qids") if isinstance(payload.get("qids"), list) else [],
            payload.get("response") if isinstance(payload.get("response"), dict) else {},
            payload.get("response_text") if isinstance(payload.get("response_text"), str) else None,
        ),
    }


def test_heuristic_examples_recover_expected_answers():
    for case in _HEURISTIC_CASES:
        assert (
            recover_cursor_question_response(case["input"], case["prose"]) == case["expected"]
        ), case["name"]


def test_answer_endpoint_accepts_prose_and_session_detail_shows_recovered_answer():
    sid = _fresh()
    _post_question_event(sid)

    result = _answer_endpoint(
        {
            "session_id": sid,
            "title": "Deploy strategy",
            "qids": ["deploy_path"],
            "response_text": "Got it, I chose Rebuild prod image + restart (Recommended).",
        }
    )

    assert result == {"ok": True, "updated": 1}
    detail = db.get_session_detail(sid)
    assert detail is not None
    question_event = [e for e in detail["events"] if e.get("category") == "question"][0]
    assert question_event["questions"][0]["answer"] == "Rebuild prod image + restart (Recommended)"


def test_answer_endpoint_still_accepts_legacy_prederived_response():
    sid = _fresh()
    event_id = _post_question_event(sid)
    legacy = {
        "answers": {"deploy_path": {"answers": ["Restart service only"]}},
        "answer_source": "assistant_summary",
    }

    assert (
        _set_answer(
            {
                "session_id": sid,
                "title": "Deploy strategy",
                "qids": ["deploy_path"],
                "response": legacy,
            }
        )["updated"]
        == 1
    )

    assert _stored_response(event_id) == legacy


def test_collector_derivation_wins_when_prose_and_legacy_response_are_both_present():
    sid = _fresh()
    event_id = _post_question_event(sid)
    stale_bridge_guess = {
        "answers": {"deploy_path": {"answers": ["Restart service only"]}},
        "answer_source": "assistant_summary",
    }

    result = _set_answer(
        {
            "session_id": sid,
            "title": "Deploy strategy",
            "qids": ["deploy_path"],
            "response": stale_bridge_guess,
            "response_text": "Perfect, selected Rebuild prod image + restart (Recommended).",
        }
    )

    assert result["updated"] == 1
    assert _stored_response(event_id)["answers"]["deploy_path"]["answers"] == [
        "Rebuild prod image + restart (Recommended)"
    ]


def test_recovery_can_replace_heuristic_answers_but_not_real_answers():
    sid = _fresh()
    recovered_id = _post_question_event(
        sid,
        tool_response={
            "answers": {"deploy_path": {"answers": ["Restart service only"]}},
            "answer_source": "assistant_summary",
        },
    )
    real_id = _post_question_event(
        sid,
        tool_response={"answers": {"deploy_path": {"answers": ["Restart service only"]}}},
        timestamp="2026-07-08T12:00:01Z",
    )

    result = _set_answer(
        {
            "session_id": sid,
            "title": "Deploy strategy",
            "qids": ["deploy_path"],
            "response_text": "I went with Rebuild prod image + restart (Recommended).",
        }
    )

    assert result["updated"] == 1
    assert _stored_response(recovered_id)["answers"]["deploy_path"]["answers"] == [
        "Rebuild prod image + restart (Recommended)"
    ]
    assert _stored_response(real_id)["answers"]["deploy_path"]["answers"] == ["Restart service only"]
    assert db.clear_recovered_answers() == 1
    assert _stored_response(recovered_id) == {}
    assert _stored_response(real_id)["answers"]["deploy_path"]["answers"] == ["Restart service only"]


def test_ambiguous_prose_does_not_apply_legacy_response_when_prose_is_present():
    sid = _fresh()
    event_id = _post_question_event(sid)

    result = _set_answer(
        {
            "session_id": sid,
            "title": "Deploy strategy",
            "qids": ["deploy_path"],
            "response": {
                "answers": {"deploy_path": {"answers": ["Restart service only"]}},
                "answer_source": "assistant_summary",
            },
            "response_text": "I need one more clarification before choosing.",
        }
    )

    assert result["updated"] == 0
    assert _stored_response(event_id) == {}


def _write_question_transcript(tool_input: dict, response_text: str) -> tempfile.TemporaryDirectory:
    tmp = tempfile.TemporaryDirectory()
    transcript = Path(tmp.name) / "session-1.jsonl"
    transcript.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "role": "assistant",
                        "message": {
                            "content": [
                                {"type": "tool_use", "name": "AskQuestion", "input": tool_input}
                            ]
                        },
                    }
                ),
                json.dumps(
                    {
                        "role": "assistant",
                        "message": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": response_text,
                                }
                            ]
                        },
                    }
                ),
            ]
        )
    )
    return tmp


def test_bridge_push_and_collector_backfill_derive_same_answer_from_transcript():
    bridge = _load_bridge()
    tmp = _write_question_transcript(
        _question_input(),
        "Selected Rebuild prod image + restart (Recommended).",
    )
    transcript = Path(tmp.name) / "session-1.jsonl"

    sid = _fresh()
    event_id = _post_question_event(sid)
    bridge_item = bridge._scan_questions_full(transcript)[0]
    assert (
        db.set_question_answer(
            sid,
            bridge_item["input"].get("title"),
            bridge._question_qids(bridge_item["input"]),
            response_text=bridge_item["response_text"],
        )
        == 1
    )

    collector_artifact = db._scan_cursor_question_artifacts(transcript)[0]
    assert _stored_response(event_id) == collector_artifact["response"]
    tmp.cleanup()


def test_bridge_push_and_collector_backfill_match_for_skipped_question():
    bridge = _load_bridge()
    tmp = _write_question_transcript(
        _question_input(),
        "This is still open; I do not have enough information to choose.",
    )
    transcript = Path(tmp.name) / "session-1.jsonl"

    sid = _fresh()
    event_id = _post_question_event(sid)
    bridge_item = bridge._scan_questions_full(transcript)[0]
    assert (
        db.set_question_answer(
            sid,
            bridge_item["input"].get("title"),
            bridge._question_qids(bridge_item["input"]),
            response_text=bridge_item["response_text"],
        )
        == 1
    )

    collector_artifact = db._scan_cursor_question_artifacts(transcript)[0]
    assert collector_artifact["response"] == {
        "skipped": ["deploy_path"],
        "answer_source": "assistant_summary",
    }
    assert _stored_response(event_id) == collector_artifact["response"]
    tmp.cleanup()


def test_skipped_recovery_can_be_replaced_by_later_answer_and_reset():
    sid = _fresh()
    event_id = _post_question_event(sid)
    skipped_payload = {
        "session_id": sid,
        "title": "Deploy strategy",
        "qids": ["deploy_path"],
        "response_text": "This is still open; I do not have enough information to choose.",
    }
    answered_payload = {
        "session_id": sid,
        "title": "Deploy strategy",
        "qids": ["deploy_path"],
        "response_text": "Selected Rebuild prod image + restart (Recommended).",
    }

    assert _set_answer(skipped_payload)["updated"] == 1
    assert _stored_response(event_id) == {
        "skipped": ["deploy_path"],
        "answer_source": "assistant_summary",
    }
    assert _set_answer(answered_payload)["updated"] == 1
    assert _stored_response(event_id)["answers"]["deploy_path"]["answers"] == [
        "Rebuild prod image + restart (Recommended)"
    ]
    assert db.clear_recovered_answers() == 1
    assert _stored_response(event_id) == {}


def test_reposting_same_recovery_is_idempotent():
    sid = _fresh()
    event_id = _post_question_event(sid)
    payload = {
        "session_id": sid,
        "title": "Deploy strategy",
        "qids": ["deploy_path"],
        "response_text": "Selected Rebuild prod image + restart (Recommended).",
    }

    assert _set_answer(payload)["updated"] == 1
    assert _set_answer(payload)["updated"] == 0
    assert _stored_response(event_id)["answers"]["deploy_path"]["answers"] == [
        "Rebuild prod image + restart (Recommended)"
    ]


def _load_bridge():
    path = os.path.join(_REPO, "bridge", "cot")
    loader = importlib.machinery.SourceFileLoader("cot_bridge_question_recovery_under_test", path)
    spec = importlib.util.spec_from_loader("cot_bridge_question_recovery_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_bridge_scans_raw_question_prose_without_owning_recovery_heuristic():
    bridge = _load_bridge()
    tmp = _write_question_transcript(
        _question_input(),
        "Selected Rebuild prod image + restart (Recommended).",
    )
    transcript = Path(tmp.name) / "session-1.jsonl"

    assert not hasattr(bridge, "_cursor_question_response")
    assert bridge._scan_questions_full(transcript) == [
        {
            "input": _question_input(),
            "response_text": "Selected Rebuild prod image + restart (Recommended).",
        }
    ]
    tmp.cleanup()


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
            except SkipTest as exc:
                print(f"SKIP {name}: {exc}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"ERROR {name}: {exc}")
    sys.exit(1 if failures else 0)

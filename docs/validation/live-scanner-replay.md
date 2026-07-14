# Live scanner canonical-event validation

**Status: not merge-ready.** Cursor transcript replay is complete. A current
raw-ingest-ledger diff and disposable live smoke Sessions for all three agents
remain open merge gates. Cursor's documented fallback was not needed; the
shared-parser path matched the expected semantic differences.

Validated on 2026-07-15 against base `8d035a0` and the current implementation
commit. The replay compared semantic hashes only; transcript contents were not
printed or copied.

## Posting-seam recordings

`backend/tests/test_bridge_live.py` freezes ordered endpoint/payload behavior
for Cursor plan turns, question turns with and without a recoverable answer,
consecutive repeated commentary, plan-only fallback text, and the hook-text
safety net. It also covers Claude and Codex live shells at the same posting
seam.

These recordings were reconstructed from the `8d035a0` behavior and added in
the implementation commit, rather than committed before the refactor. They are
useful permanent regression tests, but they are not independent historical
evidence and do not satisfy the real-data replay gate by themselves.

Hook-data-wins reconciliation and namespaced-live-key retry idempotency are
covered in the Collector suite by
`backend/tests/test_raw_ingest_drift.py::test_namespaced_live_event_supersedes_import_and_retry_is_idempotent`.

## Local transcript replay

The machine had 11 Claude transcripts and 20 readable Codex transcripts. The
old live scanners and new canonical path produced identical response,
attachment, and web-search multisets for every file. Claude Event counts also
matched exactly. Codex gained only standalone reasoning-summary thought Events,
which is listed in the spec's expected differences because import already
recovered them.

Cursor replay used a purpose-built, non-sensitive fixture Session containing 30
valid main-transcript records and a three-record subagent transcript. The old
scanner and shared-parser path agreed on one structured plan, one AskQuestion,
and all non-duplicate response semantics. The new path removed exactly two
consecutive-identical responses, matching the expected-differences list. Cursor
stored the attached file as textual mentions rather than a structured
attachment record, so both paths emitted zero attachment Events.

The replay exposed Cursor's current interruption shape: a `turn_ended` record
with `status` `error` or `aborted` and a user-abort error string. The shared
parser now maps that shape to the canonical interruption marker. Two main-turn
interruptions and one subagent interruption were recovered; the subagent marker
followed a tool call and correctly flagged the preceding retained response after
tool filtering. The real shape is locked at the posting seam in
`backend/tests/test_bridge_live.py`.

The local `~/.cot/cot.db` still predates `raw_ingest_events`, and no dev
Collector was running during the fixture Session, so no raw-ledger oracle was
available. That input remains required before merge.

`CONTEXT.md` was supplied as an explicit implementation input and committed
intact. Its broader glossary/component material was therefore not authored as
part of this refactor; the relevant implementation side effect is the included
Ingest Event definition.

## Smoke status

No dev Collector was running for disposable live Sessions, so the three-agent
live smoke remains a pre-merge manual gate. The implementation does not mutate
the developer's installed hooks or production Collector as part of validation.

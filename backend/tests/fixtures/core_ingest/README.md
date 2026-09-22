# Core Ingest Golden Session Fixtures

Each fixture directory contains:

- `metadata.json`: fixture name, agent, ingest path, captured date, sanitizer notes, and session id.
- `input.jsonl`: sanitized source data for the ingest path.
- `expected.projection.json`: normalized `GET /v1/sessions/{session_id}` UI Ingest Projection.

Normal tests never mutate snapshots. Refresh a fixture manually after reviewing sanitized input changes:

```sh
python scripts/refresh_core_ingest_snapshots.py --fixture codex/live/golden-session
python scripts/refresh_core_ingest_snapshots.py --fixture codex/history/golden-session
```

To replace the tracer-bullet sample with a newly captured Codex Golden Session, update the relevant `input.jsonl` and `metadata.json`, then run the refresh command and review the JSON diff.

"""session_stats stays equal to a recompute from events, whatever writes events."""

from __future__ import annotations

import random
from pathlib import Path

from app import db, store

_RECOMPUTE = """
SELECT session_id, COUNT(*) AS event_count,
    SUM(category IS NOT NULL AND category != 'lifecycle') AS content_count,
    SUM(tool IS NOT NULL) AS tool_count, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
    COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
    MIN(CASE WHEN category = 'prompt' THEN id END) AS first_prompt_id
FROM events GROUP BY session_id ORDER BY session_id
"""


def _state(conn) -> tuple[list[tuple], list[tuple]]:
    want = [tuple(r) for r in conn.execute(_RECOMPUTE)]
    got = [tuple(r) for r in conn.execute(f"SELECT {db._SESSION_STATS_COLUMNS} FROM session_stats ORDER BY session_id")]
    return got, want


def _session(conn, sid: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, source, started_at, status, created_at)"
        " VALUES (?, 'claude', '2026-01-01T00:00:00Z', 'active', '2026-01-01T00:00:00Z')",
        (sid,),
    )


def test_rollup_matches_recompute_through_inserts_updates_and_deletes(fresh_db: Path):
    rng = random.Random(7)
    cats = [None, "lifecycle", "prompt", "shell", "file_read", "response"]
    with store.write() as conn:
        for sid in ("a", "b", "c"):
            _session(conn, sid)
        for _ in range(300):
            op = rng.random()
            ids = [r[0] for r in conn.execute("SELECT id FROM events")]
            if op < 0.6 or not ids:
                store.insert_event(
                    conn,
                    session_id=rng.choice("abc"),
                    source="claude",
                    ts=f"2026-01-01T00:{rng.randrange(60):02d}:00Z" if rng.random() > 0.05 else None,
                    category=rng.choice(cats),
                    tool=rng.choice([None, "Bash", "Read"]),
                    input_tokens=rng.choice([None, 0, 5, 100]),
                    output_tokens=rng.randrange(50),
                )
            elif op < 0.8:
                eid = rng.choice(ids)
                col, val = rng.choice([
                    ("category", rng.choice(cats)),
                    ("ts", f"2026-01-01T01:{rng.randrange(60):02d}:00Z"),
                    ("tool", rng.choice([None, "Edit"])),
                    ("input_tokens", rng.randrange(10)),
                    ("session_id", rng.choice("abc")),
                    ("detail", "not counted"),
                ])
                conn.execute(f"UPDATE events SET {col} = ? WHERE id = ?", (val, eid))
            else:
                conn.execute("DELETE FROM events WHERE id = ?", (rng.choice(ids),))
            got, want = _state(conn)
            assert got == want
        # A session delete cascades to its events, and its stats row goes with them.
        conn.execute("DELETE FROM sessions WHERE id = 'a'")
        got, want = _state(conn)
        assert got == want
        assert not conn.execute("SELECT 1 FROM session_stats WHERE session_id = 'a'").fetchone()


def test_backfill_on_upgrade_matches_recompute(fresh_db: Path):
    with store.write() as conn:
        _session(conn, "s")
        for i in range(20):
            store.insert_event(conn, session_id="s", source="claude", ts=f"2026-01-01T00:00:{i:02d}Z",
                               category="prompt" if i % 7 == 0 else "shell", tool="Bash", input_tokens=i)
        # An older DB: no rollup yet.
        conn.execute("DELETE FROM settings WHERE key = 'session_stats_version'")
        for name in ("session_stats_insert", "session_stats_delete", "session_stats_update"):
            conn.execute(f"DROP TRIGGER {name}")
        conn.execute("DROP TABLE session_stats")
    db.init_db(build_search_index=False)
    with store.read() as conn:
        got, want = _state(conn)
    assert got == want and got[0][1] == 20

"""Semantic search over prompts and responses, opt-in.

Off unless ``COT_EMBEDDINGS_URL`` and ``COT_EMBEDDINGS_MODEL`` are set. The URL
is any OpenAI-compatible ``/v1`` base (Ollama, LM Studio, vLLM, OpenAI);
``COT_EMBEDDINGS_KEY`` is sent as a bearer token when set. Prompt and response
text leaves the machine only to that endpoint, with secrets masked first, so a
local model keeps everything local.

Vectors are cut to ``COT_EMBEDDINGS_DIM`` (default 256) and re-normalized, which
Matryoshka-trained models (nomic-embed-text, OpenAI text-embedding-3) tolerate
well, and held in memory as one float32 array: ranking is a brute-force dot
product in pure Python, about a quarter second over 40k messages.
"""

from __future__ import annotations

import json
import logging
import math
import operator
import os
import threading
import time
import urllib.error
import urllib.request
from array import array
from typing import Any

from . import ai_insights, db, store, timeutil

_log = logging.getLogger(__name__)

CATEGORIES = ("prompt", "response")
_TEXT_CHARS = 2000
_BATCH = 32
_IDLE_S = 60.0
_TIMEOUT_S = 30

_SCHEMA = """
CREATE TABLE IF NOT EXISTS embeddings (
    event_id   INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    model      TEXT NOT NULL,
    vec        BLOB NOT NULL
)
"""

_lock = threading.Lock()
_index: dict[str, Any] = {"key": None, "ids": array("q"), "vecs": array("f"), "count": 0}
_state: dict[str, Any] = {"running": False, "error": None, "last_run": None}


def config() -> dict[str, Any] | None:
    url = os.environ.get("COT_EMBEDDINGS_URL", "").strip().rstrip("/")
    model = os.environ.get("COT_EMBEDDINGS_MODEL", "").strip()
    if not url or not model:
        return None
    try:
        dim = max(16, int(os.environ.get("COT_EMBEDDINGS_DIM", "256")))
    except ValueError:
        dim = 256
    if not url.endswith("/embeddings"):
        url = f"{url}/embeddings"
    return {"url": url, "model": model, "dim": dim, "key": os.environ.get("COT_EMBEDDINGS_KEY", "").strip()}


def _normalize(vec: list[float], dim: int) -> array:
    v = vec[:dim]
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return array("f", (x / norm for x in v))


def embed(texts: list[str], cfg: dict[str, Any]) -> list[array]:
    body = json.dumps({"model": cfg["model"], "input": texts}).encode()
    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = f"Bearer {cfg['key']}"
    req = urllib.request.Request(cfg["url"], data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
        data = json.loads(resp.read().decode())
    rows = sorted(data.get("data") or [], key=lambda d: d.get("index", 0))
    if len(rows) != len(texts):
        raise ValueError(f"embeddings endpoint returned {len(rows)} vectors for {len(texts)} inputs")
    return [_normalize(r["embedding"], cfg["dim"]) for r in rows]


def _ensure_table() -> None:
    with store.write() as conn:
        conn.execute(_SCHEMA)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_embeddings_session ON embeddings(session_id)")


def _model_key(cfg: dict[str, Any]) -> str:
    return f"{cfg['model']}@{cfg['dim']}"


def _text(row: Any) -> str:
    raw = row["detail"] or row["title"] or ""
    try:
        body = json.loads(raw)
        if isinstance(body, dict):
            raw = str(body.get("text") or body.get("prompt") or body.get("message") or raw)
    except (json.JSONDecodeError, TypeError):
        pass
    return ai_insights.mask_text(raw.strip()[:_TEXT_CHARS])


def _candidates(conn: Any, key: str, where: str, params: tuple, limit: int) -> list[Any]:
    return conn.execute(
        "SELECT e.id, e.session_id, e.title, e.detail FROM events e"
        f" WHERE {where} AND e.category IN ({','.join('?' * len(CATEGORIES))}) AND e.detail IS NOT NULL"
        " AND NOT EXISTS (SELECT 1 FROM embeddings m WHERE m.event_id = e.id AND m.model = ?)"
        " ORDER BY e.id DESC LIMIT ?",
        (*params, *CATEGORIES, key, limit),
    ).fetchall()


def index_once(cfg: dict[str, Any], limit: int = 512) -> int:
    """Embed up to ``limit`` prompts and responses that have no vector yet: new
    messages first, then history backwards from the oldest one indexed. Both
    walk the primary key from a known id, so a pass never rescans the table."""
    key = _model_key(cfg)
    with store.read() as conn:
        lo, hi = conn.execute("SELECT MIN(event_id), MAX(event_id) FROM embeddings WHERE model = ?", (key,)).fetchone()
        if hi is None:
            rows = _candidates(conn, key, "1", (), limit)
        else:
            rows = _candidates(conn, key, "e.id > ?", (hi,), limit)
            if len(rows) < limit:
                rows += _candidates(conn, key, "e.id < ?", (lo,), limit - len(rows))
    done = 0
    for i in range(0, len(rows), _BATCH):
        chunk = [r for r in rows[i:i + _BATCH] if _text(r)]
        if not chunk:
            continue
        vecs = embed([_text(r) for r in chunk], cfg)
        with store.write() as conn:
            conn.executemany(
                "INSERT OR REPLACE INTO embeddings (event_id, session_id, model, vec) VALUES (?, ?, ?, ?)",
                [(r["id"], r["session_id"], key, v.tobytes()) for r, v in zip(chunk, vecs)],
            )
        done += len(chunk)
    return done


def _load_index(cfg: dict[str, Any]) -> dict[str, Any]:
    key = _model_key(cfg)
    with store.read() as conn:
        count = conn.execute("SELECT COUNT(*) FROM embeddings WHERE model = ?", (key,)).fetchone()[0]
        with _lock:
            if _index["key"] == key and _index["count"] == count:
                return _index
        ids, vecs = array("q"), array("f")
        for r in conn.execute("SELECT event_id, vec FROM embeddings WHERE model = ?", (key,)):
            ids.append(r[0])
            vecs.frombytes(r[1])
    with _lock:
        _index.update(key=key, ids=ids, vecs=vecs, count=count)
        return _index


def _rank(query_vec: array, idx: dict[str, Any], dim: int, k: int) -> list[tuple[float, int]]:
    vecs = memoryview(idx["vecs"])
    q = query_vec.tolist()
    scores = []
    for i, event_id in enumerate(idx["ids"]):
        scores.append((sum(map(operator.mul, q, vecs[i * dim:(i + 1) * dim])), event_id))
    scores.sort(reverse=True)
    return scores[:k]


def _hydrate(ranked: list[tuple[float, int]], session_id: str | None) -> list[dict[str, Any]]:
    if not ranked:
        return []
    ids = [eid for _s, eid in ranked]
    with store.read() as conn:
        rows = {r["id"]: r for r in conn.execute(
            "SELECT e.id, e.session_id, e.category, e.title, e.target, e.ts, e.source, e.model, e.detail, s.cwd"
            " FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
            f" WHERE e.id IN ({','.join('?' * len(ids))})",
            ids,
        )}
    out = []
    for score, eid in ranked:
        r = rows.get(eid)
        if r is None or (session_id and r["session_id"] != session_id):
            continue
        out.append({
            "session_id": r["session_id"], "event_id": r["id"], "category": r["category"], "title": r["title"],
            "target": r["target"], "ts": timeutil.format_ts(r["ts"]), "source": r["source"], "model": r["model"],
            "cwd": r["cwd"], "snippet": _text(r)[:240], "score": round(score, 4),
        })
    return out


def search(query: str, limit: int = 40, session_id: str | None = None, mode: str = "semantic") -> dict[str, Any]:
    """``mode`` "semantic" ranks by meaning; "hybrid" fuses that with keyword search."""
    cfg = config()
    if cfg is None:
        return {"results": [], "enabled": False}
    _ensure_table()
    idx = _load_index(cfg)
    qvec = embed([ai_insights.mask_text(query)], cfg)[0]
    semantic = _hydrate(_rank(qvec, idx, cfg["dim"], limit * 3 if session_id else limit * 2), session_id)
    if mode != "hybrid":
        return {"results": semantic[:limit], "enabled": True, "indexed": idx["count"]}
    keyword = db.search(query, limit * 2, session_id=session_id)
    # Reciprocal rank fusion: a hit near the top of either list rises.
    fused: dict[int, dict[str, Any]] = {}
    for results in (semantic, keyword):
        for rank, item in enumerate(results):
            entry = fused.setdefault(item["event_id"], {**item, "rrf": 0.0})
            entry["rrf"] += 1.0 / (60 + rank)
    ranked = sorted(fused.values(), key=lambda x: x["rrf"], reverse=True)[:limit]
    return {"results": ranked, "enabled": True, "indexed": idx["count"]}


def status() -> dict[str, Any]:
    cfg = config()
    if cfg is None:
        return {"enabled": False}
    _ensure_table()
    key = _model_key(cfg)
    with store.read() as conn:
        indexed = conn.execute("SELECT COUNT(*) FROM embeddings WHERE model = ?", (key,)).fetchone()[0]
        total = conn.execute(
            f"SELECT COUNT(*) FROM events INDEXED BY idx_events_session_agg WHERE category IN ({','.join('?' * len(CATEGORIES))})",
            CATEGORIES,
        ).fetchone()[0]
    return {"enabled": True, "model": cfg["model"], "dim": cfg["dim"], "indexed": indexed, "total": total, **_state}


def _loop() -> None:
    cfg = config()
    if cfg is None:
        return
    _ensure_table()
    while True:
        _state.update(running=True)
        try:
            n = index_once(cfg)
            _state.update(error=None, last_run=timeutil.now())
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError) as exc:
            _state.update(error=str(exc)[:200])
            _log.warning("semantic index: %s", exc)
            n = 0
        _state.update(running=False)
        time.sleep(1.0 if n else _IDLE_S)


def start() -> None:
    if config() is not None:
        threading.Thread(target=_loop, name="semantic-index", daemon=True).start()

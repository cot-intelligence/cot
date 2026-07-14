from __future__ import annotations

import sys
from pathlib import Path

import pytest


BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


@pytest.fixture
def fresh_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    from app import db, store

    db_file = tmp_path / "cot.db"
    monkeypatch.setenv("COT_DB_PATH", str(db_file))
    db.init_db()
    assert store.path() == db_file
    return db_file

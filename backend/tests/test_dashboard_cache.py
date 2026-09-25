"""The dashboard's index.html must be revalidated on every load, or a webview
keeps an old page whose hashed bundles are gone after an upgrade."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client(tmp_path: Path) -> TestClient:
    from app.main import DashboardFiles

    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html></html>")
    (tmp_path / "assets" / "index-abc123.js").write_text("")
    app = FastAPI()
    app.mount("/", DashboardFiles(directory=str(tmp_path), html=True))
    return TestClient(app)


def test_index_is_revalidated(tmp_path: Path) -> None:
    client = _client(tmp_path)
    assert client.get("/").headers["cache-control"] == "no-cache"
    assert client.get("/index.html").headers["cache-control"] == "no-cache"


def test_hashed_assets_are_immutable(tmp_path: Path) -> None:
    client = _client(tmp_path)
    response = client.get("/assets/index-abc123.js")
    assert response.status_code == 200
    assert "immutable" in response.headers["cache-control"]

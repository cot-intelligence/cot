"""Core Ingest Golden Session contract helpers.

These helpers keep the tests and manual snapshot refresh command on the same
path: fixtures are ingested into an isolated collector database, then the
UI-facing session-detail projection is normalized and compared to JSON.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import difflib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any, Iterable

_HERE = Path(__file__).resolve().parent
_BACKEND = _HERE.parent
_REPO = _BACKEND.parent
_FIXTURE_ROOT = _HERE / "fixtures" / "core_ingest"

sys.path.insert(0, str(_BACKEND))

from app import db  # noqa: E402
import app.normalize as normalize_module  # noqa: E402
from app.normalize import normalize  # noqa: E402


@dataclass(frozen=True)
class CoreIngestFixture:
    """One checked-in Format Contract Fixture."""

    path: Path
    metadata: dict[str, Any]

    @property
    def name(self) -> str:
        return str(self.metadata["fixture_name"])

    @property
    def agent(self) -> str:
        return str(self.metadata["agent"])

    @property
    def ingest_path(self) -> str:
        return str(self.metadata["ingest_path"])

    @property
    def session_id(self) -> str:
        return str(self.metadata["session_id"])

    @property
    def input_path(self) -> Path:
        return self.path / "input.jsonl"

    @property
    def expected_path(self) -> Path:
        return self.path / "expected.projection.json"

    @property
    def refresh_command(self) -> str:
        rel = self.path.relative_to(_FIXTURE_ROOT).as_posix()
        return f"python scripts/refresh_core_ingest_snapshots.py --fixture {rel}"


def _load_bridge():
    path = _REPO / "bridge" / "cot"
    loader = importlib.machinery.SourceFileLoader("cot_bridge_contract", str(path))
    spec = importlib.util.spec_from_loader("cot_bridge_contract", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise AssertionError(f"{path}:{lineno} is not valid JSONL: {exc}") from exc
        if not isinstance(obj, dict):
            raise AssertionError(f"{path}:{lineno} must be a JSON object")
        rows.append(obj)
    return rows


def iter_core_ingest_fixtures(*, agent: str | None = None) -> Iterable[CoreIngestFixture]:
    for metadata_path in sorted(_FIXTURE_ROOT.glob("*/*/*/metadata.json")):
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        fixture = CoreIngestFixture(metadata_path.parent, metadata)
        if agent is not None and fixture.agent != agent:
            continue
        yield fixture


def fixture_from_selector(selector: str) -> CoreIngestFixture:
    path = (_FIXTURE_ROOT / selector).resolve()
    try:
        path.relative_to(_FIXTURE_ROOT.resolve())
    except ValueError as exc:
        raise ValueError(f"Fixture selector escapes fixture root: {selector}") from exc
    metadata_path = path / "metadata.json"
    if not metadata_path.exists():
        raise ValueError(f"No fixture metadata at {metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    return CoreIngestFixture(path, metadata)


@contextmanager
def _isolated_collector_db():
    old_db = os.environ.get("COT_DB_PATH")
    old_telemetry = os.environ.get("COT_DISABLE_TELEMETRY")
    old_updates = os.environ.get("COT_DISABLE_UPDATE_CHECK")
    with tempfile.TemporaryDirectory(
        prefix="cot-core-ingest-",
        ignore_cleanup_errors=True,
    ) as tmp:
        os.environ["COT_DB_PATH"] = str(Path(tmp) / "cot.db")
        os.environ["COT_DISABLE_TELEMETRY"] = "1"
        os.environ["COT_DISABLE_UPDATE_CHECK"] = "1"
        db.init_db()
        try:
            yield
        finally:
            if old_db is None:
                os.environ.pop("COT_DB_PATH", None)
            else:
                os.environ["COT_DB_PATH"] = old_db
            if old_telemetry is None:
                os.environ.pop("COT_DISABLE_TELEMETRY", None)
            else:
                os.environ["COT_DISABLE_TELEMETRY"] = old_telemetry
            if old_updates is None:
                os.environ.pop("COT_DISABLE_UPDATE_CHECK", None)
            else:
                os.environ["COT_DISABLE_UPDATE_CHECK"] = old_updates


@contextmanager
def _deterministic_ingest_clock():
    old_now = normalize_module._now
    base = datetime(2026, 6, 1, 10, 0, 0, tzinfo=timezone.utc)
    counter = 0

    def fake_now() -> str:
        nonlocal counter
        timestamp = base + timedelta(seconds=counter)
        counter += 1
        return timestamp.isoformat()

    normalize_module._now = fake_now
    try:
        yield
    finally:
        normalize_module._now = old_now


def _record_payload(source: str, payload: dict[str, Any]) -> None:
    if payload.get("_attach_to_prompt"):
        db.attach_to_prompt(
            str(payload.get("session_id") or ""),
            payload.get("text"),
            payload.get("attachments") or [],
            payload.get("timestamp"),
        )
        return
    norm = normalize(source, payload)
    if not db.should_ignore_event(norm):
        db.record_event(norm, payload)


def _ingest_live_fixture(fixture: CoreIngestFixture) -> None:
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    for payload in _read_jsonl(fixture.input_path):
        response = client.post(f"/v1/ingest/{fixture.agent}", json=payload)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body.get("ok") is True, body


def _ingest_history_fixture(fixture: CoreIngestFixture) -> None:
    bridge = _load_bridge()
    state: dict[str, Any] = {}
    for lineno, obj in enumerate(_read_jsonl(fixture.input_path)):
        if fixture.agent == "codex":
            events = bridge._codex_line_to_events(
                obj,
                fixture.session_id,
                lineno=lineno,
                state=state,
                path=str(fixture.input_path),
            )
        else:
            raise AssertionError(f"Unsupported history fixture agent: {fixture.agent}")
        for event in events:
            if event.get("_dedup_key") is None:
                event.pop("_dedup_key", None)
            _record_payload(fixture.agent, event)


def render_projection(fixture: CoreIngestFixture) -> dict[str, Any]:
    with _isolated_collector_db(), _deterministic_ingest_clock():
        if fixture.ingest_path == "live":
            _ingest_live_fixture(fixture)
        elif fixture.ingest_path == "history":
            _ingest_history_fixture(fixture)
        else:
            raise AssertionError(f"Unsupported ingest path: {fixture.ingest_path}")
        projection = db.get_session_detail(fixture.session_id)
    if projection is None:
        raise AssertionError(f"{fixture.name} did not create session {fixture.session_id}")
    return normalize_projection(projection)


def normalize_projection(projection: dict[str, Any]) -> dict[str, Any]:
    """Make a session-detail response stable without deleting UI fields."""
    normalized = json.loads(json.dumps(projection, sort_keys=True))
    id_map: dict[int, str] = {}

    def event_ref(raw_id: Any) -> Any:
        if raw_id is None:
            return None
        try:
            numeric = int(raw_id)
        except (TypeError, ValueError):
            return raw_id
        if numeric not in id_map:
            id_map[numeric] = f"event_{len(id_map) + 1:03d}"
        return id_map[numeric]

    for collection_name in ("events", "timeline"):
        for item in normalized.get(collection_name, []):
            if "id" in item:
                item["id"] = event_ref(item["id"])
            for key in ("answer_event_id", "answers_event_id"):
                if key in item:
                    item[key] = event_ref(item[key])

    for clarification in normalized.get("clarifications", []):
        for key in ("question_event_id", "answer_event_id"):
            if key in clarification:
                clarification[key] = event_ref(clarification[key])

    return normalized


def assert_projection_matches_snapshot(fixture: CoreIngestFixture) -> None:
    actual = render_projection(fixture)
    if not fixture.expected_path.exists():
        raise AssertionError(
            f"{fixture.name} has no expected projection snapshot.\n"
            f"Refresh with: {fixture.refresh_command}"
        )
    expected = json.loads(fixture.expected_path.read_text(encoding="utf-8"))
    if actual != expected:
        expected_text = json.dumps(expected, indent=2, sort_keys=True) + "\n"
        actual_text = json.dumps(actual, indent=2, sort_keys=True) + "\n"
        diff = "\n".join(
            difflib.unified_diff(
                expected_text.splitlines(),
                actual_text.splitlines(),
                fromfile=str(fixture.expected_path),
                tofile=f"{fixture.name}:actual",
                lineterm="",
            )
        )
        raise AssertionError(
            f"{fixture.name} projection snapshot mismatch.\n"
            f"Refresh with: {fixture.refresh_command}\n\n{diff}"
        )


def refresh_snapshot(fixture: CoreIngestFixture) -> None:
    projection = render_projection(fixture)
    fixture.expected_path.write_text(
        json.dumps(projection, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

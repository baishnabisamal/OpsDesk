"""Tests for training and for the service. Run:  pytest"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Let the tests import the files in ml/ (one folder up).
sys.path.insert(0, str(Path(__file__).parent.parent))

import generate_data  # noqa: E402
import service  # noqa: E402
import train  # noqa: E402
from model import load_model  # noqa: E402

SECRET = "test-secret"
HEADERS = {"X-ML-Secret": SECRET}


@pytest.fixture(scope="session")
def model_path(tmp_path_factory) -> Path:
    """Trains one model into a temporary folder for the whole test run."""
    path = tmp_path_factory.mktemp("models") / "intent.joblib"
    train.train(model_path=path)
    return path


@pytest.fixture()
def client(model_path, monkeypatch):
    monkeypatch.setenv("ML_SHARED_SECRET", SECRET)
    monkeypatch.setenv("ML_MODEL_PATH", str(model_path))
    # `with` runs the startup code, which loads the model.
    with TestClient(service.app) as test_client:
        yield test_client


# --- Data and training --------------------------------------------------------


def test_generated_data_is_the_same_every_time():
    import random

    first = [generate_data.make_ticket(random.Random(7), "refund") for _ in range(3)]
    second = [generate_data.make_ticket(random.Random(7), "refund") for _ in range(3)]
    assert first == second


def test_data_file_has_every_intent():
    _, labels = train.load_data()
    assert set(labels) == set(generate_data.PHRASES)
    assert len(labels) == 7 * generate_data.ROWS_PER_INTENT


def test_training_reports_macro_f1_and_saves_a_model(model_path, capsys):
    model = load_model(model_path)
    assert model is not None
    assert 0.8 < model.macro_f1 <= 1.0
    assert model.version.startswith("tfidf-lr-")


def test_missing_model_file_gives_none(tmp_path):
    assert load_model(tmp_path / "nope.joblib") is None


# --- Service -------------------------------------------------------------------


def test_healthz_reports_the_model(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["model_loaded"] is True
    assert body["model_version"].startswith("tfidf-lr-")


def test_classify_needs_the_secret(client):
    assert client.post("/classify", json={"text": "refund"}).status_code == 401
    wrong = client.post("/classify", json={"text": "refund"}, headers={"X-ML-Secret": "nope"})
    assert wrong.status_code == 401


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Still waiting for money back\nThe credit has not reached our account yet.", "refund"),
        ("Guest turned away\nReception says the room does not exist in their system.", "booking_not_found"),
        ("Card problem\nWe were charged more than the price shown at booking time.", "payment"),
        ("Query\nDoes the hotel have a pool and is there parking?", "other"),
    ],
)
def test_classify_picks_the_intent(client, text, expected):
    response = client.post("/classify", json={"text": text}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["intent"] == expected
    assert 0 < body["confidence"] <= 1
    assert len(body["top"]) == 3
    assert body["top"][0]["intent"] == expected
    assert body["model_version"].startswith("tfidf-lr-")


def test_classify_rejects_empty_text(client):
    response = client.post("/classify", json={"text": ""}, headers=HEADERS)
    assert response.status_code == 422


def test_similarity_ranks_the_closest_text_first(client):
    response = client.post(
        "/similarity",
        headers=HEADERS,
        json={
            "text": "Refund not received, the booking was cancelled ten days ago",
            "candidates": [
                {"id": "a", "text": "Is there parking at the hotel and what does it cost"},
                {"id": "b", "text": "The refund has not arrived for the cancelled booking"},
                {"id": "c", "text": "Refund not received, the booking was cancelled ten days ago"},
            ],
        },
    )
    assert response.status_code == 200
    scores = {item["id"]: item["score"] for item in response.json()["scores"]}
    assert scores["c"] == pytest.approx(1.0, abs=0.001)  # identical text
    assert scores["c"] > scores["b"] > scores["a"]
    assert all(0 <= score <= 1.0001 for score in scores.values())


def test_similarity_with_no_candidates(client):
    response = client.post("/similarity", json={"text": "x", "candidates": []}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["scores"] == []


def test_without_a_model_the_service_says_503(monkeypatch, tmp_path):
    monkeypatch.setenv("ML_SHARED_SECRET", SECRET)
    monkeypatch.setenv("ML_MODEL_PATH", str(tmp_path / "missing.joblib"))
    with TestClient(service.app) as test_client:
        assert test_client.get("/healthz").json()["model_loaded"] is False
        response = test_client.post("/classify", json={"text": "refund"}, headers=HEADERS)
        assert response.status_code == 503

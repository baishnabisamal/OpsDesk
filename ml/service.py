"""The ML service: answers questions about text, and nothing else.

It is stateless and has no database access. Node sends text and stores the
answer, so tenant isolation stays in one place (the Node API).

Run:  uvicorn service:app --port 8001
"""

import hmac
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from model import DEFAULT_MODEL_PATH, IntentModel, cluster_texts, load_model

# What the service knows while it runs: just the loaded model.
state: dict[str, IntentModel | None] = {"model": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Runs once at startup: load the model file written by train.py."""
    path = Path(os.environ.get("ML_MODEL_PATH", DEFAULT_MODEL_PATH))
    state["model"] = load_model(path)
    yield


app = FastAPI(title="OpsDesk ML service", lifespan=lifespan)


def require_secret(x_ml_secret: str | None = Header(default=None)) -> None:
    """Only the Node API may call this service. It proves who it is with a
    shared secret in a header. compare_digest takes the same time whether the
    first or the last character is wrong, so the secret cannot be guessed one
    character at a time by measuring response times."""
    expected = os.environ.get("ML_SHARED_SECRET", "")
    if not expected or x_ml_secret is None or not hmac.compare_digest(x_ml_secret, expected):
        raise HTTPException(status_code=401, detail="Missing or wrong X-ML-Secret header.")


def get_model() -> IntentModel:
    model = state["model"]
    if model is None:
        raise HTTPException(status_code=503, detail="No model is loaded. Run train.py first.")
    return model


# --- Request shapes. Pydantic rejects anything that does not fit. -----------


class ClassifyRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


class Candidate(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=20000)


class SimilarityRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    candidates: list[Candidate] = Field(max_length=50)


class ClusterRequest(BaseModel):
    tickets: list[Candidate] = Field(max_length=5000)
    max_clusters: int = Field(default=8, ge=1, le=30)


# --- Endpoints ---------------------------------------------------------------


@app.get("/healthz")
def healthz() -> dict:
    """No secret needed: it only says whether a model is loaded."""
    model = state["model"]
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "model_version": model.version if model else None,
    }


@app.post("/classify", dependencies=[Depends(require_secret)])
def classify(request: ClassifyRequest, model: IntentModel = Depends(get_model)) -> dict:
    return model.classify(request.text)


@app.post("/similarity", dependencies=[Depends(require_secret)])
def similarity(request: SimilarityRequest, model: IntentModel = Depends(get_model)) -> dict:
    scores = model.similarity(request.text, [candidate.text for candidate in request.candidates])
    return {
        "scores": [
            {"id": candidate.id, "score": score}
            for candidate, score in zip(request.candidates, scores)
        ],
        "model_version": model.version,
    }


@app.post("/themes/cluster", dependencies=[Depends(require_secret)])
def themes_cluster(request: ClusterRequest) -> dict:
    """Weekly themes. Needs no trained model: it learns from the texts it gets."""
    texts = [ticket.text for ticket in request.tickets]
    clusters = cluster_texts(texts, max_clusters=request.max_clusters)
    return {
        "clusters": [
            {
                "label": " / ".join(cluster["terms"]) or "(no common words)",
                "terms": cluster["terms"],
                "size": len(cluster["members"]),
                "ticket_ids": [request.tickets[i].id for i in cluster["members"]],
            }
            for cluster in clusters
        ],
        "method": "tfidf-kmeans",
    }

"""The intent model: how it is built, saved, loaded and asked questions.

Used by both train.py (to build and save) and service.py (to load and use),
so the two can never disagree about what a model file contains.
"""

from dataclasses import dataclass
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

DEFAULT_MODEL_PATH = Path(__file__).parent / "models" / "intent.joblib"


def build_pipeline() -> Pipeline:
    """TF-IDF turns text into numbers; logistic regression picks the intent.

    TF-IDF gives every word (and pair of words) a weight: high when the word
    is frequent in this ticket but rare across all tickets. "refund" is a
    strong signal; "please" is not.

    Logistic regression learns one weight per word per intent, and outputs a
    probability for each intent. It is simple, fast, and its weights can be
    read, which a neural network's cannot.
    """
    return Pipeline(
        [
            (
                "tfidf",
                TfidfVectorizer(
                    lowercase=True,
                    ngram_range=(1, 2),  # single words and pairs like "charged twice"
                    sublinear_tf=True,  # a word used 10 times is not 10x as important
                    min_df=2,  # ignore words seen in only one ticket
                ),
            ),
            ("classifier", LogisticRegression(max_iter=1000, class_weight="balanced")),
        ]
    )


def join_text(subject: str, body: str) -> str:
    """The model sees one string. Node sends the same joined form."""
    return f"{subject}\n{body}".strip()


@dataclass
class IntentModel:
    pipeline: Pipeline
    version: str
    macro_f1: float

    def classify(self, text: str) -> dict:
        """Returns the best intent, its probability, and the top three."""
        probabilities = self.pipeline.predict_proba([text])[0]
        labels = self.pipeline.classes_
        ranked = sorted(zip(labels, probabilities), key=lambda pair: pair[1], reverse=True)
        best_intent, best_probability = ranked[0]
        return {
            "intent": str(best_intent),
            "confidence": round(float(best_probability), 4),
            "top": [
                {"intent": str(label), "confidence": round(float(probability), 4)}
                for label, probability in ranked[:3]
            ],
            "model_version": self.version,
        }

    def similarity(self, text: str, candidates: list[str]) -> list[float]:
        """Cosine similarity between `text` and each candidate, from 0 to 1.

        Both are turned into TF-IDF vectors. Those vectors already have length
        1, so the cosine of the angle between two of them is just their dot
        product: 1 means the same words, 0 means no words in common.
        """
        if not candidates:
            return []
        vectorizer = self.pipeline.named_steps["tfidf"]
        vectors = vectorizer.transform([text, *candidates])
        scores = (vectors[1:] @ vectors[0].T).toarray().ravel()
        return [round(float(score), 4) for score in scores]

    def save(self, path: Path = DEFAULT_MODEL_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({"pipeline": self.pipeline, "version": self.version, "macro_f1": self.macro_f1}, path)


def load_model(path: Path = DEFAULT_MODEL_PATH) -> IntentModel | None:
    """Returns None when no model has been trained yet."""
    if not path.exists():
        return None
    saved = joblib.load(path)
    return IntentModel(pipeline=saved["pipeline"], version=saved["version"], macro_f1=saved["macro_f1"])

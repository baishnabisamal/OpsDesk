"""Trains the intent model and reports how good it is.

Training is offline: this script is run by a person, not by the service.
It reads the labelled tickets, holds some back for testing, trains on the
rest, prints the scores, and writes a versioned model file that the service
loads at startup.

Run:  python train.py
"""

import csv
import hashlib
from pathlib import Path

from sklearn.metrics import classification_report, f1_score
from sklearn.model_selection import train_test_split

from model import DEFAULT_MODEL_PATH, IntentModel, build_pipeline, join_text

DATA_PATH = Path(__file__).parent / "data" / "tickets.csv"


def load_data(path: Path = DATA_PATH) -> tuple[list[str], list[str]]:
    texts, labels = [], []
    with path.open(newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            texts.append(join_text(row["subject"], row["body"]))
            labels.append(row["intent"])
    return texts, labels


def data_version(path: Path = DATA_PATH) -> str:
    """A short fingerprint of the training file.

    The model version is built from it, so every prediction stored on a
    ticket can be traced back to the exact data the model learned from.
    """
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"tfidf-lr-{digest[:8]}"


def train(data_path: Path = DATA_PATH, model_path: Path = DEFAULT_MODEL_PATH) -> IntentModel:
    texts, labels = load_data(data_path)

    # Hold out 20% that the model never sees while learning. Scoring on the
    # training rows would only measure memory, not skill.
    # stratify keeps the same share of each intent in both parts.
    train_texts, test_texts, train_labels, test_labels = train_test_split(
        texts, labels, test_size=0.2, random_state=42, stratify=labels
    )

    pipeline = build_pipeline()
    pipeline.fit(train_texts, train_labels)
    predictions = pipeline.predict(test_texts)

    # Macro-F1: work out F1 for each intent separately, then take the plain
    # average. A rare intent counts as much as a common one, so the model
    # cannot look good by only getting the common intents right.
    macro_f1 = f1_score(test_labels, predictions, average="macro")

    print(f"training rows: {len(train_texts)}   held-out rows: {len(test_texts)}")
    print(classification_report(test_labels, predictions, digits=3))
    print(f"macro-F1 on held-out data: {macro_f1:.3f}")
    print("note: the data is synthetic (see generate_data.py), so this number")
    print("      shows the pipeline works. It is not a measure on real tickets.")

    model = IntentModel(pipeline=pipeline, version=data_version(data_path), macro_f1=float(macro_f1))
    model.save(model_path)
    print(f"saved model {model.version} to {model_path}")
    return model


if __name__ == "__main__":
    train()

"""Persist scraped records to disk as JSON or CSV."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from .config import DATA_DIR


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def save_json(records: list[dict], filename: str = "records.json") -> Path:
    _ensure_dir()
    path = DATA_DIR / filename
    path.write_text(json.dumps(records, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def save_csv(records: list[dict], filename: str = "records.csv") -> Path:
    _ensure_dir()
    path = DATA_DIR / filename
    if not records:
        path.write_text("", encoding="utf-8")
        return path
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(records[0].keys()))
        writer.writeheader()
        writer.writerows(records)
    return path

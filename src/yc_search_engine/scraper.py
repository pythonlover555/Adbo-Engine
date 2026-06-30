"""Orchestrates the fetch -> parse -> store pipeline."""

from __future__ import annotations

import logging

from .config import settings
from .fetcher import Fetcher
from .parser import parse
from .storage import save_json

logger = logging.getLogger(__name__)


def run(url: str | None = None) -> list[dict]:
    target = url or settings.base_url
    fetcher = Fetcher()

    html = fetcher.get(target)
    records = parse(html)
    logger.info("Parsed %d records from %s", len(records), target)

    out_path = save_json(records)
    logger.info("Saved -> %s", out_path)
    return records

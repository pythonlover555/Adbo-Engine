"""Centralised logging: rotating file at logs/yc-filter.log + stderr.

Use `get_logger(__name__)` from any server module.
"""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parents[1] / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "yc-filter.log"

_configured = False


def _configure() -> None:
    global _configured
    if _configured:
        return

    root = logging.getLogger("yceng")
    root.setLevel(logging.DEBUG)
    root.propagate = False

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S")

    file_h = RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    file_h.setLevel(logging.DEBUG)
    file_h.setFormatter(fmt)
    root.addHandler(file_h)

    stream_h = logging.StreamHandler(sys.stderr)
    stream_h.setLevel(logging.INFO)
    stream_h.setFormatter(logging.Formatter("[%(levelname)s] %(name)s: %(message)s"))
    root.addHandler(stream_h)

    _configured = True


def get_logger(name: str) -> logging.Logger:
    _configure()
    if not name.startswith("yceng"):
        name = f"yceng.{name}"
    return logging.getLogger(name)

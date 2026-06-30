"""Configuration loaded from environment / .env file."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"


@dataclass(frozen=True)
class Settings:
    base_url: str = os.getenv("BASE_URL", "https://example.com")
    request_delay: float = float(os.getenv("REQUEST_DELAY", "1.0"))
    user_agent: str = os.getenv(
        "USER_AGENT", "YC-Search-Engine/0.1 (+https://example.com)"
    )
    timeout: float = 15.0


settings = Settings()

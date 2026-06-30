"""HTTP layer: a reusable session with retries and a polite delay."""

from __future__ import annotations

import logging
import time

import requests
from requests.adapters import HTTPAdapter, Retry

from .config import settings

logger = logging.getLogger(__name__)


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": settings.user_agent})
    retries = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=(429, 500, 502, 503, 504),
    )
    adapter = HTTPAdapter(max_retries=retries)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


class Fetcher:
    """Fetches pages while respecting a configured delay between requests."""

    def __init__(self, session: requests.Session | None = None) -> None:
        self.session = session or build_session()

    def get(self, url: str) -> str:
        logger.info("GET %s", url)
        response = self.session.get(url, timeout=settings.timeout)
        response.raise_for_status()
        time.sleep(settings.request_delay)  # be polite
        return response.text

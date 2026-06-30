"""Turn raw HTML into structured records.

This is a STUB. Replace the selectors below with ones that match the site
you're actually scraping.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from bs4 import BeautifulSoup


@dataclass
class Record:
    title: str
    url: str


def parse(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    records: list[Record] = []

    # --- Adjust this selector to your target site ---
    for link in soup.select("a[href]"):
        title = link.get_text(strip=True)
        href = link.get("href", "")
        if title and href.startswith("http"):
            records.append(Record(title=title, url=href))

    return [asdict(r) for r in records]

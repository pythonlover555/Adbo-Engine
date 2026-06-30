"""Entry point for YC-Search-Engine."""

from __future__ import annotations

import argparse
import logging

from src.yc_search_engine.scraper import run


def main() -> None:
    parser = argparse.ArgumentParser(description="YC-Search-Engine web scraper")
    parser.add_argument("--url", help="Override the base URL to scrape")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    records = run(args.url)
    print(f"Done. {len(records)} records scraped.")


if __name__ == "__main__":
    main()

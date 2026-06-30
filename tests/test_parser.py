from src.yc_search_engine.parser import parse


def test_parse_extracts_absolute_links():
    html = """
    <html><body>
      <a href="https://a.com">Alpha</a>
      <a href="/relative">Skip me</a>
      <a href="https://b.com">Beta</a>
    </body></html>
    """
    records = parse(html)
    assert {r["title"] for r in records} == {"Alpha", "Beta"}
    assert all(r["url"].startswith("http") for r in records)

"""Prompt construction for the structured project card.

The extension now parses the startup card deterministically (no AI) and POSTs
it as `project`. These tests pin that the card becomes the model's primary
funding signal, and that the raw page dump is trimmed when a card is present.
"""
from server import llm

LOOGY = {
    "name": "Loogy",
    "description": "Marketplace for hauling / last-mile services.",
    "progress": "3-6 Months",
    "funding_status": "N/A",
    "rows": {"Progress": "3-6 Months", "Funding Status": "N/A"},
}


def test_project_card_surfaces_in_prompt():
    text = llm._build_user_text({"name": "Jane", "project": LOOGY, "raw_text": ""})
    assert "Startup / project" in text
    assert "Name: Loogy" in text
    assert "Funding Status: N/A" in text
    assert "Progress: 3-6 Months" in text


def test_extra_rows_included_without_duplication():
    proj = {**LOOGY, "rows": {**LOOGY["rows"], "Team": "2 cofounders"}}
    lines = llm._project_lines(proj)
    assert "Team: 2 cofounders" in lines
    # Named rows render once, via their dedicated line — not again as "rows".
    assert lines.count("Funding Status") == 1


def test_raw_text_trimmed_when_card_present():
    big = "x" * 9000
    with_card = llm._build_user_text({"name": "J", "project": LOOGY, "raw_text": big})
    no_card = llm._build_user_text({"name": "J", "project": None, "raw_text": big})
    # Card present -> raw dump trimmed to 1500 (token saving); absent -> full
    # 8000 backstop. Delta is 8000 - 1500.
    assert no_card.count("x") - with_card.count("x") == 6500


def test_no_card_no_project_block():
    text = llm._build_user_text({"name": "J", "project": None, "raw_text": "hi"})
    assert "Startup / project" not in text


def test_funding_source_scoped_to_funding_status_cell():
    # Funding figures in the description must NOT become the funding source;
    # the Funding Status cell is called out as the only one.
    proj = {**LOOGY, "description": "raised $500k seed", "funding_status": "N/A"}
    text = llm._build_user_text({"name": "J", "project": proj, "raw_text": ""})
    assert "ONLY source for funding_kind and funding_usd" in text
    # The cell value is surfaced on its own, ahead of the descriptive card.
    cell_pos = text.index("Funding Status cell")
    card_pos = text.index("Startup / project")
    assert cell_pos < card_pos
    # Description still present (revenue can qualify independently).
    assert "raised $500k seed" in text


def test_blank_funding_status_is_flagged_as_none():
    proj = {**LOOGY, "funding_status": ""}
    text = llm._build_user_text({"name": "J", "project": proj, "raw_text": ""})
    assert "blank — treat as none_stated" in text
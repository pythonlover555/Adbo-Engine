"""Server configuration + the keep/skip rule thresholds.

Everything tunable lives here so the rule can be adjusted without touching
the evaluation or HTTP code. Values come from the environment (.env loaded
once at import) with sensible defaults.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
MATCHES_XLSX = DATA_DIR / "matches.xlsx"

# Server port. Kept off Call-Support's 8765 so both can run at once.
PORT = int(os.getenv("YCENG_PORT", "8791"))

# --- LLM provider (any OpenAI-compatible chat-completions endpoint) ---
# The server talks to the OpenAI SDK, but the endpoint is swappable so a
# key/provider change is a .env edit, not a code change. Default is Google
# Gemini's free OpenAI-compatible endpoint. To switch:
#   Groq    -> YCENG_LLM_BASE_URL=https://api.groq.com/openai/v1
#              YCENG_LLM_MODEL=llama-3.3-70b-versatile
#   Ollama  -> YCENG_LLM_BASE_URL=http://localhost:11434/v1
#              YCENG_LLM_MODEL=llama3.1  (key can be any non-empty string)
#   OpenAI  -> YCENG_LLM_BASE_URL=https://api.openai.com/v1
#              YCENG_LLM_MODEL=gpt-4o-mini
LLM_BASE_URL = os.getenv(
    "YCENG_LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/"
)
LLM_MODEL = os.getenv("YCENG_LLM_MODEL", "gemini-2.5-flash")

# --- Keep/skip rule ---------------------------------------------------
# A profile is KEPT only if it passes BOTH the region gate and the
# funding gate. Anything that clearly fails is SKIPPED. Anything the
# model can't pin down (e.g. "raised a round" with no amount) is flagged
# REVIEW so a real match isn't lost to a bad inference.

# Countries that pass the region gate (case-insensitive). EMPTY = gate OFF,
# i.e. no region restriction (the current setting). To re-enable, set e.g.
# YCENG_ALLOWED_REGIONS="United States,Canada" in .env.
ALLOWED_REGIONS = [
    r.strip()
    for r in os.getenv("YCENG_ALLOWED_REGIONS", "").split(",")
    if r.strip()
]

# Minimum *raised* external capital (USD) to pass the funding gate.
# Self-funding / line-of-credit / intent-to-raise all count as $0.
FUNDING_MIN_USD = float(os.getenv("YCENG_FUNDING_MIN_USD", "100000"))

# Whether clearly-stated substantial revenue can satisfy the funding gate
# on its own (profiles have no revenue field, so this rides on free-text
# inference and only passes at high confidence).
REVENUE_CAN_PASS = os.getenv("YCENG_REVENUE_CAN_PASS", "true").lower() == "true"

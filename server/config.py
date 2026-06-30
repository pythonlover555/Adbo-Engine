"""Server configuration for the Adbo-Engine extension backend.

Values come from the environment (.env loaded once at import) with defaults.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

# Port the nav-extension talks to (it targets http://localhost:8791).
# ADBO_PORT is the current name; YCENG_PORT is still read for back-compat.
PORT = int(os.getenv("ADBO_PORT") or os.getenv("YCENG_PORT") or "8791")

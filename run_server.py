"""Launch the evaluation server. `python run_server.py`"""
from __future__ import annotations

import uvicorn

from server.config import PORT

if __name__ == "__main__":
    uvicorn.run("server.main:app", host="127.0.0.1", port=PORT, reload=False)

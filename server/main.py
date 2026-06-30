"""FastAPI backend the Adbo-Engine browser extension talks to.

The nav-extension drives the redirect loop in the browser, then asks this
local server for the data it fills into the sign-up funnel:
  GET /api/identity  -> a random name + email (one per run)
  GET /api/details   -> the rest of the registration form (address, phone,
                        DOB, gender) — everything except email/name

Run:  python run_server.py     (or: uvicorn server.main:app --port 8791)
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import identities
from .config import PORT
from .logging_setup import get_logger

# Project version. Format x.x.x.x; bump the last segment per release
# (1.0.0.0 -> 1.0.0.1 -> ...). Keep in sync with nav-extension/manifest.json.
VERSION = "1.0.0.10"

log = get_logger("main")

app = FastAPI(title="Adbo-Engine", version=VERSION)

# The content script runs on a public origin (uplevelrewards.com) and calls
# this loopback server, so we need permissive CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Private Network Access: Chrome sends a preflight with
# `Access-Control-Request-Private-Network: true` when a public-origin page
# calls a loopback address, and BLOCKS the request unless the response echoes
# `Access-Control-Allow-Private-Network: true`. CORSMiddleware doesn't emit it,
# so we stamp it on every response. Registered after CORSMiddleware => outermost
# layer => also covers the preflight OPTIONS.
@app.middleware("http")
async def add_private_network_header(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "version": VERSION}


@app.get("/api/identity")
async def identity(count: int = 1) -> dict[str, Any]:
    """Random name(s) + email for the sign-up automation. The extension
    pulls one per funnel run and reuses it across the funnel's pages.
    `?count=N` (capped at 50) returns a batch instead of a single record."""
    n = max(1, min(count, 50))
    items = [identities.random_identity() for _ in range(n)]
    log.info("issued identity: %s <%s>", items[0]["full_name"], items[0]["email"])
    return {"ok": True, "identities": items, "identity": items[0]}


@app.get("/api/details")
async def details() -> dict[str, Any]:
    """Everything the registration form needs EXCEPT email/name (the extension
    already has those from /api/identity): shipping address, phone, DOB, gender.
    One per funnel run, cached extension-side. Random for now."""
    d = identities.random_details()
    log.info(
        "issued details: %s, %s %s %s | %s | dob %s gender %s",
        d["address1"], d["city"], d["state"], d["zip"], d["phone"],
        f"{d['dob']['year']}-{d['dob']['month']}-{d['dob']['day']}", d["gender"],
    )
    return {"ok": True, "details": d}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)

"""FastAPI app the browser extension talks to.

Flow per profile: extension POSTs scraped fields to /api/evaluate ->
OpenAI normalises -> rules decide keep/skip/review -> keep/review get
appended to matches.xlsx -> decision returned so the content script knows
whether to click "Skip for now".

Run:  python run_server.py     (or: uvicorn server.main:app --port 8791)
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import excel_store, llm
from .config import ALLOWED_REGIONS, FUNDING_MIN_USD, PORT
from .logging_setup import get_logger
from .rules import decide

log = get_logger("main")

app = FastAPI(title="YC Co-Founder Filter")

# The content script runs on https://www.startupschool.org and calls this
# loopback server, so we need permissive CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Private Network Access: Chrome sends a preflight with
# `Access-Control-Request-Private-Network: true` when a public-origin page
# calls a loopback address, and BLOCKS the request unless the response
# echoes `Access-Control-Allow-Private-Network: true`. CORSMiddleware
# doesn't emit it, so we stamp it on every response. Registered after
# CORSMiddleware => outermost layer => also covers the preflight OPTIONS.
@app.middleware("http")
async def add_private_network_header(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def _retry_after_ms(e: Exception) -> int | None:
    """Pull the provider's suggested wait (ms) out of a 429. Checks the
    Retry-After header first, then the Google-style 'retryDelay: 57s' and the
    OpenAI-style 'try again in 1.5s' / 'in 750ms' message forms. None if the
    provider didn't say."""
    resp = getattr(e, "response", None)
    headers = getattr(resp, "headers", None)
    if headers:
        ra = headers.get("retry-after")
        if ra:
            try:
                return int(float(ra) * 1000)
            except ValueError:
                pass
    msg = str(e)
    m = re.search(r"retry[_ ]?delay[\"']?\s*[:=]\s*[\"']?\s*([\d.]+)\s*s", msg, re.I)
    if m:
        return int(float(m.group(1)) * 1000)
    m = re.search(r"try again in\s+([\d.]+)\s*ms", msg, re.I)
    if m:
        return int(float(m.group(1)))
    m = re.search(r"try again in\s+([\d.]+)\s*s", msg, re.I)
    if m:
        return int(float(m.group(1)) * 1000)
    return None


class ProjectIn(BaseModel):
    """The startup card the content script parsed deterministically from the
    profile's project section (name + description + the funding table)."""
    name: str | None = None
    description: str | None = None
    progress: str | None = None
    funding_status: str | None = None
    rows: dict[str, str] = {}


class ProfileIn(BaseModel):
    profile_id: str | None = None
    profile_url: str | None = None
    name: str | None = None
    fields: dict[str, str] = {}
    raw_text: str = ""
    # Set by the extension's deterministic gate. The extension only POSTs
    # profiles it classified as having a real project, but we don't rely on
    # that — the model still does the funding/revenue read.
    project_state: str | None = None
    project: ProjectIn | None = None


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "allowed_regions": ALLOWED_REGIONS,
        "funding_min_usd": FUNDING_MIN_USD,
        "matches": await run_in_threadpool(excel_store.count_matches),
    }


@app.get("/api/key_status")
async def key_status() -> dict[str, Any]:
    return await llm.validate_key()


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
    return {"matches": await run_in_threadpool(excel_store.count_matches)}


@app.post("/api/evaluate")
async def evaluate(profile: ProfileIn) -> dict[str, Any]:
    """Evaluate one profile and (for keep/review) persist it. Returns the
    decision the content script acts on."""
    # Echo the raw startup card the extension scraped, verbatim, so the
    # terminal shows exactly what was read off the profile before any AI runs.
    p = profile.project
    if p is not None:
        log.info(
            "scraped project | name=%r | progress=%r | funding_status=%r",
            p.name, p.progress, p.funding_status,
        )
    else:
        log.info("scraped project | none (state=%s) for %r", profile.project_state, profile.name)

    try:
        ev = await llm.evaluate_profile(profile.model_dump())
    except Exception as e:  # noqa: BLE001
        log.exception("evaluation failed")
        # Transient errors (rate limit / network / timeout) are worth the
        # extension retrying the same profile; permanent ones aren't.
        name = type(e).__name__.lower()
        msg = str(e).lower()
        # A DAILY request cap (RPD) won't clear until midnight UTC — the
        # API's "try again in Ns" is misleading. Treat it as terminal so
        # the extension stops instead of pausing 60s forever.
        daily_limit = (
            "per day" in msg or "requests per day" in msg or "(rpd)" in msg
        )
        # A tokens/requests-per-MINUTE limit refills at the next minute, so a
        # short coordinated pause clears it. (Daily caps don't — handled above.)
        rate_limited = (not daily_limit) and (
            "ratelimit" in name
            or "429" in msg
            or "rate limit" in msg
            or "per minute" in msg
            or "tokens per minute" in msg
            or "tpm" in msg
        )
        retryable = rate_limited or (not daily_limit) and (
            "timeout" in name
            or "connection" in name
            or "overloaded" in msg
            or "503" in msg
        )
        reason = f"eval error: {type(e).__name__}: {e}"
        if daily_limit:
            reason = (
                "Daily request limit reached (RPD) — provider quota is "
                "exhausted until it resets (~midnight UTC). "
                "Raise your usage tier or wait. | " + reason
            )

        # Tell the extension exactly how long to pause for a TPM/RPM limit.
        # Fall back to 60s — the per-minute bucket resets on the minute.
        retry_after_ms = _retry_after_ms(e) if rate_limited else None
        if rate_limited and not retry_after_ms:
            retry_after_ms = 60000
        if rate_limited:
            log.warning("rate limited; advising %sms pause", retry_after_ms)

        return {
            "ok": False,
            "decision": "review",
            "retryable": retryable,
            "rate_limited": rate_limited,
            "retry_after_ms": retry_after_ms,
            "reason": reason,
        }

    verdict = decide(ev)
    decision = verdict["decision"]

    saved = False
    if decision in ("keep", "review"):
        # Offload the blocking workbook read/write to a thread so concurrent
        # browsers don't stall the event loop. excel_store's internal lock
        # keeps the dedup + write atomic across those threads.
        saved = await run_in_threadpool(excel_store.append_match, {
            "profile_id": profile.profile_id,
            "profile_url": profile.profile_url,
            "name": profile.name,
            "country": ev.get("country"),
            "decision": decision,
            "funding_kind": ev.get("funding_kind"),
            "funding_usd": ev.get("funding_usd"),
            "revenue_signal": (
                f"{ev.get('makes_substantial_revenue')}/{ev.get('revenue_confidence')}"
            ),
            "reason": verdict["reason"],
            "matched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })

    log.info("decision=%s saved=%s reason=%s", decision, saved, verdict["reason"])
    return {
        "ok": True,
        "decision": decision,
        "reason": verdict["reason"],
        "saved": saved,
        "evaluation": ev,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)

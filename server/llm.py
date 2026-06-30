"""LLM-backed profile evaluation.

One structured call per profile: given the scraped free-text fields, the
model returns a normalised judgement (country, funding kind/amount,
revenue read) as strict JSON. It does NOT decide keep/skip — that's the
deterministic job of rules.py. This split keeps the threshold logic
debuggable and the model focused on interpretation only.

The provider is any OpenAI-compatible chat-completions endpoint (default:
Google Gemini's free endpoint). Configure via YCENG_LLM_BASE_URL /
YCENG_LLM_MODEL and an API key — see server/config.py.
"""
from __future__ import annotations

import json
import os
from typing import Any

# Use the OS certificate store so calls work behind SSL-inspecting
# corporate proxies (same reason Call-Support does this).
import truststore

truststore.inject_into_ssl()

from openai import AsyncOpenAI, BadRequestError

from .config import LLM_BASE_URL, LLM_MODEL
from .logging_setup import get_logger

log = get_logger("llm")

_client: AsyncOpenAI | None = None


def _resolve_key() -> str:
    """The provider API key. YCENG_LLM_API_KEY is preferred; GEMINI_API_KEY
    and OPENAI_API_KEY are accepted as fallbacks so old .env files keep
    working after a provider switch."""
    return (
        os.environ.get("YCENG_LLM_API_KEY")
        or os.environ.get("GEMINI_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or ""
    ).strip()


def _get_client() -> AsyncOpenAI:
    global _client
    key = _resolve_key()
    if not key:
        raise RuntimeError(
            "No LLM API key set. Put YCENG_LLM_API_KEY (or GEMINI_API_KEY / "
            "OPENAI_API_KEY) in .env next to the project root."
        )
    if _client is None:
        # max_retries=0: the SDK must NOT silently sleep on a 429. On a TPM
        # rate limit the provider's Retry-After is ~60s, and the old default
        # (max_retries=6) made that wait happen *inside* the request — the
        # browser's single in-flight fetch froze for a minute with no reason
        # shown. The extension now owns one visible, coordinated pause
        # instead, so the server must surface the 429 immediately.
        _client = AsyncOpenAI(api_key=key, base_url=LLM_BASE_URL, max_retries=0)
    return _client


# JSON Schema the model must fill. response_format=json_schema forces a
# valid object, so downstream code never has to parse-and-pray.
_EVAL_SCHEMA: dict[str, Any] = {
    "name": "profile_evaluation",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "country": {
                "type": ["string", "null"],
                "description": (
                    "Country the person currently lives in / is based in, if stated. "
                    "Use the full canonical English name (e.g. 'United States', not "
                    "'USA'/'US'; 'United Kingdom', not 'UK'). Null if not stated."
                ),
            },
            "funding_kind": {
                "type": "string",
                "enum": ["raised", "grant", "self_funded", "intent_to_raise", "none_stated"],
                "description": (
                    "Derive ONLY from the 'Funding Status' cell — never from the "
                    "description or page text. "
                    "raised = external capital actually closed/committed (angel, F&F, "
                    "pre-seed, seed, VC). grant = non-dilutive grant received. "
                    "self_funded = own money / savings / line of credit / bootstrapped. "
                    "intent_to_raise = only PLANNING or LOOKING to raise, nothing closed. "
                    "none_stated = the Funding Status cell is blank / N/A / no funding info."
                ),
            },
            "funding_usd": {
                "type": ["number", "null"],
                "description": (
                    "External capital RAISED in USD, read ONLY from the 'Funding Status' "
                    "cell. Null if that cell states no amount, is N/A/blank, or is "
                    "self-funded/intent only. Do NOT pull figures from the description."
                ),
            },
            "makes_substantial_revenue": {
                "type": "boolean",
                "description": "True only if the profile (description / page text) clearly indicates meaningful/recurring revenue or paying customers (not pre-revenue, not 'hope to monetize'). This is independent of the Funding Status cell.",
            },
            "revenue_confidence": {
                "type": "string",
                "enum": ["low", "medium", "high"],
                "description": "Confidence in the revenue read. Profiles have no revenue field, so default low unless the text is explicit.",
            },
            "reasoning": {
                "type": "string",
                "description": "One or two sentences citing the exact profile phrases that drove the funding and country reads.",
            },
        },
        "required": [
            "country",
            "funding_kind",
            "funding_usd",
            "makes_substantial_revenue",
            "revenue_confidence",
            "reasoning",
        ],
    },
}

_SYSTEM = (
    "You normalise YC co-founder matching profiles for a downstream filter. "
    "Read the candidate's profile text and extract only what is stated or "
    "strongly implied. Be conservative: never invent funding or revenue.\n\n"
    "IMPORTANT — source rules:\n"
    "- funding_kind and funding_usd come ONLY from the 'Funding Status' cell. "
    "Ignore any investment/funding figures mentioned in the description, the "
    "extracted fields, or the full profile text. If the Funding Status cell is "
    "blank / N/A, then funding_kind = none_stated and funding_usd = null.\n"
    "- makes_substantial_revenue / revenue_confidence are read from the "
    "description and profile text (revenue rarely appears in the Funding "
    "Status cell) and are independent of funding.\n\n"
    "Treat 'own money', 'savings', 'line of credit', 'bootstrapped' as "
    "self_funded ($0 raised). Treat 'looking to raise', 'planning a round', "
    "'in talks' as intent_to_raise ($0 raised). Only 'raised' means capital "
    "actually closed. Country is where the person lives now.\n\n"
    "Respond with a single JSON object, no markdown fences, with exactly "
    "these keys:\n"
    '- "country": full English country name where they live now (e.g. '
    '"United States", not "US"/"USA"), or null if not stated.\n'
    '- "funding_kind": one of "raised", "grant", "self_funded", '
    '"intent_to_raise", "none_stated".\n'
    '- "funding_usd": number = external capital RAISED in USD per the Funding '
    "Status cell ONLY, or null if that cell states no amount / self-funded / "
    "intent only.\n"
    '- "makes_substantial_revenue": boolean, true only when the description or '
    "profile text clearly shows meaningful/recurring revenue or paying customers.\n"
    '- "revenue_confidence": one of "low", "medium", "high" (default "low").\n'
    '- "reasoning": one or two sentences citing the exact profile phrases '
    "that drove the funding and country reads."
)


def _project_lines(project: dict[str, Any] | None) -> str:
    """Render the deterministically-parsed startup card. This is the primary
    signal for the funding/revenue read — the content script extracted it
    straight from the project table, so it's cleaner than the page dump."""
    if not project:
        return ""
    parts = []
    if project.get("name"):
        parts.append(f"- Name: {project['name']}")
    if project.get("description"):
        parts.append(f"- Description: {project['description']}")
    if project.get("progress"):
        parts.append(f"- Progress: {project['progress']}")
    if project.get("funding_status"):
        parts.append(f"- Funding Status: {project['funding_status']}")
    # Any extra rows the card carried that we didn't name explicitly.
    named = {"Progress", "Funding Status"}
    for k, v in (project.get("rows") or {}).items():
        if k not in named and v:
            parts.append(f"- {k}: {v}")
    return "\n".join(parts)


def _build_user_text(profile: dict[str, Any]) -> str:
    name = profile.get("name") or "(unknown)"
    fields = profile.get("fields") or {}
    field_lines = "\n".join(f"- {k}: {v}" for k, v in fields.items() if v)
    raw = (profile.get("raw_text") or "").strip()
    project = profile.get("project") or {}
    funding_status = (project.get("funding_status") or "").strip()
    project_lines = _project_lines(profile.get("project"))
    project_block = (
        f"Startup / project (parsed from the project card):\n{project_lines}\n\n"
        if project_lines
        else ""
    )
    # Funding is read from the "Funding Status" cell and NOTHING else. We
    # surface it on its own so the model can't be tempted by a dollar figure
    # that appears in the description or page body.
    funding_block = (
        "Funding Status cell — the ONLY source for funding_kind and "
        "funding_usd. Ignore any funding/investment figures that appear "
        "anywhere else (description, page text, fields):\n"
        f"{funding_status or '(blank — treat as none_stated, no amount)'}\n\n"
    )
    # With a structured card in hand the raw dump is just a small backstop for
    # things that live in free text (country, revenue asides) — funding now
    # comes only from the Funding Status cell and revenue from the
    # description, both already in the card. Keep it short to cut tokens per
    # call (the direct lever on the tokens-per-minute rate limit).
    raw_budget = 1500 if project_lines else 8000
    return (
        f"Candidate: {name}\n\n"
        f"{funding_block}"
        f"{project_block}"
        f"Extracted fields:\n{field_lines or '(none)'}\n\n"
        f"Full profile text:\n{raw[:raw_budget]}"
    )


# Which response_format the current provider accepts. Strict "json_schema"
# guarantees a valid object, but not every OpenAI-compatible model supports
# it (e.g. Groq's llama-3.3-70b only does "json_object"). We try schema
# first, fall back to object on the provider's 400, and cache the result so
# we don't eat a failed request on every profile.
_json_mode: str | None = None

_VALID_KIND = {"raised", "grant", "self_funded", "intent_to_raise", "none_stated"}
_VALID_CONF = {"low", "medium", "high"}


def _response_format(mode: str) -> dict[str, Any]:
    if mode == "schema":
        return {"type": "json_schema", "json_schema": _EVAL_SCHEMA}
    return {"type": "json_object"}


def _normalize(raw: Any) -> dict[str, Any]:
    """Coerce a model response into the shape rules.py expects. Strict-schema
    output already conforms; this mainly guards json_object output, where the
    types aren't enforced by the API."""
    d = raw if isinstance(raw, dict) else {}

    country = d.get("country")
    country = country.strip() if isinstance(country, str) and country.strip() else None

    kind = d.get("funding_kind")
    kind = kind if kind in _VALID_KIND else "none_stated"

    amount = d.get("funding_usd")
    if isinstance(amount, str):
        try:
            amount = float(amount.replace("$", "").replace(",", "").strip())
        except ValueError:
            amount = None
    amount = amount if isinstance(amount, (int, float)) else None

    conf = d.get("revenue_confidence")
    conf = conf if conf in _VALID_CONF else "low"

    return {
        "country": country,
        "funding_kind": kind,
        "funding_usd": amount,
        "makes_substantial_revenue": bool(d.get("makes_substantial_revenue")),
        "revenue_confidence": conf,
        "reasoning": str(d.get("reasoning") or ""),
    }


async def evaluate_profile(profile: dict[str, Any]) -> dict[str, Any]:
    """Return the normalised judgement dict for one scraped profile."""
    global _json_mode
    client = _get_client()
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": _build_user_text(profile)},
    ]

    mode = _json_mode or "schema"
    try:
        resp = await client.chat.completions.create(
            model=LLM_MODEL,
            temperature=0,
            response_format=_response_format(mode),
            messages=messages,
        )
    except BadRequestError as e:
        # Provider rejects strict json_schema (e.g. Groq llama-3.3). Retry
        # once in json_object mode and remember it for next time.
        if mode == "schema" and "response_format" in str(e).lower():
            log.warning(
                "%s rejected json_schema; falling back to json_object mode", LLM_MODEL
            )
            mode = "object"
            resp = await client.chat.completions.create(
                model=LLM_MODEL,
                temperature=0,
                response_format=_response_format(mode),
                messages=messages,
            )
        else:
            raise
    if _json_mode is None:
        _json_mode = mode  # cache the mode that actually worked

    content = resp.choices[0].message.content or "{}"
    data = _normalize(json.loads(content))
    log.info(
        "eval %s [%s]: country=%s funding=%s/%s revenue=%s(%s)",
        (profile.get("name") or "?")[:30],
        mode,
        data.get("country"),
        data.get("funding_kind"),
        data.get("funding_usd"),
        data.get("makes_substantial_revenue"),
        data.get("revenue_confidence"),
    )
    return data


async def validate_key() -> dict[str, Any]:
    """Cheap auth check for the popup's status indicator."""
    key = _resolve_key()
    if not key:
        return {"ok": False, "error": "No LLM API key set (YCENG_LLM_API_KEY)"}
    try:
        client = AsyncOpenAI(api_key=key, base_url=LLM_BASE_URL)
        await client.models.list()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001 - surface provider message verbatim
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

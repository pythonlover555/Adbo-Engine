"""The deterministic keep/skip gate.

Takes the model's normalised judgement (from llm.evaluate_profile) and the
thresholds in config.py, and returns a decision. No model calls here — this
is plain, testable logic so the threshold behaviour is predictable.

Decisions:
- "keep"   -> passes region AND funding. Save + stop for the user to act.
- "skip"   -> clearly fails a gate. Extension clicks "Skip for now".
- "review" -> ambiguous (e.g. raised an unknown amount, or revenue read is
              only medium confidence). Save but flag; never auto-skipped, so
              a real match isn't lost to a bad inference.
"""
from __future__ import annotations

from typing import Any

from .config import ALLOWED_REGIONS, FUNDING_MIN_USD, REVENUE_CAN_PASS

_ALLOWED_LOWER = {r.lower() for r in ALLOWED_REGIONS}
# When the allowlist is empty, the region gate is OFF — every country
# passes. Set YCENG_ALLOWED_REGIONS in .env to re-enable it.
_REGION_RESTRICTED = bool(_ALLOWED_LOWER)

# Map common country aliases / abbreviations to a canonical name so the
# gate doesn't reject "USA" or "US" when the allowlist says "United
# States". Keys are compared lowercase. Extend as new variants show up.
_COUNTRY_ALIASES = {
    "usa": "united states",
    "us": "united states",
    "u.s.": "united states",
    "u.s.a.": "united states",
    "america": "united states",
    "united states of america": "united states",
    "the united states": "united states",
    "ca": "canada",
    "can": "canada",
}


def _canonical_country(country: str) -> str:
    c = country.strip().lower()
    # Also try a form with all dots/spaces removed so "U.S.", "U. S. A."
    # collapse to "us"/"usa" and hit the alias table.
    stripped = c.replace(".", "").replace(" ", "")
    return (
        _COUNTRY_ALIASES.get(c.rstrip("."))
        or _COUNTRY_ALIASES.get(stripped)
        or c.rstrip(".")
    )


def _region_pass(country: str | None) -> tuple[bool, bool]:
    """Return (passes, known). known=False when no country was extracted."""
    if not _REGION_RESTRICTED:
        return True, True  # gate disabled — country is irrelevant
    if not country:
        return False, False
    return _canonical_country(country) in _ALLOWED_LOWER, True


def _funding_pass(ev: dict[str, Any]) -> tuple[str, str]:
    """Return (status, reason) where status is 'pass' | 'fail' | 'review'."""
    kind = ev.get("funding_kind") or "none_stated"
    amount = ev.get("funding_usd")

    # Revenue can satisfy the gate on its own, but only when explicit.
    if REVENUE_CAN_PASS and ev.get("makes_substantial_revenue"):
        conf = ev.get("revenue_confidence") or "low"
        if conf == "high":
            return "pass", "substantial revenue (high confidence)"
        return "review", f"possible revenue but {conf} confidence"

    if kind in ("self_funded", "intent_to_raise", "none_stated"):
        return "fail", f"no external funding ({kind})"

    # kind is 'raised' or 'grant' from here.
    if amount is None:
        return "review", f"{kind} but no amount stated"
    if amount >= FUNDING_MIN_USD:
        return "pass", f"{kind} ${int(amount):,} >= ${int(FUNDING_MIN_USD):,}"
    return "fail", f"{kind} ${int(amount):,} < ${int(FUNDING_MIN_USD):,}"


def decide(ev: dict[str, Any]) -> dict[str, Any]:
    region_ok, region_known = _region_pass(ev.get("country"))
    funding_status, funding_reason = _funding_pass(ev)

    # Region is a hard gate. A clearly-disallowed country is an immediate
    # skip regardless of funding.
    if region_known and not region_ok:
        decision = "skip"
        reason = f"region {ev.get('country')!r} not in {ALLOWED_REGIONS}"
    elif funding_status == "fail":
        decision = "skip"
        reason = funding_reason
    elif not region_known:
        # Funding might pass, but we don't know the country — don't skip a
        # potential match on missing data; flag it.
        decision = "review"
        reason = f"country unknown; funding: {funding_reason}"
    elif funding_status == "review":
        decision = "review"
        reason = funding_reason
    else:  # region_ok and funding pass
        decision = "keep"
        reason = (
            f"region {ev.get('country')}; {funding_reason}"
            if _REGION_RESTRICTED
            else funding_reason
        )

    return {
        "decision": decision,
        "reason": reason,
        "region_pass": region_ok,
        "region_known": region_known,
        "funding_status": funding_status,
    }

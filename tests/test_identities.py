"""Adbo-Engine backend contract: the data the extension fills into the funnel."""
from __future__ import annotations

import re

from fastapi.testclient import TestClient

from server import identities
from server.main import app

client = TestClient(app)

# State codes / DOB option values the registration form's <select>s accept.
FORM_STATES = set(identities.STATES)


def test_random_identity_shape():
    ident = identities.random_identity()
    assert ident["first_name"] and ident["last_name"]
    assert ident["full_name"] == f"{ident['first_name']} {ident['last_name']}"
    assert re.fullmatch(r"[a-z0-9._]+@[a-z.]+", ident["email"]), ident["email"]


def test_random_details_matches_form_expectations():
    d = identities.random_details()
    assert d["state"] in FORM_STATES
    assert re.fullmatch(r"\d{5}", d["zip"])
    assert re.fullmatch(r"\d{10}", d["phone"])  # 10 digits, no separators
    assert d["dob"]["month"] in {f"{m:02d}" for m in range(1, 13)}
    assert 1 <= int(d["dob"]["day"]) <= 28  # always a valid calendar day
    assert 1950 <= int(d["dob"]["year"]) <= 2002
    assert d["gender"] in {"M", "F"}


def test_identity_endpoint():
    r = client.get("/api/identity?count=3")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert len(body["identities"]) == 3
    assert body["identity"] == body["identities"][0]


def test_details_endpoint():
    r = client.get("/api/details")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["details"]["state"] in FORM_STATES


def test_health_endpoint():
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert re.fullmatch(r"\d+\.\d+\.\d+\.\d+", body["version"])  # x.x.x.x


def test_version_matches_extension_manifest():
    import json
    from pathlib import Path

    from server.main import VERSION

    manifest = json.loads(
        (Path(__file__).resolve().parents[1] / "nav-extension" / "manifest.json")
        .read_text(encoding="utf-8")
    )
    assert manifest["version"] == VERSION  # single source of truth stays in sync

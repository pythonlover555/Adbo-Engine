"""Random identity generation for the sign-up automation.

The browser extension asks this server for a name + email to enter on the
landing-page form. For now both come from the sample lists below and are
combined randomly — swap `random_identity` for a real source (a CSV, a
provider API, a reserved-mailbox pool) without touching the HTTP or
extension code.
"""
from __future__ import annotations

import random
import re
from typing import Any

FIRST_NAMES = [
    "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael",
    "Linda", "William", "Elizabeth", "David", "Barbara", "Richard", "Susan",
    "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Daniel",
    "Nancy", "Matthew", "Lisa", "Anthony", "Betty", "Mark", "Sandra",
    "Donald", "Ashley", "Steven", "Kimberly", "Andrew", "Emily", "Joshua",
    "Donna", "Kevin", "Michelle", "Brian", "Carol", "George", "Amanda",
    "Edward", "Melissa", "Ronald", "Deborah", "Timothy", "Stephanie",
    "Jason", "Rebecca",
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
    "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark",
    "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
    "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green",
    "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
    "Carter", "Roberts",
]

EMAIL_DOMAINS = [
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com",
    "aol.com", "live.com",
]


def _slug(s: str) -> str:
    """Keep only a-z0-9 so the local-part is always a valid email."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _make_email(first: str, last: str) -> str:
    f, l = _slug(first), _slug(last)
    # A spread of natural-looking local-part shapes.
    patterns = [
        f"{f}.{l}",
        f"{f}{l}",
        f"{f}_{l}",
        f"{f[0]}{l}",
        f"{f}{l[0]}",
        f"{f}.{l}{random.randint(1, 99)}",
        f"{f}{l}{random.randint(1, 9999)}",
    ]
    local = random.choice(patterns)
    return f"{local}@{random.choice(EMAIL_DOMAINS)}"


def random_identity() -> dict[str, str]:
    """One random full name + matching email built from the sample lists."""
    first = random.choice(FIRST_NAMES)
    last = random.choice(LAST_NAMES)
    return {
        "first_name": first,
        "last_name": last,
        "full_name": f"{first} {last}",
        "email": _make_email(first, last),
    }


# --- registration details (everything EXCEPT email/name) --------------
# The extension already holds email + name from the identity step, so the
# details endpoint supplies the rest of the sign-up form. All random for now;
# swap `random_details()` for a real/validated source later.

STREET_NAMES = [
    "Main", "Oak", "Pine", "Maple", "Cedar", "Elm", "Washington", "Lake",
    "Hill", "Park", "Sunset", "River", "Church", "Spring", "Highland",
    "Forest", "Franklin", "Center", "Walnut", "Chestnut", "Lincoln", "Adams",
]
STREET_SUFFIXES = ["St", "Ave", "Rd", "Dr", "Ln", "Blvd", "Ct", "Way", "Pl"]

CITIES = [
    "Springfield", "Franklin", "Greenville", "Bristol", "Clinton", "Madison",
    "Georgetown", "Salem", "Fairview", "Riverside", "Auburn", "Dayton",
    "Arlington", "Ashland", "Burlington", "Manchester", "Oxford", "Newport",
    "Milton", "Kingston", "Marion", "Oakland",
]

# 2-letter codes matching exactly the <select id="state"> options on the form.
STATES = [
    "AK", "AL", "AR", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI",
    "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN",
    "MO", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH",
    "OK", "OR", "PA", "PR", "RI", "SD", "SC", "TN", "TX", "UT", "VA", "VT",
    "WA", "WI", "WV", "WY",
]


def _phone() -> str:
    """A plausible 10-digit US number (area/exchange lead 2-9). Digits only;
    the form auto-formats on input."""
    digits = [str(random.randint(2, 9))] + [str(random.randint(0, 9)) for _ in range(2)]
    digits += [str(random.randint(2, 9))] + [str(random.randint(0, 9)) for _ in range(6)]
    return "".join(digits)


def random_details() -> dict[str, Any]:
    """Random shipping/contact/DOB/gender details for the registration form,
    using value formats the form's fields expect (zero-padded DOB, 2-letter
    state, day capped at 28 so the date is always valid)."""
    return {
        "address1": f"{random.randint(1, 9999)} {random.choice(STREET_NAMES)} "
        f"{random.choice(STREET_SUFFIXES)}",
        "city": random.choice(CITIES),
        "state": random.choice(STATES),
        "zip": f"{random.randint(1, 99999):05d}",
        "phone": _phone(),  # 10 digits, no separators
        "dob": {
            "month": f"{random.randint(1, 12):02d}",  # "01".."12"
            "day": f"{random.randint(1, 28):02d}",    # "01".."28" (always valid)
            "year": str(random.randint(1950, 2002)),  # adult age range
        },
        "gender": random.choice(["M", "F"]),
    }

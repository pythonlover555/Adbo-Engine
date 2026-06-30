# Conditional Navigation (Chrome Extension)

Drives a single tab through a redirect loop until a target landing page is
reached, then injects a content script to scrape it.

## Flow

```
Source URL ──redirects──▶ google.com           → FAILURE: wait 2s, re-navigate to Source (retry)
                       └▶ uplevelrewards.com    → SUCCESS: stop loop, inject content.js (scrape)
                       └▶ anything else          → log & wait (intermediate hop / unknown)
```

- **Source URL:** `https://glstrk.com/?offer_ids=MjM3MCwxNDIx&affiliate_id=MTkwNDU3`
- **Failure pattern:** URL contains `google.com`
- **Success pattern:** URL contains `uplevelrewards.com`

## How it works

`background.js` (MV3 service worker) listens on
`chrome.webNavigation.onCompleted` for the driven tab's **main frame**. Because
one source load fans out into several redirect hops, each `onCompleted` re-arms
a short *settle* timer (`SETTLE_MS`); the URL is only judged once navigation has
been quiet, so an intermediate hop is never mistaken for the destination.

Safety guards prevent infinite loops:

- `MAX_RETRIES` — cap on `google.com` bounces.
- `MAX_UNKNOWN` — cap on settles matching neither pattern.

All constants live at the top of [background.js](background.js).

## Load it

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `nav-extension/` folder.
3. Click the toolbar icon → **Start**. A new tab opens and the loop runs.
   The popup shows live status; the toolbar badge shows `…` (running), `✓`
   (landed/scraped), or `!` (stopped on error).

## Funnel automation (after landing)

[content.js](content.js) is a **declared content script** on
`*://*.uplevelrewards.com/*`, so it auto-runs on the landing page and on every
later page of the sign-up funnel — each run inspects the page and does that
step's work.

- **Identity:** the service worker fetches one name + e-mail from the local
  server (`GET /api/identity`) the first time a page asks for it, and caches it
  for the whole run, so every funnel page uses the **same person**. A new run
  (clicking Start again) issues a fresh identity.
- **Details:** the rest of the registration data (address, zip, state, city,
  phone, DOB, gender) comes from `GET /api/details` — *not* e-mail/name, which
  the extension already holds. Also fetched once and cached per run.
- **Step 1 — e-mail sign-up:** fills `#user-email` with the run's e-mail and
  clicks the `div.cid-btns` **Continue** control (its inline `submitCid()` fires
  on a real click).
- **Step 2 — full registration (`#reg-container`):** fills e-mail + first/last
  name from the identity and address/zip/state/city/phone/DOB/gender from the
  details, then clicks `#sub-btn`. Text fields are typed char-by-char; `<select>`
  fields are set + `change`-dispatched; gender is a real click on the
  `#male`/`#female` tile.

Names/emails come from sample lists in
[`server/identities.py`](../server/identities.py) (`random_identity`); the
registration details come from `random_details` in the same file — both are
random for now; swap them for real/validated sources without touching the
extension. Add later funnel steps in `content.js`'s `main()`, each guarded by
its own element check like `emailStep()` / `registrationStep()`.

**The local server must be running** for identities to be issued:
`python run_server.py` (serves on `http://localhost:8791`).

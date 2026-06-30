/* Conditional Navigation — service worker (the retry loop).
 *
 * Drives ONE tab through a redirect chain:
 *   Source URL  --redirects-->  google.com   (FAILURE: bounce, retry)
 *                            \-> uplevelrewards.com (SUCCESS: scrape & stop)
 *
 * We listen on chrome.webNavigation.onCompleted (main frame only) and act on
 * the URL the tab SETTLES on. Because a single Source load fans out into
 * several hops (glstrk -> ... -> google|uplevel), each onCompleted resets a
 * short "settle" timer; we only judge the URL once navigation has been quiet
 * for SETTLE_MS. That way intermediate hops never get mistaken for the final
 * destination.
 *
 * MV3 note: this worker is event-driven. webNavigation events and our own
 * short timers wake it as needed; we persist the minimal run state to
 * storage.session so a worker eviction mid-loop can be recovered.
 */

// --- configuration ----------------------------------------------------

const SOURCE_URL =
  "https://glstrk.com/?offer_ids=MTQyMSwyMzcw&affiliate_id=MTkwNDU3";
const FAILURE_SUBSTR = "google.com"; // any URL containing this = bounce
const SUCCESS_SUBSTR = "uplevelrewards.com"; // any URL containing this = landed
const REWARD_SUBSTR = "eward4spot.com"; // funnel finished here -> loop again

const SERVER = "http://localhost:8791"; // local FastAPI server (identities, scrape sink)

const RETRY_DELAY_MS = 2000; // pause before re-navigating after a bounce
const RESTART_DELAY_MS = 4000; // pause on the reward page before looping again
const SETTLE_MS = 1500; // quiet window after the last hop before we judge
const MAX_RETRIES = 50; // safety cap on google bounces (infinite-loop guard)
const MAX_UNKNOWN = 12; // safety cap on settles that match neither pattern

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- run state --------------------------------------------------------
//
// Held in memory for the active worker and mirrored to storage.session so a
// worker restart can resume the listener wiring. `running` is the master
// switch; `tabId` scopes every event to the one tab we drive.

let state = {
  running: false, // is the redirect LOOP actively bouncing right now?
  sessionActive: false, // is a funnel run in progress? (Start..Stop) — gates the
  //                       content script so it only automates during a run, not
  //                       on every site the user happens to visit.
  tabId: null,
  retries: 0, // count of FAILURE bounces this run
  unknown: 0, // consecutive settles matching neither pattern
  identity: null, // the name+email this run fills into the funnel (one per run)
  details: null, // address/phone/DOB/gender for the registration page (one per run)
};
let settleTimer = null; // debounce handle for scheduleEvaluate()

async function persist() {
  await chrome.storage.session.set({ navState: { ...state } });
}

async function restore() {
  const { navState } = await chrome.storage.session.get("navState");
  if (navState) state = { ...state, ...navState };
}

function log(...args) {
  console.log("[cond-nav]", ...args);
}

// Push a one-line status to any open popup (best-effort; ignored if closed)
// and reflect coarse state on the toolbar badge.
function status(text, kind = "info") {
  log(text);
  chrome.runtime.sendMessage({ type: "status", text, kind }).catch(() => {});
  const badge = { run: "…", ok: "✓", fail: "!", info: "" }[kind] ?? "";
  const color = { run: "#6366f1", ok: "#16a34a", fail: "#ef4444", info: "#6b7280" }[kind] ?? "#6b7280";
  chrome.action.setBadgeText({ text: badge });
  chrome.action.setBadgeBackgroundColor({ color });
}

// --- lifecycle --------------------------------------------------------

async function start() {
  await stop(); // clear any prior run first

  // Drive the CURRENT tab (don't open a new one): navigate the active tab to
  // the source URL and run the whole funnel in place.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) {
    status("No active tab to drive.", "fail");
    return;
  }
  // Fresh run => drop the previous identity so a new one is issued on the
  // first request from this run's content script (one identity per funnel).
  state = {
    running: true,
    sessionActive: true, // a run is now in progress -> content script may automate
    tabId: active.id,
    retries: 0,
    unknown: 0,
    identity: null,
    details: null,
  };
  await chrome.storage.local.remove(["identity", "details"]);
  await persist();
  await chrome.tabs.update(active.id, { url: SOURCE_URL });
  status("Started — loading source URL in this tab…", "run");
}

async function stop() {
  state.running = false;
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  await persist();
}

// --- navigation handling ----------------------------------------------

// Every completed main-frame load on our tab (re)arms the settle timer.
// Only when the chain goes quiet for SETTLE_MS do we evaluate the result.
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.tabId !== state.tabId) return;
  if (details.frameId !== 0) return; // ignore sub-frames (ads/iframes)

  // Reward page = the funnel finished. Even though the redirect LOOP isn't
  // running anymore (it stopped on landing), the session is still active, so
  // loop the whole thing again with a fresh identity.
  if (state.sessionActive && (details.url || "").includes(REWARD_SUBSTR)) {
    onFunnelComplete(details.url);
    return;
  }

  if (!state.running) return;
  scheduleEvaluate();
});

// Reached the reward page: pause briefly (let the conversion register), then
// restart the funnel from the source URL in the same tab. A guard prevents the
// reward page's repeat onCompleted events from stacking restarts.
let restarting = false;
async function onFunnelComplete(url) {
  if (restarting) return;
  restarting = true;
  status(`Funnel complete (${shortHost(url)}) — looping again in ${RESTART_DELAY_MS / 1000}s…`, "ok");
  await sleep(RESTART_DELAY_MS);
  if (state.sessionActive && state.tabId != null) {
    // Fresh per-run state (new identity), same tab + session, loop running again.
    state = { ...state, running: true, retries: 0, unknown: 0, identity: null, details: null };
    await chrome.storage.local.remove(["identity", "details"]);
    await persist();
    await chrome.tabs.update(state.tabId, { url: SOURCE_URL });
    status("Restarted — loading source URL…", "run");
  }
  restarting = false;
}

function scheduleEvaluate() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(evaluate, SETTLE_MS);
}

async function evaluate() {
  settleTimer = null;
  if (!state.running) return;

  let tab;
  try {
    tab = await chrome.tabs.get(state.tabId);
  } catch {
    // Tab was closed out from under us — end the run.
    status("Tab closed — stopped.", "fail");
    return stop();
  }

  const url = tab.url || "";
  if (url.includes(SUCCESS_SUBSTR)) {
    await onSuccess(url);
  } else if (url.includes(FAILURE_SUBSTR)) {
    await onFailure(url);
  } else {
    await onUnknown(url);
  }
}

async function onSuccess(url) {
  await stop(); // landed — the redirect loop is done
  // No manual injection needed: content.js is a declared content script on
  // *.uplevelrewards.com, so it auto-runs here AND on every later funnel page.
  status(`Reached target — running funnel on ${shortHost(url)}.`, "ok");
}

// --- identity (one per funnel run, reused across its pages) ------------

// Fetch a name+email from the local server the first time it's needed this
// run, then cache it so every page of the funnel uses the SAME identity.
async function getIdentity() {
  if (state.identity) return state.identity;
  // Survive a service-worker eviction (the funnel spans domains, which often
  // evicts the worker): reuse THIS run's identity from storage before issuing a
  // new one, so the registration page's names stay consistent with the email
  // typed on the first page. start()/onFunnelComplete clear it for a fresh run.
  const stored = (await chrome.storage.local.get("identity")).identity;
  if (stored) {
    state.identity = stored;
    return stored;
  }
  const resp = await fetch(`${SERVER}/api/identity`);
  if (!resp.ok) throw new Error(`server ${resp.status}`);
  const data = await resp.json();
  state.identity = data.identity;
  await chrome.storage.local.set({ identity: state.identity });
  await persist();
  status(
    `Identity: ${state.identity.full_name} <${state.identity.email}>`,
    "run"
  );
  return state.identity;
}

// Registration-form details (address/phone/DOB/gender) — everything except
// the email/name that getIdentity already provides. Same once-per-run cache,
// with the same storage fallback so it survives a worker eviction mid-funnel.
async function getDetails() {
  if (state.details) return state.details;
  const stored = (await chrome.storage.local.get("details")).details;
  if (stored) {
    state.details = stored;
    return stored;
  }
  const resp = await fetch(`${SERVER}/api/details`);
  if (!resp.ok) throw new Error(`server ${resp.status}`);
  const data = await resp.json();
  state.details = data.details;
  await chrome.storage.local.set({ details: state.details });
  await persist();
  status(
    `Details: ${state.details.city}, ${state.details.state} ${state.details.zip}`,
    "run"
  );
  return state.details;
}

async function onFailure(url) {
  state.retries += 1;
  if (state.retries > MAX_RETRIES) {
    status(`Hit the ${MAX_RETRIES}-bounce cap — giving up.`, "fail");
    return stop();
  }
  state.unknown = 0; // a fresh attempt clears the unknown streak
  await persist();
  status(
    `Bounced to ${shortHost(url)} (#${state.retries}) — retrying in ${RETRY_DELAY_MS / 1000}s…`,
    "run"
  );

  // Wait, then re-navigate the SAME tab back to the source to retry the chain.
  setTimeout(() => {
    if (!state.running) return;
    chrome.tabs.update(state.tabId, { url: SOURCE_URL }).catch((e) => {
      status(`Could not re-navigate: ${e.message}`, "fail");
      stop();
    });
  }, RETRY_DELAY_MS);
}

// Settled on a page that is neither the failure nor the success pattern.
// This is usually a still-resolving intermediate hop: we DON'T act, because
// the next onCompleted will re-arm the settle timer and re-evaluate. We only
// count these to break out if a page keeps firing onCompleted without ever
// matching (the genuine "stuck on unknown" case the spec warns about).
async function onUnknown(url) {
  state.unknown += 1;
  await persist();
  // Flag the unexpected landing to the console as a warning (stands out in the
  // service-worker DevTools), matching neither the success nor failure pattern.
  console.warn(`[cond-nav] ⚠ UNEXPECTED redirect (#${state.unknown}):`, url);
  if (state.unknown > MAX_UNKNOWN) {
    status(`Stuck on unexpected page ${shortHost(url)} — stopped.`, "fail");
    return stop();
  }
  status(`Waiting on ${shortHost(url)} (unexpected #${state.unknown})…`, "run");
}

function shortHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

// --- wiring -----------------------------------------------------------

// If our driven tab is closed, abandon the run.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.running && tabId === state.tabId) {
    status("Driven tab was closed — stopped.", "fail");
    stop();
  }
});

// Receive scraped data from content.js and stash the latest result so the
// popup can show / the user can retrieve it. (Swap this for a POST to your
// collection endpoint if you want it pushed somewhere.)
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === "scrape-result") {
    chrome.storage.local.set({ lastScrape: req.data });
    status(`Scraped ${req.data?.fieldCount ?? 0} fields from target.`, "ok");
    sendResponse?.({ ok: true });
    return; // sync response
  }
  if (req.type === "get-identity") {
    getIdentity()
      .then((identity) => sendResponse?.({ ok: true, identity }))
      .catch((e) => {
        status(`Could not get identity from server: ${e.message}`, "fail");
        sendResponse?.({ ok: false, error: e.message });
      });
    return true; // async
  }
  if (req.type === "get-details") {
    getDetails()
      .then((details) => sendResponse?.({ ok: true, details }))
      .catch((e) => {
        status(`Could not get details from server: ${e.message}`, "fail");
        sendResponse?.({ ok: false, error: e.message });
      });
    return true; // async
  }
  if (req.type === "start") {
    start().then(() => sendResponse?.({ ok: true }));
    return true; // async
  }
  if (req.type === "stop") {
    state.sessionActive = false; // user ended the run -> content script goes inert
    stop().then(() => {
      status("Stopped by user.", "info");
      sendResponse?.({ ok: true });
    });
    return true; // async
  }
  if (req.type === "is-active") {
    // The content script asks this before doing anything, so it automates only
    // during an active run (we run on <all_urls>, so this gate is what keeps it
    // from touching forms on unrelated sites).
    if (state.sessionActive) {
      sendResponse?.({ active: true });
      return; // sync fast path
    }
    // The worker may have just respawned on a deeper funnel domain (cross-domain
    // navigation evicts it) BEFORE restore() ran, so the in-memory flag is still
    // false. Fall back to the persisted state so we don't wrongly skip an active
    // run (which left surveys un-answered).
    chrome.storage.session.get("navState").then(({ navState }) => {
      if (navState) state = { ...state, ...navState }; // rehydrate for later msgs
      sendResponse?.({ active: !!navState?.sessionActive });
    });
    return true; // async
  }
  if (req.type === "get-state") {
    sendResponse?.({ running: state.running, retries: state.retries });
    return; // sync
  }
});

// Recover in-memory state if the worker was evicted and re-spawned by an event.
restore();
log("service worker loaded");

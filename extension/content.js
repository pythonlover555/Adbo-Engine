/* YC Scout — content script (the engine).
 *
 * Runs on startupschool.org/cofounder-matching/*. When started from the
 * popup it loops over the Discover queue: scrape the current profile, send
 * it to the local server for evaluation, and either click "Skip for now"
 * (non-match) or halt on a match so the user can act.
 *
 * Robustness notes:
 * - Selectors target TEXT, not emotion `css-*` classes (those churn between
 *   YC deploys). The Skip button is found by its label; field values by the
 *   label text that precedes them.
 * - The page is a SPA: after a skip we wait for the profile id (or name) to
 *   change before scraping again, rather than assuming instant navigation.
 */

const SERVER = "http://localhost:8791";
const MAX_PROFILES = 500; // hard stop so a bug can't loop forever
const NAV_TIMEOUT_MS = 25000; // how long to wait for the next profile to load
const WATCHDOG_MS = 10000; // how often to check whether to auto-resume
// Steady gap between token-spending evaluations, to spread requests across
// the provider's per-minute (TPM/RPM) budget instead of bunching several into
// one minute and tripping the 429. This is a small, PREDICTABLE pace — the
// trade that avoids the unexpected ~60s rate-limit freeze. Only applied after
// a profile we actually sent to the AI; free skips (no-project / ideas) are
// not delayed. Tune to taste: higher = safer under the limit but slower.
const EVAL_PACING_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log("[yc-filter]", ...args);
}

// --- scraping ---------------------------------------------------------

function currentProfileId() {
  // IDs look like /cofounder-matching/candidate/r9y33dswO. The Discover
  // URL may stay on /candidate/next, so also scan links/canonical.
  const fromUrl = location.pathname.match(/\/candidate\/([A-Za-z0-9_-]{6,})/);
  if (fromUrl && fromUrl[1] !== "next") return fromUrl[1];
  const canon = document.querySelector('link[rel="canonical"]');
  if (canon) {
    const m = canon.href.match(/\/candidate\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
  }
  for (const a of document.querySelectorAll('a[href*="/candidate/"]')) {
    const m = a.getAttribute("href").match(/\/candidate\/([A-Za-z0-9_-]{6,})/);
    if (m && m[1] !== "next") return m[1];
  }
  return null;
}

function profileName() {
  // The candidate name is the most prominent heading in the profile pane.
  const h = document.querySelector("h1, h2, h3");
  return h ? h.textContent.trim() : "";
}

// Known label/value pairs render as <span>LABEL</span><div>VALUE</div>.
// We match by label text and read the next sibling, so we don't depend on
// the generated class names.
const KNOWN_LABELS = [
  "Intro",
  "Funding Status",
  "Progress",
  "Impressive accomplishment",
  "Education",
  "Employment",
  "Free Time",
  "Other",
  "Equity expectations",
  "Ideal co-founder",
];

function scrapeFields() {
  const fields = {};
  const wanted = new Set(KNOWN_LABELS.map((l) => l.toLowerCase()));
  for (const el of document.querySelectorAll("span, div, strong, b")) {
    const label = (el.textContent || "").trim();
    if (!wanted.has(label.toLowerCase())) continue;
    const sib = el.nextElementSibling;
    if (sib) {
      const val = (sib.textContent || "").trim();
      if (val && val.length < 4000) fields[label] = val;
    }
  }
  return fields;
}

function profileContainerText() {
  // Send the whole profile pane as fallback context for the model
  // (revenue / country often live in free text). Prefer <main>, else body.
  const main = document.querySelector("main") || document.body;
  return (main.innerText || "").replace(/\s+\n/g, "\n").slice(0, 12000);
}

function scrapeProfile() {
  const analysis = analyzeProject();
  return {
    profile_id: currentProfileId(),
    profile_url: location.href,
    name: profileName(),
    fields: scrapeFields(),
    raw_text: profileContainerText(),
    // Deterministic project read (no AI). state drives the local gate;
    // project (when present) is the clean funding table sent to the model.
    project_state: analysis.state,
    project: analysis.project,
  };
}

// --- skip button + navigation ----------------------------------------

// Idea-stage profiles show a "Potential ideas" section heading instead of a
// committed startup. They can't meet the funding/revenue bar, so we skip
// them up front — and crucially WITHOUT an OpenAI call (saves tokens / rate
// limit). Matched by heading text, not the churning css-* class.
function showsPotentialIdeas() {
  for (const h of document.querySelectorAll("h1, h2, h3, h4")) {
    if ((h.textContent || "").trim().toLowerCase() === "potential ideas") return true;
  }
  return false;
}

// --- project detection (deterministic, no AI) -------------------------
//
// The profile is a stack of section blocks. The two stable anchors are the
// "My Background" section and the "What I'm looking for in a co-founder"
// section. Between them sits AT MOST one section:
//   - nothing                -> the person has no startup            (no project)
//   - a "Potential ideas" box -> only loose ideas, nothing committed (no project)
//   - a startup card         -> a real project with a funding table  (PROJECT)
// So we don't need absolute indices (3rd/4th/5th churn); we find the
// co-founder anchor and inspect the single block immediately before it.
//
// Section blocks share class `css-fu3au1`. We key on that for selection but
// decide on the block's HEADING TEXT, which is stable across deploys. If the
// class ever disappears we return state:"unknown" and fall back to AI rather
// than silently dropping a candidate.
const SECTION_CLASS = "css-fu3au1";

function normHeading(s) {
  // lowercase, drop apostrophes (straight/curly), collapse whitespace.
  return (s || "").toLowerCase().replace(/['’`]/g, "").replace(/\s+/g, " ").trim();
}

// A block's heading is the first <span> (labeled sections like "My
// Background") or the first <b> (a startup card leads with <b>NAME</b>).
function blockHeading(el) {
  const node = el.querySelector("span, b");
  return node ? (node.textContent || "").trim() : "";
}

// Break a startup card into the structured fields the funding judgement
// needs. Rows render as <tr><span>LABEL</span> … <div>VALUE</div></tr>; the
// first row's label is the startup name and its value is the description.
function parseProjectBlock(block) {
  const nameEl = block.querySelector("b");
  const name = nameEl ? nameEl.textContent.trim() : "";
  const rows = {};
  let description = "";
  for (const tr of block.querySelectorAll("tr")) {
    const labelEl = tr.querySelector("span");
    const valueEl = tr.querySelector("div");
    if (!labelEl || !valueEl) continue;
    const label = labelEl.textContent.trim();
    const value = valueEl.textContent.trim();
    if (!label || !value) continue;
    if (name && label === name && !description) {
      description = value; // first row: name -> description
      continue;
    }
    rows[label] = value;
  }
  // Fallback if the name/description heuristic missed (e.g. unnamed card):
  // take the longest cell value as the description.
  if (!description) {
    const vals = Object.values(rows);
    if (vals.length) description = vals.reduce((a, b) => (b.length > a.length ? b : a), "");
  }
  return {
    name,
    description,
    progress: rows["Progress"] || "",
    funding_status: rows["Funding Status"] || "",
    rows,
  };
}

// Classify the current profile: "no-project" | "ideas" | "project" |
// "unknown". Only "project" warrants an AI call.
function analyzeProject() {
  const blocks = Array.from(document.querySelectorAll(`.${SECTION_CLASS}`));
  if (!blocks.length) return { state: "unknown", project: null };

  const headings = blocks.map((b) => normHeading(blockHeading(b)));
  const ci = headings.findIndex((h) => h.includes("looking for in a co-founder"));
  if (ci <= 0) return { state: "unknown", project: null }; // anchor missing/first

  const prev = headings[ci - 1];
  if (prev.includes("my background")) return { state: "no-project", project: null };
  if (prev.includes("potential ideas")) return { state: "ideas", project: null };

  return { state: "project", project: parseProjectBlock(blocks[ci - 1]) };
}

function findSkipButton() {
  for (const b of document.querySelectorAll("button")) {
    if ((b.textContent || "").trim().toLowerCase() === "skip for now") return b;
  }
  return null;
}

// Wait until the visible profile changes (id or name differs from before),
// signalling the SPA loaded the next candidate.
async function waitForNextProfile(prevId, prevName, timeout = NAV_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(400);
    const id = currentProfileId();
    const name = profileName();
    if ((id && id !== prevId) || (name && name !== prevName)) return true;
  }
  return false;
}

// --- server -----------------------------------------------------------

async function evaluate(profile) {
  const resp = await fetch(`${SERVER}/api/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!resp.ok) throw new Error(`server ${resp.status}`);
  return resp.json();
}

// Sleep that aborts promptly when the user hits Stop. Checks RUNNING each
// second WITHOUT repainting the banner (so the one pause message stays put,
// no per-second spam). Returns true if it slept the full time, false if the
// user stopped partway.
async function sleepUntilOrStopped(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!RUNNING) return false;
    await sleep(Math.min(1000, end - Date.now()));
  }
  return true;
}

// Evaluate one profile. The ONLY deliberate pause in the whole engine lives
// here: when the provider's tokens-per-minute budget is spent (429 TPM), the
// loop CANNOT proceed until it refills at the next minute. So we pause the
// whole process once — clearly labelled with the reason and duration — then
// retry the SAME profile (never skip an unevaluated candidate). Everything
// else returns immediately. Throws only if the server is unreachable.
async function evaluatePacingTpm(profile) {
  while (RUNNING) {
    const result = await evaluate(profile);
    if (result.ok === false && result.rate_limited) {
      const waitMs = result.retry_after_ms || 60000;
      notify(
        `Rate limit: provider tokens-per-minute budget reached after several ` +
          `profiles. Pausing ${Math.round(waitMs / 1000)}s for it to reset, ` +
          `then continuing on ${profile.name}.`,
        "warn"
      );
      if (!(await sleepUntilOrStopped(waitMs))) return { ok: false, reason: "stopped by user" };
      if (RUNNING) notify(`Budget reset — resuming on ${profile.name}.`, "info");
      continue; // retry the same profile now that the minute bucket refilled
    }
    return result;
  }
  return { ok: false, reason: "stopped by user" };
}

// --- main loop --------------------------------------------------------

let RUNNING = false; // is the loop actively iterating right now?
let DESIRED = false; // does the user want it running? (survives transient stops)

async function setRunning(v) {
  RUNNING = v;
  await chrome.storage.local.set({ running: v });
  chrome.runtime.sendMessage({ type: "status", running: v }).catch(() => {});
}

// DESIRED is the persistent "on switch". The watchdog resumes the loop
// whenever DESIRED is true but RUNNING is false (e.g. after a slow page
// load or a rate-limit give-up). Terminal conditions (queue swept, manual
// Stop) clear DESIRED so it stays off.
async function setDesired(v) {
  DESIRED = v;
  await chrome.storage.local.set({ desired: v });
}

async function runLoop() {
  if (RUNNING) return;
  await setRunning(true);
  log("started");

  const seen = new Set();
  let processed = 0;
  let kept = 0;

  try {
    while (RUNNING && processed < MAX_PROFILES) {
      const skipBtn = findSkipButton();
      if (!skipBtn) {
        // No Skip button: usually the page is mid-load between profiles
        // (transient) — leave DESIRED on so the watchdog retries shortly.
        // If the queue is genuinely exhausted, the button never returns and
        // the watchdog simply finds nothing to do.
        log("no skip button yet — will let watchdog retry");
        break;
      }

      const profile = scrapeProfile();
      const key = profile.profile_id || profile.name;
      if (key && seen.has(key)) {
        // Looped back to a profile we already handled this run = queue fully
        // swept. This IS terminal — turn the switch off so we don't re-sweep
        // and burn tokens re-evaluating everyone.
        await setDesired(false);
        notify(
          `Queue swept — processed ${processed}, saved ${kept}. Auto-filter off.`,
          "info"
        );
        break;
      }
      if (key) seen.add(key);
      processed++;

      // Deterministic gate first — only real-project profiles reach the AI.
      // "no-project"/"ideas" can't clear the funding bar, so skip them with
      // zero tokens. "unknown" (structure changed) falls back to the old
      // heading check, then to AI, so we never silently drop a candidate.
      const state = profile.project_state;
      const skipNoAi =
        state === "no-project" ||
        state === "ideas" ||
        (state === "unknown" && showsPotentialIdeas());

      let evaluated = false; // did this profile cost an AI call? (drives pacing)
      if (skipNoAi) {
        const why =
          state === "no-project" ? "no project section"
          : state === "ideas" ? 'idea-stage ("Potential ideas")'
          : "idea-stage (fallback)";
        log(`#${processed} ${profile.name}: ${why} — skipped, no eval`);
      } else {
        evaluated = true;
        let result;
        try {
          // The only pause in here is the coordinated TPM wait (see
          // evaluatePacingTpm) — the unavoidable one that lets the per-minute
          // token budget refill so we stop bouncing off the 429.
          result = await evaluatePacingTpm(profile);
        } catch (e) {
          notify(`Server unreachable (${e.message}). Is run_server.py running?`, "error");
          break;
        }

        if (result.ok === false && result.reason === "stopped by user") break;

        // The server couldn't assess this profile (and it wasn't a TPM limit,
        // which we already waited out) — stop rather than blindly skip a
        // candidate we never evaluated. A non-retryable failure (daily quota)
        // turns the switch off; a transient one leaves DESIRED on so the
        // watchdog picks it up on its next tick.
        if (result.ok === false) {
          if (result.retryable === false) await setDesired(false);
          notify(`Stopped on ${profile.name}: ${result.reason}`, "error");
          break;
        }

        log(`#${processed} ${profile.name}:`, result.decision, "—", result.reason);

        // Matches (keep/review) are already saved server-side. Note them, but
        // DON'T stop — we want to sweep the whole queue.
        if (result.decision === "keep" || result.decision === "review") {
          kept++;
          notify(
            `Match #${kept} (${result.decision}): ${profile.name} → saved. Continuing… (${processed} seen)`,
            result.decision === "keep" ? "match" : "review"
          );
        }
      }

      // Always advance to the next candidate, regardless of verdict — "Skip
      // for now" is just the queue's "next" control here.
      const prevId = profile.profile_id;
      const prevName = profile.name;
      skipBtn.click();
      const advanced = await waitForNextProfile(prevId, prevName);
      if (!advanced) {
        notify(
          `Clicked Skip but no next profile loaded — likely end of queue. Processed ${processed}, saved ${kept}.`,
          "info"
        );
        break;
      }

      // Pace only the token-spending profiles, so we stay under the per-minute
      // budget. Free skips race ahead untouched. Stop-responsive.
      if (evaluated && EVAL_PACING_MS > 0) {
        await sleepUntilOrStopped(EVAL_PACING_MS);
      }
    }
    if (processed >= MAX_PROFILES) {
      notify(
        `Reached the ${MAX_PROFILES}-profile safety cap. Processed ${processed}, saved ${kept}. Click Start to continue.`,
        "info"
      );
    }
  } finally {
    await setRunning(false);
    log("stopped");
  }
}

// --- in-page banner + messaging --------------------------------------

function notify(msg, kind = "info") {
  chrome.runtime.sendMessage({ type: "notify", msg, kind }).catch(() => {});
  let bar = document.getElementById("yc-scout-banner");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "yc-scout-banner";
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:999999;padding:10px 16px;" +
      "font:600 13px sans-serif;text-align:center;color:#fff;";
    document.body.appendChild(bar);
  }
  const colors = { match: "#7c3aed", review: "#f59e0b", warn: "#e67e22", error: "#ef4444", info: "#6366f1" };
  bar.style.background = colors[kind] || colors.info;
  bar.style.color = kind === "review" ? "#222" : "#fff";
  bar.textContent = `YC Scout: ${msg}`;
}

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === "start") {
    setDesired(true);
    runLoop();
    sendResponse({ ok: true });
  } else if (req.type === "stop") {
    setDesired(false); // explicit Stop turns the switch off for good
    setRunning(false);
    sendResponse({ ok: true });
  } else if (req.type === "ping") {
    sendResponse({ ok: true, running: RUNNING, desired: DESIRED, profile: profileName() });
  }
  return true;
});

// Watchdog: if the user wants it on (DESIRED) but the loop isn't running,
// restart it — provided there's actually a profile to act on. This is what
// makes it "keep going once it's on": it self-heals through slow page loads,
// rate-limit give-ups, and SPA navigations without the user re-clicking
// Start. It does NOT fight a genuine end-of-queue (no Skip button = nothing
// to do) or a manual Stop / swept queue (DESIRED was cleared).
async function watchdogTick() {
  if (!DESIRED) {
    // Re-read in case the page reloaded and lost in-memory state.
    const { desired } = await chrome.storage.local.get("desired");
    if (!desired) return;
    DESIRED = true;
  }
  if (!RUNNING && findSkipButton()) {
    log("watchdog: resuming");
    runLoop();
  }
}
setInterval(watchdogTick, WATCHDOG_MS);
setTimeout(watchdogTick, 2500); // also check shortly after (re)load

log("loaded on", location.href);

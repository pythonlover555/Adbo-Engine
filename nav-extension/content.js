/* Conditional Navigation — content script (the funnel automation).
 *
 * Declared in the manifest on <all_urls> (the funnel spans several domains), so
 * it loads on every page. To avoid touching unrelated sites, it FIRST asks the
 * service worker whether a run is active (isSessionActive) and does nothing
 * unless one is — i.e. it only automates between Start and Stop. When active, it
 * inspects the page and runs the matching step.
 *
 * STEP 1: the e-mail sign-up.
 *   - <input id="user-email" name="email"> -> fill with the run's e-mail
 *   - <div class="cid-btns">Continue</div>  -> click to submit
 *
 * STEP 2: the full registration form (#reg-container).
 *   - email + first/last name come from the cached identity
 *   - address/zip/state/city/phone/DOB/gender come from /api/details
 *   - <div id="sub-btn">Continue</div> -> submit
 *
 * STEP 3: generic survey questions (.SurveyQue), looping through questions
 *   revealed one at a time. Per question:
 *   - single-select -> random among the real, visible options (per ANSWER_RULES
 *     when set);
 *   - "select all that apply" (.multiple / checkboxes) -> a RANDOM number of
 *     real options, then click Done/Submit;
 *   - consent / lead-gen questions (.sponsored, or a disclaimer that opts you
 *     into marketing calls) -> pick the decline option (No Call / No Thanks /
 *     Skip / No), so we never consent to solicitation.
 *
 * STEP 4: TCPA confirmation gate (#tcpaSubBtn) — the REQUIRED lead-submit page.
 *   Here we DO agree: tick "I Agree" (#leadid_tcpa_disclosure_b), click Continue.
 *
 * STEP 5: "email me my status?" CTA (#cidmain) -> click "Yes!".
 *
 * STEP 6: "reviewing progress" interstitial (#stepper2) -> do nothing; it
 *   finishes on its own and redirects to the reward URL.
 *
 * The identity (name + e-mail) AND the details are each fetched ONCE per run by
 * the service worker and reused, so every funnel page shares the same person.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Random delay in [min, max] ms. Used to space actions out so the funnel sees
// human-like pacing instead of instant, bot-shaped fills/clicks.
const rand = (min, max) => min + Math.random() * (max - min);

// The standard interval BEFORE each human action (fill a field, answer a
// question, click a button): a random 1–5 seconds, like a real person. Call it
// with no args. (Sub-action timing like per-keystroke typing uses sleep()/rand
// directly with shorter values — that's typing speed, not an action interval.)
const ACTION_MIN_MS = 1000;
const ACTION_MAX_MS = 5000;
const humanPause = (min = ACTION_MIN_MS, max = ACTION_MAX_MS) => sleep(rand(min, max));

function log(...args) {
  console.log("[cond-nav]", ...args);
}

// Flag an UNEXPECTED / unhandled situation to the browser console as a warning
// (shows with a warning marker in DevTools), so it stands out during a run —
// e.g. an unknown page, a control we expected but didn't find, or a server error.
function flag(...args) {
  console.warn("[cond-nav] ⚠ UNEXPECTED:", ...args);
}

// Wait for an element to appear (the page may still be hydrating).
async function waitFor(selector, timeout = 8000) {
  return waitForCondition(() => document.querySelector(selector), timeout);
}

// Wait until `test()` returns something truthy (returns it), else null on
// timeout. Generic version of waitFor for non-selector conditions.
async function waitForCondition(test, timeout = 8000) {
  const start = Date.now();
  do {
    const v = test();
    if (v) return v;
    await sleep(250);
  } while (Date.now() - start < timeout);
  return null;
}

// Is the element actually on-screen (not display:none / zero-size)? Used to
// skip hidden survey questions that the page reveals one at a time.
function isVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Write `value` into an input so framework listeners (React/Vue) see it: use
// the native value setter, then dispatch the input event. Used per keystroke.
function setNativeValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const ownSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;
  if (nativeSetter && nativeSetter !== ownSetter) nativeSetter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Type a string into an input one character at a time with small randomized
// gaps, firing a full key event sequence per character — so the page receives
// human-paced keystrokes, not one instant paste.
async function typeInto(input, text) {
  input.focus();
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await humanPause(120, 320);
  let current = "";
  for (const ch of text) {
    const opts = { bubbles: true, key: ch };
    input.dispatchEvent(new KeyboardEvent("keydown", opts));
    current += ch;
    setNativeValue(input, current);
    input.dispatchEvent(new KeyboardEvent("keyup", opts));
    await sleep(rand(70, 200)); // per-keystroke jitter
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
}

// The Continue control is a <div class="cid-btns">, not a <button>. There can be
// MORE THAN ONE .cid-btns in the DOM (hidden ones from other steps/offers), so
// querySelector's "first in DOM" is unreliable — pick a VISIBLE one. `root`
// scopes the search to a specific container (e.g. the email box) so we never
// grab a Continue belonging to a different section.
function findContinue(root = document) {
  const tiles = [...root.querySelectorAll(".cid-btns")].filter(isVisible);
  if (tiles.length) return tiles[0];
  // Fall back to a visible element whose exact text is "Continue".
  for (const el of root.querySelectorAll("button, a, div, span")) {
    if ((el.textContent || "").trim().toLowerCase() === "continue" && isVisible(el)) {
      return el;
    }
  }
  // Last resort: any .cid-btns at all (even if our visibility check missed it).
  return root.querySelector(".cid-btns");
}

// Click an element the way a real cursor would: scroll it into view, then fire
// hover -> move -> press -> release AT THE ELEMENT'S CENTER COORDINATES, and end
// with a SINGLE activating click.
//
// Why this shape:
//  - Coordinates + pointer/mouse hover/press make it look like a genuine cursor
//    click (some survey handlers read clientX/Y or require a pointerdown first).
//  - Exactly ONE activating click. We must NOT both dispatch a synthetic "click"
//    AND call .click() — that double-fired and made auto-advancing surveys skip
//    questions / jump to the final page.
//  - For a <label> the native .click() forwards to its radio (checks it + fires
//    change); for a <div> with inline onclick (submitCid) it runs that once.
function clickElement(el) {
  try {
    el.scrollIntoView({ block: "center", inline: "center" });
  } catch {}
  const r = el.getBoundingClientRect();
  const x = Math.max(1, Math.round(r.left + r.width / 2));
  const y = Math.max(1, Math.round(r.top + r.height / 2));
  const at = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
  };
  const seq = [
    ["pointerover", 0], ["mouseover", 0],
    ["pointermove", 0], ["mousemove", 0],
    ["pointerdown", 1], ["mousedown", 1],
    ["pointerup", 0], ["mouseup", 0],
  ];
  for (const [type, buttons] of seq) {
    const usePointer = type.startsWith("pointer") && typeof PointerEvent === "function";
    const Ctor = usePointer ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { ...at, buttons, pointerId: 1, isPrimary: true }));
  }
  if (typeof el.click === "function") {
    el.click(); // the single, authoritative click (forwards label -> radio)
  } else {
    el.dispatchEvent(new MouseEvent("click", { ...at, buttons: 0, detail: 1 }));
  }
}

async function getIdentity() {
  const res = await chrome.runtime.sendMessage({ type: "get-identity" });
  if (!res?.ok) throw new Error(res?.error || "no identity from server");
  return res.identity;
}

async function getDetails() {
  const res = await chrome.runtime.sendMessage({ type: "get-details" });
  if (!res?.ok) throw new Error(res?.error || "no details from server");
  return res.details;
}

// Clear an input's current value, firing events so the page registers it empty.
function clearInput(el) {
  el.focus();
  setNativeValue(el, ""); // native setter + input event
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Type a value into a text input by id.
//  - default: skip if the field already holds a value (e.g. the email the site
//    carried from page 1 — leave it).
//  - { overwrite: true }: replace whatever's there with `value` (used for the
//    name fields, which the page may pre-fill with a stale/"original" name that
//    must be updated to the stored identity so it matches the email).
async function fillField(id, value, { overwrite = false } = {}) {
  const el = document.getElementById(id);
  if (!el || value == null || value === "") return;
  const current = (el.value || "").trim();
  if (current === String(value).trim()) return; // already exactly right
  if (current && !overwrite) return; // populated and we're not overwriting
  await humanPause();
  if (current) clearInput(el); // remove the pre-filled "original" first
  await typeInto(el, String(value));
  log(`filled #${id} = ${value}${current ? ` (was "${current}")` : ""}`);
}

// Choose an <option> in a <select> by id. Selects can't be "typed"; we set the
// value via the native setter and fire input/change so the page's validation
// runs, bracketed by short human pauses.
async function selectField(id, value) {
  const sel = document.getElementById(id);
  if (!sel || value == null || value === "") return;
  if (sel.value) return; // already chosen
  const opt = [...sel.options].find((o) => o.value === String(value));
  if (!opt) {
    log(`#${id}: no option for "${value}"`);
    return;
  }
  await humanPause();
  sel.focus();
  setNativeValue(sel, opt.value); // native setter + input event
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  sel.blur?.();
  log(`selected #${id} = ${value}`);
}

// Gender is two clickable <div class="gbtn"> tiles (#male / #female) backed by
// a hidden <input id="genderid" name="gender">. Click the tile like a person;
// also set the hidden field as a fallback in case the page's handler is gated.
async function chooseGender(gender) {
  const female = gender === "F" || /female/i.test(gender || "");
  const tile = document.getElementById(female ? "female" : "male");
  await humanPause();
  if (tile) {
    clickElement(tile);
    log(`clicked gender ${female ? "Female" : "Male"}`);
  }
  const hidden = document.getElementById("genderid");
  if (hidden && !hidden.value) setNativeValue(hidden, female ? "F" : "M");
}

// --- STEP 1: e-mail sign-up ------------------------------------------
async function emailStep() {
  // The fuller registration page (STEP 2) also has an email input; let that
  // step own it so we don't fill+submit just the email there.
  if (document.getElementById("reg-container")) return false;
  const input = await waitFor('#user-email, input[type="email"][name="email"]', 8000);
  if (!input) return false; // not this page

  if (input.dataset.condNavFilled === "1") return true; // already handled
  input.dataset.condNavFilled = "1";

  let identity;
  try {
    identity = await getIdentity();
  } catch (e) {
    flag("could not get identity:", e.message, "— is the server running?");
    input.dataset.condNavFilled = ""; // allow a retry on the next run
    return true;
  }

  await humanPause(); // 1–5s before starting to type, as a person would
  await typeInto(input, identity.email);
  log(`typed email ${identity.email} (${identity.full_name})`);

  await humanPause(); // read-over pause between typing and clicking
  // Scope the Continue to the email's own box (.cta-box / #cid-main-container,
  // which contain BOTH the input and the button) so we click THIS form's button,
  // not some other .cid-btns on the page.
  const scope = input.closest(".cta-box, #cid-main-container") || document;
  const cont = findContinue(scope) || findContinue();
  if (!cont) {
    flag("email step: Continue control not found");
    return true;
  }
  clickElement(cont);
  log("clicked Continue");
  return true;
}

// --- STEP 2: full registration form ----------------------------------
// Email + first/last name come from the cached identity; everything else
// (address, zip, state, city, phone, DOB, gender) comes from /api/details.
async function registrationStep() {
  const root = await waitFor("#reg-container", 8000);
  if (!root) return false; // not this page
  if (root.dataset.condNavReg === "1") return true; // already handled this load
  root.dataset.condNavReg = "1";

  let identity, details;
  try {
    [identity, details] = await Promise.all([getIdentity(), getDetails()]);
  } catch (e) {
    flag("could not get identity/details:", e.message, "— is the server running?");
    root.dataset.condNavReg = ""; // allow a retry on the next run
    return true;
  }

  log("filling registration form for", identity.full_name);

  // Sanity check: if the page already carries an email (from step 1), it must be
  // THIS identity's email — otherwise the names we're about to type wouldn't
  // match it. Flag a mismatch so it's obvious (shouldn't happen now that the
  // identity is cached for the whole run).
  const emEl = document.getElementById("em");
  const carried = (emEl?.value || "").trim().toLowerCase();
  if (carried && carried !== (identity.email || "").toLowerCase()) {
    flag(`registration email "${carried}" != identity "${identity.email}" — names may not match`);
  }

  // Already-known person fields. Email + first/last name all come from the SAME
  // identity, and the server builds the email from the name, so they correspond.
  // Keep the carried email as-is, but FORCE the names to the stored identity so
  // a pre-filled "original" name gets replaced (and matches the email).
  await fillField("em", identity.email);
  await fillField("fn", identity.first_name, { overwrite: true });
  await fillField("ln", identity.last_name, { overwrite: true });

  // Server-supplied details.
  await fillField("ad", details.address1);
  await fillField("zp", details.zip);
  await selectField("state", details.state);
  await fillField("ct", details.city);
  await fillField("tl", details.phone); // 10 digits; the field auto-formats
  await selectField("dobmonth", details.dob?.month);
  await selectField("dobday", details.dob?.day);
  await selectField("dobyear", details.dob?.year);
  await chooseGender(details.gender);

  await humanPause(); // review pause before submitting
  // Submit is the specific #sub-btn; only if that's missing fall back to a
  // Continue control SCOPED to this form (never a button elsewhere on the page).
  const submit = document.getElementById("sub-btn") || findContinue(root);
  if (!submit) {
    flag("registration: submit (#sub-btn) not found");
    return true;
  }
  clickElement(submit);
  log("clicked Continue (registration submitted)");
  return true;
}

// --- STEP 3: generic single-select survey questions ------------------
// Survey pages render one or more questions, each shaped like:
//   <div class="SurveyQue ..."><span class="question">…?</span>
//     <div class="answers"><input type="radio" name="vag" value="own" id="Aid…">
//       <label for="Aid…"><span>Yes</span></label></div>
//     <div class="answers"><input type="radio" … value="rent"><label>No</label></div>
//   </div>
// ONE handler covers every such question. Pages may reveal questions one at a
// time or navigate per answer — the loop in surveyStep() handles both, and the
// per-block "answered" flag stops repeats.

// Optional answer overrides: when the question text matches `match`, pick the
// option whose label OR value matches `prefer`. Empty => answer at random.
// Add rules here as you learn which answers you want, e.g.:
//   { match: /home ?owner/i, prefer: /^yes$/i },
const ANSWER_RULES = [];

// Opt-out / decline answers: "Skip", "Skip Question", "Skip/No Call", "No
// thanks", "Prefer not to answer", etc. A NORMAL question must never land on
// these (we want real data); a CONSENT question deliberately picks one.
const SKIP_RE = /skip|no[\s,/-]*call|no[\s,/-]*thanks|not interested|decline|prefer not/i;

// Consent / lead-gen language found in a question's disclaimer. When present,
// selecting a "real" answer opts the user into marketing calls/texts, so we
// DECLINE (see declineOption). These often have NO .sponsored tag, so the text
// is the reliable signal.
const CONSENT_RE =
  /express(ly)?\s+(written\s+)?consent|affirmative\s+(express\s+)?consent|consent to (receive|be contacted|share)|provide my[^.]*consent|do not call registry|marketing[^.]*(calls|messages|consent)|autodialer/i;

// Read the VISIBLE options out of one question block. Options the survey has
// hidden (class "answers none" / display:none) aren't real choices and are
// dropped. Skip/opt-out options are KEPT but flagged, so chooseAnswer decides.
function readAnswerOptions(block) {
  const opts = [];
  for (const input of block.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
    const wrap = input.closest(".answers") || input.parentElement;
    if (wrap && (wrap.classList.contains("none") || !isVisible(wrap))) continue; // hidden
    const label = input.id
      ? block.querySelector(`label[for="${CSS.escape(input.id)}"]`)
      : input.closest("label");
    const text = (label?.textContent || input.value || "").trim();
    opts.push({
      input,
      value: input.value || "",
      label: text,
      clickTarget: label || input,
      isSkip: SKIP_RE.test(text) || SKIP_RE.test(input.value || ""),
    });
  }
  return opts;
}

// The question's visible text, with nested <style>/<script>/disclaimer markup
// stripped (sponsored questions embed all three inside .question).
function questionText(block) {
  const q = block.querySelector(".question");
  if (!q) return "";
  const clone = q.cloneNode(true);
  clone
    .querySelectorAll("style, script, .sponsored, [class*='disclaimer']")
    .forEach((n) => n.remove());
  return (clone.textContent || "").replace(/\s+/g, " ").trim();
}

// A consent / lead-gen question: a sponsored ad, or any question whose
// disclaimer opts you into marketing calls/texts when you pick a "real" answer.
// We decline these. Detected by the .sponsored tag, the "not required" / "sponsored
// ad" wording, or consent language in the disclaimer (CONSENT_RE).
function isConsentQuestion(block) {
  if (block.querySelector(".sponsored")) return true;
  const raw = block.querySelector(".question")?.textContent || "";
  const low = raw.toLowerCase();
  if (low.includes("sponsored ad") || low.includes("question is not required")) return true;
  return CONSENT_RE.test(raw);
}

// The "decline" answer for a consent question — worded differently each time
// ("No Call", "No, Thanks", "Skip", "Prefer not to answer", or a plain "No").
// Tried most-specific first so "No Call" wins over a bare "No".
function declineOption(options) {
  const tiers = [
    /no[\s,/-]*call/i,
    /no[\s,/-]*thanks/i,
    /\bskip\b/i,
    /prefer not/i,
    /not interested|decline/i,
    /^\s*no\b/i, // last resort: a plain "No" in a yes/no consent question
  ];
  for (const re of tiers) {
    const hit = options.find((o) => re.test(o.label) || re.test(o.value));
    if (hit) return hit;
  }
  return null;
}

// Decide which option to select for a single-select question.
function chooseAnswer(block, qText, options) {
  if (!options.length) return null;

  // Consent / lead-gen -> decline, so we never opt into marketing calls.
  if (isConsentQuestion(block)) {
    const decline = declineOption(options);
    if (decline) return decline;
    flag(`consent question with no decline option — "${qText.slice(0, 60)}"`);
    // fall through and answer normally rather than stalling
  }

  // Explicit per-question overrides.
  for (const rule of ANSWER_RULES) {
    if (rule.match.test(qText)) {
      const hit = options.find((o) => rule.prefer.test(o.label) || rule.prefer.test(o.value));
      if (hit) return hit;
    }
  }

  // Default: random among the REAL answers (never an opt-out/skip).
  const real = options.filter((o) => !o.isSkip);
  const pool = real.length ? real : options;
  return pool[Math.floor(Math.random() * pool.length)];
}

const trunc = (s, n = 90) => (s.length > n ? s.slice(0, n) + "…" : s);

// In-place-safe random shuffle (Fisher–Yates).
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// "Select" one option. The survey platform binds its "next question" handler to
// the CONTROL, not the visible label, and the radios are display:none — so we
// must target the right element per type:
//  - radio (single-select): the page does
//      $('.answers input[type=radio]').click(... getNextQuestion ...)
//    so click the RADIO INPUT directly (a label-forwarded click on a hidden
//    radio doesn't reliably fire it). One click == one advance.
//  - checkbox (multi-select): the page delegates
//      $(document).on('click', '.SurveyQue.multiple label.btnstyle', ...)
//    so click the LABEL.
function selectOption(opt) {
  if (opt.input.type === "checkbox") {
    clickElement(opt.clickTarget); // the styled label
  } else {
    opt.input.checked = true;
    opt.input.click(); // fires the radio's click handler -> getNextQuestion
  }
}

// Answer one question block. Returns true if it acted. Branches on single-
// vs multi-select (the latter = "Select all that apply", checkbox inputs).
async function answerSurveyQuestion(block) {
  if (block.dataset.condNavAnswered === "1") return false;
  const options = readAnswerOptions(block);
  if (!options.length) return false;
  block.dataset.condNavAnswered = "1";

  const qText = questionText(block);
  const isMulti =
    block.classList.contains("multiple") ||
    options.some((o) => o.input.type === "checkbox");

  if (isMulti) return answerMultiSelect(block, qText, options);
  return answerSingleSelect(block, qText, options);
}

async function answerSingleSelect(block, qText, options) {
  const choice = chooseAnswer(block, qText, options);
  if (!choice) return false;
  await humanPause(); // read the question before answering
  selectOption(choice);
  log(`survey: "${trunc(qText)}" -> "${choice.label}"`);
  return true;
}

// "Select all that apply": tick a RANDOM number of the real options (1..N),
// then click the Done/Submit control.
async function answerMultiSelect(block, qText, options) {
  // Pick from real answers only (never the "Prefer not to answer" opt-out).
  const pool = options.filter((o) => !o.isSkip);
  const choices = pool.length ? pool : options;
  const k = 1 + Math.floor(Math.random() * choices.length); // random count, ≥1
  const picked = shuffle(choices).slice(0, k);

  for (const opt of picked) {
    await humanPause();
    selectOption(opt);
  }
  log(`survey (multi): "${trunc(qText)}" -> ${picked.map((p) => p.label).join(", ")}`);

  // Submit the multi-select (Done/Submit). Auto-advancing ones won't have one.
  await humanPause();
  const submit = findMultiSubmit(block);
  if (submit) {
    clickElement(submit);
    log("survey (multi): submitted");
  } else {
    flag("multi-select: Done/Submit control not found");
  }
  return true;
}

// The Done/Submit control inside a multi-select block.
function findMultiSubmit(block) {
  const direct = block.querySelector(
    ".btnSubmit a, a[id^='btnSubmit'], [id^='btnSubmit'], button[type=submit]"
  );
  if (direct) return direct;
  for (const el of block.querySelectorAll("a, button, div")) {
    if (/^(done|submit|continue|next)$/i.test((el.textContent || "").trim())) return el;
  }
  return null;
}

async function surveyStep() {
  if (!document.querySelector(".SurveyQue")) return false; // not a survey page

  // The next visible, unanswered question that actually has options.
  const nextUnanswered = () =>
    [...document.querySelectorAll(".SurveyQue")].find(
      (b) =>
        b.dataset.condNavAnswered !== "1" && isVisible(b) && readAnswerOptions(b).length
    );

  let answered = 0;
  // The whole survey runs on ONE page (questions shown/hidden in place), so the
  // loop must cover every question that gets revealed — cap high (80+ exist).
  for (let i = 0; i < 150; i++) {
    // grab the current one, or briefly wait for the next to be revealed
    const block = nextUnanswered() || (await waitForCondition(nextUnanswered, 3000));
    if (!block) break; // no more questions appeared
    await answerSurveyQuestion(block);
    answered++;
    // No extra pause here: the per-question 1–5s interval is the pause INSIDE
    // answerSurveyQuestion (before the click), and the loop top waits for the
    // next question to be revealed.
  }
  if (!answered) {
    flag("survey page detected but no answerable question was found");
    return false;
  }

  // Some surveys need an explicit Continue/Next/Submit after the last answer
  // (auto-advancing ones simply won't have one — clicking nothing is fine).
  const next = findAdvanceButton();
  if (next) {
    await humanPause();
    clickElement(next);
    log("survey: clicked", (next.textContent || "advance").trim());
  }
  return true;
}

// A forward/submit control after answering survey questions. Strict to avoid
// clicking the wrong thing: only a VISIBLE .cid-btns tile, or a VISIBLE
// button/link/submit-input whose text is EXACTLY an advance word. Deliberately
// does NOT match arbitrary <div>/<span> text (too easy to hit a footer/label).
// Most surveys auto-advance on answer click, so this usually finds nothing.
function findAdvanceButton() {
  const tile = [...document.querySelectorAll(".cid-btns")].filter(isVisible)[0];
  if (tile) return tile;
  const re = /^(continue|next|submit|done|proceed)$/i;
  for (const el of document.querySelectorAll(
    "button, a, input[type=submit], input[type=button]"
  )) {
    const txt = (el.textContent || el.value || "").trim();
    if (re.test(txt) && isVisible(el)) return el;
  }
  return null;
}

// Tick a checkbox to CHECKED and notify the page, without the toggle risk of a
// real click (set state + dispatch input/change + a synthetic, non-toggling
// click so the page's "enable Continue" handler still fires).
function setChecked(input) {
  if (input.checked) return;
  input.checked = true;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// --- STEP 4: TCPA confirmation (the required lead-submit gate) ---------
// A summary page showing the registered details (readonly) with an "I Agree"
// checkbox (#leadid_tcpa_disclosure_b) and a Continue button (#tcpaSubBtn).
// Unlike the inline survey consent questions (which we decline), THIS gate is
// required to finish the funnel — so we agree and continue.
async function tcpaConfirmStep() {
  const submit = document.getElementById("tcpaSubBtn");
  if (!submit) return false;
  // #tcpaSubBtn exists in the DOM from page load but lives inside #TCPAStep,
  // which is display:none until the survey finishes. Don't submit early — wait
  // until the gate is actually shown.
  const wrap = document.getElementById("TCPAStep");
  if (wrap && !isVisible(wrap)) return false;
  if (submit.dataset.condNavDone === "1") return true;
  submit.dataset.condNavDone = "1";

  const agree =
    document.getElementById("leadid_tcpa_disclosure_b") ||
    document.querySelector("#confirmbox input[type=checkbox], input.cb[type=checkbox]");
  if (agree) {
    await humanPause();
    setChecked(agree);
    log("tcpa: checked I Agree");
  } else {
    flag("tcpa: 'I Agree' checkbox not found — clicking Continue anyway");
  }

  await humanPause();
  clickElement(submit); // its inline onclick runs survey.submit()
  log("tcpa: clicked Continue");
  return true;
}

// --- STEP 5: "email me my status?" CTA -> click "Yes!" ----------------
async function ctaYesStep() {
  const main = document.getElementById("cidmain");
  if (!main) return false;
  const yes =
    main.querySelector(".yes_btn") ||
    [...main.querySelectorAll("div, button, a")].find((el) =>
      /^yes!?$/i.test((el.textContent || "").trim())
    );
  if (!yes) {
    flag("cta (#cidmain): 'Yes!' button not found");
    return false;
  }
  if (main.dataset.condNavDone === "1") return true;
  main.dataset.condNavDone = "1";

  await humanPause();
  clickElement(yes); // inline onclick runs showEmPop()
  log("cta: clicked Yes!");
  return true;
}

// --- STEP 6: "reviewing progress" interstitial -> just wait -----------
// An animated progress screen ("REVIEWING PROGRESS" / "The reward is almost
// yours!") that finishes on its own and redirects to the reward URL. We must
// NOT interact with it — just recognize it so the loop waits and the page
// completes its own redirect.
function reviewingProgressStep() {
  if (!document.querySelector("#stepper2, .slider-stepper")) return false;
  log("reviewing progress — waiting for it to finish (it auto-redirects)");
  return true;
}

// Selector for every page anchor we know how to handle.
const FUNNEL_ANCHORS =
  "#reg-container, .SurveyQue, #tcpaSubBtn, #cidmain, #stepper2, .slider-stepper, #user-email, .cid-btns, input[type=email][name=email]";

// Is a funnel run active right now? We run on <all_urls>, so this gate keeps the
// automation from touching forms on unrelated sites the user happens to visit —
// it only acts between Start and Stop.
async function isSessionActive() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "is-active" });
    return !!res?.active;
  } catch {
    return false; // background asleep / not reachable -> stay inert
  }
}

// --- router -----------------------------------------------------------
async function main() {
  if (!(await isSessionActive())) return; // no run in progress — do nothing
  const topFrame = window === window.top;
  log("active on", location.href, topFrame ? "(top)" : "(frame)");

  // Wait ONCE for any known page anchor to render, then route to exactly one
  // step — so a survey page doesn't sit through the email/registration waits.
  const anchor = await waitForCondition(() => document.querySelector(FUNNEL_ANCHORS), 8000);
  if (!anchor) {
    // We run in EVERY frame (all_frames) on EVERY site (all_urls), so most
    // frames legitimately have no funnel anchor — only flag it on the top frame.
    if (topFrame) flag("no known funnel anchor on this page —", location.href);
    return;
  }

  // Single-purpose pages.
  if (document.querySelector("#stepper2, .slider-stepper")) return void reviewingProgressStep();
  if (document.getElementById("reg-container")) return void (await registrationStep());
  if (document.getElementById("cidmain")) return void (await ctaYesStep());

  // Survey funnel page: the survey questions AND the TCPA "confirm" gate live on
  // ONE page (shown/hidden in place — no navigation between questions). Run the
  // survey, then handle the TCPA gate once it becomes visible. A standalone TCPA
  // page (gate already visible, no survey) also flows through here.
  const hasSurvey = !!document.querySelector(".SurveyQue");
  const hasTcpa = !!document.getElementById("tcpaSubBtn");
  if (hasSurvey || hasTcpa) {
    if (hasSurvey) await surveyStep();
    // The TCPA gate (#TCPAStep) is display:none until the survey finishes.
    await waitForCondition(() => {
      const sub = document.getElementById("tcpaSubBtn");
      if (!sub) return null;
      const wrap = document.getElementById("TCPAStep");
      return !wrap || isVisible(wrap) ? sub : null;
    }, 15000);
    if (document.getElementById("tcpaSubBtn")) await tcpaConfirmStep();
    return;
  }

  if (document.querySelector('#user-email, input[type="email"][name="email"]')) {
    return void (await emailStep());
  }
  if (topFrame) flag("anchor matched but no step handled it —", location.href);
}

main();

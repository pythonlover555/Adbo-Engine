/* Service worker: relays popup <-> content-script messages and reflects
 * run state on the toolbar badge. Kept thin — all DOM work is in
 * content.js, all secrets/file I/O are on the local server. */

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req.type === "status") {
    chrome.action.setBadgeText({ text: req.running ? "ON" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  } else if (req.type === "notify") {
    // Surface match/stop events on the badge too.
    if (req.kind === "match") {
      chrome.action.setBadgeText({ text: "✓" });
      chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
    } else if (req.kind === "review") {
      chrome.action.setBadgeText({ text: "?" });
      chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    } else if (req.kind === "error" || req.kind === "warn") {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    }
  }
  sendResponse?.({ ok: true });
  return true;
});

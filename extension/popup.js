/* Popup: start/stop the loop in the active tab and show server health. */

const SERVER = "http://localhost:8791";

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(type) {
  const tab = await activeTab();
  if (!tab || !/startupschool\.org\/cofounder-matching/.test(tab.url || "")) {
    setSrv(false, "Open the Discover page first");
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    setSrv(false, "Reload the YC tab");
  }
}

function setSrv(ok, text) {
  document.getElementById("srvDot").className = "dot " + (ok ? "ok" : "bad");
  document.getElementById("srvText").textContent = text;
}

async function refreshHealth() {
  try {
    const r = await fetch(`${SERVER}/api/health`);
    const j = await r.json();
    setSrv(true, "ready");
    document.getElementById("matches").textContent = j.matches ?? "–";
    document.getElementById("regions").textContent = (j.allowed_regions || []).join(", ");
  } catch {
    setSrv(false, "not running");
  }
}

document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;
document.getElementById("start").addEventListener("click", () => send("start"));
document.getElementById("stop").addEventListener("click", () => send("stop"));
refreshHealth();

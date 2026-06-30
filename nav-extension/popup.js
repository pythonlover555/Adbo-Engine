/* Popup: start/stop the navigation loop and mirror the worker's status. */

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");

function setStatus(text) {
  if (text) statusEl.textContent = text;
}

startBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "start" });
  setStatus("Starting…");
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop" });
  setStatus("Stopping…");
});

// Live status pushed by the service worker while the popup is open.
chrome.runtime.onMessage.addListener((req) => {
  if (req.type === "status") setStatus(req.text);
});

// Reflect current run state when the popup opens.
chrome.runtime.sendMessage({ type: "get-state" }, (res) => {
  if (chrome.runtime.lastError) return; // worker asleep; leave default text
  if (res?.running) setStatus(`Running… (${res.retries} bounces so far)`);
});

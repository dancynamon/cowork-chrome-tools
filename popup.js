// Popup: ask the active Gmail tab's content script for a link, then copy it.

const statusEl = document.getElementById("status");

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", !!isError);
}

async function copyLink(type) {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !/^https:\/\/mail\.google\.com\//.test(tab.url || "")) {
    setStatus("Open a Gmail tab first.", true);
    return;
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    setStatus("Reload the Gmail tab and retry.", true);
    return;
  }

  if (!resp || !resp.link) {
    setStatus(
      type === "get-thread" ? "No thread open." : "No open message in view.",
      true
    );
    return;
  }

  try {
    await navigator.clipboard.writeText(resp.link);
    setStatus(type === "get-thread" ? "Thread link copied!" : "Message link copied!");
  } catch (e) {
    setStatus("Copy failed.", true);
  }
}

document.getElementById("msg").addEventListener("click", () => copyLink("get-message"));
document.getElementById("thread").addEventListener("click", () => copyLink("get-thread"));

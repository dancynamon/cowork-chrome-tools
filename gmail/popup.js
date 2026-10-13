// Gmail section of the combined popup: shown only on a Gmail tab. Asks the
// Gmail tab's content script for a link, then copies it.

(function () {
  const GMAIL = /^https:\/\/mail\.google\.com\//;
  const section = document.getElementById("gmail");
  const statusEl = document.getElementById("gmailStatus");

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "err" : "ok";
  }

  async function activeGmailTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && GMAIL.test(tab.url || "") ? tab : null;
  }

  async function copyLink(type) {
    const tab = await activeGmailTab();
    if (!tab) {
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
      setStatus(type === "get-thread" ? "No thread open." : "No open message in view.", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(resp.link);
      setStatus(type === "get-thread" ? "Thread link copied!" : "Message link copied!");
    } catch (e) {
      setStatus("Copy failed.", true);
    }
  }

  activeGmailTab().then((tab) => { section.hidden = !tab; });
  document.getElementById("gmailMsg").addEventListener("click", () => copyLink("get-message"));
  document.getElementById("gmailThread").addEventListener("click", () => copyLink("get-thread"));
})();

// Routes keyboard-shortcut commands to the Gmail tab's content script.

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !/^https:\/\/mail\.google\.com\//.test(tab.url || "")) return;

  const type =
    command === "copy-thread-link" ? "copy-thread" : "copy-message";
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    // Content script not loaded on this tab yet — ignore.
  }
});

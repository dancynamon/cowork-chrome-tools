// Routes keyboard-shortcut commands to the Gmail tab's content script.

// manifest command → message type gmail/content.js handles.
const GMAIL_COMMANDS = {
  "copy-message-link": "copy-message",
  "copy-thread-link": "copy-thread",
  "copy-cowork-prompt": "copy-prompt",
};

chrome.commands.onCommand.addListener(async (command) => {
  const type = GMAIL_COMMANDS[command];
  if (!type) return;
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab || !/^https:\/\/mail\.google\.com\//.test(tab.url || "")) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    // Content script not loaded on this tab yet — ignore.
  }
});

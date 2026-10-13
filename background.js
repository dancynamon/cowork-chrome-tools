// Cowork Tab Group Namer - background service worker (MV3)  v1.1.0
//
// Message types:
//   {type:'setGroupTitle', title, color}          from content script (page-context bridge)
//   {type:'getGroupTitle'}                        from content script - read-back for verification
//   {type:'setGroupTitleForTab', tabId, title, color}   from popup.js
//   {type:'getGroupTitleForTab', tabId}                 from popup.js
//
// chrome.tabGroups.update() is the ONLY Chrome API that changes the label shown
// in the tab strip without modifying page content. It is not exposed to page
// JavaScript, which is why this extension exists.

// Automatic site-based labeling lives in auto.js so this file stays about the
// explicit set/get protocol.
try { importScripts('auto.js'); } catch (e) { console.warn('auto.js not loaded:', e); }

const NO_GROUP = chrome.tabGroups ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1;

// An explicit rename (session or popup) outranks auto-labeling: forget that this
// group was ever auto-named so auto.js will not touch it again.
async function forgetAutoTitle(groupId) {
  try {
    const { autoTitles } = await chrome.storage.session.get({ autoTitles: {} });
    delete autoTitles[String(groupId)];
    await chrome.storage.session.set({ autoTitles });
  } catch (e) { /* storage.session unavailable - harmless */ }
}

function applyToGroup(groupId, title, color) {
  if (groupId === undefined || groupId === NO_GROUP) {
    return Promise.resolve({ ok: false, error: 'tab is not in a tab group' });
  }
  const props = {};
  if (title !== undefined && title !== null) props.title = String(title);
  if (color) props.color = color;

  return chrome.tabGroups.update(groupId, props)
    .then(async (g) => {
      await forgetAutoTitle(g.id);
      return { ok: true, groupId: g.id, title: g.title, color: g.color };
    })
    .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
}

function readGroup(groupId) {
  if (groupId === undefined || groupId === NO_GROUP) {
    return Promise.resolve({ ok: false, error: 'tab is not in a tab group' });
  }
  return chrome.tabGroups.get(groupId)
    .then((g) => ({ ok: true, groupId: g.id, title: g.title || '', color: g.color }))
    .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'setGroupTitle': {
      const tab = sender.tab;
      if (!tab) { sendResponse({ ok: false, error: 'no sender tab' }); return false; }
      applyToGroup(tab.groupId, msg.title, msg.color).then(sendResponse);
      return true;
    }
    case 'getGroupTitle': {
      const tab = sender.tab;
      if (!tab) { sendResponse({ ok: false, error: 'no sender tab' }); return false; }
      readGroup(tab.groupId).then(sendResponse);
      return true;
    }
    case 'setGroupTitleForTab': {
      chrome.tabs.get(msg.tabId)
        .then((t) => applyToGroup(t.groupId, msg.title, msg.color))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'getGroupTitleForTab': {
      chrome.tabs.get(msg.tabId)
        .then((t) => readGroup(t.groupId))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    default:
      return false;
  }
});

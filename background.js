// Cowork Tab Group Namer - background service worker (MV3)
// Version lives only in manifest.json (chrome.runtime.getManifest().version).
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

// Automatic site-based labeling lives in auto.js, and restoring a title after
// Claude in Chrome recreates its group in restore.js, so this file stays about
// the explicit set/get protocol.
try { importScripts('auto.js', 'restore.js'); } catch (e) { console.warn('auto.js/restore.js not loaded:', e); }

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

// Optional allowlist of sites whose pages may use the content-script bridge
// (storage.local 'allowlist', edited in the popup). Empty - the default - means
// any page may rename the group it is in, exactly as before. The popup path is
// never restricted: it is you clicking the toolbar.
//
// Pattern forms: "mail.google.com" (that host only) or "*.myshopify.com" (the
// domain and every subdomain). A pasted URL is reduced to its hostname.
function normalizePattern(pattern) {
  let p = String(pattern || '').trim().toLowerCase();
  if (!p) return '';
  const wild = p.startsWith('*.');
  if (wild) p = p.slice(2);
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(p)) {
    try { p = new URL(p).hostname; } catch (e) { return ''; }
  }
  p = p.replace(/[\/:].*$/, '').replace(/\.$/, '');
  return p ? (wild ? '*.' + p : p) : '';
}

function isHostAllowed(host, allowlist) {
  const list = (Array.isArray(allowlist) ? allowlist : []).map(normalizePattern).filter(Boolean);
  if (list.length === 0) return true;
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return list.some((p) => p.startsWith('*.')
    ? (h === p.slice(2) || h.endsWith('.' + p.slice(2)))
    : h === p);
}

async function checkSender(sender) {
  let allowlist = [];
  try { ({ allowlist } = await chrome.storage.local.get({ allowlist: [] })); } catch (e) { /* default */ }
  let host = '';
  try { host = new URL(sender.url || (sender.tab && sender.tab.url) || '').hostname; } catch (e) { /* none */ }
  return isHostAllowed(host, allowlist)
    ? null
    : { ok: false, error: 'site not in allowlist: ' + (host || '(unknown)') };
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
      if (typeof rememberExplicitTitle === 'function') await rememberExplicitTitle(g);
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
      checkSender(sender)
        .then((denied) => denied || applyToGroup(tab.groupId, msg.title, msg.color))
        .then(sendResponse);
      return true;
    }
    case 'getGroupTitle': {
      const tab = sender.tab;
      if (!tab) { sendResponse({ ok: false, error: 'no sender tab' }); return false; }
      checkSender(sender)
        .then((denied) => denied || readGroup(tab.groupId))
        .then(sendResponse);
      return true;
    }
    case 'setGroupTitleForTab': {
      // Popup-only: a message from a content script (sender.tab set) could
      // otherwise target any tab and bypass the allowlist.
      if (sender.tab) { sendResponse({ ok: false, error: 'popup-only message' }); return false; }
      chrome.tabs.get(msg.tabId)
        .then((t) => applyToGroup(t.groupId, msg.title, msg.color))
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'getGroupTitleForTab': {
      // Popup-only: a message from a content script (sender.tab set) could
      // otherwise target any tab and bypass the allowlist.
      if (sender.tab) { sendResponse({ ok: false, error: 'popup-only message' }); return false; }
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

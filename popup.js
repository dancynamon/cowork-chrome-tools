// Cowork Tab Group Namer - toolbar popup
// Renames the group containing the ACTIVE tab. Works on any tab, including
// pages where content scripts are blocked (chrome://, Web Store), because the
// popup talks to the background worker directly.

const titleEl  = document.getElementById('title');
const colorEl  = document.getElementById('color');
const applyEl  = document.getElementById('apply');
const statusEl = document.getElementById('status');

let activeTabId = null;
let activeTabUrl = '';

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { setStatus('No active tab.', 'err'); applyEl.disabled = true; return; }
  activeTabId = tab.id;
  activeTabUrl = tab.url || '';

  const res = await chrome.runtime.sendMessage({ type: 'getGroupTitleForTab', tabId: tab.id });
  if (!res || !res.ok) {
    setStatus(res && res.error ? res.error : 'unknown error', 'err');
    applyEl.disabled = true;
    return;
  }
  titleEl.value = res.title || '';
  titleEl.select();
  setStatus('groupId ' + res.groupId + ' (' + res.color + ')');
}

async function apply() {
  applyEl.disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: 'setGroupTitleForTab',
    tabId: activeTabId,
    title: titleEl.value,
    color: colorEl.value || undefined
  });
  applyEl.disabled = false;

  if (res && res.ok) {
    setStatus('Renamed to "' + res.title + '"', 'ok');
    setTimeout(() => window.close(), 600);
  } else {
    setStatus(res && res.error ? res.error : 'unknown error', 'err');
  }
}

const autoEl = document.getElementById('auto');

chrome.storage.local.get({ autoLabel: true }).then(({ autoLabel }) => {
  autoEl.checked = autoLabel;
});
autoEl.addEventListener('change', () => {
  chrome.storage.local.set({ autoLabel: autoEl.checked });
  setStatus(autoEl.checked ? 'Auto-naming on' : 'Auto-naming off', 'ok');
});

const restoreEl = document.getElementById('restore');

chrome.storage.local.get({ restoreTitle: false }).then(({ restoreTitle }) => {
  restoreEl.checked = restoreTitle;
});
restoreEl.addEventListener('change', () => {
  chrome.storage.local.set({ restoreTitle: restoreEl.checked });
  setStatus(restoreEl.checked ? 'Title restore on' : 'Title restore off', 'ok');
});

const allowEl = document.getElementById('allowlist');

function parseAllowlist(text) {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

chrome.storage.local.get({ allowlist: [] }).then(({ allowlist }) => {
  allowEl.value = (allowlist || []).join('\n');
  if (allowlist && allowlist.length) document.getElementById('allowBox').open = true;
});

document.getElementById('saveAllow').addEventListener('click', async () => {
  const allowlist = parseAllowlist(allowEl.value);
  await chrome.storage.local.set({ allowlist });
  allowEl.value = allowlist.join('\n');
  setStatus(allowlist.length ? 'Allowlist saved (' + allowlist.length + ' sites)' : 'Allowlist cleared - every site allowed', 'ok');
});

document.getElementById('addSite').addEventListener('click', () => {
  let host = '';
  try {
    const u = new URL(activeTabUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch (e) { /* not a web page */ }
  if (!host) { setStatus('Active tab is not a web page', 'err'); return; }
  const list = parseAllowlist(allowEl.value);
  if (!list.includes(host)) list.push(host);
  allowEl.value = list.join('\n');
  setStatus('Added ' + host + ' - click Save', '');
});

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

applyEl.addEventListener('click', apply);
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

init();

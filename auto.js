// Cowork Tab Group Namer - automatic labeling
//
// Why this exists: the extension cannot know the Cowork task name - no channel
// exposes it. But it CAN see what a group's tabs are, and "QBO" / "Shopify" /
// "Gmail" already tells Dan which chip is which without any session involvement.
//
// Rule: only ever replace a title that is empty, the extension default
// ("Claude"), or a label this module set itself. A name set by a Claude session
// or typed in the popup is authoritative and is never overwritten.

const SITE_MAP = [
  { match: /(^|\.)admin\.shopify\.com$|myshopify\.com$/, label: 'Shopify',  color: 'purple' },
  { match: /(^|\.)sellercentral\.amazon\.com$/,          label: 'Amazon',   color: 'orange' },
  { match: /(^|\.)qbo\.intuit\.com$|(^|\.)intuit\.com$/, label: 'QBO',      color: 'green'  },
  { match: /(^|\.)mail\.google\.com$/,                   label: 'Gmail',    color: 'grey'   },
  { match: /(^|\.)docs\.google\.com$/,                   label: 'Docs',     color: 'grey'   },
  { match: /71lbs\.com$/,                                label: '71lbs',    color: 'blue'   },
  { match: /(^|\.)ups\.com$/,                            label: 'UPS',      color: 'blue'   },
  { match: /(^|\.)fedex\.com$/,                          label: 'FedEx',    color: 'blue'   },
  { match: /gtzship\.com$|globaltranz\.com$/,            label: 'Freight',  color: 'blue'   },
  { match: /(^|\.)app\.hubspot\.com$/,                   label: 'HubSpot',  color: 'orange' },
  { match: /maytronics/,                                 label: 'Maytronics', color: 'cyan' }
];

const DEFAULT_TITLES = ['', 'Claude', '✅Claude', '✅ Claude'];

function labelForUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch (e) { return null; }

  for (const entry of SITE_MAP) {
    if (entry.match.test(host)) return { label: entry.label, color: entry.color };
  }
  // Fall back to the bare second-level domain: "brightermarine.com" -> "Brightermarine".
  const parts = host.replace(/^www\./, '').split('.');
  const base = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  if (!base) return null;
  return { label: base.charAt(0).toUpperCase() + base.slice(1), color: 'cyan' };
}

// True when auto-labeling may overwrite `current`: it is empty, a Claude in
// Chrome default, or exactly the label this module last wrote to the group.
function isReplaceableTitle(current, lastAutoTitle) {
  const title = current || '';
  return DEFAULT_TITLES.includes(title) || (lastAutoTitle !== undefined && lastAutoTitle === title);
}

// Pick the label for a group from its tabs' URLs: the site with the most tabs
// wins. Ties keep the current label (so the chip does not flip back and forth
// as tabs come and go), otherwise go to the site of the left-most tab.
function dominantLabel(urls, currentTitle) {
  const tally = new Map();
  urls.forEach((url, index) => {
    const guess = labelForUrl(url || '');
    if (!guess) return;
    const entry = tally.get(guess.label);
    if (entry) entry.count++;
    else tally.set(guess.label, { label: guess.label, color: guess.color, count: 1, first: index });
  });
  if (tally.size === 0) return null;

  const ranked = [...tally.values()].sort((a, b) => b.count - a.count || a.first - b.first);
  const best = ranked[0];
  const incumbent = tally.get(currentTitle);
  if (incumbent && incumbent.count >= best.count) return incumbent;
  return best;
}

async function isEnabled() {
  const { autoLabel } = await chrome.storage.local.get({ autoLabel: true });
  return autoLabel;
}

async function ourTitles() {
  const { autoTitles } = await chrome.storage.session.get({ autoTitles: {} });
  return autoTitles;
}

async function rememberTitle(groupId, title) {
  const map = await ourTitles();
  map[String(groupId)] = title;
  await chrome.storage.session.set({ autoTitles: map });
}

async function maybeLabelGroup(groupId) {
  if (groupId === undefined || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  // A remembered title (restore.js, opt-in) outranks a site guess.
  if (typeof maybeRestoreTitle === 'function' && await maybeRestoreTitle(groupId)) return;
  if (!(await isEnabled())) return;

  let group;
  try { group = await chrome.tabGroups.get(groupId); } catch (e) { return; }

  const current = group.title || '';
  const mine = await ourTitles();
  if (!isReplaceableTitle(current, mine[String(groupId)])) return; // a session or the popup named it

  const tabs = await chrome.tabs.query({ groupId });
  tabs.sort((a, b) => a.index - b.index);
  const pick = dominantLabel(tabs.map((t) => t.url || t.pendingUrl || ''), current);
  if (!pick || pick.label === current) return;

  try {
    await chrome.tabGroups.update(groupId, { title: pick.label, color: pick.color });
    await rememberTitle(groupId, pick.label);
  } catch (e) { /* group closed mid-flight */ }
}

// Coalesce bursts (a page load fires several onUpdated events, opening N tabs
// fires N) into one evaluation per group.
const AUTO_DEBOUNCE_MS = 400;
const pending = new Map();

function scheduleLabel(groupId) {
  if (groupId === undefined || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  clearTimeout(pending.get(groupId));
  pending.set(groupId, setTimeout(() => {
    pending.delete(groupId);
    maybeLabelGroup(groupId);
  }, AUTO_DEBOUNCE_MS));
}

chrome.tabGroups.onCreated.addListener((g) => scheduleLabel(g.id));
// Only a URL change or a tab joining a group can change the answer. Plain
// status/title/favicon churn (including a discarded tab reloading when you
// switch to it) is ignored, and tab activation is not listened to at all.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url !== undefined || info.groupId !== undefined) scheduleLabel(tab.groupId);
});
chrome.tabs.onAttached.addListener((tabId) => {
  chrome.tabs.get(tabId).then((t) => scheduleLabel(t.groupId)).catch(() => {});
});

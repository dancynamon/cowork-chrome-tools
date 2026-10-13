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
  if (!(await isEnabled())) return;

  let group;
  try { group = await chrome.tabGroups.get(groupId); } catch (e) { return; }

  const current = group.title || '';
  const mine = await ourTitles();
  const replaceable = DEFAULT_TITLES.includes(current) || mine[String(groupId)] === current;
  if (!replaceable) return; // a session or the popup named this group - leave it alone

  const tabs = await chrome.tabs.query({ groupId });
  for (const tab of tabs) {
    const guess = labelForUrl(tab.url || tab.pendingUrl || '');
    if (!guess) continue;
    if (guess.label === current) return;
    try {
      await chrome.tabGroups.update(groupId, { title: guess.label, color: guess.color });
      await rememberTitle(groupId, guess.label);
    } catch (e) { /* group closed mid-flight */ }
    return;
  }
}

chrome.tabGroups.onCreated.addListener((g) => maybeLabelGroup(g.id));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) maybeLabelGroup(tab.groupId);
});
chrome.tabs.onAttached.addListener((tabId) => {
  chrome.tabs.get(tabId).then((t) => maybeLabelGroup(t.groupId)).catch(() => {});
});

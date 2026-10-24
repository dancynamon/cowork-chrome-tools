// Cowork Tab Group Namer - put a group's name back when Claude in Chrome loses it
//
// On by default (storage.local 'restoreTitle', checkbox in the popup).
//
// When a Cowork session comes back to the browser, Claude in Chrome often
// makes a fresh tab group titled "Claude" (or "⌛Claude"), and the name the
// group had is gone. This module remembers the recent real names in each
// window - set by a session, typed in the popup, renamed in Chrome, or given by
// Claude in Chrome itself - and gives a NEW default-titled group in that window
// the most recent name whose group has since closed. A name whose group is
// still open is never copied, so a second, parallel group is not mislabeled.
//
// State lives in storage.session: it is per browser run, like window ids.

const MAX_RESTORES_PER_GROUP = 2;  // Claude in Chrome may re-title once more after we restore
const MAX_TITLES_PER_WINDOW = 5;

// Only a group explicitly titled "Claude" (any status emoji) is restored. A
// brand-new group is blank for a moment before Claude in Chrome gives it the
// session's own name; restoring into that blank would hand a new task the
// previous task's name.
function isRestoreTrigger(title) { return baseTitle(title) === 'Claude'; }

async function restoreEnabled() {
  try {
    const { restoreTitle } = await chrome.storage.local.get({ restoreTitle: true });
    return restoreTitle !== false;
  } catch (e) { return false; }
}

// storage.session read-modify-writes from overlapping events must not interleave.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// Remember `group`'s current name as the most recent one for its window.
// Default titles and this extension's own site labels are not names.
function rememberName(group) {
  if (!group || isDefaultTitle(group.title)) return Promise.resolve();
  return serialized(async () => {
    const { lastTitles, autoTitles } =
      await chrome.storage.session.get({ lastTitles: {}, autoTitles: {} });
    const title = baseTitle(group.title);
    if (autoTitles[String(group.id)] === title) return;

    const key = String(group.windowId);
    const list = (Array.isArray(lastTitles[key]) ? lastTitles[key] : [])
      .filter((r) => r.groupId !== group.id && r.title !== title); // one record per name
    list.unshift({ groupId: group.id, title, color: group.color });
    lastTitles[key] = list.slice(0, MAX_TITLES_PER_WINDOW);
    await chrome.storage.session.set({ lastTitles });
  }).catch(() => { /* storage.session unavailable */ });
}

// Called by background.js after a successful rename from a session or the popup.
function rememberExplicitTitle(group) { return rememberName(group); }

// Pure decision, separated for tests. Returns the record to restore, or null.
//   records   this window's remembered names, most recent first
//   restores  how often this group was already restored
//   aliveIds  Set of group ids that still exist
function pickRestore({ currentTitle, groupId, records, restores, aliveIds }) {
  if (!isRestoreTrigger(currentTitle) || !Array.isArray(records)) return null;
  if (restores > 0) {
    // Claude in Chrome reset a title we restored: put it back, but do not fight.
    if (restores >= MAX_RESTORES_PER_GROUP) return null;
    return records.find((r) => r.groupId === groupId) || null;
  }
  // Never hand out a name an open group already carries (stale duplicate records
  // used to stamp the same name on every new "Claude" group).
  const aliveTitles = new Set(records.filter((r) => aliveIds.has(r.groupId)).map((r) => r.title));
  return records.find((r) => r.groupId !== groupId && !aliveIds.has(r.groupId)
    && !aliveTitles.has(r.title)) || null;
}

const restoring = new Set(); // onUpdated and auto.js can both ask at once

// Returns true if it restored a title (callers then skip auto-labeling).
async function maybeRestoreTitle(groupId) {
  if (restoring.has(groupId) || !(await restoreEnabled())) return false;
  restoring.add(groupId);
  try { return await restoreGroup(groupId); } finally { restoring.delete(groupId); }
}

async function restoreGroup(groupId) {
  let group;
  try { group = await chrome.tabGroups.get(groupId); } catch (e) { return false; }
  if (!isRestoreTrigger(group.title)) return false;

  const { lastTitles, restoredGroups } =
    await chrome.storage.session.get({ lastTitles: {}, restoredGroups: {} });
  const records = lastTitles[String(group.windowId)];
  if (!Array.isArray(records) || records.length === 0) return false;

  const aliveIds = new Set();
  for (const r of records) {
    try { await chrome.tabGroups.get(r.groupId); aliveIds.add(r.groupId); } catch (e) { /* gone */ }
  }
  const restores = restoredGroups[String(groupId)] || 0;
  const record = pickRestore({ currentTitle: group.title, groupId, records, restores, aliveIds });
  if (!record) return false;

  try {
    const props = { title: splitStatus(group.title).prefix + record.title };
    if (record.color) props.color = record.color;
    await chrome.tabGroups.update(groupId, props);
  } catch (e) { return false; }

  await serialized(async () => {
    const s = await chrome.storage.session.get({ lastTitles: {}, restoredGroups: {} });
    s.restoredGroups[String(groupId)] = restores + 1;
    // The name now lives on this group; move its record here.
    const key = String(group.windowId);
    const list = (s.lastTitles[key] || []).filter((r) => r.groupId !== groupId
      && r.groupId !== record.groupId && r.title !== record.title);
    list.unshift({ ...record, groupId });
    s.lastTitles[key] = list.slice(0, MAX_TITLES_PER_WINDOW);
    await chrome.storage.session.set(s);
  });
  return true;
}

// A group titled "Claude" gets its name back; a group that gets a real name
// (from anyone) has it remembered. auto.js also calls maybeRestoreTitle first on
// onCreated, so a group created already titled is covered too.
chrome.tabGroups.onUpdated.addListener((g) => {
  if (isRestoreTrigger(g.title)) maybeRestoreTitle(g.id);
  else if (!isDefaultTitle(g.title)) rememberName(g);
});

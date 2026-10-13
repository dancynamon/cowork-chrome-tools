// Cowork Tab Group Namer - restore a title when Claude in Chrome recreates its group
//
// Off by default (storage.local 'restoreTitle', checkbox in the popup).
//
// Claude in Chrome sometimes throws its tab group away and makes a new one
// titled "Claude" mid-task, losing the name a session (or you, in the popup)
// gave it. With this on, the last explicitly set title in each window is
// remembered, and a NEW group in that window that comes up with a default title
// gets it back - but only once the group that carried that title is gone, so a
// second, parallel group is never mislabeled as the first.
//
// State lives in storage.session: it is per browser run, like window ids.

const MAX_RESTORES_PER_GROUP = 2; // Claude may set "Claude" once more after we restore

async function restoreEnabled() {
  try {
    const { restoreTitle } = await chrome.storage.local.get({ restoreTitle: false });
    return restoreTitle === true;
  } catch (e) { return false; }
}

// Called by background.js after a successful explicit rename.
async function rememberExplicitTitle(group) {
  if (!group || isDefaultTitle(group.title)) return;
  try {
    const { lastTitles } = await chrome.storage.session.get({ lastTitles: {} });
    lastTitles[String(group.windowId)] = { groupId: group.id, title: baseTitle(group.title), color: group.color };
    await chrome.storage.session.set({ lastTitles });
  } catch (e) { /* storage.session unavailable */ }
}

// Pure decision, separated for tests. `record` is the window's remembered
// title, `restores` how often this group was already restored, `oldGroupAlive`
// whether record.groupId still exists.
function shouldRestore({ currentTitle, groupId, record, restores, oldGroupAlive }) {
  if (!record || !isDefaultTitle(currentTitle)) return false;
  if (restores > 0) return restores < MAX_RESTORES_PER_GROUP; // Claude reset our restore
  return record.groupId !== groupId && !oldGroupAlive;
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

  const { lastTitles, restoredGroups } =
    await chrome.storage.session.get({ lastTitles: {}, restoredGroups: {} });
  const record = lastTitles[String(group.windowId)];
  const restores = restoredGroups[String(groupId)] || 0;

  let oldGroupAlive = false;
  if (record && record.groupId !== groupId) {
    try { await chrome.tabGroups.get(record.groupId); oldGroupAlive = true; } catch (e) { /* gone */ }
  }
  if (!shouldRestore({ currentTitle: group.title, groupId, record, restores, oldGroupAlive })) return false;

  try {
    const props = { title: splitStatus(group.title).prefix + record.title };
    if (record.color) props.color = record.color;
    await chrome.tabGroups.update(groupId, props);
  } catch (e) { return false; }

  restoredGroups[String(groupId)] = restores + 1;
  lastTitles[String(group.windowId)] = { ...record, groupId };
  await chrome.storage.session.set({ lastTitles, restoredGroups });
  return true;
}

// Claude in Chrome usually creates the group and then titles it "Claude"; catch
// that second step (auto.js handles onCreated and calls maybeRestoreTitle first).
chrome.tabGroups.onUpdated.addListener((g) => {
  if (isDefaultTitle(g.title)) maybeRestoreTitle(g.id);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, sendMessage, plain } = require('./chrome-mock');

test('maybeLabelGroup labels a "Claude" group by its dominant site', async () => {
  const { ctx, chrome } = loadBackground();
  const g = chrome._addGroup({ title: 'Claude' });
  chrome._addTab({ id: 1, groupId: g, url: 'https://mail.google.com/' });
  chrome._addTab({ id: 2, groupId: g, url: 'https://admin.shopify.com/a' });
  chrome._addTab({ id: 3, groupId: g, url: 'https://admin.shopify.com/b' });
  await ctx.maybeLabelGroup(g);
  assert.equal(chrome._groups.get(g).title, 'Shopify');
  assert.equal(chrome._groups.get(g).color, 'purple');
});

test('maybeLabelGroup handles "⌛Claude" and keeps the status emoji', async () => {
  const { ctx, chrome } = loadBackground();
  const g = chrome._addGroup({ title: '⌛Claude' });
  chrome._addTab({ id: 1, groupId: g, url: 'https://qbo.intuit.com/' });
  await ctx.maybeLabelGroup(g);
  assert.equal(chrome._groups.get(g).title, '⌛QBO');

  // Claude in Chrome flips the emoji to done: no rewrite, no churn.
  chrome._groups.get(g).title = '✅QBO';
  await ctx.maybeLabelGroup(g);
  assert.equal(chrome._groups.get(g).title, '✅QBO');
  assert.equal(chrome._updates.length, 1);
});

test('maybeLabelGroup never overwrites a session-set title', async () => {
  const { ctx, chrome } = loadBackground();
  const g = chrome._addGroup({ title: 'Claude' });
  chrome._addTab({ id: 1, groupId: g, url: 'https://admin.shopify.com/' });
  const res = await sendMessage(chrome, { type: 'setGroupTitle', title: 'Kiefer Pallet', color: 'blue' },
    { tab: { id: 1, groupId: g }, url: 'https://admin.shopify.com/' });
  assert.equal(res.ok, true);
  await ctx.maybeLabelGroup(g);
  assert.equal(chrome._groups.get(g).title, 'Kiefer Pallet');
});

test('maybeLabelGroup does nothing when the label is unchanged', async () => {
  const { ctx, chrome } = loadBackground();
  const g = chrome._addGroup({ title: '' });
  chrome._addTab({ id: 1, groupId: g, url: 'https://qbo.intuit.com/' });
  await ctx.maybeLabelGroup(g);
  await ctx.maybeLabelGroup(g);
  assert.equal(chrome._updates.length, 1);
});

test('auto-labeling off leaves the group alone', async () => {
  const { ctx, chrome } = loadBackground();
  await chrome.storage.local.set({ autoLabel: false });
  const g = chrome._addGroup({ title: 'Claude' });
  chrome._addTab({ id: 1, groupId: g, url: 'https://qbo.intuit.com/' });
  await ctx.maybeLabelGroup(g);
  assert.equal(chrome._groups.get(g).title, 'Claude');
});

test('setGroupTitle reply matches the "OK: groupId=... title=..." contract fields', async () => {
  const { chrome } = loadBackground();
  const g = chrome._addGroup();
  const res = await sendMessage(chrome, { type: 'setGroupTitle', title: 'Box Prices' },
    { tab: { id: 1, groupId: g }, url: 'https://example.com/' });
  assert.deepEqual(plain(res), { ok: true, groupId: g, title: 'Box Prices', color: 'grey' });
});

test('allowlist: empty allows every site (default)', async () => {
  const { ctx } = loadBackground();
  assert.equal(ctx.isHostAllowed('anything.example', []), true);
  assert.equal(ctx.isHostAllowed('anything.example', undefined), true);
});

test('allowlist: exact and wildcard patterns', () => {
  const { ctx } = loadBackground();
  const list = ['mail.google.com', '*.myshopify.com', 'https://app.71lbs.com/labels', '  QBO.Intuit.com '];
  assert.equal(ctx.isHostAllowed('mail.google.com', list), true);
  assert.equal(ctx.isHostAllowed('docs.google.com', list), false);
  assert.equal(ctx.isHostAllowed('aquamentor.myshopify.com', list), true);
  assert.equal(ctx.isHostAllowed('myshopify.com', list), true);
  assert.equal(ctx.isHostAllowed('evilmyshopify.com', list), false);
  assert.equal(ctx.isHostAllowed('app.71lbs.com', list), true);
  assert.equal(ctx.isHostAllowed('qbo.intuit.com', list), true);
  assert.equal(ctx.isHostAllowed('', list), false);
});

test('allowlist: a page outside it cannot set or read the group title', async () => {
  const { chrome } = loadBackground();
  await chrome.storage.local.set({ allowlist: ['*.myshopify.com'] });
  const g = chrome._addGroup({ title: 'Secret Task' });
  const sender = { tab: { id: 1, groupId: g }, url: 'https://evil.example/' };

  const set = await sendMessage(chrome, { type: 'setGroupTitle', title: 'pwned' }, sender);
  assert.deepEqual(plain(set), { ok: false, error: 'site not in allowlist: evil.example' });
  const get = await sendMessage(chrome, { type: 'getGroupTitle' }, sender);
  assert.equal(get.ok, false);
  assert.equal(chrome._groups.get(g).title, 'Secret Task');

  const ok = await sendMessage(chrome, { type: 'setGroupTitle', title: 'Shop work' },
    { tab: { id: 2, groupId: g }, url: 'https://aquamentor.myshopify.com/admin' });
  assert.equal(ok.ok, true);
});

test('popup-only messages are refused from content scripts, allowed from the popup', async () => {
  const { chrome } = loadBackground();
  await chrome.storage.local.set({ allowlist: ['mail.google.com'] });
  const g = chrome._addGroup({ title: 'Claude' });
  chrome._addTab({ id: 7, groupId: g, url: 'https://mail.google.com/' });

  const fromPage = await sendMessage(chrome, { type: 'setGroupTitleForTab', tabId: 7, title: 'x' },
    { tab: { id: 9, groupId: -1 }, url: 'https://evil.example/' });
  assert.equal(fromPage.ok, false);

  const fromPopup = await sendMessage(chrome, { type: 'setGroupTitleForTab', tabId: 7, title: 'Inbox' }, {});
  assert.equal(fromPopup.ok, true);
  assert.equal(chrome._groups.get(g).title, 'Inbox');
});

test('pickRestore decision table', () => {
  const { ctx } = loadBackground();
  const kiefer = { groupId: 1, title: 'Kiefer Pallet', color: 'blue' };
  const boxes = { groupId: 3, title: 'Box Prices', color: 'green' };
  const base = { currentTitle: '⌛Claude', groupId: 2, records: [kiefer], restores: 0, aliveIds: new Set() };
  assert.equal(ctx.pickRestore(base).title, 'Kiefer Pallet');
  assert.equal(ctx.pickRestore({ ...base, records: undefined }), null);
  assert.equal(ctx.pickRestore({ ...base, currentTitle: 'Shopify' }), null);
  assert.equal(ctx.pickRestore({ ...base, currentTitle: '' }), null);              // blank while being created
  assert.equal(ctx.pickRestore({ ...base, aliveIds: new Set([1]) }), null);        // parallel group
  assert.equal(ctx.pickRestore({ ...base, groupId: 1 }), null);                     // same group, never restored
  // Most recent name whose group is gone wins; open groups are skipped.
  assert.equal(ctx.pickRestore({ ...base, records: [boxes, kiefer], aliveIds: new Set([3]) }).title, 'Kiefer Pallet');
  assert.equal(ctx.pickRestore({ ...base, records: [boxes, kiefer] }).title, 'Box Prices');
  // Claude in Chrome reset a group we restored: once more, then stop.
  const restored = { ...kiefer, groupId: 2 };
  assert.equal(ctx.pickRestore({ ...base, records: [restored], restores: 1 }).title, 'Kiefer Pallet');
  assert.equal(ctx.pickRestore({ ...base, records: [restored], restores: 2 }), null);
});

test('pickRestore: stale duplicate of a name an open group carries is skipped', () => {
  const { ctx } = loadBackground();
  const live = { groupId: 5, title: 'Big Blue Collection', color: 'purple' };
  const stale = { groupId: 4, title: 'Big Blue Collection', color: 'purple' };
  const older = { groupId: 3, title: 'Box Prices', color: 'green' };
  const r = ctx.pickRestore({ currentTitle: 'Claude', groupId: 9, records: [live, stale, older],
    restores: 0, aliveIds: new Set([5]) });
  assert.equal(r.title, 'Box Prices');
});

test('restore (on by default): a new "⌛Claude" group gets the session name back', async () => {
  const { ctx, chrome } = loadBackground();
  const old = chrome._addGroup({ windowId: 5, title: 'Claude' });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Kiefer Pallet', color: 'blue' },
    { tab: { id: 1, groupId: old }, url: 'https://example.com/' });
  chrome._retitle(old, '⌛Kiefer Pallet'); // Claude in Chrome adds its status emoji
  await chrome._settle();

  chrome._removeGroup(old);
  const fresh = chrome._addGroup({ windowId: 5, title: '⌛Claude' });
  chrome._addTab({ id: 2, groupId: fresh, url: 'https://admin.shopify.com/' });
  await ctx.maybeLabelGroup(fresh);
  assert.equal(chrome._groups.get(fresh).title, '⌛Kiefer Pallet');
  assert.equal(chrome._groups.get(fresh).color, 'blue');

  // A group in another window is not affected; it gets the site label.
  const other = chrome._addGroup({ windowId: 6, title: 'Claude' });
  chrome._addTab({ id: 3, groupId: other, url: 'https://admin.shopify.com/' });
  await ctx.maybeLabelGroup(other);
  assert.equal(chrome._groups.get(other).title, 'Shopify');
});

test('restore: names Claude in Chrome itself gave the group are remembered too', async () => {
  const { chrome } = loadBackground();
  const old = chrome._addGroup({ windowId: 5, title: '' });
  chrome._retitle(old, '⌛Cowork Tab Group Namer'); // session title from Claude in Chrome
  await chrome._settle();
  chrome._removeGroup(old);

  const fresh = chrome._addGroup({ windowId: 5, title: '' });
  chrome._retitle(fresh, '⌛Claude');
  await chrome._settle();
  assert.equal(chrome._groups.get(fresh).title, '⌛Cowork Tab Group Namer');
});

test('restore: a new blank group is left for Claude in Chrome to name, not restored', async () => {
  const { ctx, chrome } = loadBackground();
  const old = chrome._addGroup({ windowId: 5, title: '' });
  chrome._retitle(old, '⌛Task A');
  await chrome._settle();
  chrome._removeGroup(old);

  const fresh = chrome._addGroup({ windowId: 5, title: '' });
  chrome._addTab({ id: 1, groupId: fresh, url: 'https://example.com/' });
  chrome._retitle(fresh, '');
  await chrome._settle();
  assert.equal(chrome._groups.get(fresh).title, '');
  chrome._retitle(fresh, '⌛Task B'); // Claude in Chrome names the new session's group
  await ctx.maybeLabelGroup(fresh);
  await chrome._settle();
  assert.equal(chrome._groups.get(fresh).title, '⌛Task B');
});

test('restore: site labels are not remembered as names', async () => {
  const { ctx, chrome } = loadBackground();
  const old = chrome._addGroup({ windowId: 5, title: 'Claude' });
  chrome._addTab({ id: 1, groupId: old, url: 'https://qbo.intuit.com/' });
  await ctx.maybeLabelGroup(old);
  await chrome._settle();
  assert.equal(chrome._groups.get(old).title, 'QBO');
  chrome._removeGroup(old);

  const fresh = chrome._addGroup({ windowId: 5, title: 'Claude' });
  assert.equal(await ctx.maybeRestoreTitle(fresh), false);
});

test('restore: can be turned off, and never copies a name whose group is still open', async () => {
  const { ctx, chrome } = loadBackground();
  await chrome.storage.local.set({ restoreTitle: false });
  const old = chrome._addGroup({ windowId: 5 });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Kiefer Pallet' },
    { tab: { id: 1, groupId: old }, url: 'https://example.com/' });
  await chrome._settle();
  chrome._removeGroup(old);
  const fresh = chrome._addGroup({ windowId: 5, title: 'Claude' });
  assert.equal(await ctx.maybeRestoreTitle(fresh), false); // disabled

  await chrome.storage.local.set({ restoreTitle: true });
  const named = chrome._addGroup({ windowId: 7 });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Box Prices' },
    { tab: { id: 2, groupId: named }, url: 'https://example.com/' });
  await chrome._settle();
  const parallel = chrome._addGroup({ windowId: 7, title: 'Claude' });
  assert.equal(await ctx.maybeRestoreTitle(parallel), false);
  assert.equal(chrome._groups.get(parallel).title, 'Claude');
});

test('restore: two "Claude" groups created at once do not both get the same name', async () => {
  const { ctx, chrome } = loadBackground();
  const old = chrome._addGroup({ windowId: 5 });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Big Blue Collection' },
    { tab: { id: 1, groupId: old }, url: 'https://example.com/' });
  await chrome._settle();
  chrome._removeGroup(old);

  const a = chrome._addGroup({ windowId: 5, title: 'Claude' });
  const b = chrome._addGroup({ windowId: 5, title: 'Claude' });
  const results = await Promise.all([ctx.maybeRestoreTitle(a), ctx.maybeRestoreTitle(b)]);
  await chrome._settle();
  assert.deepEqual(results.sort(), [false, true]);
  const titles = [chrome._groups.get(a).title, chrome._groups.get(b).title].sort();
  assert.deepEqual(titles, ['Big Blue Collection', 'Claude']);
});

test('restore: a name an open group in another window carries is not copied', async () => {
  const { ctx, chrome } = loadBackground();
  const old = chrome._addGroup({ windowId: 5 });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Big Blue Collection' },
    { tab: { id: 1, groupId: old }, url: 'https://example.com/' });
  await chrome._settle();
  chrome._removeGroup(old);
  const elsewhere = chrome._addGroup({ windowId: 6, title: '' });
  chrome._retitle(elsewhere, '⌛Big Blue Collection'); // the session reopened in window 6
  await chrome._settle();

  const fresh = chrome._addGroup({ windowId: 5, title: 'Claude' });
  assert.equal(await ctx.maybeRestoreTitle(fresh), false);
  assert.equal(chrome._groups.get(fresh).title, 'Claude');
});

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

test('shouldRestore decision table', () => {
  const { ctx } = loadBackground();
  const rec = { groupId: 1, title: 'Kiefer Pallet', color: 'blue' };
  const base = { currentTitle: 'Claude', groupId: 2, record: rec, restores: 0, oldGroupAlive: false };
  assert.equal(ctx.shouldRestore(base), true);
  assert.equal(ctx.shouldRestore({ ...base, record: undefined }), false);
  assert.equal(ctx.shouldRestore({ ...base, currentTitle: 'Shopify' }), false);
  assert.equal(ctx.shouldRestore({ ...base, oldGroupAlive: true }), false); // parallel group
  assert.equal(ctx.shouldRestore({ ...base, groupId: 1 }), false);          // same group reset
  assert.equal(ctx.shouldRestore({ ...base, restores: 1 }), true);          // Claude re-titled once more
  assert.equal(ctx.shouldRestore({ ...base, restores: 2 }), false);         // stop fighting
});

test('restore: recreated "Claude" group gets the last session title back (when enabled)', async () => {
  const { ctx, chrome } = loadBackground();
  await chrome.storage.local.set({ restoreTitle: true });
  const old = chrome._addGroup({ windowId: 5, title: 'Claude' });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Kiefer Pallet', color: 'blue' },
    { tab: { id: 1, groupId: old }, url: 'https://example.com/' });

  chrome._removeGroup(old);
  const fresh = chrome._addGroup({ windowId: 5, title: 'Claude' });
  chrome._addTab({ id: 2, groupId: fresh, url: 'https://admin.shopify.com/' });
  await ctx.maybeLabelGroup(fresh);
  assert.equal(chrome._groups.get(fresh).title, 'Kiefer Pallet');
  assert.equal(chrome._groups.get(fresh).color, 'blue');

  // A group in another window is not affected; it gets the site label.
  const other = chrome._addGroup({ windowId: 6, title: 'Claude' });
  chrome._addTab({ id: 3, groupId: other, url: 'https://admin.shopify.com/' });
  await ctx.maybeLabelGroup(other);
  assert.equal(chrome._groups.get(other).title, 'Shopify');
});

test('restore: off by default, and never applied while the named group still exists', async () => {
  const { ctx, chrome } = loadBackground();
  const old = chrome._addGroup({ windowId: 5 });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Kiefer Pallet' },
    { tab: { id: 1, groupId: old }, url: 'https://example.com/' });
  chrome._removeGroup(old);
  const fresh = chrome._addGroup({ windowId: 5, title: 'Claude' });
  assert.equal(await ctx.maybeRestoreTitle(fresh), false); // disabled

  await chrome.storage.local.set({ restoreTitle: true });
  const named = chrome._addGroup({ windowId: 7 });
  await sendMessage(chrome, { type: 'setGroupTitle', title: 'Box Prices' },
    { tab: { id: 2, groupId: named }, url: 'https://example.com/' });
  const parallel = chrome._addGroup({ windowId: 7, title: 'Claude' });
  assert.equal(await ctx.maybeRestoreTitle(parallel), false);
  assert.equal(chrome._groups.get(parallel).title, 'Claude');
});

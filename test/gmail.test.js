'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBackground, plain, ROOT } = require('./chrome-mock');

test('Gmail shortcuts are routed to the active Gmail tab', async () => {
  const { chrome } = loadBackground();
  chrome._addTab({ id: 1, url: 'https://mail.google.com/mail/u/0/#inbox', active: true });
  await Promise.all(chrome.commands.onCommand.dispatch('copy-message-link'));
  await Promise.all(chrome.commands.onCommand.dispatch('copy-thread-link'));
  assert.deepEqual(plain(chrome._sent), [
    { tabId: 1, msg: { type: 'copy-message' } },
    { tabId: 1, msg: { type: 'copy-thread' } }
  ]);
});

test('Gmail shortcuts do nothing on a non-Gmail tab', async () => {
  const { chrome } = loadBackground();
  chrome._addTab({ id: 1, url: 'https://qbo.intuit.com/', active: true });
  await Promise.all(chrome.commands.onCommand.dispatch('copy-message-link'));
  assert.equal(chrome._sent.length, 0);
});

test('manifest: shortcuts fit Chrome\'s limit of 4 and every script file exists', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const keyed = Object.values(m.commands).filter((c) => c.suggested_key);
  assert.ok(keyed.length <= 4, 'too many suggested shortcuts');
  const files = [m.background.service_worker, 'auto.js', 'restore.js', 'gmail/background.js', m.action.default_popup];
  for (const cs of m.content_scripts) files.push(...cs.js, ...(cs.css || []));
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

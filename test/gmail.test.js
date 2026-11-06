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
  await Promise.all(chrome.commands.onCommand.dispatch('copy-cowork-prompt'));
  assert.deepEqual(plain(chrome._sent), [
    { tabId: 1, msg: { type: 'copy-message' } },
    { tabId: 1, msg: { type: 'copy-thread' } },
    { tabId: 1, msg: { type: 'copy-prompt' } }
  ]);
});

test('an unknown command is not sent to Gmail as a message-link copy', async () => {
  const { chrome } = loadBackground();
  chrome._addTab({ id: 1, url: 'https://mail.google.com/mail/u/0/#inbox', active: true });
  await Promise.all(chrome.commands.onCommand.dispatch('something-else'));
  assert.equal(chrome._sent.length, 0);
});

test('every manifest Gmail command has a route, and the content script handles each type', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const bg = fs.readFileSync(path.join(ROOT, 'gmail/background.js'), 'utf8');
  const cs = fs.readFileSync(path.join(ROOT, 'gmail/content.js'), 'utf8');
  const popup = fs.readFileSync(path.join(ROOT, 'gmail/popup.js'), 'utf8');
  const routes = Object.fromEntries([...bg.matchAll(/"([\w-]+)":\s*"([\w-]+)"/g)].map((x) => [x[1], x[2]]));
  for (const cmd of Object.keys(m.commands).filter((c) => c !== '_execute_action')) {
    assert.ok(routes[cmd], 'no route for ' + cmd);
  }
  const types = [...Object.values(routes),
    ...[...popup.matchAll(/type: "([\w-]+)"|copyLink\("([\w-]+)"\)/g)].map((x) => x[1] || x[2])];
  for (const t of types) assert.ok(cs.includes(`req.type === "${t}"`), 'content.js ignores ' + t);
});

test('Gmail shortcuts do nothing on a non-Gmail tab', async () => {
  const { chrome } = loadBackground();
  chrome._addTab({ id: 1, url: 'https://qbo.intuit.com/', active: true });
  await Promise.all(chrome.commands.onCommand.dispatch('copy-message-link'));
  assert.equal(chrome._sent.length, 0);
});

test('manifest: valid JSON, shortcuts fit Chrome\'s limit of 4, every referenced file exists', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const keyed = Object.values(m.commands).filter((c) => c.suggested_key);
  assert.ok(keyed.length <= 4, 'too many suggested shortcuts');
  const files = [m.background.service_worker, m.action.default_popup];
  // importScripts() targets of the worker, and <script src> of the popup.
  const worker = fs.readFileSync(path.join(ROOT, m.background.service_worker), 'utf8');
  for (const call of worker.matchAll(/importScripts\(([^)]*)\)/g)) {
    files.push(...[...call[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  const popup = fs.readFileSync(path.join(ROOT, m.action.default_popup), 'utf8');
  files.push(...[...popup.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]));
  for (const cs of m.content_scripts) files.push(...cs.js, ...(cs.css || []));
  assert.ok(files.includes('allowlist-defaults.js') && files.includes('gmail/parsers.js'));
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('manifest: no host_permissions; the Gmail parsers load before the Gmail content script', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(m.host_permissions, undefined);
  const gmail = m.content_scripts.find((cs) => cs.js.includes('gmail/content.js'));
  assert.deepEqual(gmail.js, ['gmail/parsers.js', 'gmail/content.js']);
});

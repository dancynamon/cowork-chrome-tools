# CLAUDE.md

Cowork Chrome Tools: one MV3 Chrome extension, loaded unpacked from Dan's local
clone (~/code/cowork-chrome-tools). Two features:

1. Tab group namer: `background.js` (explicit set/get protocol), `content.js`
   (page-attribute bridge), `auto.js` (site-based labels), `restore.js`
   (puts a name back when Claude in Chrome recreates a group titled "Claude"),
   `popup.html`/`popup.js`.
2. Gmail link copier: everything under `gmail/`.

## Rules
- Never touch `document.title`. `chrome.tabGroups.update()` is the only label we write.
- Page bridge contract is fixed (callers live in Dan's Cowork preferences and the
  chrome-tab-group-label skill): set `data-cowork-group-color` BEFORE
  `data-cowork-group-title`; title is the trigger; result is read from
  `data-cowork-group-result` as `OK: groupId=... title=...`. Do not rename these.
- Version lives only in `manifest.json`. Bump the patch version on every behavior change.
- Run `npm test` (node --test, no deps; mock in `test/chrome-mock.js`) before every
  commit. Add a test for every bug fixed.
- No build step, no bundler, no npm runtime deps. Files load as-is.

## Deploy
After a push, Dan pulls in ~/code/cowork-chrome-tools and hits reload on
chrome://extensions. Reload clears storage.session (remembered group names).

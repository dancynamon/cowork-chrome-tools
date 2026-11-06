# Cowork Chrome Tools

One Chrome extension, two Claude Cowork helpers:

1. **Tab group namer** — everything below this list.
2. **Gmail link copier** — 🔗 copies a Gmail permalink, ✨ copies a structured
   Cowork prompt (subject, API thread/message IDs, sender, money, full thread)
   from any message or inbox row. `Alt+Shift+C` copies the message link,
   `Alt+Shift+T` the thread link, `Alt+Shift+P` the Cowork prompt for the
   open thread, and the toolbar popup shows all three buttons when you are
   on Gmail. Details: [gmail/README.md](gmail/README.md).

Until 2.0.0 these were two extensions, "Cowork Tab Group Namer" and "Gmail
Message Link Copier". Remove both old copies when you load this one.

## Tab group namer

Renames the **Chrome tab group chip** (the colored pill left of the tabs, currently
hardcoded to "Claude" by the Claude in Chrome extension) to the current task name.

Page titles are never touched.

## Why this exists

Chrome's tab strip renders `document.title` for individual tabs, and there is no
`chrome.tabs.setTitle`. The only writable label that is not page content is the
**tab group** title, set via `chrome.tabGroups.update()`. That API is available only
to extensions, not to page JavaScript, and no Claude in Chrome / Control Chrome MCP
tool currently exposes it. This extension exposes it.

## Architecture

```
Claude session
   └─ javascript_tool  (runs in PAGE context)
        └─ sets  <html data-cowork-group-title="Kiefer Pallet">
             └─ content.js  (ISOLATED world, MutationObserver on that attribute)
                  └─ chrome.runtime.sendMessage
                       └─ background.js  →  chrome.tabGroups.update(tab.groupId, {title, color})
                            └─ result written back to <html data-cowork-group-result="...">
```

No native messaging host, no local server, no polling, no network. A plain string
attribute on the shared DOM is the transport, which avoids cross-world object
cloning problems with `CustomEvent.detail`. Since 1.3.0 a `cowork-group-result`
DOM event also fires right after the result attribute is written, so callers can
await it instead of sleeping.

The version lives only in `manifest.json`; the popup shows it at the bottom.

## Automatic naming

The extension cannot know the Cowork task name — no channel exposes it — but it
can see what the group's tabs are. So any group whose title is empty or the
default "Claude" gets named after the **dominant site** in it (the site with the
most tabs; ties keep the current label, otherwise the left-most tab wins):
**Shopify** (purple),
**QBO** (green), **Gmail** (grey), **71lbs / UPS / FedEx / Freight** (blue),
**Amazon** (orange), **HubSpot** (orange), anything else the bare domain (cyan).

A name set by a Claude session or typed in the popup always wins and is never
overwritten. Toggle the whole behavior with the checkbox in the popup.

Re-evaluation is debounced (400 ms per group) and only happens when a tab's URL
changes or a tab joins a group, so switching tabs or a discarded tab reloading
never relabels anything.

Edit the `SITE_MAP` table at the top of `auto.js` to add your own sites.

## Manual use

Click the extension's toolbar icon, or press **Cmd+Shift+G**, to open a popup that
renames the group containing the active tab. The field is pre-filled with the
current group name. Enter applies.

This path works even where content scripts are blocked (`chrome://`, Web Store)
and regardless of which Claude surface you are using, because the popup talks to
the background worker directly. It is the only option that works for **Claude in
Chrome sidebar sessions**, which do not read Cowork preferences.

## Read-back

```js
document.documentElement.setAttribute('data-cowork-group-query', '1');
await new Promise(r => setTimeout(r, 400));
document.documentElement.getAttribute('data-cowork-group-result');
// OK: groupId=1358198707 title="Tab Group Test" color=blue
```

## Install (Developer Mode)

1. Copy this folder somewhere permanent (do not leave it in Downloads; Chrome loads
   it from this path on every launch).
2. Open `chrome://extensions`
3. Toggle **Developer mode** on, top right.
4. Click **Load unpacked** and select this folder (`~/code/cowork-chrome-tools`;
   in the file picker press Cmd+Shift+G and paste the path).
5. Confirm "Cowork Chrome Tools" is enabled, and reload any open Gmail tabs.

Runs alongside Claude in Chrome. It does not modify or conflict with that extension;
it only calls `tabGroups.update` on whatever group a tab already belongs to.

## Usage from a Cowork session

Execute in any tab that is inside the Cowork tab group. The original snippet
keeps working unchanged:

```js
document.documentElement.setAttribute('data-cowork-group-color', 'blue');
document.documentElement.setAttribute('data-cowork-group-title', 'Kiefer Pallet');
await new Promise(r => setTimeout(r, 400));
document.documentElement.getAttribute('data-cowork-group-result');
```

Faster (1.3.0+): wait for the `cowork-group-result` event instead of a fixed
sleep. The timeout keeps it safe on an older install or a blocked page:

```js
const root = document.documentElement;
const done = new Promise(r => document.addEventListener('cowork-group-result',
  () => r(root.getAttribute('data-cowork-group-result')), { once: true }));
root.setAttribute('data-cowork-group-color', 'blue');
root.setAttribute('data-cowork-group-title', 'Kiefer Pallet');
await Promise.race([done, new Promise(r => setTimeout(r, 2000))]);
root.getAttribute('data-cowork-group-result');
```

Expected return: `OK: groupId=125213100 title="Kiefer Pallet"`

Valid colors: `grey, blue, red, yellow, green, pink, purple, cyan, orange`
(color is optional; set it before the title, since the title is the trigger).

### Errors

| Result string | Meaning |
|---|---|
| `ERROR: tab NNN is not in a tab group` | tab is standalone; group it first |
| `ERROR: invalid color "x"` | use one of the nine Chrome group colors |
| `ERROR: site not in allowlist: host` | the site is not in the popup's "Allowed sites" list (or, with that list empty, not one of the built-in work sites); add it there |
| `null` / no result attribute | extension not loaded, or page is `chrome://` (content scripts are blocked there) |

## Limitations

- Does not work on `chrome://`, `chrome-extension://`, or the Web Store; Chrome
  blocks content scripts on those pages. Navigate to any normal page first.
- The group title persists across navigation on its own. Unlike `document.title`
  tricks, it does not need re-injection after every page load.
- If Claude in Chrome recreates its tab group, the new group starts as "Claude"
  again. Since 1.4.0 the extension puts the lost name back on its own (below).

## Names come back when Cowork returns to the browser (1.4.0, on by default)

When a Cowork session goes back to Chrome, Claude in Chrome often opens a fresh
group titled "Claude". The extension remembers the last five real names in each
window, wherever they came from: the session snippet, the popup, Chrome's own
rename menu, or the session title Claude in Chrome sets itself. A new group that
comes up as "Claude" gets the most recent of those names whose group has since
closed, with its color. Nothing is needed from the session.

- A name still showing on an open group is never copied, so a second group
  running in parallel is not mislabeled; it falls through to site auto-naming.
- Site auto-labels ("QBO", "Shopify") are not remembered as names.
- A group is restored at most twice, so the extension never fights Claude in Chrome.
- Memory is per browser run (`storage.session`) and per window.
- Turn it off with **Give a new "Claude" group back the name it lost** in the popup.

### Claude in Chrome status emoji

Claude in Chrome prefixes its group title with a status emoji (`⌛` while a
session works, `✅` when it is done) and keeps that prefix on any name you set:
"Kiefer Pallet" shows as "⌛Kiefer Pallet". The extension compares titles without
the prefix (so "⌛Claude" counts as the default) and keeps the prefix on anything
it writes. Read-back results include it, e.g. `title="⌛Kiefer Pallet"`.

## Security: allowed sites

`content.js` runs on every page so the session snippet works wherever a task
starts, but since 2.1.0 only allowed sites may use it to rename (or read) the
title of the group they are in. Everything else gets
`ERROR: site not in allowlist: <host>`.

- **Empty list (the default):** the built-in work sites in
  `allowlist-defaults.js`: Shopify admin, Amazon Seller Central, QBO/Intuit,
  Gmail, Google Docs, 71lbs, UPS, FedEx, GTZship/GlobalTranz, HubSpot and
  Maytronics (the same sites `auto.js` names).
- **Your own list:** **Allowed sites** in the popup, one per line,
  `mail.google.com` for one host or `*.myshopify.com` for a domain and all its
  subdomains (a pasted URL is reduced to its host). A saved list replaces the
  built-ins; "Add this site" on an empty list starts from them. Lists saved
  before 2.1.0 keep working unchanged.
- **Every site (the pre-2.1.0 behavior):** save a single `*`.

The popup itself is never restricted, and the popup-only messages refuse
content-script senders.

The extension declares no `host_permissions` (2.1.0): nothing in it injects
scripts, reads cookies or fetches cross-origin from the worker, and the `tabs`
permission already gives tab URLs. Chrome still shows the "all sites" install
warning because of `content.js`'s `<all_urls>` match. For a hard lock at the
Chrome level, edit `manifest.json` and replace `"matches": ["<all_urls>"]`
with only the hosts you automate, for example:

```json
"matches": [
  "https://*.myshopify.com/*",
  "https://admin.shopify.com/*",
  "https://*.intuit.com/*",
  "https://mail.google.com/*",
  "https://*.71lbs.com/*"
]
```

## Development

```bash
npm test
```

Node 18+ and no dependencies: `test/chrome-mock.js` loads `background.js` (and
the `auto.js` / `restore.js` it imports) into a vm context with an in-memory
`chrome.*` mock. Tests cover `labelForUrl`, the replaceable-title rule,
dominant-site picking, the allowlist and title restore.
`test/gmail-parsers.test.js` runs `gmail/parsers.js` against synthetic Gmail
print-view fixtures in `test/fixtures/gmail/` (fictional people and domains,
never real mail); when Gmail changes its print view, add a fixture that
reproduces the break.

Files: `background.js` (message protocol, allowlist), `allowlist-defaults.js`
(built-in allowed sites), `auto.js` (site naming),
`restore.js` (name restore), `content.js` (page bridge), `popup.*` (toolbar UI),
`gmail/` (link copier: `content.js` for the Gmail UI, `parsers.js` for the
pure print-view parsing it loads first, `styles.css`, `background.js` for the
shortcuts, `popup.js` for the popup's Gmail section).

## Changelog

- **2.3.0** — Gmail ✨ prompt carries the fields Cowork acts on, in less
  space: ROUTE (suggested skill), REFS (PO / SO / invoice / estimate / order
  numbers), TRACK (UPS / FedEx / USPS with carrier), LINES (quantity × SKU),
  SHIP_TO and TERMS; padding, blank lines, the fetch note and a MSG_IDS that
  only repeats THREAD_ID are gone; the newest message gets 1,200 characters
  instead of 500; inline signature images are no longer listed as attachments.
  Labels the skills read (THREAD_ID, PERMALINK, LATEST MESSAGE, INTENT) are
  unchanged. Fix: in an open thread with collapsed earlier messages,
  THREAD_ID was a message id (get_thread 404); it now comes from the subject
  header.
- **2.2.0** — Gmail: the ✨ Cowork prompt for the open thread is now one
  keystroke (`Alt+Shift+P`) or one click in the toolbar popup, not only the
  chip in the message header. Unknown shortcut commands are ignored instead
  of being treated as "copy message link".
- **2.1.0** — security: no more `host_permissions: <all_urls>` (unused); an
  empty "Allowed sites" list now means the built-in work sites, not every site
  (`*` restores the old behavior; saved lists are unchanged). Gmail: the print
  view parsers moved to `gmail/parsers.js` with fixture tests, which found and
  fixed: the ✨ Cowork prompt never included the thread body (a stray
  `messages` reference threw, so it always fell back to IDs only); MONEY took
  the oldest message's figure over the newest; negative amounts lost their
  sign; `$300,` kept the comma; "Subtotal" counted as "Total"; `Cc:` lines and
  the next sender's name leaked into message gists; numeric entities such as
  `&#8239;` before PM were not decoded, so those threads did not parse.
- **2.0.1** — restore only fires on a group titled "Claude", not on the blank
  title a new group has before Claude in Chrome names it (a new session in the
  same window was getting the previous task's name; found in live testing).
- **2.0.0** — merged with Gmail Message Link Copier 1.4.1 (history kept under
  `gmail/`) into one extension, "Cowork Chrome Tools".
- **1.4.0** — Claude in Chrome's `⌛`/`✅` status emoji understood everywhere
  (previously "⌛Claude" groups were never auto-named or restored); lost names
  are restored by default, remembered from every naming source.
- **1.3.0** — single version source (manifest); dominant-site auto-naming,
  debounced, no relabel on tab switch; `cowork-group-result` completion event;
  optional allowed-sites list; optional title restore after Claude recreates its
  group; test harness.
- **1.2.0** — automatic naming from the site in the group.
- **1.1.0** — toolbar popup (Cmd+Shift+G) and read-back query.
- **1.0.0** — page-attribute bridge.

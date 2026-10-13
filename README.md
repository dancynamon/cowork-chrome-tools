# Cowork Tab Group Namer

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
4. Click **Load unpacked** and select this folder.
5. Confirm "Cowork Tab Group Namer" is enabled.

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
| `ERROR: site not in allowlist: host` | the popup's "Allowed sites" list is set and excludes this site |
| `null` / no result attribute | extension not loaded, or page is `chrome://` (content scripts are blocked there) |

## Limitations

- Does not work on `chrome://`, `chrome-extension://`, or the Web Store; Chrome
  blocks content scripts on those pages. Navigate to any normal page first.
- The group title persists across navigation on its own. Unlike `document.title`
  tricks, it does not need re-injection after every page load.
- If Claude in Chrome recreates its tab group, the new group starts as "Claude"
  again. Either re-run the snippet, or turn on **Restore my last title when
  Claude recreates its group** in the popup (below).

## Restoring a title after Claude recreates its group (opt-in)

With the popup checkbox on, the last title you set explicitly in each window
(from a session or the popup) is remembered for the browser run. When a new
group in that window comes up empty or "Claude" *and the group that carried
that title is gone*, the title and color are put back. A second, parallel group
is never relabeled, and a group is restored at most twice so the extension never
fights Claude in Chrome. Restore runs before site auto-naming. Off by default.

## Security: allowed sites

`content.js` runs on `<all_urls>`, so by default any web page could set the
attribute and rename (or read) the title of the group it is in. The impact is a
label change, not data access, but you can lock it down from the popup:
**Allowed sites**, one per line, `mail.google.com` for one host or
`*.myshopify.com` for a domain and all its subdomains (a pasted URL is reduced
to its host). "Add this site" fills in the active tab's host. Leave the list
empty to allow every site, which is the default. The popup itself is never
restricted, and the popup-only messages refuse content-script senders.

For a hard lock at the Chrome level you can still edit `manifest.json` and
replace `"matches": ["<all_urls>"]` with only the hosts you automate, for example:

```json
"matches": [
  "https://*.myshopify.com/*",
  "https://admin.shopify.com/*",
  "https://*.intuit.com/*",
  "https://mail.google.com/*",
  "https://*.71lbs.com/*"
]
```

Same edit for `host_permissions`.

## Development

```bash
npm test
```

Node 18+ and no dependencies: `test/chrome-mock.js` loads `background.js` (and
the `auto.js` / `restore.js` it imports) into a vm context with an in-memory
`chrome.*` mock. Tests cover `labelForUrl`, the replaceable-title rule,
dominant-site picking, the allowlist and title restore.

Files: `background.js` (message protocol, allowlist), `auto.js` (site naming),
`restore.js` (title restore), `content.js` (page bridge), `popup.*` (toolbar UI).

## Changelog

- **1.3.0** — single version source (manifest); dominant-site auto-naming,
  debounced, no relabel on tab switch; `cowork-group-result` completion event;
  optional allowed-sites list; optional title restore after Claude recreates its
  group; test harness.
- **1.2.0** — automatic naming from the site in the group.
- **1.1.0** — toolbar popup (Cmd+Shift+G) and read-back query.
- **1.0.0** — page-attribute bridge.

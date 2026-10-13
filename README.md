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
cloning problems with `CustomEvent.detail`.

## Automatic naming (v1.2.0)

The extension cannot know the Cowork task name — no channel exposes it — but it
can see what the group's tabs are. So any group whose title is empty or the
default "Claude" gets named after the site inside it: **Shopify** (purple),
**QBO** (green), **Gmail** (grey), **71lbs / UPS / FedEx / Freight** (blue),
**Amazon** (orange), **HubSpot** (orange), anything else the bare domain (cyan).

A name set by a Claude session or typed in the popup always wins and is never
overwritten. Toggle the whole behavior with the checkbox in the popup.

Edit the `SITE_MAP` table at the top of `auto.js` to add your own sites.

## Manual use (v1.1.0)

Click the extension's toolbar icon, or press **Cmd+Shift+G**, to open a popup that
renames the group containing the active tab. The field is pre-filled with the
current group name. Enter applies.

This path works even where content scripts are blocked (`chrome://`, Web Store)
and regardless of which Claude surface you are using, because the popup talks to
the background worker directly. It is the only option that works for **Claude in
Chrome sidebar sessions**, which do not read Cowork preferences.

## Read-back (v1.1.0)

```js
document.documentElement.setAttribute('data-cowork-group-query', '1');
await new Promise(r => setTimeout(r, 250));
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

Execute in any tab that is inside the Cowork tab group:

```js
document.documentElement.setAttribute('data-cowork-group-color', 'blue');
document.documentElement.setAttribute('data-cowork-group-title', 'Kiefer Pallet');
await new Promise(r => setTimeout(r, 250));
document.documentElement.getAttribute('data-cowork-group-result');
```

Expected return: `OK: groupId=125213100 title="Kiefer Pallet"`

Valid colors: `grey, blue, red, yellow, green, pink, purple, cyan, orange`
(color is optional; set it before the title, since the title is the trigger).

### Errors

| Result string | Meaning |
|---|---|
| `ERROR: tab NNN is not in a tab group` | tab is standalone; group it first |
| `ERROR: invalid color "x"` | use one of the nine Chrome group colors |
| `null` / no result attribute | extension not loaded, or page is `chrome://` (content scripts are blocked there) |

## Limitations

- Does not work on `chrome://`, `chrome-extension://`, or the Web Store; Chrome
  blocks content scripts on those pages. Navigate to any normal page first.
- The group title persists across navigation on its own. Unlike `document.title`
  tricks, it does not need re-injection after every page load.
- If Claude in Chrome recreates its tab group, the new group starts as "Claude"
  again and needs one more call.

## Security note

`content.js` is registered for `<all_urls>`, so any web page could in principle set
that attribute and rename your tab group. The impact is cosmetic (a label change,
no data access), but if you want it locked down, edit `manifest.json` and replace
`"matches": ["<all_urls>"]` with only the hosts you automate, for example:

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

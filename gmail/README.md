# Gmail Message Link Copier

A tiny Chrome extension for grabbing Gmail permalinks — or a ready-to-paste
Claude Cowork prompt built around the link.

**Copy a link:**
- **Inbox hover** — hover any row and click the **🔗** icon in the action
  toolbar (next to Archive/Delete) to copy a link to that email.
- **🔗 Copy link** button in the header of every open message.
- **Keyboard shortcut** — `Alt+Shift+C` copies the message you're reading;
  `Alt+Shift+T` copies the whole thread.
- **Toolbar popup** — on a Gmail tab, the extension's popup shows
  "Message link" and "Thread link" buttons above the tab group controls.

**Copy a Claude Cowork blurb (deep dive):**
- **✨** icon on inbox-row hover, or the **✨ Cowork prompt** chip in an open
  message header.
- On click it reads the **resolved Gmail API IDs straight from the DOM**
  (`data-legacy-thread-id` / `data-legacy-message-id` — these *are* the hex API
  ids), then fetches the print view and parses *every* message. It emits a
  structured blurb:

  ```
  SUBJECT:    <subject>            ← first line, so Cowork names the task by subject
  THREAD_ID:  <hex API thread id>  ← connector fetches directly, no DOM scrape
  MSG_IDS:    [<hex>, ...]         ← per-message ids, newest LAST
  PERMALINK:  …/#all/<THREAD_ID>   ← stable hex permalink, not the #FMfcg… fragment
  ACCOUNT:    u/<N>  (<email>)
  FROM / TO / DATE
  ATTACHMENTS: filename (size)     ← connector pulls bytes via THREAD_ID/MSG_ID
  BODY (newest-first): …
  INTENT:     process
  MONEY:      $<amt> (status: PAID|DUE, <card x1234>)
  ```

  Why the IDs matter: the web URL fragment (`#FMfcg…`) is the *web client's* id,
  not the API id — emitting the resolved hex `THREAD_ID` means Claude's Gmail
  connector never has to drive Chrome to scrape it.
- If the print-view fetch fails, the blurb still carries the identity block
  (IDs + subject + account) so the connector can pull the rest via `THREAD_ID`.

  *Async copy:* uses the `ClipboardItem` promise pattern so the clipboard stays
  tied to your click while the thread loads.

  *Not emitted:* the Gmail API `attachment_id` — it isn't present in the web DOM
  (only `attid`/`realattid`, a different namespace) and the extension has no
  Gmail API auth. The connector resolves it from `THREAD_ID`/`MSG_ID` in one API
  call, so no browser round-trip is needed regardless.

## Install

Part of **Cowork Chrome Tools** since 2.0.0: load the repository root (one level
up from this folder) unpacked, not this folder. See the root README.

### Change the shortcuts

Go to `chrome://extensions/shortcuts` to remap `Alt+Shift+C` /
`Alt+Shift+T` if they clash with anything.

## How it works

Each message's link looks like:

```
https://mail.google.com/mail/u/0/#all/<messageId>
```

`#all/<messageId>` opens the containing thread focused on that exact message,
no matter which label it's filed under. The `u/0` part matches whichever
account you're signed into when you copy.

## Notes / limits

- Buttons appear on **expanded** messages. Collapsed messages in a long thread
  won't have one until you click to expand them.
- Anyone you paste the link to must have access to that mailbox/account for the
  link to open the message for them — it's a deep link into *your* Gmail, not a
  public share.
- Gmail's HTML class names change occasionally. If the button ever stops
  appearing, it's almost always a class-name change in `content.js`
  (`.adn`, `.gH`, `.gE`) that needs a quick update.

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
  "Message link", "Thread link" and "✨ Cowork prompt" buttons above the tab
  group controls.

**Copy a Claude Cowork blurb (deep dive):**
- **✨** icon on inbox-row hover, the **✨ Cowork prompt** chip in an open
  message header, `Alt+Shift+P` with a thread open, or the popup button.
- On click it reads the **resolved Gmail API IDs straight from the DOM**
  (`data-legacy-thread-id` / `data-legacy-message-id` — these *are* the hex API
  ids), then fetches the print view and parses *every* message. It emits a
  structured blurb:

  ```
  SUBJECT: <subject>                 ← first line, so Cowork names the task by subject
  THREAD_ID: <hex API thread id>     ← connector fetches directly, no DOM scrape
  MSG_IDS: [<hex>, ...]              ← only when it adds to THREAD_ID; newest LAST
  PERMALINK: …/#all/<THREAD_ID>      ← stable hex permalink, not the #FMfcg… fragment
  ACCOUNT: u/<N> (<email>)
  ROUTE: process-sales-order         ← suggested skill, or "(FYI: …)"; a hint only
  REFS: PO F2000123 · SO 1500 · INV 4417 · EST 3656 · CHECK 3060 · ORDER 1042
  TRACK: 1Z… UPS · 1234… FedEx · 94… USPS
  LINES: 120× DMO-50-RD-PL · 40× DMO-40-RD-PL · PM-STF-RD-4848
  SHIP_TO: <name, street, city, ST 12345>
  MONEY: $<amt> (status: PAID|DUE, <card x1234>)
  TERMS: Net 30 | Due on receipt | Due on fulfillment | Prepaid | COD
  FROM: <sender> → <to> · <date>
  ATTACHMENTS: file.pdf (212K), …    ← inline signature images left out
  LATEST MESSAGE:
  <newest message, up to 1,200 characters>
  EARLIER (newest first):
  • <date> <who>: <one-line gist>
  INTENT: process
  ```

  Every line after ACCOUNT appears only when there is something to say, so a
  typical blurb is a few hundred characters. ROUTE, REFS, TRACK, LINES,
  SHIP_TO and TERMS are read from the subject and every message in the
  thread (quoted history and the sender's signature block removed), so Cowork can often fill a sales order or
  bill without opening the email. `INTENT: process` still means "classify and
  route"; ROUTE is a suggestion it can overrule. The routing rules are the
  `ROUTES` table in `parsers.js`: generic patterns only (subject wording,
  Shopify / QuickBooks / carrier senders, and your own mail domain read from
  the tab), because this repository is public. Never add a customer's or
  vendor's domain to it; a test fails if you do.

  Why the IDs matter: the web URL fragment (`#FMfcg…`) is the *web client's* id,
  not the API id — emitting the resolved hex `THREAD_ID` means Claude's Gmail
  connector never has to drive Chrome to scrape it.
- If the print-view fetch fails, the blurb still carries the identity block
  (IDs + subject + account, plus any refs in the subject) so the connector can
  pull the rest via `THREAD_ID`.
- In an open thread, THREAD_ID comes from the subject header's thread id
  (2.3.0). Before that it was the first *visible* message's id, which is only
  the thread id when no earlier message is collapsed; otherwise `get_thread`
  404ed.

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
`Alt+Shift+T` / `Alt+Shift+P` if they clash with anything.

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
- The ✨ blurb's FROM/TO/DATE, body and MONEY come from Gmail's print view,
  parsed in `parsers.js`. If those go missing while the IDs still appear, the
  print-view markup changed: save a synthetic copy that reproduces it under
  `test/fixtures/gmail/` and fix `parsers.js` until `npm test` passes.

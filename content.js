// Gmail Message Link Copier
// - Adds a "Copy link" button to every open message.
// - Keyboard shortcut copies the focused message's link.
// - Toolbar popup copies the focused message OR the whole thread.

(function () {
  "use strict";

  const BTN_CLASS = "gmlc-copy-btn";

  // Which account (e.g. /mail/u/0/) the user is currently in.
  function accountIndex() {
    const m = location.pathname.match(/\/mail\/u\/(\d+)\//);
    return m ? m[1] : "0";
  }

  // "#all/<id>" opens the containing thread focused on that exact message (or
  // thread, if given a thread id), regardless of which label it's filed under.
  function buildLink(id) {
    return `https://mail.google.com/mail/u/${accountIndex()}/#all/${id}`;
  }

  // ---- Claude Cowork prompt -----------------------------------------------

  function text(el) {
    return el ? el.textContent.trim() : "";
  }

  function clip(s, n) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // "Thu, Jun 18, 2026 at 7:16 AM" → "Jun 18"
  function shortDate(raw) {
    const m = raw.match(/(\w{3}) (\d{1,2})/);
    return m ? m[1] + " " + m[2] : raw;
  }

  // "Name <email>" → "Name"; "<a@b.com>" → "a"
  function shortSender(s) {
    if (!s) return "?";
    const name = (s.match(/^([^<]+?)\s*</) || [])[1];
    if (name) return clip(name, 24);
    const em = (s.match(/<([^>@]+)@/) || [])[1];
    return em || clip(s, 24);
  }

  // ---- DOM metadata (IDs, account, attachments) ---------------------------
  // The Gmail web DOM exposes the API (hex) IDs directly via the
  // data-legacy-* attributes, so we can put resolved THREAD_ID / MSG_IDS in the
  // blurb and Claude's connector never has to scrape the DOM to find the thread.

  function accountEmail() {
    // The signed-in mailbox is in the tab title, e.g. "… - dan@aquamentor.com - …"
    return (document.title.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || "";
  }

  function openAttachments() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll(".aZo, span.aZo").forEach((chip) => {
      const name = text(chip.querySelector(".aV3")) || text(chip.querySelector("[download]"));
      if (!name || seen.has(name)) return;
      seen.add(name);
      const size = (chip.textContent.match(/\b\d+(?:\.\d+)?\s?(?:bytes|KB|MB|GB)\b/i) || [])[0] || "";
      out.push({ name, size });
    });
    return out;
  }

  function rowAttachments(row) {
    const out = [];
    const seen = new Set();
    row.querySelectorAll(".brc, .yKraGc, .aZo .aV3").forEach((e) => {
      const name = text(e);
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push({ name, size: "" });
      }
    });
    return out;
  }

  // Gathers everything readable from the DOM at click time. ctx.row → an inbox
  // row (collapsed); otherwise the currently open thread.
  function gatherDomMeta(ctx) {
    const account = accountIndex();
    const email = accountEmail();
    if (ctx && ctx.row) {
      const tid = legacyThreadId(ctx.row);
      return {
        account,
        email,
        threadId: tid,
        msgIds: tid ? [tid] : [], // collapsed row: rest aren't in the DOM
        subject: text(ctx.row.querySelector("span.bog")),
        attachments: rowAttachments(ctx.row),
      };
    }
    const adns = [
      ...document.querySelectorAll(".adn[data-legacy-message-id]"),
    ].filter((a) => a.offsetParent !== null);
    const ids = adns.map((a) => a.getAttribute("data-legacy-message-id"));
    return {
      account,
      email,
      threadId: ids[0] || null, // Gmail's thread id == its first message's id
      msgIds: ids, // DOM order is oldest→newest, i.e. newest LAST
      subject: text(document.querySelector("h2.hP")),
      attachments: openAttachments(),
    };
  }

  // ---- deep dive: fetch + parse the whole thread --------------------------

  // Gmail's print view needs the per-session 'ik' key. Content scripts can't
  // read the page's window.GM_ID_KEY, so we recover it from the resource
  // timing entries or the page source.
  function getIk() {
    try {
      const e = performance
        .getEntriesByType("resource")
        .map((x) => x.name)
        .find((n) => /[?&]ik=/.test(n));
      if (e) {
        const m = e.match(/[?&]ik=([^&]+)/);
        if (m) return m[1];
      }
    } catch (e) {
      /* ignore */
    }
    try {
      const src = document.documentElement.innerHTML;
      const m =
        src.match(/GM_ID_KEY\s*[:=]\s*["']([^"']+)["']/) ||
        src.match(/[?&]ik=([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // Same-origin fetch of the full conversation as printable HTML.
  async function fetchThreadDigest(threadId) {
    const ik = getIk();
    if (!ik) return null;
    const url =
      `https://mail.google.com/mail/u/${accountIndex()}/?ik=` +
      `${encodeURIComponent(ik)}&view=pt&search=all&th=${threadId}&pli=1`;
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return null;
      return parsePrintView(await r.text());
    } catch (e) {
      return null;
    }
  }

  // The print view has no semantic classes, but every message starts with a
  // regular date header — segment on that.
  const DATE_RE =
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2}\s?(?:AM|PM)/g;

  function decodeStrip(html) {
    let t = html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br[^>]*>/gi, "\n")
      .replace(/<\/(div|p|tr|table|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    return t
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ");
  }

  function cleanBody(s) {
    return s
      .replace(/On\b[\s\S]*?wrote:[\s\S]*$/, "") // quoted reply history
      .replace(/\[Quoted text hidden\][\s\S]*$/i, "")
      // legal/confidentiality footer
      .replace(
        /\bThis (?:e-?mail|message)[\s\S]*?(?:confidential|intended (?:solely|only))[\s\S]*$/i,
        ""
      )
      .replace(/\bSent from my \w+[\s\S]*$/i, "") // mobile signature
      .replace(/\bGet Outlook for \w+\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const MONTHS = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };

  // "Thu, Jun 11, 2026 at 6:20 PM" → "2026-06-11 18:20"
  function normalizeDate(raw) {
    const m = raw.match(/(\w{3})\w* (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2})\s?(AM|PM)/);
    if (!m) return raw;
    let h = parseInt(m[4], 10);
    if (/PM/i.test(m[6]) && h !== 12) h += 12;
    if (/AM/i.test(m[6]) && h === 12) h = 0;
    const mo = MONTHS[m[1]] || "01";
    return `${m[3]}-${mo}-${String(m[2]).padStart(2, "0")} ${String(h).padStart(2, "0")}:${m[5]}`;
  }

  const dollars = (s) => parseFloat(s.replace(/[$,]/g, "")) || 0;

  // Pre-flag a dollar figure + paid/unpaid + method so it can't be missed.
  function extractMoney(t) {
    const amts = t.match(/\$[\d,]+(?:\.\d{2})?/g);
    if (!amts || !amts.length) return null;
    let status = null;
    if (/\bPAID\b|Amount Paid|Paid in full|payment received|charged to/i.test(t))
      status = "PAID";
    else if (/Amount Due|Balance Due|Total Due|\bNet\s?\d+\b/i.test(t))
      status = "DUE";
    // amount next to a relevant label, else the largest figure
    const lbl = t.match(
      /(?:Amount Due|Balance Due|Amount Paid|Total Due|Grand Total|Total)\D{0,14}(\$[\d,]+(?:\.\d{2})?)/i
    );
    const amount = lbl ? lbl[1] : amts.slice().sort((a, b) => dollars(b) - dollars(a))[0];
    const meth = t.match(
      /\b(VISA|MASTERCARD|MC|AMEX|AMERICAN EXPRESS|DISCOVER)\b[^\d]{0,14}(\d{4})\b/i
    );
    const bits = [];
    if (status) bits.push("status: " + status);
    if (meth) bits.push(meth[1].toUpperCase().replace("AMERICAN EXPRESS", "AMEX") + " x" + meth[2]);
    return amount + (bits.length ? "  (" + bits.join(", ") + ")" : "");
  }

  function stripRecipients(s) {
    return s
      .replace(/^\s*(To|Cc|Bcc|Subject|Date|Sent|From):[^\n]*\n?/gi, "")
      .trim();
  }

  function senderBefore(t, endIdx) {
    let pre = t.slice(Math.max(0, endIdx - 200), endIdx).replace(/\s+/g, " ");
    // Drop trailing quoted-history / trimmed-content noise before the name.
    pre = pre
      .replace(/.*(?:Quoted text hidden\]?|trimmed content|wrote:|\d+ messages?)/i, "")
      .trim();
    // Name = 1–4 Capitalized words immediately before the address, so leaked
    // lowercase tails from the previous message don't get pulled in.
    const m = pre.match(
      /(?:^|\s)([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){0,3})\s*<([\w.+-]+@[\w.-]+)>\s*$/
    );
    if (m) return m[1].trim() + " <" + m[2] + ">";
    const e = pre.match(/<?([\w.+-]+@[\w.-]+\.\w+)>?\s*$/);
    return e ? "<" + e[1] + ">" : "";
  }

  function parsePrintView(html) {
    const t = decodeStrip(html);
    // Skip quoted-reply dates ("On <date>, <name> wrote:") so they don't create
    // phantom message boundaries.
    const matches = [...t.matchAll(DATE_RE)].filter(
      (m) => !/\bOn\s$/.test(t.slice(Math.max(0, m.index - 4), m.index))
    );
    if (!matches.length) return null;
    const count = (t.match(/(\d+)\s+messages/) || [])[1] || String(matches.length);
    const emails = [...new Set(t.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [])];
    const segs = matches.map((m, k) => {
      const start = m.index + m[0].length;
      const end = k + 1 < matches.length ? matches[k + 1].index : t.length;
      return {
        date: m[0],
        sender: senderBefore(t, m.index),
        body: cleanBody(stripRecipients(t.slice(start, end))),
      };
    });
    // Newest first. The most recent message gets more room; older ones are
    // trimmed but kept long enough to follow the conversation.
    // Tight body: the latest message (the actual ask) reasonably full, then
    // older messages collapsed to one-line gists so long threads stay small.
    const ordered = segs.slice().reverse(); // newest first
    const EARLIER_MAX = 6;
    const latestBody = clip(ordered[0] ? ordered[0].body : "", 500) || "(no readable text)";
    const earlier = ordered.slice(1, 1 + EARLIER_MAX).map((s) => ({
      date: shortDate(s.date),
      who: shortSender(s.sender),
      gist: clip(s.body, 120) || "(no text)",
    }));
    const omitted = Math.max(0, ordered.length - 1 - earlier.length);
    // Headers of the most recent message → FROM / TO / DATE.
    const lastM = matches[matches.length - 1];
    const lastSeg = segs[segs.length - 1];
    const head = t.slice(
      lastM.index + lastM[0].length,
      lastM.index + lastM[0].length + 300
    );
    const fromEmail = (lastSeg.sender.match(/<([^>]+)>/) || [])[1] || "";
    const toEmails = [...new Set(head.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [])]
      .filter((e) => e !== fromEmail)
      .slice(0, 6);
    // The print view lists "<filename>.<ext> <size>" — harvest the sizes so we
    // can pair them with the DOM attachment filenames (the DOM hides size).
    const attachmentSizes = [
      ...t.matchAll(/\.[a-z0-9]{2,4}\s+(\d+(?:\.\d+)?\s?(?:[KMG]B?|bytes))\b/gi),
    ].map((m) => m[1].replace(/\s+/g, ""));
    return {
      count,
      shown: messages.length,
      firstDate: matches[0][0],
      lastDate: matches[matches.length - 1][0],
      participants: emails.slice(0, 12),
      latest: {
        from: lastSeg.sender,
        to: toEmails.join(", "),
        date: normalizeDate(lastM[0]),
      },
      money: extractMoney(t),
      attachmentSizes,
      latestBody,
      earlier,
      omitted,
    };
  }

  // Renders the Cowork blurb. `meta` is the DOM-gathered identity (IDs, account,
  // subject, attachments); `d` is the fetched thread digest (FROM/TO/DATE, body,
  // money) — d may be null if the fetch failed, in which case we still emit the
  // identity block so Claude's connector can pull the rest via THREAD_ID.
  function buildBlurb(meta, d) {
    const tid = meta.threadId || "";
    const pad = (k) => (k + ":").padEnd(11) + " ";
    const L = [];
    L.push(pad("SUBJECT") + (meta.subject || "(no subject)"));
    if (tid) L.push(pad("THREAD_ID") + tid);
    if (meta.msgIds && meta.msgIds.length)
      L.push(pad("MSG_IDS") + "[" + meta.msgIds.join(", ") + "]");
    if (tid)
      L.push(
        pad("PERMALINK") +
          "https://mail.google.com/mail/u/" + meta.account + "/#all/" + tid
      );
    L.push(pad("ACCOUNT") + "u/" + meta.account + (meta.email ? "  (" + meta.email + ")" : ""));

    if (d && d.latest) {
      L.push("");
      if (d.latest.from) L.push(pad("FROM") + d.latest.from);
      if (d.latest.to) L.push(pad("TO") + d.latest.to);
      if (d.latest.date) L.push(pad("DATE") + d.latest.date);
    }
    if (meta.attachments && meta.attachments.length) {
      const sizes = (d && d.attachmentSizes) || [];
      L.push("ATTACHMENTS:");
      meta.attachments.forEach((a, i) => {
        const size = a.size || sizes[i] || "";
        L.push("  - " + a.name + (size ? " (" + size + ")" : ""));
      });
      L.push("  (fetch bytes via THREAD_ID/MSG_ID — Gmail connector)");
    }

    if (d && d.latestBody) {
      L.push("", "LATEST MESSAGE:");
      L.push(d.latestBody);
      if (d.earlier && d.earlier.length) {
        L.push("", "EARLIER (newest first, one line each):");
        d.earlier.forEach((m) =>
          L.push("• " + m.date + " " + m.who + ": " + m.gist)
        );
      }
      if (d.omitted)
        L.push(
          "• (+" + d.omitted + " older messages — fetch full thread via THREAD_ID)"
        );
    } else {
      L.push("", "BODY: (open the thread via THREAD_ID to read it)");
    }

    L.push("INTENT:     process");
    if (d && d.money) L.push("MONEY:      " + d.money);
    return L.join("\n");
  }

  // Copies the Cowork blurb. Uses the async ClipboardItem pattern so the
  // clipboard stays tied to the click while the thread fetch resolves; if the
  // fetch/parse fails we still emit the identity block (IDs + subject) so the
  // connector can pull the rest via THREAD_ID.
  function deepDiveCopy(meta, successMsg) {
    toast("Building blurb…");
    const build = (meta.threadId ? fetchThreadDigest(meta.threadId) : Promise.resolve(null))
      .then((d) => buildBlurb(meta, d))
      .catch(() => buildBlurb(meta, null));

    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        const item = new ClipboardItem({
          "text/plain": build.then((txt) => new Blob([txt], { type: "text/plain" })),
        });
        navigator.clipboard.write([item]).then(
          () => toast(successMsg),
          () => build.then(copyText).then((ok) => toast(ok ? successMsg : "Copy failed", !ok))
        );
        return;
      } catch (e) {
        /* fall through */
      }
    }
    build.then(copyText).then((ok) => toast(ok ? successMsg : "Copy failed", !ok));
  }

  // ---- clipboard ----------------------------------------------------------

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e2) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  // ---- toast (feedback for keyboard / popup actions) ----------------------

  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.getElementById("gmlc-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "gmlc-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("gmlc-toast-error", !!isError);
    el.classList.add("gmlc-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("gmlc-toast-show"), 1600);
  }

  // ---- message / thread detection -----------------------------------------

  // `.adn` is Gmail's per-message container; it carries the stable
  // data-legacy-message-id we need for a per-message permalink.
  function allMessages() {
    return Array.from(
      document.querySelectorAll(".adn[data-legacy-message-id]")
    ).filter((el) => el.offsetParent !== null);
  }

  // The message the user is most likely reading: the visible one whose top is
  // nearest the top of the viewport.
  function currentMessage() {
    const msgs = allMessages();
    if (!msgs.length) return null;
    const vh = window.innerHeight;
    let best = null;
    let bestScore = Infinity;
    for (const m of msgs) {
      const r = m.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue; // off-screen
      const score = Math.abs(r.top - 80); // ~just below Gmail's header
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return best || msgs[msgs.length - 1];
  }

  // The thread id of the currently OPEN conversation, taken from the URL hash
  // (e.g. "#all/FMfcgz...") — this id works in an "#all/<id>" permalink. We
  // can't trust document-wide [data-legacy-thread-id] lookups because the
  // inbox list stays in the DOM behind an open thread.
  function openThreadIdFromHash() {
    const m = location.hash.match(/^#[^/]+\/([^/?]+)/);
    return m ? m[1] : null;
  }

  function currentMessageLink() {
    const m = currentMessage();
    if (!m) return null;
    const id = m.getAttribute("data-legacy-message-id");
    return id ? buildLink(id) : null;
  }

  function currentThreadLink() {
    // Prefer a thread id on the open message's own ancestors, if present...
    const m = currentMessage();
    let el = m;
    while (el) {
      const t = el.getAttribute && el.getAttribute("data-legacy-thread-id");
      if (t) return buildLink(t);
      el = el.parentElement;
    }
    // ...otherwise use the open thread id from the URL.
    const hashId = openThreadIdFromHash();
    return hashId ? buildLink(hashId) : null;
  }

  // ---- inline per-message button ------------------------------------------

  function flash(btn, text) {
    const orig = btn.getAttribute("data-label");
    btn.textContent = text;
    btn.classList.add("gmlc-copied");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("gmlc-copied");
    }, 1200);
  }

  // A text chip button in a message header. action(btn) owns its own feedback.
  function msgChip(label, title, cls, action) {
    const btn = document.createElement("div");
    btn.className = cls;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("data-label", label);
    btn.setAttribute("title", title);
    btn.textContent = label;
    const onActivate = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      action(btn);
    };
    btn.addEventListener("click", onActivate);
    btn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") onActivate(ev);
    });
    return btn;
  }

  function augment(msg) {
    const msgId = msg.getAttribute("data-legacy-message-id");
    if (!msgId) return;
    // `.gH` is the message header's right-hand cell (date / reply area).
    const host = msg.querySelector(".gH") || msg.querySelector(".gE");
    if (!host) return;
    // Idempotent by actual presence, not a sticky flag — so if Gmail rebuilds
    // the header we re-add the buttons on the next sweep.
    if (host.querySelector(".gmlc-copy-btn")) return;
    // Insert prompt first, then link before it → order: [🔗 link] [✨ triage].
    host.insertBefore(
      msgChip(
        "✨ Cowork prompt",
        "Deep-dive the whole thread and copy a Cowork blurb",
        "gmlc-prompt-chip",
        () => deepDiveCopy(gatherDomMeta({}), "Cowork blurb copied")
      ),
      host.firstChild
    );
    host.insertBefore(
      msgChip("🔗 Copy link", "Copy a permalink to this message", BTN_CLASS, (btn) =>
        copyText(buildLink(msgId)).then((ok) => flash(btn, ok ? "Copied!" : "Failed"))
      ),
      host.firstChild
    );
  }

  // ---- inbox/list-row hover button ----------------------------------------

  // The hex thread id that the "#all/<id>" permalink needs for a list row.
  function legacyThreadId(row) {
    const el = row.querySelector("[data-legacy-thread-id]");
    if (el) return el.getAttribute("data-legacy-thread-id");
    // Fallback: derive it from the decimal "#thread-f:123..." form.
    const el2 = row.querySelector("[data-thread-id]");
    if (el2) {
      const v = el2.getAttribute("data-thread-id") || "";
      const m = v.match(/:(\d+)/);
      if (m) {
        try {
          return BigInt(m[1]).toString(16);
        } catch (e) {
          /* ignore */
        }
      }
    }
    return null;
  }

  // An <li> icon button that sits in Gmail's hover-action toolbar and inherits
  // its exact show-on-hover behavior (the toolbar cell is display:none until
  // the row is hovered). action() owns its own copy + feedback.
  function rowIconBtn(emoji, tooltip, cls, action) {
    const btn = document.createElement("li");
    btn.className = cls;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("data-tooltip", tooltip);
    btn.setAttribute("aria-label", tooltip);
    btn.textContent = emoji;

    // Keep clicks from opening the conversation.
    const swallow = (ev) => {
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    };
    btn.addEventListener("mousedown", (ev) => {
      swallow(ev);
      ev.preventDefault();
    });
    btn.addEventListener("mouseup", swallow);
    btn.addEventListener("click", (ev) => {
      swallow(ev);
      ev.preventDefault();
      action();
    });
    btn.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        swallow(ev);
        ev.preventDefault();
        action();
      }
    });
    return btn;
  }

  function augmentRow(row) {
    // The hover-action toolbar (Archive / Delete / Snooze). It lives in a cell
    // that Gmail keeps display:none until the row is hovered, so our buttons
    // show and hide for free — no clipping, no custom hover CSS. Gmail builds
    // this toolbar LAZILY, so a row may have none on first scan; the periodic
    // sweep retries until it exists.
    const toolbar =
      row.querySelector("td.bq4 ul.bqY") || row.querySelector("td.bq4 ul");
    if (!toolbar) return;
    // Idempotent by presence — survives Gmail rebuilding the toolbar.
    if (toolbar.querySelector(".gmlc-row-btn")) return;
    const tid = legacyThreadId(row);
    if (!tid) return;
    // Insert triage first, then link before it → order: [🔗 link] [✨ triage].
    toolbar.insertBefore(
      rowIconBtn(
        "✨",
        "Deep-dive the whole thread and copy a Cowork blurb",
        "gmlc-prompt-btn",
        () => deepDiveCopy(gatherDomMeta({ row }), "Cowork blurb copied")
      ),
      toolbar.firstChild
    );
    toolbar.insertBefore(
      rowIconBtn("🔗", "Copy link to this email", "gmlc-row-btn", () =>
        copyText(buildLink(tid)).then((ok) =>
          toast(ok ? "Email link copied" : "Copy failed", !ok)
        )
      ),
      toolbar.firstChild
    );
  }

  function scan(root) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll(".adn[data-legacy-message-id]").forEach(augment);
    root.querySelectorAll("tr.zA").forEach(augmentRow);
  }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches(".adn[data-legacy-message-id]")) augment(n);
        else if (n.matches && n.matches("tr.zA")) augmentRow(n);
        else scan(n);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  scan(document);
  // Self-heal: Gmail builds row toolbars lazily and re-renders rows/messages
  // as you read, mark, and scroll. A light periodic sweep re-adds any button
  // that isn't present yet. Presence checks make this cheap and idempotent.
  setInterval(() => scan(document), 700);

  // ---- messaging from background (keyboard) and popup ---------------------

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.type === "get-message") {
      sendResponse({ link: currentMessageLink() });
    } else if (req.type === "get-thread") {
      sendResponse({ link: currentThreadLink() });
    } else if (req.type === "copy-message") {
      const link = currentMessageLink();
      if (link) {
        copyText(link).then((ok) =>
          toast(ok ? "Message link copied" : "Copy failed", !ok)
        );
      } else {
        toast("No open message in view", true);
      }
    } else if (req.type === "copy-thread") {
      const link = currentThreadLink();
      if (link) {
        copyText(link).then((ok) =>
          toast(ok ? "Thread link copied" : "Copy failed", !ok)
        );
      } else {
        toast("No thread open", true);
      }
    }
    return true;
  });
})();

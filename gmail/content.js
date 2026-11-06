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

  // Pure print-view parsing and blurb rendering live in gmail/parsers.js,
  // which the manifest loads first into this same isolated world.
  const { parsePrintView, buildBlurb } = window.GmailParsers;

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
    } else if (req.type === "get-prompt") {
      // Popup: return the blurb text; the popup writes the clipboard itself
      // (the Gmail page is not focused while the popup is open).
      const meta = gatherDomMeta({});
      if (!meta.threadId) {
        sendResponse({ blurb: null });
      } else {
        fetchThreadDigest(meta.threadId)
          .catch(() => null)
          .then((d) => sendResponse({ blurb: buildBlurb(meta, d) }));
      }
    } else if (req.type === "copy-prompt") {
      const meta = gatherDomMeta({});
      if (meta.threadId) deepDiveCopy(meta, "Cowork blurb copied");
      else toast("No thread open", true);
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

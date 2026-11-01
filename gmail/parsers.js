// Gmail Message Link Copier - pure parsers (no DOM, no chrome.*)
//
// Turns Gmail's print view (view=pt) HTML into the thread digest, and the
// digest plus DOM metadata into the Cowork blurb. Loaded as a content script
// before content.js (manifest content_scripts order), which reads them from
// the GmailParsers global; test/gmail-parsers.test.js require()s this file.
// Gmail changes its print-view markup without notice: the fixtures in
// test/fixtures/gmail/ pin what these functions expect.

(function (root) {
  "use strict";

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
      .replace(/&nbsp;/g, " ")
      // Numeric entities, e.g. &#8239; (narrow no-break space) before AM/PM.
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
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

  // "$1,234.56", "$1,200", and negatives "-$45.00" / "$-45.00" / "($45.00)".
  // A spaced "- $20" is a list dash, not a sign.
  // Commas only between digit groups, so "$300, terms" is "$300".
  const NUM = String.raw`\d+(?:,\d{3})*(?:\.\d{2})?`;
  const AMOUNT = String.raw`-\$${NUM}|\$-${NUM}|\(\$${NUM}\)|\$${NUM}`;

  // Any of the AMOUNT forms → "$1,234.56" or "-$45.00".
  function formatAmount(s) {
    const neg = /^-|^\$-|^\(/.test(s);
    return (neg ? "-$" : "$") + s.replace(/[^\d,.]/g, "");
  }

  const dollars = (s) => parseFloat(s.replace(/[^\d.]/g, "")) || 0;

  // Pre-flag a dollar figure + paid/unpaid + method so it can't be missed.
  function extractMoney(t) {
    const amts = t.match(new RegExp(AMOUNT, "g"));
    if (!amts || !amts.length) return null;
    let status = null;
    if (/\bPAID\b|Amount Paid|Paid in full|payment received|charged to/i.test(t))
      status = "PAID";
    else if (/Amount Due|Balance Due|Total Due|\bNet\s?\d+\b/i.test(t))
      status = "DUE";
    // amount next to a relevant label ("Subtotal" is not one), else the
    // largest figure either side of zero
    const lbl = t.match(new RegExp(
      String.raw`\b(?:Amount Due|Balance Due|Amount Paid|Total Due|Grand Total|Total)\D{0,14}?(${AMOUNT})`, "i"
    ));
    const amount = formatAmount(lbl ? lbl[1] : amts.slice().sort((a, b) => dollars(b) - dollars(a))[0]);
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
      // the whole leading header block, not just its first line
      .replace(/^(?:\s*(?:To|Cc|Bcc|Subject|Date|Sent|From):[^\n]*\n?)+/i, "")
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
    const senders = matches.map((m) => senderBefore(t, m.index));
    const segs = matches.map((m, k) => {
      const start = m.index + m[0].length;
      const end = k + 1 < matches.length ? matches[k + 1].index : t.length;
      let body = cleanBody(stripRecipients(t.slice(start, end)));
      // The next message's "Name <email>" sits before its date, i.e. at the
      // end of this segment.
      const next = senders[k + 1];
      if (next && body.endsWith(next)) body = body.slice(0, -next.length).trim();
      return { date: m[0], sender: senders[k], body };
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
      shown: segs.length,
      firstDate: matches[0][0],
      lastDate: matches[matches.length - 1][0],
      participants: emails.slice(0, 12),
      latest: {
        from: lastSeg.sender,
        to: toEmails.join(", "),
        date: normalizeDate(lastM[0]),
      },
      // The newest message's figure; the whole thread only if it has none, so
      // an old "Total Due" does not outrank a newer "Amount Paid".
      money: extractMoney(lastSeg.body) || extractMoney(t),
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

  const api = {
    clip, shortDate, shortSender, decodeStrip, cleanBody, normalizeDate,
    extractMoney, stripRecipients, senderBefore, parsePrintView, buildBlurb,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GmailParsers = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

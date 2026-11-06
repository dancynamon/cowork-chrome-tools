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
    const latestBody = clip(ordered[0] ? ordered[0].body : "", 1200) || "(no readable text)";
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
      // Unclipped, for the field extractors and routing: every message's
      // cleaned body (quoted history already removed), and the newest alone.
      text: segs.map((s) => s.body).join("\n"),
      latestText: lastSeg.body,
      earlier,
      omitted,
    };
  }

  // ---- structured fields Cowork can act on without reading the body ------

  const uniq = (xs) => [...new Set(xs)];

  // Reference numbers. Each kind keeps its first 4 distinct values, oldest
  // mention first. With a marker ("#", "No.", "Number") the value may start
  // with letters (AHS-1418568); without one it needs 3+ leading digits
  // ("Invoice 4417", "PO160272") or a short letter prefix and 4+ digits
  // ("PO F2000123"), so "Purchase Order Date" and "PO deliver date" are not POs.
  const REF = (lead) => new RegExp(
    lead + String.raw`(?:\s*(?:#|No\.?|Number)\s*:?\s*([A-Z]{0,4}-?\d[\w-]{2,})|\s*:?\s*((?:[A-Z]{1,4}-?)?\d{4,}[\w-]*|\d{3,}[\w-]*))`, "gi");
  const REF_RES = [
    ["PO", REF(String.raw`\b(?:P\.?O\.?|Purchase Order)`)],
    ["SO", REF(String.raw`\b(?:S\.?O\.?(?=\s*#)|Sales Order)`)],
    ["INV", REF(String.raw`\bInvoice`)],
    ["EST", REF(String.raw`\b(?:Estimate|Quote)`)],
    ["ORDER", REF(String.raw`(?<!(?:Purchase|Sales)\s)\bOrder`)],
  ];

  function extractRefs(t) {
    const out = [];
    for (const [kind, re] of REF_RES) {
      const vals = [...(t || "").matchAll(re)].map((m) => (m[1] || m[2]).replace(/-+$/, ""));
      uniq(vals).slice(0, 4).forEach((v) => out.push(kind + " " + v));
    }
    return out;
  }

  // Tracking numbers with their carrier. FedEx's bare 12/15 digits only count
  // next to a word that says so, or they would catch account numbers.
  function extractTracking(t) {
    t = t || "";
    const out = [];
    for (const m of t.matchAll(/\b1Z[0-9A-Z]{16}\b/g)) out.push(m[0] + " UPS");
    for (const m of t.matchAll(/\b9[2-5]\d{18,20}\b/g)) out.push(m[0] + " USPS");
    for (const m of t.matchAll(/\b(\d{12}|\d{15})\b/g)) {
      const near = t.slice(Math.max(0, m.index - 40), m.index);
      if (/fed\s?ex|tracking|track/i.test(near) && !/(acct|account)\W*(#|no\.?)?\s*$/i.test(near))
        out.push(m[0] + " FedEx");
    }
    return uniq(out).slice(0, 6);
  }

  // SKUs: letters first, then 2+ dash-separated parts (XRT-50-RD-CL,
  // RWB-BL-100). Some catalogs put a pack digit and a space in front ("3 FB-7315-YL").
  const SKU = String.raw`(?:\d )?[A-Z][A-Z0-9]{1,5}(?:-[A-Z0-9]{1,8}){2,4}\b`;

  // "6× XRT-50-RD-CL" lines: "6 x SKU" in an order note, "× 6 … SKU: X" in a
  // Shopify order notification, and bare SKUs (no quantity) anywhere else.
  function extractLines(t) {
    t = t || "";
    const qty = new Map();
    const order = [];
    const add = (sku, q) => {
      if (!qty.has(sku)) order.push(sku);
      if (q && !qty.get(sku)) qty.set(sku, q);
      else if (!qty.has(sku)) qty.set(sku, "");
    };
    for (const m of t.matchAll(new RegExp(String.raw`\b(\d{1,5})\s*[x×]\s*(` + SKU + ")", "g"))) add(m[2], m[1]);
    for (const m of t.matchAll(new RegExp(String.raw`×\s*(\d{1,5})\b[^×]{0,120}?SKU:\s*(` + SKU + ")", "g"))) add(m[2], m[1]);
    for (const m of t.matchAll(new RegExp(SKU, "g"))) add(m[0], "");
    // Drop a bare SKU that is the same item as one found with a quantity but
    // spelled with/without the pack-digit prefix ("FB-7315-YL" vs "3 FB-7315-YL").
    return order
      .filter((s) => !(qty.get(s) === "" && order.some((o) => o !== s && (o.endsWith(" " + s) || s.endsWith(" " + o)) && qty.get(o))))
      .slice(0, 12)
      .map((s) => (qty.get(s) ? qty.get(s) + "× " + s : s));
  }

  const STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|" +
    "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Puerto Rico|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming";

  // The ship-to block, from its label through "<State> <ZIP>". The newest one
  // wins, since a thread's later message corrects an earlier address.
  function extractShipTo(t) {
    const re = new RegExp(
      String.raw`\b(?:Shipping address|Ship(?:ping)? to|Deliver to)\s*:?\s*(.{5,200}?\b(?:` + STATES + String.raw`)\.?,?\s+\d{5}(?:-\d{4})?)\b`, "gi");
    const all = [...(t || "").matchAll(re)];
    return all.length ? clip(all[all.length - 1][1], 200) : null;
  }

  function extractTerms(t) {
    const m = (t || "").match(/\bNet\s?(\d{1,3})\b|\b(Due on (?:receipt|fulfillment)|Prepaid|C\.?O\.?D\.?|Credit card on file)\b/i);
    return m ? (m[1] ? "Net " + m[1] : m[2]) : null;
  }

  // ---- ROUTE: which skill should take this thread ---------------------------
  // A hint, not an order: INTENT stays "process" and Cowork's own classifier
  // decides. First matching rule wins. Edit this table to change routing; keep
  // it free of customer or vendor names (this repository is public).
  // ctx: { subject, from (latest sender email), own (your mail domain), text }
  const ROUTES = [
    ["process-maytronics-dropshipments", (c) => /^\[[^\]]+\] Order #\d+ placed by/i.test(c.subject) && /\b(Dolphin|Maytronics)\b/i.test(c.text)],
    ["process-website-dropship-orders", (c) => /^\[[^\]]+\] Order #\d+ placed by/i.test(c.subject)],
    ["answer-customer-question", (c) => /@shopify\.com$/i.test(c.from) && /customer message/i.test(c.subject)],
    ["(FYI: payment received)", (c) => /^Payment received/i.test(c.subject)],
    ["(FYI: our invoice/estimate sent)", (c) => /@notification\.intuit\.com$/i.test(c.from) && /^(Invoice|Estimate) #?\d+ from/i.test(c.subject)],
    ["(vendor reply on our PO)", (c) => /Purchase Order #?\d+ from /i.test(c.subject)],
    ["process-shipment", (c) => c.own && c.from.endsWith("@" + c.own) && /\b(shipp(?:ed|ing)|tracking)\b/i.test(c.latest)],
    ["(FYI: carrier notice)", (c) => /@([\w-]+\.)*(ups|fedex|usps|mothership|71lbs)\.com$/i.test(c.from)],
    ["process-sales-order", (c) => !(c.own && c.from.endsWith("@" + c.own)) &&
      /\b(purchase order|new purchase|blanket release|P\.?O\.?\s*#?\s*:?\s*[A-Z]{0,4}-?\d{3,})/i.test(c.subject + " " + c.latest)],
    ["process-bill", (c) => !(c.own && c.from.endsWith("@" + c.own)) && /\b(invoice|statement|bill)\b/i.test(c.subject)],
    ["aquamentor-create-estimate", (c) => /\b(quote|pricing|price)\b/i.test(c.subject + " " + c.latest)],
    ["(FYI: automated notice)", (c) => /(no-?reply|do-?not-?reply|alerts?|notifications?)[@.]/i.test(c.from)],
  ];

  function routeFor(ctx) {
    const c = {
      subject: ctx.subject || "", from: (ctx.from || "").toLowerCase(),
      own: (ctx.own || "").toLowerCase(), text: ctx.text || "", latest: ctx.latest || "",
    };
    const hit = ROUTES.find(([, test]) => test(c));
    return hit ? hit[0] : null;
  }

  // Inline signature images are not attachments anyone needs.
  const isInlineImage = (name) => /^(image|Outlook-|logo)[\w-]*\.(png|jpe?g|gif)$/i.test(name);

  // Renders the Cowork blurb. `meta` is the DOM-gathered identity (IDs, account,
  // subject, attachments); `d` is the fetched thread digest (FROM/TO/DATE, body,
  // money) — d may be null if the fetch failed, in which case we still emit the
  // identity block (and whatever the subject alone gives) so Claude's connector
  // can pull the rest via THREAD_ID.
  // Labels THREAD_ID, PERMALINK, INTENT and LATEST MESSAGE are read by the
  // email-processing and inbox-sweep skills: keep their names.
  function buildBlurb(meta, d) {
    const tid = meta.threadId || "";
    const L = [];
    const put = (k, v) => { if (v) L.push(k + ": " + v); };
    put("SUBJECT", meta.subject || "(no subject)");
    put("THREAD_ID", tid);
    const ids = meta.msgIds || [];
    if (ids.length > 1 || (ids.length === 1 && ids[0] !== tid)) put("MSG_IDS", "[" + ids.join(", ") + "]");
    if (tid) put("PERMALINK", "https://mail.google.com/mail/u/" + meta.account + "/#all/" + tid);
    put("ACCOUNT", "u/" + meta.account + (meta.email ? " (" + meta.email + ")" : ""));

    const text = (meta.subject || "") + "\n" + ((d && d.text) || "");
    const latest = (d && d.latest) || {};
    const fromEmail = ((latest.from || "").match(/<([^>]+)>/) || [])[1] || "";
    put("ROUTE", routeFor({
      subject: meta.subject, from: fromEmail, text,
      // A shared free-mail domain says nothing about who is a teammate.
      own: /^(gmail|googlemail|yahoo|outlook|hotmail|icloud|aol)\./i.test((meta.email || "").split("@")[1] || "")
        ? "" : (meta.email || "").split("@")[1] || "",
      latest: (d && d.latestText) || "",
    }));
    put("REFS", extractRefs(text).join(" · "));
    put("TRACK", extractTracking(text).join(" · "));
    put("LINES", extractLines(text).join(" · "));
    put("SHIP_TO", extractShipTo(text));
    if (d && d.money) put("MONEY", d.money.replace(/\s{2,}/g, " "));
    put("TERMS", extractTerms(text));

    if (latest.from) {
      put("FROM", latest.from + (latest.to ? " → " + latest.to : "") + (latest.date ? " · " + latest.date : ""));
    }
    const atts = (meta.attachments || []).filter((a) => !isInlineImage(a.name));
    if (atts.length) {
      const sizes = (d && d.attachmentSizes) || [];
      put("ATTACHMENTS", atts.map((a, i) => {
        const size = a.size || sizes[i] || "";
        return a.name + (size ? " (" + size + ")" : "");
      }).join(", "));
    }

    if (d && d.latestBody) {
      L.push("LATEST MESSAGE:", d.latestBody);
      if (d.earlier && d.earlier.length) {
        L.push("EARLIER (newest first):");
        d.earlier.forEach((m) => L.push("• " + m.date + " " + m.who + ": " + m.gist));
      }
      if (d.omitted) L.push("• (+" + d.omitted + " older, fetch via THREAD_ID)");
    } else {
      L.push("BODY: (open the thread via THREAD_ID to read it)");
    }
    put("INTENT", "process");
    return L.join("\n");
  }

  const api = {
    clip, shortDate, shortSender, decodeStrip, cleanBody, normalizeDate,
    extractMoney, stripRecipients, senderBefore, parsePrintView, buildBlurb,
    extractRefs, extractTracking, extractLines, extractShipTo, extractTerms, routeFor, ROUTES,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GmailParsers = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

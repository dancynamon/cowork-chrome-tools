'use strict';
// gmail/parsers.js against synthetic print-view fixtures (test/fixtures/gmail/,
// fictional people and domains). When Gmail changes its print view, save a new
// fixture that reproduces the break and add a case here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../gmail/parsers.js');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'gmail', name), 'utf8');

test('extractMoney: comma thousands, missing cents, labels', () => {
  assert.equal(P.extractMoney('Total Due: $1,234.56'), '$1,234.56  (status: DUE)');
  assert.equal(P.extractMoney('Balance Due $12,000 by Friday'), '$12,000  (status: DUE)');
  assert.equal(P.extractMoney('Grand Total: $1,000,000.00'), '$1,000,000.00');
  assert.equal(P.extractMoney('fee $1,200 and $35'), '$1,200'); // no label: largest
  assert.equal(P.extractMoney('Pay $9 now'), '$9');
});

test('extractMoney: "Subtotal" is not a label; "Total" after it wins', () => {
  assert.equal(P.extractMoney('Subtotal: $100.00 Tax $8.25 Total: $108.25'), '$108.25');
});

test('extractMoney: negatives keep their sign', () => {
  assert.equal(P.extractMoney('Refund -$45.00'), '-$45.00');
  assert.equal(P.extractMoney('adjustment $-9.99'), '-$9.99');
  assert.equal(P.extractMoney('credit ($12.50) applied'), '-$12.50');
  assert.equal(P.extractMoney('Amount Due: -$1,250.00'), '-$1,250.00  (status: DUE)');
  // Largest by size, either side of zero.
  assert.equal(P.extractMoney('shipping $20.00, refund -$500.00'), '-$500.00');
  // A spaced list dash is not a minus sign.
  assert.equal(P.extractMoney('Pump kit - $20.00'), '$20.00');
});

test('extractMoney: paid/due status and card', () => {
  assert.equal(P.extractMoney('Amount Paid: $2,635.00 charged to VISA ending 4242'),
    '$2,635.00  (status: PAID, VISA x4242)');
  assert.equal(P.extractMoney('Invoice $300, terms Net 30'), '$300  (status: DUE)');
  assert.equal(P.extractMoney('PAID $50 American Express ending in 1005'),
    '$50  (status: PAID, AMEX x1005)');
});

test('extractMoney: no dollar figure gives null', () => {
  assert.equal(P.extractMoney('no money here'), null);
  assert.equal(P.extractMoney('USD 40 and 12.00'), null);
  assert.equal(P.extractMoney('$'), null);
  assert.equal(P.extractMoney('$, then'), null);
});

test('normalizeDate: AM/PM, noon and midnight, padding', () => {
  assert.equal(P.normalizeDate('Thu, Jun 11, 2026 at 6:20 PM'), '2026-06-11 18:20');
  assert.equal(P.normalizeDate('Mon, Jan 5, 2026 at 9:05 AM'), '2026-01-05 09:05');
  assert.equal(P.normalizeDate('Wed, Jun 10, 2026 at 12:15 AM'), '2026-06-10 00:15');
  assert.equal(P.normalizeDate('Wed, Jun 10, 2026 at 12:15 PM'), '2026-06-10 12:15');
  assert.equal(P.normalizeDate('Sat, Dec 31, 2026 at 11:59 PM'), '2026-12-31 23:59');
});

test('normalizeDate: full month names, no space or a narrow no-break space before PM', () => {
  assert.equal(P.normalizeDate('Tue, September 1, 2026 at 7:00 AM'), '2026-09-01 07:00');
  assert.equal(P.normalizeDate('Fri, Oct 2, 2026 at 4:07PM'), '2026-10-02 16:07');
  assert.equal(P.normalizeDate('Fri, Oct 2, 2026 at 4:07 PM'), '2026-10-02 16:07');
});

test('normalizeDate: anything else is returned unchanged', () => {
  assert.equal(P.normalizeDate('yesterday'), 'yesterday');
  assert.equal(P.normalizeDate('2026-06-11 18:20'), '2026-06-11 18:20');
});

test('decodeStrip: tags out, entities (named and numeric) decoded', () => {
  const t = P.decodeStrip('<style>x{}</style><p>A &amp; B&nbsp;&lt;a@b.example&gt; it&#39;s &quot;ok&quot;&#8239;&#x41;</p>');
  assert.equal(t.trim(), 'A & B <a@b.example> it\'s "ok" A');
});

test('parsePrintView: three-message invoice thread', () => {
  const d = P.parsePrintView(fixture('thread-invoice.html'));
  assert.equal(d.count, '3');
  assert.equal(d.shown, 3);
  assert.equal(d.firstDate, 'Mon, Jun 8, 2026 at 9:05 AM');
  assert.equal(d.lastDate, 'Wed, Jun 10, 2026 at 12:15 AM');
  assert.deepEqual(d.latest, {
    from: 'Pat Rivera <pat@supply.example.net>',
    to: 'buyer@example.com',
    date: '2026-06-10 00:15'
  });
  assert.deepEqual(d.participants, ['buyer@example.com', 'pat@supply.example.net', 'ap@example.com']);
  // The newest message's "Amount Paid" beats the first message's "Total Due".
  assert.equal(d.money, '$2,635.00  (status: PAID, VISA x4242)');
  assert.deepEqual(d.attachmentSizes, ['212K']);
  assert.match(d.latestBody, /^Freight is \$185/);
  assert.doesNotMatch(d.latestBody, /Quoted text hidden/);
  assert.equal(d.omitted, 0);
  assert.deepEqual(d.earlier.map((m) => [m.date, m.who]), [['Jun 9', 'Sam Lee'], ['Jun 8', 'Pat Rivera']]);
  // Header lines, mobile signature, quoted history and legal footer are gone.
  const [reply, first] = d.earlier.map((m) => m.gist);
  assert.equal(reply, 'Got it & thanks. Can you confirm the freight line? I\'ll pay this week.');
  assert.doesNotMatch(first, /confidential/);
  assert.match(first, /Total Due: \$2,450\.00/);
});

test('parsePrintView: single message with &#8239; before PM and a negative amount', () => {
  const d = P.parsePrintView(fixture('single-refund.html'));
  assert.equal(d.shown, 1);
  assert.equal(d.count, '1');
  assert.equal(d.latest.from, 'Store Support <support@shop.example.org>');
  assert.equal(d.latest.to, 'customer@example.com');
  assert.equal(d.latest.date, '2026-10-02 16:07');
  assert.equal(d.money, '-$45.00  (MASTERCARD x5100)');
  assert.deepEqual(d.earlier, []);
});

test('parsePrintView: a page with no message headers gives null, not a throw', () => {
  assert.equal(P.parsePrintView(fixture('no-messages.html')), null);
  assert.equal(P.parsePrintView(''), null);
});

test('parsePrintView: long threads keep 6 earlier gists and count the rest', () => {
  const names = ['Ana Ortiz', 'Ben Cho', 'Cara Diaz', 'Dev Shah', 'Eli Moss', 'Fay Wu', 'Gus Hale', 'Hana Ito', 'Ivo Park'];
  const msgs = [];
  for (let i = 1; i <= 9; i++) {
    msgs.push(`<b>${names[i - 1]}</b> &lt;p${i}@example.com&gt; Mon, Mar ${i}, 2026 at 10:0${i} AM` +
      `<div>To: team@example.com</div><div>Update number ${i}.</div>`);
  }
  const d = P.parsePrintView('<div>9 messages</div>' + msgs.join('<hr>'));
  assert.equal(d.count, '9');
  assert.equal(d.shown, 9);
  assert.equal(d.latestBody, 'Update number 9.');
  assert.equal(d.earlier.length, 6);
  // Each gist stops before the next message's "Name <email>".
  assert.deepEqual(d.earlier[0], { date: 'Mar 8', who: 'Hana Ito', gist: 'Update number 8.' });
  assert.equal(d.latest.from, 'Ivo Park <p9@example.com>');
  assert.equal(d.omitted, 2);
});

test('buildBlurb: compact identity block plus digest, and identity alone when the fetch failed', () => {
  const meta = {
    account: '0', email: 'buyer@example.com', threadId: '18f0a1b2c3d4e5f6',
    msgIds: ['18f0a1b2c3d4e5f6', '18f0a1b2c3d4e5f7'], subject: 'Invoice 4417',
    attachments: [{ name: 'INV-4417.pdf', size: '' }, { name: 'image001.png', size: '' }]
  };
  const d = P.parsePrintView(fixture('thread-invoice.html'));
  const full = P.buildBlurb(meta, d).split('\n');
  assert.equal(full[0], 'SUBJECT: Invoice 4417');
  // Labels the email-processing / inbox-sweep skills read keep their names.
  assert.ok(full.includes('THREAD_ID: 18f0a1b2c3d4e5f6'));
  assert.ok(full.includes('PERMALINK: https://mail.google.com/mail/u/0/#all/18f0a1b2c3d4e5f6'));
  assert.ok(full.includes('LATEST MESSAGE:'));
  assert.equal(full[full.length - 1], 'INTENT: process');
  assert.ok(full.includes('FROM: Pat Rivera <pat@supply.example.net> → buyer@example.com · 2026-06-10 00:15'));
  assert.ok(full.includes('ATTACHMENTS: INV-4417.pdf (212K)'), 'inline signature image dropped');
  assert.ok(full.includes('MONEY: $2,635.00 (status: PAID, VISA x4242)'));
  assert.ok(full.includes('REFS: INV 4417'));
  assert.ok(full.includes('TERMS: Net 30'));
  assert.ok(full.includes('ROUTE: process-bill'));
  assert.ok(!full.some((l) => l === ''), 'no blank lines');

  const bare = P.buildBlurb(meta, null);
  assert.match(bare, /BODY: \(open the thread via THREAD_ID to read it\)/);
  assert.doesNotMatch(bare, /MONEY:/);
  assert.match(bare, /REFS: INV 4417/, 'the subject alone still gives refs');
});

test('buildBlurb: MSG_IDS only when it says more than THREAD_ID', () => {
  const one = P.buildBlurb({ account: '0', threadId: 'aa1', msgIds: ['aa1'], subject: 's' }, null);
  assert.doesNotMatch(one, /MSG_IDS/);
  const two = P.buildBlurb({ account: '0', threadId: 'aa1', msgIds: ['aa1', 'aa2'], subject: 's' }, null);
  assert.match(two, /MSG_IDS: \[aa1, aa2\]/);
});

const blurbFor = (file, meta) => P.buildBlurb(
  { account: '0', threadId: 'abc123', msgIds: ['abc123'], ...meta },
  P.parsePrintView(fixture(file))).split('\n');

test('fixture: Shopify order notification → lines, ship-to, terms, website route', () => {
  const b = blurbFor('shopify-order.html',
    { subject: '[Example Store] Order #1042 placed by Jo Tester', email: 'owner@store.example.com' });
  assert.ok(b.includes('ROUTE: process-website-dropship-orders'));
  assert.ok(b.includes('REFS: ORDER 1042'));
  assert.ok(b.includes('LINES: 6× DMO-50-RD-CL · 1× DMO-1SIDE-SETUP'));
  assert.ok(b.includes('SHIP_TO: Jo Tester 100 Sample Rd Springfield, Utah 84000'));
  assert.ok(b.includes('MONEY: $504.20'));
  assert.ok(b.includes('TERMS: Due on fulfillment'));
});

test('fixture: emailed customer PO → PO ref, quantities, ship-to, sales-order route', () => {
  const b = blurbFor('customer-po.html', {
    subject: 'PURCHASE ORDER # F2000123', email: 'orders@vendor.example.com',
    attachments: [{ name: 'PO-F2000123.pdf', size: '' }]
  });
  assert.ok(b.includes('ROUTE: process-sales-order'));
  assert.ok(b.includes('REFS: PO F2000123'));
  assert.ok(b.includes('LINES: 120× DMO-50-RD-PL · 40× DMO-40-RD-PL'));
  assert.ok(b.includes('SHIP_TO: Example Pools Warehouse, 55 Dock St, Unit 4, Dallas, TX 75001'));
  assert.ok(b.includes('TERMS: Net 30'));
  assert.ok(b.includes('ATTACHMENTS: PO-F2000123.pdf (88K)'));
});

test('fixture: same-domain shipment reply → tracking, SO/PO refs, shipment route', () => {
  const b = blurbFor('shipment-reply.html',
    { subject: 'Re: SO #1500 / Example Pools PO F2000123', email: 'owner@vendor.example.com' });
  assert.ok(b.includes('ROUTE: process-shipment'));
  assert.ok(b.includes('REFS: PO F2000123 · SO 1500'));
  assert.ok(b.includes('TRACK: 123456789012 FedEx'));
  assert.ok(b.includes('MONEY: $48.10'));
});

test('extractRefs: markers, glued and spaced forms, and the false friends', () => {
  assert.deepEqual(P.extractRefs(
    'Order 960837 (REF PO 8721) PO160272 po#AHS-1418568 SO #1191 Invoice #0348348 Estimate #3656 Order #6169'),
    ['PO 8721', 'PO 160272', 'PO AHS-1418568', 'SO 1191', 'INV 0348348', 'EST 3656', 'ORDER 960837', 'ORDER 6169']);
  // Not references: dates and words after PO / Purchase Order, "so" in prose,
  // and "Purchase Order #" is a PO, not an ORDER.
  assert.deepEqual(P.extractRefs('Purchase Order Date: 2026-11-04. PO deliver date 11/7. so 300 of them.'), []);
  assert.deepEqual(P.extractRefs('Purchase Order #8720 from Example, Inc.'), ['PO 8720']);
  assert.deepEqual(P.extractRefs(''), []);
});

test('extractTracking: UPS, USPS, FedEx only with a tracking word, never an account number', () => {
  assert.deepEqual(P.extractTracking('Tracking 1Z999AA10123456784 and 9400111899223100012345'),
    ['1Z999AA10123456784 UPS', '9400111899223100012345 USPS']);
  assert.deepEqual(P.extractTracking('FedEx tracking: 123456789012'), ['123456789012 FedEx']);
  assert.deepEqual(P.extractTracking('call 123456789012'), []);
  assert.deepEqual(P.extractTracking('ship FedEx, bill acct #123456789012'), []);
});

test('extractLines: "N x SKU", pack-prefixed SKUs, bare SKUs; dates and one-dash codes are not SKUs', () => {
  assert.deepEqual(P.extractLines('2 x 3 AB-CD-100 and 275 x XYZ-50-RD'), ['2× 3 AB-CD-100', '275× XYZ-50-RD']);
  assert.deepEqual(P.extractLines('Item # PM-STF-RD-4848, PM-TUR-PU-4836'), ['PM-STF-RD-4848', 'PM-TUR-PU-4836']);
  assert.deepEqual(P.extractLines('on 2026-11-04 ref ET-ET12956 id bf8499b0-6860-4162'), []);
});

test('extractShipTo / extractTerms', () => {
  assert.equal(P.extractShipTo('Ship to: A Co, 1 Main St, Garden City, NY 11530-1234 thanks'), 'A Co, 1 Main St, Garden City, NY 11530-1234');
  assert.equal(P.extractShipTo('Ship to the usual place'), null);
  assert.equal(P.extractTerms('terms net30'), 'Net 30');
  assert.equal(P.extractTerms('Payment terms Due on receipt'), 'Due on receipt');
  assert.equal(P.extractTerms('nothing'), null);
});

test('routeFor: first matching rule wins; no rule gives null', () => {
  const r = (o) => P.routeFor({ subject: '', from: '', own: 'vendor.example.com', text: '', latest: '', ...o });
  assert.equal(r({ subject: '[Shop] Order #12 placed by A', text: 'Dolphin Wave 80' }), 'process-maytronics-dropshipments');
  assert.equal(r({ subject: 'New customer message on May 1', from: 'mailer@shopify.com' }), 'answer-customer-question');
  assert.equal(r({ subject: 'Payment received: Invoice #18940' }), '(FYI: payment received)');
  assert.equal(r({ subject: 'RE: Purchase Order #8720 from Vendorside, Inc.', from: 'cs@supplier.example.net' }), '(vendor reply on our PO)');
  assert.equal(r({ from: 'ship@vendor.example.com', latest: 'shipped today' }), 'process-shipment');
  assert.equal(r({ from: 'pkginfo@ups.com', subject: 'Your Label Is Ready' }), '(FYI: carrier notice)');
  assert.equal(r({ subject: 'New Purchase - PO160272', from: 'buyer@customer.example.org' }), 'process-sales-order');
  // Our own outgoing PO talk is not a customer PO.
  assert.equal(r({ subject: 'PO 8721 question', from: 'me@vendor.example.com' }), null);
  assert.equal(r({ subject: 'Attached is an Invoice dated 11/3', from: 'invoices@supplier.example.net' }), 'process-bill');
  assert.equal(r({ subject: 'Price & Freight Quote', from: 'kelly@customer.example.org' }), 'aquamentor-create-estimate');
  assert.equal(r({ subject: 'hello', from: 'friend@example.org' }), null);
});

test('buildBlurb: on a free-mail account, a same-domain sender is not treated as a teammate', () => {
  const d = P.parsePrintView(fixture('shipment-reply.html'));
  const b = P.buildBlurb({ account: '1', threadId: 'x1', subject: 'Re: hello', email: 'someone@gmail.com' },
    { ...d, latest: { ...d.latest, from: 'Pal <pal@gmail.com>' } });
  assert.doesNotMatch(b, /ROUTE: process-shipment/);
});

test('ROUTES: the public table names no customer or vendor domains', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gmail', 'parsers.js'), 'utf8');
  const table = src.slice(src.indexOf('const ROUTES = ['), src.indexOf('function routeFor'));
  // "@shopify\.com" and alternations like "(ups|fedex)\.com" alike.
  const domains = [...table.matchAll(/([\w|-]+)\)?\\\.(com|net|org)/gi)]
    .flatMap((m) => m[1].toLowerCase().split('|'));
  assert.ok(domains.includes('fedex') && domains.includes('shopify'), 'guard sees the table');
  const allowed = ['shopify', 'intuit', 'notification', 'ups', 'fedex', 'usps', 'mothership', '71lbs'];
  for (const d of domains) assert.ok(allowed.includes(d), 'unexpected domain in ROUTES: ' + d);
});

test('content.js reads the parsers from the GmailParsers global the manifest loads first', () => {
  const vm = require('vm');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gmail', 'parsers.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.GmailParsers.parsePrintView, 'function');
  assert.equal(typeof ctx.GmailParsers.buildBlurb, 'function');
  const content = fs.readFileSync(path.join(__dirname, '..', 'gmail', 'content.js'), 'utf8');
  assert.match(content, /= window\.GmailParsers;/);
});

test('check-received fixture: routes to receive-check-payment, CHECK ref, signature trimmed', () => {
  const b = blurbFor('check-received.html',
    { subject: 'Check 11/6/26', email: 'owner@vendor.example.com' });
  assert.ok(b.includes('ROUTE: receive-check-payment'), b);
  assert.ok(b.includes('REFS: CHECK 3060892'), b);
  assert.ok(b.includes('MONEY: $2,091'), b);
  assert.equal(b[b.indexOf('LATEST MESSAGE:') + 1], 'Example Health System Check #: 3060892 Amount: $2,091');
  assert.doesNotMatch(b.join('\n'), /Vice President|555-555-0100/);
});

test('extractRefs: CHECK numbers, but not a date or the verb "check"', () => {
  assert.deepEqual(P.extractRefs('Check #: 3060892, Chk No. 1188, cheque number 4402'),
    ['CHECK 3060892', 'CHECK 1188', 'CHECK 4402']);
  assert.deepEqual(P.extractRefs('Check 11/6/26. Please check the 2 boxes.'), []);
});

test('routeFor: check payments, but not bank deposit alerts or "check PO"', () => {
  const r = (subject, latest, from = 'pat@customer.example.com') => P.routeFor({ subject, from, latest, text: latest });
  assert.equal(r('Payment', 'Check #: 3060892 Amount: $2,091'), 'receive-check-payment');
  assert.equal(r('Fwd: Checks', 'two came in today, $410 and $96'), 'receive-check-payment');
  assert.equal(r('Your check deposit', 'Check #1234 deposited', 'alerts@bank.example.com'), '(FYI: automated notice)');
  assert.notEqual(r('Question', 'can you check PO #4417 for me'), 'receive-check-payment');
});

test('trimSignature: cuts the sender block, keeps sign-offs and bodies that only mention them', () => {
  const s = 'Pat Q. <pat@x.example.com>';
  assert.equal(P.trimSignature('Got it. Thanks, Pat Quinn Sales pat@x.example.com P: 555', s), 'Got it. Thanks,');
  assert.equal(P.trimSignature('Got it. Pat Quinn pat@x.example.com', s), 'Got it.');
  assert.equal(P.trimSignature('Reach me at pat@x.example.com' + ' and more text'.repeat(40), s).length > 400, true);
  assert.equal(P.trimSignature('Pat pat@x.example.com', s), 'Pat pat@x.example.com');
  assert.equal(P.trimSignature('No address here', s), 'No address here');
});

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

test('buildBlurb: identity block plus digest, and identity alone when the fetch failed', () => {
  const meta = {
    account: '0', email: 'buyer@example.com', threadId: '18f0a1b2c3d4e5f6',
    msgIds: ['18f0a1b2c3d4e5f6', '18f0a1b2c3d4e5f7'], subject: 'Invoice 4417',
    attachments: [{ name: 'INV-4417.pdf', size: '' }]
  };
  const d = P.parsePrintView(fixture('thread-invoice.html'));
  const full = P.buildBlurb(meta, d).split('\n');
  assert.equal(full[0], 'SUBJECT:    Invoice 4417');
  assert.ok(full.includes('THREAD_ID:  18f0a1b2c3d4e5f6'));
  assert.ok(full.includes('PERMALINK:  https://mail.google.com/mail/u/0/#all/18f0a1b2c3d4e5f6'));
  assert.ok(full.includes('FROM:       Pat Rivera <pat@supply.example.net>'));
  assert.ok(full.includes('DATE:       2026-06-10 00:15'));
  assert.ok(full.includes('  - INV-4417.pdf (212K)'));
  assert.ok(full.includes('MONEY:      $2,635.00  (status: PAID, VISA x4242)'));

  const bare = P.buildBlurb(meta, null);
  assert.match(bare, /BODY: \(open the thread via THREAD_ID to read it\)/);
  assert.doesNotMatch(bare, /MONEY:/);
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

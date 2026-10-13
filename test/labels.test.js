'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, plain } = require('./chrome-mock');

const { ctx, get } = loadBackground();
const { labelForUrl, isReplaceableTitle, dominantLabel } = ctx;

test('labelForUrl: mapped sites', () => {
  const cases = {
    'https://admin.shopify.com/store/aquamentor/orders': ['Shopify', 'purple'],
    'https://aquamentor.myshopify.com/admin': ['Shopify', 'purple'],
    'https://sellercentral.amazon.com/orders-v3': ['Amazon', 'orange'],
    'https://qbo.intuit.com/app/invoices': ['QBO', 'green'],
    'https://accounts.intuit.com/signin': ['QBO', 'green'],
    'https://mail.google.com/mail/u/0/#inbox': ['Gmail', 'grey'],
    'https://docs.google.com/spreadsheets/d/x': ['Docs', 'grey'],
    'https://app.71lbs.com/labels': ['71lbs', 'blue'],
    'https://www.ups.com/track': ['UPS', 'blue'],
    'https://www.fedex.com/en-us/home.html': ['FedEx', 'blue'],
    'https://app.gtzship.com/quote': ['Freight', 'blue'],
    'https://app.hubspot.com/contacts/1': ['HubSpot', 'orange'],
    'https://partners-portal.maytronics.com/': ['Maytronics', 'cyan']
  };
  for (const [url, [label, color]] of Object.entries(cases)) {
    assert.deepEqual(plain(labelForUrl(url)), { label, color }, url);
  }
});

test('labelForUrl: fallback to capitalized second-level domain', () => {
  assert.deepEqual(plain(labelForUrl('https://www.brightermarine.com/x')), { label: 'Brightermarine', color: 'cyan' });
  assert.deepEqual(plain(labelForUrl('https://shop.example.co/')), { label: 'Example', color: 'cyan' });
  assert.deepEqual(plain(labelForUrl('http://localhost:3000/')), { label: 'Localhost', color: 'cyan' });
});

test('labelForUrl: lookalike hosts are not mapped', () => {
  // "notmail.google.com" must not count as Gmail; "evilups.com" not as UPS.
  assert.equal(labelForUrl('https://notmail.google.com/').label, 'Google');
  assert.equal(labelForUrl('https://evilups.com/').label, 'Evilups');
});

test('labelForUrl: unparseable or host-less URLs give null', () => {
  assert.equal(labelForUrl(''), null);
  assert.equal(labelForUrl('not a url'), null);
  assert.equal(labelForUrl('about:blank'), null);
});

test('isReplaceableTitle: defaults are replaceable', () => {
  for (const t of plain(get('DEFAULT_TITLES'))) assert.equal(isReplaceableTitle(t, undefined), true, JSON.stringify(t));
  assert.equal(isReplaceableTitle(undefined, undefined), true);
});

test('isReplaceableTitle: our own last label is replaceable, anything else is not', () => {
  assert.equal(isReplaceableTitle('Shopify', 'Shopify'), true);
  assert.equal(isReplaceableTitle('Shopify', 'QBO'), false);       // renamed since
  assert.equal(isReplaceableTitle('Kiefer Pallet', undefined), false); // session-set
  assert.equal(isReplaceableTitle('claude', undefined), false);      // case-sensitive
  assert.equal(isReplaceableTitle('', ''), true);
});

test('status emoji: Claude in Chrome prefixes are ignored when comparing titles', () => {
  for (const t of ['Claude', '⌛Claude', '✅Claude', '✅ Claude', '⌛ ', '']) {
    assert.equal(ctx.isDefaultTitle(t), true, JSON.stringify(t));
  }
  assert.equal(ctx.isDefaultTitle('⌛Kiefer Pallet'), false);
  assert.deepEqual(plain(ctx.splitStatus('⌛Kiefer Pallet')), { prefix: '⌛', base: 'Kiefer Pallet' });
  assert.deepEqual(plain(ctx.splitStatus('✅️ Done')), { prefix: '✅️ ', base: 'Done' });
  // Leading digits, # and letters are part of the name, not a status prefix.
  assert.equal(ctx.baseTitle('#42 Order'), '#42 Order');
  assert.equal(ctx.baseTitle('71lbs'), '71lbs');
});

test('isReplaceableTitle: our label with a status emoji added is still ours', () => {
  assert.equal(isReplaceableTitle('⌛Shopify', 'Shopify'), true);
  assert.equal(isReplaceableTitle('⌛Kiefer Pallet', 'Shopify'), false);
});

test('dominantLabel: most common site wins over first tab', () => {
  const pick = dominantLabel([
    'https://mail.google.com/',
    'https://qbo.intuit.com/a',
    'https://qbo.intuit.com/b'
  ], 'Claude');
  assert.equal(pick.label, 'QBO');
});

test('dominantLabel: tie goes to the left-most tab', () => {
  const pick = dominantLabel(['https://app.71lbs.com/', 'https://admin.shopify.com/'], '');
  assert.equal(pick.label, '71lbs');
});

test('dominantLabel: tie keeps the incumbent label (no flip-flop)', () => {
  const pick = dominantLabel(['https://app.71lbs.com/', 'https://admin.shopify.com/'], 'Shopify');
  assert.equal(pick.label, 'Shopify');
});

test('dominantLabel: incumbent loses only when strictly outnumbered', () => {
  const urls = ['https://admin.shopify.com/', 'https://app.71lbs.com/', 'https://app.71lbs.com/x'];
  assert.equal(dominantLabel(urls, 'Shopify').label, '71lbs');
});

test('dominantLabel: no labelable tabs gives null', () => {
  assert.equal(dominantLabel(['', 'about:blank'], ''), null);
  assert.equal(dominantLabel([], ''), null);
});

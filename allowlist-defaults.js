// Cowork Tab Group Namer - sites allowed to use the page bridge by default
//
// Used when the popup's "Allowed sites" list is empty. These are the sites
// auto.js already knows (SITE_MAP), i.e. where Cowork sessions actually work.
// Any other page gets "ERROR: site not in allowlist" until you add it in the
// popup; a single "*" entry there allows every site (the pre-2.1.0 default).
// Loaded by background.js (importScripts) and popup.html.

const DEFAULT_ALLOWLIST = [
  'admin.shopify.com',
  '*.myshopify.com',
  'sellercentral.amazon.com',
  '*.intuit.com',
  'mail.google.com',
  'docs.google.com',
  '*.71lbs.com',
  '*.ups.com',
  '*.fedex.com',
  '*.gtzship.com',
  '*.globaltranz.com',
  'app.hubspot.com',
  '*.maytronics.com'
];

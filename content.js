// Cowork Tab Group Namer - content script (isolated world)
//
// Bridge between page-context JavaScript (what Claude can execute via
// javascript_tool / execute_javascript) and the extension background worker.
//
// Protocol: page context sets attributes on <html>:
//     document.documentElement.setAttribute('data-cowork-group-color', 'blue');   // optional, set FIRST
//     document.documentElement.setAttribute('data-cowork-group-title', 'Kiefer Pallet');
//
// Attributes are plain strings on the shared DOM, so no cross-world object
// cloning is involved. The title attribute is the trigger; set color first.
//
// Result is written back to <html data-cowork-group-result="..."> so the caller
// can read it in the same page context.
//
// Read-back: set any value on data-cowork-group-query to have the
// CURRENT group title written to data-cowork-group-result, without changing it:
//     document.documentElement.setAttribute('data-cowork-group-query', '1');

const TITLE_ATTR  = 'data-cowork-group-title';
const COLOR_ATTR  = 'data-cowork-group-color';
const QUERY_ATTR  = 'data-cowork-group-query';
const RESULT_ATTR = 'data-cowork-group-result';

const VALID_COLORS = [
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'
];

function report(text) {
  try {
    document.documentElement.setAttribute(RESULT_ATTR, text);
  } catch (e) {
    // documentElement gone (navigation) - nothing to report to
  }
}

function query() {
  chrome.runtime.sendMessage({ type: 'getGroupTitle' }, (response) => {
    if (chrome.runtime.lastError) {
      report('ERROR: ' + chrome.runtime.lastError.message);
      return;
    }
    report(response && response.ok
      ? 'OK: groupId=' + response.groupId + ' title="' + response.title + '" color=' + response.color
      : 'ERROR: ' + ((response && response.error) || 'unknown'));
  });
}

function apply() {
  const root = document.documentElement;
  if (!root) return;

  const title = root.getAttribute(TITLE_ATTR);
  if (title === null) return;

  let color = root.getAttribute(COLOR_ATTR);
  if (color !== null) {
    color = String(color).toLowerCase().trim();
    if (!VALID_COLORS.includes(color)) {
      report('ERROR: invalid color "' + color + '"; valid: ' + VALID_COLORS.join(', '));
      return;
    }
  }

  chrome.runtime.sendMessage(
    { type: 'setGroupTitle', title: String(title), color: color || undefined },
    (response) => {
      if (chrome.runtime.lastError) {
        report('ERROR: ' + chrome.runtime.lastError.message);
        return;
      }
      report(response && response.ok
        ? 'OK: groupId=' + response.groupId + ' title="' + response.title + '"'
        : 'ERROR: ' + ((response && response.error) || 'unknown'));
    }
  );
}

// Fire on any change to the trigger attributes.
new MutationObserver((records) => {
  if (records.some((r) => r.attributeName === QUERY_ATTR)) { query(); return; }
  apply();
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: [TITLE_ATTR, COLOR_ATTR, QUERY_ATTR]
});

// Re-apply on load, so a label survives a full page navigation: the caller can
// leave the attribute in place via a re-injected snippet and this picks it up.
apply();

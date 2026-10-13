# Preferences snippet

Paste into Settings → Cowork preferences once the extension is loaded.
Replaces the earlier `document.title` block — delete that one.

```
## CHROME TAB GROUP LABELING
The "Cowork Tab Group Namer" extension is loaded in Chrome. At the start of any
task that opens Chrome tabs, derive a 2-4 word slug from my prompt (or use the
slug verbatim if I write "TAB: <slug>"). Once the first non-chrome:// page has
loaded in the session's tab group, run ONCE via
mcp__claude-in-chrome__javascript_tool:

  document.documentElement.setAttribute('data-cowork-group-color', 'blue');
  document.documentElement.setAttribute('data-cowork-group-title', '<SLUG>');
  await new Promise(r => setTimeout(r, 400));
  document.documentElement.getAttribute('data-cowork-group-result');

Expect "OK: groupId=... title=...". Report the error string if it is anything else.
NEVER modify document.title on any tab.
Re-run only if Claude in Chrome creates a new tab group mid-task (the label
survives navigation on its own).
```

Optional, extension 1.3.0+: the same call without the fixed sleep (returns as
soon as the result is written; the 2s timeout covers an older install):

```
  const root = document.documentElement;
  const done = new Promise(r => document.addEventListener('cowork-group-result',
    () => r(root.getAttribute('data-cowork-group-result')), { once: true }));
  root.setAttribute('data-cowork-group-color', 'blue');
  root.setAttribute('data-cowork-group-title', '<SLUG>');
  await Promise.race([done, new Promise(r => setTimeout(r, 2000))]);
  root.getAttribute('data-cowork-group-result');
```

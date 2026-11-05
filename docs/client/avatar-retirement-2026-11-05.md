# Retire Mini Corgi and Mini Croissant

`mini-corgi` and `mini-croissant` are removed from the avatar picker, client
shuffle and future Host assignments through the existing shared retirement
list. The active pool has 122 entries. The historical 145-entry catalog keeps
its order, IDs, names and packaged WebP assets. Existing saved PNG overrides
and persisted defaults remain valid, including when read by older clients.
No database rewrite or forced replacement is required.

App-managed and CLI-registered Bots consume the same active assignment pool;
no CLI command or protocol change is needed. First-Bot behavior and the original
36-entry fallback for legacy unassigned Bots stay unchanged. This change does
not publish or install an App.

The focused catalog regression failed before the two IDs were retired. Catalog,
Host assignment and avatar API tests then passed (18 tests), including every
active shuffle/assignment index, legacy mapping integrity, all retained image
paths, saved defaults, restart/retry, rollback and offline CLI registration.
Root and client translation/type/build checks passed.

Browser verification uses the built client and disposable Hubs. It checks both
removed choices are absent from desktop/phone pickers, every remaining tile
loads, keyboard navigation and saved custom-image synchronization/restoration
still work, and both retired defaults decode after a cold offline reload at
1360 px and 390 px. Chromium and WebKit each passed all nine cases. These are
browser checks, not installed-App or physical-device acceptance. Raw test evidence and fixture screenshots remain outside Git.

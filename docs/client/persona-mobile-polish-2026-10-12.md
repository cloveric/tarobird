# Editable Bot persona and phone layout corrections

Bot settings and conversation details now open a real persona editor. The owner
can read, edit and save the selected Bot's `agent.md` through the authenticated
Hub/Gateway. The editor states that every chat with the Bot shares the persona,
while chat history remains separate. Memory files and transport instructions are
not edited by this control. Changes are used by subsequent engine work; existing
history and active tasks are retained. Use a new chat for a fresh context.

Writes are limited to one fixed file and 16,000 characters (the common native
adapter limit), atomically replaced, and protected by an optimistic revision plus file mutex. One private previous version
is kept. Symlinks, invalid UTF-8, unreadable and oversized files are refused.
Audit records contain Bot identity only, never persona text. Missing-file
DeepSeek setups retain the harness instructions link so the first edit is usable.
An unconfirmed save is never silently retried. Drafts survive conflicts and closing
or reloading a dirty editor requires an explicit discard. Only owners can read
or change the persona; existing authorization and offline errors are retained.

The Me heading scrolls with the profile instead of covering it. The profile
container establishes its own formatting context and the page uses the shared
canvas. Search keeps one enclosing focus surface without the nested input's
second shadow. Android now paints the native insets with the web canvas and
switches status/navigation icon contrast with light/dark appearance. The last
native appearance is restored on resume. Native padding still reserves the
system bars, cutout and keyboard.

## Verification

- Standalone build and full core gate: 221 files; 2,861 passed, one existing skip.
- A final adapter-limit audit aligned the editor with the common 16,000-character
  native instruction limit. Four focused core tests and two Chromium journeys
  passed after that adjustment; the full gate above preceded this boundary fix.
- Chromium and WebKit cover real authenticated persona writes, independent-device
  reads, stale conflicts, draft preservation, permission rejection, unchanged
  session bindings and profile/search geometry. Existing mobile navigation,
  effort and settings lifecycle regressions were also run.
- A rerender test uncovered sibling key reuse in the new persona entry. It was
  corrected with a unique key and a one-avatar assertion. An initial desktop
  fixture pairing timeout was resolved by explicitly setting the fixture Hub URL.
- Android 16 emulator instrumentation exercises the installed isolated APK's real
  Capacitor appearance bridge. Light/dark native background, icon contrast,
  reserved inset and persisted appearance assertions pass. Screenshots show both
  system bars and the WebView. This is not a physical-device/OEM acceptance claim.
- The initial unscoped Gradle instrumentation command also selected third-party
  plugin test apps with conflicting Kotlin test dependencies. The intended
  `:app:connectedDebugAndroidTest` target passes without modifying dependencies.

Evidence: persona (historical image omitted from this clean snapshot),
Me (historical image omitted from this clean snapshot),
search (historical image omitted from this clean snapshot),
light native canvas (historical image omitted from this clean snapshot),
dark native canvas (historical image omitted from this clean snapshot).

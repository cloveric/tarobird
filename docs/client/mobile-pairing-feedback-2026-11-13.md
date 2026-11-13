# Mobile pairing: make the imported state and next action explicit

After a phone read a connection QR code, the screen still emphasized the import
instructions and three import actions. The host summary was easy to miss and
"Pair this device" did not explain that another step remained.

On native iOS and Android, including expanded phone/tablet windows, an imported
connection now replaces those entry points with a persistent summary card. It
says that the host information was read and that the device is not connected
yet. The primary action reads "Next: Pair this device" and describes the upcoming
8-digit code and approval by an already connected device. Changing the imported
information remains available with a 44 CSS-pixel touch target. Device naming
and advanced options remain editable. LAN/Tailscale notes follow the action.
English helper text is concise enough for the complete summary, next action
and footer to fit common portrait phone sizes. Very short screens remain
scrollable. Mobile pairing errors scroll into view without moving focus to an
input, including repeated identical refusals, so a rejected request does not
appear to do nothing below the fold.

This presentation is derived from the existing platform, imported key and
pending-pairing state. Scanning, pasting or importing an image does not submit an
enrollment request. The existing focus/scroll handoff, identity checks,
invitation lifetime, approval, durable recovery and duplicate-request handling
are unchanged. Desktop and browser presentation retain their existing flow.
Their three shared English helper strings are also shorter; the Tailscale note
uses "device" rather than "computer" so the same advice fits phones and PCs.
CLI: not applicable to this client presentation; existing pairing APIs and CLI
approval commands are unchanged.

A related existing rendering failure was reproduced on the unchanged baseline:
after importing connection details, entering an incomplete URL in advanced
settings threw during summary rendering and unmounted the page. The summary
now reuses the guarded hostname parser, with the entered text as its fallback.
Validation and host trust checks still run before pairing.

## Verification

- On baseline `706f267`, focused browser checks reproduced the missing next-step
  cue and the invalid-URL render failure.
- 35 invitation and pairing-time unit tests passed.
- 52 Chromium UI cases passed across the final new-feedback, import-recovery,
  design and layout suites. They cover Chinese/English, iOS/Android, compact
  phones, expanded windows, tablets, rotation, enlarged text, dark appearance,
  QR images, cancellation, replacement, rejected pairing and incomplete URLs.
  The final checks also cover full error visibility on a short screen, a
  repeated identical refusal after scrolling, and that the English footer fits
  common portrait phones after shortening the copy. The repeated-refusal check
  reproduced an effect-only reveal missing an unchanged synchronous error;
  the form also reveals the message after an attempt, without changing pairing.
  The first UI run had two incorrect test assertions expecting a WebView health
  request from an invalid synthetic native key. The guard correctly rejected
  it first; corrected cases assert that rejection and retained UI, then passed.
- Nine targeted Chromium flows against disposable real Hubs passed: strict
  invitations, lost replies/reload, approval, wizard transitions and remote
  confirmation. Native credential and transport implementations are not tested
  by those browser fixtures. A broad filename match also selected unrelated
  Tailscale cases; that remainder was stopped after the targeted flows finished
  and is not reported as a completed suite.
- Host and client builds, translation validation and client type checking passed.
- Fable designed, implemented and reviewed the presentation; the integrating
  agent independently reviewed the diff, rendered screens and the checks above.
- Android's native journey selectors were updated to the current labels, but
  that instrumentation test was not run. No WebKit, physical-device or installed
  App acceptance is claimed. This source change does not publish a release.

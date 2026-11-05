# Browser page tools — 2026-10-31

The browser address bar now opens a page-tools menu distinct from the workbench
Tab menu. It brings find, print/PDF, independent zoom, responsive size preview,
viewport screenshots, downloads, history, clear-data choices and browser settings
into one discoverable place. Password saving/autofill and importing credentials
or cookies are deliberately excluded from this change.

## Interaction and ownership

- Find has an inline query, match count, previous/next, case sensitivity and Escape.
  Debouncing does not hide stale-result checks: native request ID **0** is valid,
  and both the current request and navigation generation must match. A matching
  receipt supplies counts if the event was missed. Page-origin Escape closes the
  find bar without stealing page focus and still reaches the website; the find
  input supports Cmd/Ctrl+G and Shift for next/previous.
- Each page owns its zoom and phone/tablet/desktop size selection. A responsive
  size preview is not a real mobile browser: it does not emulate the user agent,
  touch hardware, system fonts or the phone OS. Preview fitting and ordinary zoom
  remain separate: the preset dimensions describe the 100% page-zoom layout,
  while changing page zoom changes the CSS viewport (a 390-px preset at 125%
  measured 312 CSS px). Chromium also bounds the combined zoom factor. Native
  geometry changes invalidate old Bot observations.
- Print always uses the system dialog. Saving a PDF or viewport PNG uses the
  system save dialog; the renderer cannot supply a filesystem destination.
  Unresponsive pages reject new page tools; PDF rendering has a 60-second bound.
  Saving is reported only after the native operation succeeds. Print request
  success does not establish physical printer output. Cancelling is not failure.
- History and settings are local to the **current device and conversation**, under
  the existing Host/user/conversation browser scope. History is bounded to 500
  visits; disabling history stops new entries without silently removing old ones.
  Search engine and new-page zoom are configurable. A new default does not change
  already open pages unexpectedly. Unreadable or malformed settings stop history
  recording until recovered. The UI offers retry and an explicit settings reset
  with history **off**, retaining existing history. A Host reset fences pending
  saves so they cannot recreate removed metadata. Settings broadcasts merge only
  untouched fields into an open form; locally edited fields stay visible with a
  notice. A stale form cannot silently turn history recording back on.
- Clear history and clear website logins/cookies/cache are separate choices. The
  confirmation states what remains: chat, notes, boards and other conversations.
  If one choice succeeds and another fails, the UI names the completed part and
  retries only the remaining choice.
- New features are gated by native capabilities. Older desktop binaries retain
  downloads and existing website-data clearing, with a visible update explanation
  for unsupported page tools.

## Boundaries and entry points

`BrowserPageTools.tsx` owns the menu, inline bars and scoped managers;
`workbench-browser-tools.ts` owns browser-safe settings/history parsing and search
URLs. `Workbench.tsx` keeps native page geometry below these bars. The existing
layout coordinator hides native views behind menus/dialogs. Native events remain
bound to their originating scope and page; asynchronous actions never re-resolve
an unrelated currently selected tab.

Electron's `browser.mjs`, `browser-contract.mjs`, `browser-user-tools.mjs` and
`browser-user-store.mjs` own actual page operations and local metadata. The ten
new commands are trusted-user-only. The App Bot action allowlist is unchanged,
and the Hub also rejects these commands from Bot requests before dispatch.
Synthetic Bot Cmd/Ctrl+F/G/P/0 shortcuts cannot enter user-only page tools. Existing
observation, screenshot, navigation, DOM input and downloads APIs remain available
to Bots; the screenshot-save action is distinct from a Bot screenshot read.

No new CLI command is needed for these person-operated page controls. The shared
`tarobot workbench run` path retains its existing authenticated scope and reports
user-only action rejection consistently. No release or installed-App replacement
is part of this task.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp.noindex/browser-page-tools-20261031`.

- Root's focused browser-helper/controller suites passed **27/27**; the Hub
  workbench suite passed **17/17**, including rejection of all ten user-only
  actions before a Bot dispatch. Root and client builds passed.
- The new UI suite passed **11/11 Chromium and 11/11 WebKit**. It uses the real App
  and isolated Hub, but a native-bridge substitute. It covers per-page split
  zoom/device controls, request ID 0 and stale find events, scoped settings and
  history, partial-clear retry, late/cancelled saves, narrow English layout and
  older native capabilities. Added review regressions cover shortcut focus,
  receipt-only find results, recovered preview controls, sleeping pages, explicit
  recovery with history off, cross-window draft merging, unresponsive/recovered
  pages and reset cancellation feedback. The suite is included
  in the checked-in WebKit test selection. The existing usability suite passed
  **9/9 Chromium**.
  After adding the observed no-printer error, the affected save/print scenario
  was rerun and passed; this is an overlapping rerun, not an additional case.
- Root used CUA on an isolated Electron 45.1.0 window with the actual
  `WorkbenchBrowser` implementation and a small test control strip. The system
  PDF save dialog wrote a 62,858-byte PDF, whose text was independently read with
  `pdftotext`. Cancelling the PNG save dialog returned `cancelled, saved:false`.
  A real native phone-size preview accepted a pointer click; its saved 324×702
  PNG contains the resulting “Clicked” state and was visually inspected.
  Receipts and hashes are in `manual-native/`.
- The physical print path is **not accepted**: this Mac reported
  `No printers available on the network` before showing a print panel. The UI
  now explains the missing printer and offers the PDF alternative. No printer
  was configured and no physical job was submitted. This native harness is not
  a packaged App update or physical-phone acceptance.
- Opus 5.5 independently reviewed the UI/Host changes. Its focus, recovered
  preview, missing find event, cancellation, settings recovery and keyboard
  findings were fixed and covered by the UI regressions above; the final field-by-field
  settings merge received a second read-only review with no blocking findings. The full Electron
  suite passed **264/264** (`evidence/13-final-test-electron.log`). Real Electron
  page-tool smoke passed **9/9**, and the existing browser smoke passed **26/26**.
  Root independently ran the full Electron suite before the last ENOTDIR test was
  added (**263/263**) and the page-tool native smoke (**9/9**), then reran the
  final page-tools unit suite (**18/18**). Native smoke uses
  real pages/preload/IPC with an isolated App stand-in; automated save-dialog
  responses are substituted, while the capture/PDF bytes and file writes are real.
- macOS is the native environment tested here. Windows/Linux, physical mobile
  devices and real trackpad/wheel zoom remain unverified. The full installed or
  packaged App has not been replaced. No release was made.

Menu/settings previews were delivered once as App message
`msg_2e0b25c26da025594796ef37d09dc797`. They are test-UI screenshots, not proof of
an installed-App update.

## API references

- [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents):
  find events, isolated zoom, capturePage, print and printToPDF.
- [Electron session](https://www.electronjs.org/docs/latest/api/session): scoped
  persistent website data and permissions.

Opus 5.5's native probes use Electron 45.1.0 / Chromium 156. They established that
same-origin default zoom sharing needs explicit isolation and that device
emulation scaling cannot simply be enabled without validating input/capture
coordinates. Native implementation evidence is recorded separately from the
React UI tests, which use a native-bridge substitute.

# ADHD personal browser dock

The ADHD toolbar now places a browser icon immediately after Agent Bus. It opens
an independent right-hand browser alongside the board; it does not select or
expand a conversation card. The existing conversation workbench stays available
for webpages that a person explicitly wants a Bot to work on.

## Interaction and ownership

- The dock reuses side-panel resizing and native window expansion. Opening it
  preserves the board width when the display has room; otherwise it uses an
  in-window split. Closing restores the previous window width through the same
  side-panel controller. Browser and Agent Bus docks are mutually exclusive;
  their contents/drafts remain available after switching.
- Browser tabs, URL/search, navigation and page tools reuse `BrowserPage` and
  the existing Electron `WorkbenchBrowser`. A single personal controller belongs
  to the App document, independent of Host/Bot/conversation selection.
- Closing the dock and switching between ADHD and ordinary chat retain native
  pages and form state. The selected tab is remembered within the document.
  Closing the App window ends the tabs; this change does not add a tab/session
  restore feature after quitting. Cookies and site logins persist in the local
  personal profile until the person clears them.
- The reserved personal scope is never registered as a Hub workbench target.
  The native contract rejects Bot/default sources and only permits user page
  management/tools. DOM reads, screenshots returned to the model, synthetic
  inputs and uploads via the Bot API are refused even with `source=user`.
  Saving a screenshot through the user's file dialog remains available.
  This guards browser API routing, not an already compromised App renderer or
  separately authorized system-level computer/screen control.
- Removing one Host preserves personal browsing data. Full device disconnect
  explicitly clears the personal profile even if no Host identity remains.
- Four conversation browser panes plus the personal dock fit within five native
  surfaces. The live-page budget remains six; hidden pages may keep media/forms
  alive and occupy that budget. Closing the dock does not promise to mute media.
  The 64-tab total and six live-page budget are shared by the personal dock and
  conversation workbenches in the same App window; they are not separate pools
  per conversation. A full total budget requires closing tabs; a full live-page
  budget produces the existing close/sleep guidance. Shared resource limits do
  not share site data or give Bots access to personal pages.
- Phone/browser clients do not receive a nonfunctional native-browser button.
  CLI: no new command. This is a local desktop browsing surface, with no new
  headless Host capability or implicit Bot authorization.

## Implementation and review

`AdhdBrowserDock` / `PersonalBrowserController` own the dock. Shared page UI and
error mapping were extracted from `Workbench`; the latter still reads live
controller visibility in each layout frame so disposal immediately hides native
views. Both surfaces share menu/modal occlusion and deterministic bounded layout.
`BrowserUserClient` has no Hub dependency. `WorkbenchBrowserClient` retains the
existing authorized Bot dispatch pipeline and rejects the reserved namespace.

Opus 5.5 reviewed the architecture and candidate diff. Its early findings led to
personal-profile reset coverage, live visibility checks, a native action allowlist,
strict unknown-event handling and document-owned controller lifetime. The final read-only review found no remaining code blockers; all three
conditions (controller failure recovery, window geometry, real native failure
retention) subsequently passed. Opus did not independently execute the tests.

## Validation

Evidence directory: `/Volumes/gdrive/taro-tmp.noindex/adhd-browser-dock-20261031`.

- Focused controller, browser boundary and reset tests: 20 passed (`unit-final.log`).
- Existing native browser/page-tools tests plus source/scope guards: 52 passed
  (`native-unit-3.log`); the additional personal profile reset/isolation check passed 1/1 (`native-reset.log`).
- Real isolated Electron acceptance: 4 passed (`native-personal-final/browser-acceptance-personal.json`).
  Actual WebContentsView pages retain form state after hiding/restoring, failed
  navigation remains listable and closeable, personal
  pages reject Bot reads, and five actual native views coexist. App chrome is a
  fixture in this run; this does not claim installed-App acceptance.
- Chromium full ADHD/browser suite: 7/7 (`chromium-3.log`). After the final
  lifecycle and CSS fixes, all 3 personal-browser journeys passed again
  (`chromium-final.log`), including the added native-frame IPC fixture regression:
  pending expansion, stable board width, close/restore and mode switch. These
  runs cover 8 distinct browser journeys, not 10 distinct tests. OS frame writes
  are simulated in this geometry test, not an installed-App measurement.
- The geometry test first reproduced a 34.7 px board-width change: a pending CSS
  rule read an unset sidebar variable as auto. Adding the same fallback as the
  existing side panel fixed the regression. The final expanded and restored
  board widths match the baseline.
- Native smoke uses real Electron pages and the trusted App IPC, but fixture
  chrome. The browser UI journeys use real React/Hub with mocked native IPC.
  Fullscreen/crash on actual production sites and physical Windows were not
  re-exercised for this dock change.
- TypeScript and client production build passed (`build-final.log`), with existing
  bundle-size/dynamic-import warnings.

An earlier native smoke command used a phase not yet added to the harness and
fell through to its default suite. It was stopped; that interrupted run is not
counted as personal-browser acceptance. The dedicated phase above was then added
and rerun successfully.

Known nonblocking behavior: opening a slow new URL serializes tab creation/close
until the navigation receipt arrives; the page toolbar retains Stop. Native site
permission prompts still refer to a workbench scope.

No production Host, installed App, model settings or version were changed.
No release or installation is part of this change. Physical Windows acceptance
has not been performed.

## Tab appearance follow-up

Selected personal-browser tabs use a pale fill from the selected Monochrome
mark (or the palette accent), without the dark inset underline. Inactive tabs
stay transparent; title/close-button hover uses the same accent. Normal theme
text, keyboard focus, hit areas and tab behavior are retained. CLI is unaffected:
this change is local App presentation only.

The existing Chromium personal-browser journey passed, covering tab creation,
switching, close/reopen and retained pages/drafts across mode changes. Temporary
visual probes covered light warm-gray, sage, mist and neutral, plus dark
warm-gray. Selected-tab text contrast was measured after colour transitions
settled. Client typecheck and production build passed. Evidence is under
`/Volumes/gdrive/taro-tmp.noindex/browser-tab-tint-20261031`; the temporary
probe is not committed. Native IPC is simulated in this UI journey; no installed
App or physical-device acceptance, release or installation is claimed.

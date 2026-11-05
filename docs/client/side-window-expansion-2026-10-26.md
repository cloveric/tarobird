# Desktop side conversation window expansion

Opening a temporary side conversation in the native desktop App adds window
width for the side panel, retaining the original main conversation width. It
prefers the original left edge. Near the monitor's right edge it moves left only
as far as necessary to fit the current work area (excluding the menu bar/Dock).
It does not span monitors or change window height.

Maximized/fullscreen windows, insufficient room for the full requested panel,
and native API failures retain the existing three-column split. Browser tabs
also retain the existing split. Phone/tablet/ADHD/group eligibility is unchanged.
Closing the panel, navigating to a chat without a side, or hiding that Host
releases its expansion. Returning to a retained side reacquires it.
Conversation details and history search also temporarily hide the side and
release the extra width; returning reacquires it without discarding its handle
or draft. Expansion follows the visible panel, not merely an open side session.

As revised on 2026-10-31, closing returns the auto-expanded normal window to its
original width even after movement or resizing, while retaining later position
and height changes. Fullscreen/maximized state, display/scale changes and uncertain
native results remain protected. Manual panel/directory dragging continues to
redistribute the existing room. See the [close repair and current verification](right-panel-close-2026-10-31.md);
the earlier measurements below describe the original implementation.

## Implementation

- `client/src/side-window-expansion.ts`: physical geometry planning and a single
  serialized lease per WebView, including owner transfer and close/reopen races.
  A later Host's acquisition supersedes earlier cleanup without cumulative growth.
  A request arriving during native close inherits the original CSS measurement,
  rather than treating the temporarily wide viewport as the unexpanded window.
- `client/src/use-side-window-expansion.ts`: native Tauri adapter and React
  lifecycle. The panel stays hidden while opening IPC and WebView geometry are
  pending, then enters at its final position; close temporarily holds the original main area until restoration
  settles. A default sidebar is pinned across desktop CSS breakpoints so it does
  not take width from the main chat after expansion.
- `App.tsx`, `Sidebar.tsx`, `SideConversation.tsx`, `side-conversation.css` connect
  layout state and existing pointer/keyboard size controls. Custom navigation
  width that was constrained in a narrow window is preserved on opening.
- Tauri main-window capability adds only `set-size` and `set-position`. No new
  Host endpoints, side permissions, sessions, or persistent data are introduced.

Uncertain native results are not forcibly overwritten. We fall back to split
when measurements or native capability are unavailable. Unexpected OS clamping
or an intervening manual window change may leave the actual window geometry as
reported by the OS rather than forcing the saved frame back onto it.

CLI impact: not applicable; this is App window presentation. Side session APIs,
CLI commands, ownership, messages, drafts, attachments and task lifecycle retain
their existing behavior. No release, installation or production restart occurred.

## Verification

- 25 unit cases: growth, right-edge shift, negative monitor origins, 2x physical
  scaling, fullscreen/maximized/no-room fallback, manual-change protection,
  asynchronous close/reopen, cross-Host ownership, failed reads/writes and rollback.
- Full existing `side-conversation.spec.ts`: 27 Chromium cases passed, covering
  conversation navigation, drafts, attachments, side file delivery, cancellation,
  capability compatibility and mobile/group/ADHD exclusion. After final layout
  refinements, the four relevant navigation/layout/eligibility cases passed again
  in Chromium and WebKit (8 further passes).
- Client TypeScript/production build and root standalone build passed. The existing
  Capacitor keyboard static/dynamic import warning remains non-blocking.
- Real macOS Tauri/WKWebView isolated fixture using the production hook/controller
  and layout CSS, including the production Sidebar control: passed native open,
  close, desktop breakpoint crossing, custom constrained sidebar, right-edge
  movement/restoration, manual resize preservation, rapid open/close, maximized,
  fullscreen and insufficient-room split. The close path also asserts that the
  main width does not briefly grow while native restoration is pending.
- Native measured example: window 1000 -> 1400 -> 1000, main stays 728; crossing
  1200 -> 1600 retains main 928 and sidebar 272. Narrow 780 -> 1180 retains main
  360 and constrained custom sidebar 420. CUA keyboard check changed navigation
  272 -> 280 and Return restored 272. Native light/dark screenshots recorded.

The isolated fixture uses synthetic content and does not connect to a Host.
This is not installed-production-App acceptance. Native Windows, physical
multi-monitor transitions and fractional-DPI Windows execution remain unverified;
negative monitor origins and scaling math have unit coverage.

The 2026-10-29 [opening-order repair](side-window-opening-2026-10-29.md)
adds frame-by-frame browser coverage for the pending-to-expanded transition.
The earlier native passes above predate that repair; its newly built native
fixture still requires execution because the CUA native connection was unavailable.

Reproduce the native check on macOS:

```sh
node client/scripts/side-window-native-build.mjs /Volumes/gdrive/taro-tmp.noindex/side-window-acceptance
open '/Volumes/gdrive/taro-tmp.noindex/side-window-acceptance/TaroBot Side Window Acceptance.app'
```

Click “执行原生检查”. The fixture records `PASS` or an error. `receipt-path.txt`
points to a small disposable log under `/private/tmp` (avoids a removable-volume
permission prompt in the independent App). Copy it into the external evidence
directory after the run, then remove that temporary log. Builds and bundles stay
on the external disk. Quit the fixture when finished.

# macOS overlay title bar — PR #86 review

The Mac window uses an overlay title bar, hides its duplicate native title, and
keeps the three system buttons inside the top application row. Other desktop
platforms and Capacitor mobile clients retain their existing window treatment.
This is presentation only: no Host, headless CLI, schema, permissions on user
data, pairing, or conversation semantics change.

## Implementation

- `client/src-tauri/tauri.conf.json` owns the native title bar and system-button
  position; the main window capability adds only `allow-start-dragging`.
- `client/src/desktop-window-chrome.ts` enables the layout only in a Mac Tauri
  shell. It marks shell headers, the image action row and standalone-page
  backgrounds. ADHD card headers retain their own rearrangement behavior.
  The Mac check requires `Macintosh`, not the `like Mac OS X` substring in an
  iPhone user agent; the platform unit test includes the full iPhone form.
- Tauri 2.12.1 supplies the drag and double-click behavior. Its `deep` regions
  exclude buttons, inputs, links and other interactive descendants. No custom
  replacement mouse handler is installed.
- `DesktopMenu.tsx` explicitly opts menu subtrees out of inherited dragging,
  including the padding, section headings and separators of nested menus.
  The compact-layout conversation-filter group also opts out.
- `desktop-window-chrome.css` reserves the traffic-light area in the sidebar,
  details-open narrow desktop header, image toolbar, and compact desktop top
  inset. A confirmed native fullscreen state releases this reservation.

## Corrections during review

The original observer rescanned the entire document after child-list updates,
including streaming chat updates. The integrated version inspects inserted
element subtrees only and ignores text-only mutations. It uses a WeakMap for
owned markers, so removed message/header nodes are not retained.

Resize reads are coalesced and versioned: late fullscreen replies cannot replace
a newer result, and rejected reads retain the last confirmed layout. Listener
registration happens before the initial read. Disposal cancels pending work,
disconnects the observer, releases even a late-arriving native listener and
restores only the markers owned by this installation. `main.tsx` includes that
cleanup in its existing hot-reload disposal.

The image viewer normally passes blank toolbar presses through to the image.
Only the visible action row in a non-fullscreen Mac overlay now receives those
presses, so its title actually works as a drag region. Export feedback and the
fading gradient remain outside that region; hidden controls, fullscreen and
non-Mac image gestures keep the original hit testing.

At the minimum sidebar width, the wordmark truncates inside its flex item
instead of painting over the Agent Bus control. Settings, file-center, ordinary
creation/detail dialogs and non-movable file-preview headers retain a window
drag handle while the underlying shell is inert. Dialogs with their own
in-page drag controller (including video) retain that controller; they are not
also made native window handles.

Draft file previews initially show a loading view and may reuse that header
when the file resolves to a video. Class changes on creation/file-preview roots
therefore reconcile only their direct header, releasing an owned native drag
marker when in-page dragging takes over. No document rescan is performed, and
explicit markers set by another component are preserved, including on disposal.

## Verification and boundaries

Focused tests cover platform gating, inserted headers, explicit drag opt-outs,
text-only updates, cleanup, late listener registration, failed and out-of-order
fullscreen reads. Browser checks cover system-button avoidance, multiple hosts,
details-open/narrow layouts, fullscreen reservation and the nested create menu.
The recent desktop message-action hover repair and sidebar resizing were also
rerun in Chromium and WebKit. Client type checking, translations and production
build pass.

Root verification runs:

| Scope | Result |
| --- | --- |
| Chrome lifecycle and desktop capability unit tests | 11 passed |
| Chrome layout, brand, sidebar resize and message-action hover | 11 Chromium + 11 WebKit passed |
| ADHD board, conversation details and fullscreen file previews | 46 Chromium passed |
| Chrome/menu/image-row checks and image gallery gestures | 10 Chromium + 10 WebKit passed |
| Final minimum-sidebar and image-row regression | 2 Chromium + 2 WebKit passed |

These are run counts; later batches repeat the chrome-layout cases after the
image-row and asynchronous draft-preview corrections. Unit tests and the final
two-browser window checks were rerun on the final module too.

Opus 5.5 xhigh independently reviewed the frozen PR and the integrated changes.
Its browser probes combined the real initializer with Tauri 2.12.1's drag
script and recorded IPC requests. This reproduced the original menu-padding,
image-title hit-testing, minimum-sidebar and fullscreen-listener issues and
revealed the asynchronous draft-video marker problem during final review.
Those probes verify event routing, not physical native window displacement.
After correcting the draft-video handoff, 16 final Chromium/WebKit checks
covered narrow draft/sent video, home filters, settings, details, devices and
file-center windows. Earlier probe navigation errors are excluded from that
acceptance; the affected steps were rerun in fresh isolated pages.

An isolated native Mac binary used the production WindowConfig, capabilities,
initializer and CSS with synthetic content and no Host or user credentials.
Native checks verified button clicks, input, body text selection, double-click
maximize/restore, fullscreen transitions and reservation restoration. Native
event observation confirmed that Tauri consumes the draggable header press and
leaves ordinary controls alone. The automation did not establish physical window
displacement during drag; manual mouse/trackpad dragging remains a release
acceptance item. Full application surfaces were checked in browser fixtures,
not claimed as a complete installed-App native acceptance.

Double-click keeps Tauri's existing maximize/restore behavior. It does not add
support for the macOS preference to minimize on title-bar double-click, and
double-clicking header text may also select a word. Movable in-page dialogs
keep their own drag controller rather than providing a second window-drag
gesture. These are recorded limitations, not additional native acceptance.

No release, installed-App replacement or production Host restart is part of
this merge.

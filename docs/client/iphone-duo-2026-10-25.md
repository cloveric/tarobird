# Adaptive iPhone windows — 2026-10-25

This change prepares the iOS App for iPhone Duo without requiring a device.
It does not publish a release or update the owner's installed Mac. Android and
desktop appearance remain scoped to their existing rules. CLI-not-applicable:
the changes concern the iOS shell and client presentation, with no Host protocol,
schema, engine execution, queue semantics or command-line capability change.

## Basis and observed gaps

[Apple's preparation guide](https://developer.apple.com/iphone-duo/prepare/)
requires current-window geometry, resizing and safe-area-aware layouts. The
Xcode 27.1 Duo device profile supplies a cover viewport of 466×678 points and an
expanded viewport of 951×669 points; rotation and a narrower split window are
also tested. These are SDK profiles, not measurements from a physical phone.
Browser cases deliberately use unequal left/right safe insets as stress inputs.

Inspection and regression found these gaps:

- The Capacitor keyboard path reports screen-sized frames. On resizable iPhone
  windows, keyboard avoidance needs the actual WebView overlap instead.
- Expanded iOS inherited desktop-sized icon targets and a file-only attachment
  entry. Camera/photo/file choices must remain available after expansion.
- Some phone sheets had a safe width but were centred against the whole window,
  leaving the wrong margin when the left and right insets differed.
- At a narrow split width the header's duplicate Bot label crowded out the
  conversation title, and run action labels could break into stacked fragments.
- The native share form was a fixed stack; short windows plus the keyboard
  could make its last actions unreachable.

## Implementation

`KeyboardInsets.swift` measures `UIKeyboardLayoutGuide` in WebView coordinates.
It excludes the resting home-indicator inset and floating/off-window keyboards.
A document-start capability and ready handshake restore the latest overlap on
page reload. The existing `tarobot-keyboard` event carries `{height, at, duration}`;
the first changed frame borrows OS timing, while later corrections and window
resizes apply immediately. The 27.1 Simulator delivered guide layout just before
the animation notification; coalescing publication to the end of that run-loop
turn preserves the first frame's duration instead of publishing a jump.
New iOS binaries use this single source. Old shells
without the capability retain Capacitor events. Android reports are unchanged.

`ios-adaptive.css` scopes changes to iOS: asymmetric inset alignment, safe-area
ownership between sidebar and conversation, usable touch targets on expanded
windows, compact header priorities, and whole-label wrapping for run actions.
It also complements the existing touch keyboard CSS for a wide iOS window with
a fine pointer. Saved sidebar width and density choices remain respected.

`AttachmentPicker.tsx` keeps the mobile source sheet on expanded iOS, preserving
the existing origin/epoch checks for late file results. The share extension
uses a scroll view bounded by this scene's keyboard and safe-area guides.
The native edge-back gesture starts at the content's safe leading edge.

## Verification

Validation evidence is retained in
`/Volumes/gdrive/taro-tmp/iphone-duo-20261025`.

| Check | Verified result |
| --- | --- |
| `client-viewport` unit suite | 15 passed, including capability fallback, OS timing, iOS pointer support and unchanged Android pointer handling |
| Production Swift geometry/timing suite | 24 checks passed |
| Chromium focused browser suite | 48 passed |
| WebKit focused browser suite | 48 passed |
| Final Duo matrix after pointer-boundary review | 4 passed in each browser |
| Root build and client translation/type/Vite build | Passed |
| Full iOS App + ShareExtension Simulator build, SDK 27.1 | Passed; the final incremental build includes the timing correction and final client assets |

Focused browser suites: `iphone-duo`, `claude-send-choice`,
`attachment-composer`, `safe-area`, `keyboard`, `layout-density`. They cover
cover/inner/rotated/split widths, asymmetric insets, light/dark themes, camera
picker results after resizing, retained conversation/draft/attachment/send
choice, keyboard geometry with touch and fine pointers, and image-viewer resize
and return. Keyboard geometry in these browser tests is injected; camera files
are fixtures. This is not a physical camera or hardware-keyboard test.

The dedicated Duo Simulator runs the complete App. Its inner-screen startup
and pairing sheet with the real software keyboard were visually checked:
the field and submit action remain above the keyboard. A separate native probe
using the production keyboard class verified cover-screen docked overlap,
hidden/resting keyboard, WebView bounds that end above the keyboard, restoration,
fresh-document snapshots and OS animation timing. Do not equate this probe with
a complete chat or model run. The Simulator reported asymmetric safe insets
(including a right inset); no fixed inset values are hard-coded in the App.
Inner-screen rotation to portrait retained entered pairing information. A
separate native layout probe instantiated the production `ShareViewController`
in a short window and scrolled both final actions fully into view; this does not
claim system share-sheet invocation, share persistence or delivery acceptance.
The final complete-App check **passed** against the isolated Hub using a
standard CA and a separate `serverAuth` leaf certificate. The native device was
paired through the UI and approved with the isolated CLI; one user message and
one completed test-engine reply were read back from the fixture database.
`native-probe/native-round-trip.json` records this boundary: the engine is a
local fixture, with no provider inference. With the real software keyboard
visible, folding to the cover display and returning to the inner display
retained the same conversation, the unsent draft and the Send button.
`native-chat-response.png`, `draft-closed.png` and `draft-restored-settled.png`
capture those states. The unsettled transition screenshot is not a performance
or frame-rate result. Attachment and queue preservation remain browser checks.

Initial HTTP and self-signed-CA-as-leaf TLS fixture attempts failed before
pairing. Correcting the test certificate configuration resolved the TLS path;
no product network or trust policy was changed to bypass the failure.

Logs are under `logs/`; final browser screenshots under `last-chromium/` and
`last-webkit/`; native probe and App screenshots under `native-probe/`.
The test build retains the existing version metadata and is not a published
replacement for 1.0.110.

Physical-device acceptance remains unavailable: no actual Duo hinge transition,
camera capture, external input device, thermal/performance or touch-inertia
measurement is claimed. Browser resizing is a layout contract check; Simulator
and a native keyboard probe provide additional iOS-container evidence.

# Keep expanded iPhone changes out of ordinary phones

The initial Duo follow-up enabled chat-tap keyboard dismissal on every iOS
device and exposed the ADHD board by width alone. An ordinary iPhone in
landscape could therefore receive expanded-display behavior. The footer and
composer spacing overrides also reached compact or short phone windows.

The current layout window now controls these additions. A native iPhone needs
at least 600 CSS pixels on its shorter side for the keyboard workaround; the
ADHD board additionally needs its existing width above 760. This is an adaptive
layout boundary, not hardware model detection. Native WebViews keep their
full layout size while the keyboard overlays them; visual viewport height and
physical screen dimensions are not used. iPad board eligibility, Android and
desktop behavior remain as before this follow-up.

Pointer down and up both check the expanded state, so folding during a gesture
does not dismiss a compact phone's input. The native undocked-guide override
uses the same shorter-side boundary with the phone idiom and current WebView
bounds, and updates during layout. Compact/ordinary phones and iPads retain
the previous native guide setting. The footer/composer reductions require both
a wide and tall touch window; regular portrait/landscape and folded windows
keep their home-indicator clearance.

Regression cases cover ordinary phone and cover-window sizes in both
orientations, expanded iPhone windows, a height-only resize, gesture-time
folding, retained drafts, and unchanged iPad/desktop/Android decisions. Browser
geometry and pure Swift checks do not establish physical iPhone/Duo or UIKit
build acceptance. This client-only change adds no Host/CLI API or data change.

## Verification boundary

The focused ordinary/folded/expanded keyboard and safe-area cases passed in
both Chromium and WebKit. Chromium also passed the full Hub-backed rotation,
folding, upload-preservation and footer flows. The existing full WebKit journeys
stalled before pairing, before any layout assertion: a separate blank-page
probe, with no application code loaded, also stalled while storing an
Ed25519 CryptoKey in IndexedDB. Do not count those full journeys as passed or
as physical iPhone acceptance. Pure Swift geometry checks passed; UIKit and
physical-device acceptance remain separate. No release was published.

The isolation also restores the pre-follow-up iPad tap and native-guide
behavior, and safe-area clearance in short, wide iPad windows. This is relative
to the newly merged Duo follow-up, not a claim that iPad source is unchanged.
Previously released shared iOS touch styles remain intact; this change scopes
the new keyboard, ADHD and spacing overrides instead of restyling phones.

Before releasing the native changes, verify Duo inner-screen keyboard display
keeps the full layout-window height, typing does not exit ADHD, and changing
the guide policy during a fold refreshes its geometry. Narrow inner-screen
Split View intentionally does not receive the expanded-only workaround; check
its keyboard and Send visibility on a Simulator or device. Geometry/browser
tests cannot settle these UIKit runtime conditions.

## ADHD pane containment and device limit (2026-11-12)

The native overlay viewport rules previously targeted every `.app-shell`,
including the `conversation-pane` shells nested inside ADHD cards. On touch
layouts fixed positioning removed panes from the card's flex sizing and left
zero-height content inside empty frames; the wide iOS pointer complement could instead cover
other cards and the picker. The same selectors apply to iPad and expanded
iPhone windows. Both rule sets now target the outer chat or ADHD shell only;
card contents keep their local flex layout. The outer board follows the visible
keyboard band. Excluding panes does not raise the selectors' specificity.

Expanded iPhone boards now allow two selected panes in total, not just two
columns. Checkboxes and navigation share the same capacity check. On initial
restore, older phone layouts mount only their first two panes and explain the
limit. The read does not rewrite stored layout; later user edits save the active
selection as usual. Conversation and draft stores are untouched, and the other
conversations remain selectable after removing a pane. iPad and desktop retain
the existing twelve-pane limit. Ordinary phone eligibility is unchanged.

`adhd-ios-phone` exercises native overlay CSS as well as platform eligibility,
checks headers/message text/composers and hit targets inside cards, and covers
iPad portrait/landscape/split windows, touch/pointer input, Duo capacity,
legacy layout restoration, retained drafts and folding during an upload.
Its keyboard open/close check uses manually set overlay attributes with two
panes in one row; it does not exercise the viewport controller's focus reveal.
The earlier browser fixture only changed board platform checks, missing
the native overlay CSS responsible for the blank cards. `adhd-board-state`
covers non-mutating restoration and unchanged iPad/desktop limits. These are
browser and source checks, not a physical iPad/Duo or installed-App receipt.
No Host protocol, CLI command, dependency or native keyboard timing changes.

### ADHD keyboard follow-up (2026-11-12)

The containment repair exposed a missing keyboard-reveal path: a single-chat
composer follows its outer shell, but an ADHD composer belongs to a card in a
scrollable grid with a minimum row height. Shrinking the shell can leave a
lower-row composer, or a Duo composer under a taller keyboard, below the visible
area. `viewport.ts` now reveals the entire active composer (including Send)
only for iOS ADHD cards. It scrolls inner containers, never the document or the
message history. Existing single-chat and non-iOS composer exclusions remain.
Focus changes with the keyboard already open and window resizes use the same
path. Repeated unchanged keyboard reports do not reset an intentional scroll.

The iOS-only card input rule now preserves the existing 16px input-size floor
without changing the saved message reading size. The outer ADHD toolbar
consumes the top safe-area inset once, for touch and pointer input alike.
These correct measurable CSS contract gaps; browser checks alone do not prove
that a particular WKWebView had focus zoom or native status-bar overlap.

`adhd-keyboard` selects the real `MobileViewport` controller in an isolated Vite
fixture and delivers native-shaped keyboard events to it. It covers iPad
lower-row input, touch/pointer focus changes, split resize with the keyboard
open, a taller Duo keyboard, preserved drafts, visible/hittable input and Send,
the input-size floor and top safe area. The native event bridge is a fixture;
UIKit, WKWebView, installed-App and physical iPad/Duo acceptance remain separate.
Ordinary phone keyboard and board-containment regressions run alongside it.
This is client layout behavior: Host/CLI/protocols, dependencies, device limits,
saved layouts and native keyboard animation timing are unchanged.

## Explicit expanded-phone keyboard dismissal (2026-11-12)

The native Keyboard plugin hides WebKit's input accessory bar by default. An
expanded iPhone keyboard may have no dismissal key of its own, leaving only
chat-tap dismissal, which deliberately excludes selection and interactive
controls. A report of intermittent failure to dismiss by tapping is not yet a
reproduced physical-device failure of that gesture.

`ios-keyboard-accessory.ts`, installed by `MobileViewport`, restores the system
accessory bar (including its localized Done control) only in the existing
expanded-iPhone window scope. It restores the hidden policy on folding or
teardown. Ordinary/cover iPhones, iPads, Android and desktop retain their
existing policy. It does not change keyboard animation, viewport geometry,
message delivery or drafts; no native dependency is upgraded. The Host/CLI has
no input accessory bar and needs no command change.

Native calls are serialized and the desired window state is rechecked after
module loading. Folding or unmounting during loading cannot enable a stale bar;
an in-flight Show is followed by Hide when required. A rejected native call is
reported without unhandled rejections or a retry on every same-scope resize.

Focused checks cover compact/landscape phones, iPad/Android exclusion, rotation,
folding, teardown during loading/native calls, failure handling and the existing
touch-dismissal/safe-area behavior. Native component probes use the production
Capacitor shell and real system keyboard with synthetic content and window-policy
metrics. They do not certify physical folding, the friend's third-party keyboard
or the complete installed App. The intermittent chat-tap report remains open
for device confirmation; this change supplies an explicit dismissal route.

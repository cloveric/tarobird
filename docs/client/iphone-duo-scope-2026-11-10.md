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

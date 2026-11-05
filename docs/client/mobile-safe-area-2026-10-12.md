# Mobile system-bar and display-cutout layout

## iOS container inset follow-up (2026-10-23)

The iPhone report showed excess blank space between the status bar and chat
identity. The native configuration still requested `ios.contentInset: automatic`
while `viewport-fit=cover` and the CSS header reserved the safe-area inset.
This left two owners for the same top space. The configuration now uses `never`,
so CSS alone reserves the iOS safe areas, including in dialogs and landscape.
It does not hide the status bar or remove the notch protection. Android native
insets and native keyboard resizing remain unchanged.

The installed Capacitor implementation maps this option directly to
`WKWebView.scrollView.contentInsetAdjustmentBehavior`; its default is also
`never`. See the [Capacitor configuration reference](https://capacitorjs.com/docs/config).

Validation: WebKit and Chromium safe-area/keyboard journeys cover pairing,
inbox, chat, settings, sheets, readers, rotation and retained drafts. The chat
header is explicitly checked at 390px and 430px widths: with a simulated 59px
top inset its total height is 115px (59px + 56px), starting at page y=0.
`cap copy ios` generated `ios.contentInset: never`, retained native keyboard
resize, and contained no development server URL; the generated configuration
was read back. Client translation/type/production build passed.

This validates configuration propagation and browser geometry, not native UIKit
behavior on the user's device. Full Xcode is available on the external volume,
but no iOS Simulator runtime is installed. No IPA was built or published; the
installed iPhone requires a new native package before this change can take effect.
CLI not applicable: only the iOS container's layout policy changed; no host,
protocol, storage or provider behavior changed.

### Keyboard transition follow-up

A second user screenshot showed the title back at its expected top position,
with excess space instead below the idle composer; the user reported movement
when typing starts. The installed Capacitor keyboard plugin clears the native
scroll view's content inset on both show and hide, and resizes the WebView in
native mode. With the former automatic container inset, keyboard transitions
could therefore expose the competing native/CSS owners. The `never` correction
above applies to the entire WebView, not only its top edge.

Added a real-App browser journey at 430x932 with simulated 59px top / 34px bottom
insets. Three consecutive focus, keyboard-open, type, keyboard-close and clear
cycles must keep the header at y=0 with height 115px. The composer ends 34px above
the full viewport bottom when closed and 8px above the simulated keyboard when
open; typing or focus alone must not change that geometry, and text survives
each dismissal. Chromium and WebKit passed; both rendered states were inspected.
This is transition regression evidence, not a native keyboard or physical-phone
result. The user's installed package has not received the native configuration
change through these source commits.

## File readers: full safe viewport

Phone file previews now fill the usable screen instead of retaining desktop
dialog margins. Sent attachments, conversation files and unsent draft previews
share this layout, including Word, PDF, Markdown, text, spreadsheets and media.
The title and Close control remain above the reader's own scrollport. Long names
are limited to two visible lines; native save/share/open actions use a compact
44px row. Desktop mouse layouts keep their centered dialog.

The outer dialog consumes the existing safe-area tokens exactly once. Its panel
fills the remaining rectangle, including on touch viewports wider than 760px
after rotation. Android's native window padding still owns system bars, cutouts
and IME; its zero CSS tokens prevent duplicate gaps. Browser/iOS safe insets and
the keyboard-aware shell height/offset remain authoritative. No system fullscreen
API or status-bar hiding is used.

`file-preview-fullscreen` checks real Word/PDF/text readers and a Markdown draft
with simulated 59px top / 34px bottom insets, rotated 44px side cutouts, native
and browser headers, Android's already-inset mode and a keyboard viewport. It
checks full panel bounds, pinned header, reachable Close and PDF navigation,
native Back, and retained drafts. These are browser layout checks, not physical
Android/iOS cutout or system file-chooser acceptance.

Validation: 44 Chromium and 27 WebKit checks passed, including existing document,
PDF, spreadsheet, media, draft and safe-area regressions. Client and standalone
builds passed. No new installer or physical-device acceptance is included.

## Follow-up: Android native ownership in 0.1.397-test.1

The user's phone still showed the title under the status bar after the first
release. The earlier browser tests injected their own CSS inset values; they did
not establish that the Android container delivered those values on that phone.
Capacitor 8.5.2 chooses native padding below WebView 140 and CSS/passthrough above
it. The emulator has WebView 133 and the previous implementation passes there;
the exact failing phone/WebView combination has not been reproduced locally.

`NativeInsets.java` now always reserves system bars, display cutouts and the
larger of keyboard/navigation bottom insets in the native window. It returns zero
system/cutout insets to the WebView; IME visibility is retained for keyboard
events. `SystemBars.insetsHandling` is disabled so it cannot replace this owner.
Before React renders, Android selects zero CSS safe-area tokens; browser and iOS
tokens remain unchanged. This removes WebView-version and CSS-injection timing
from Android's layout contract. It does not hide the status bar or use a fixed
pixel notch height.

`PairingJourneyTest` supports `safeArea=true,nativeLayout=true`: the actual APK
pairs with an isolated TLS Hub, verifies DOM controls against screen coordinates
and OS insets, reloads, removes CSS inset values, browses the Bot's conversations,
rotates, and opens/closes the native keyboard. On the API 36 emulator with a tall
cutout enabled, it passed. The WebView's top matched the OS safe top (136px), and
the composer remained above the keyboard. This is emulator evidence, not proof
on the user's physical phone or on iOS. All testing uses a separate application
ID, vault and Hub; the installed Mac host and original phone pairing stay intact.

Release checks: 16 related Chromium and 16 WebKit journeys passed; final shortcut
styling and already-inset CSS checks passed in another 2 journeys per browser.
The standalone build/suite passed (2,851 passed, one existing skip), as did the
20 Android JVM tests, release build and lint. Independent production directory
and local npm archive installs started without the Feishu SDK. The signed APK
retains the prior certificate and has code 2026101212; its 398 bundled web assets,
native inset class/configuration and all selected launcher icons were verified.

See also [the conversation shortcut follow-up](mobile-bot-conversations-2026-10-12.md).

## Original CSS implementation (superseded on Android)

The phone chat header reserved no space for the top system area, placing Back,
the Bot identity and the menu behind status icons or a camera/activity capsule.
Other surfaces used browser `env(safe-area-inset-*)` directly and missed the
compatibility values supplied by the Android native container.

## Ownership

- `safe-area-tokens.css`, imported by the base stylesheet, defines four
  `--app-safe-*` tokens. Each prefers Capacitor's `--safe-area-inset-*` and falls
  back to browser/iOS `env()`. Native zero is honored: the installed Capacitor
  8.5.2 runtime already pads older WebViews and then publishes zero. Adding or
  maximizing both sources would incorrectly reserve space twice.
- Chat headers add top padding to their content height without shrinking the
  buttons. Inbox, pairing, settings, file views and sheets share the tokens.
  Left/right cutouts are respected in landscape, including touch viewports
  wider than the mobile breakpoint. Preview Close buttons stay reachable.
- Headers and bottom surfaces own their own insets. The App root does not add a
  second blanket padding; top-layer dialogs are bounded independently.
- The keyboard controller continues to own the visible height and offset.
  Bottom safe padding becomes zero while the keyboard is shown, because native
  or visual-viewport resizing already excludes the IME. Insets are CSS values,
  so rotation and native updates do not depend on React rerender timing.
- Capacitor SystemBars explicitly uses `css` inset handling and the `cover`
  startup hint matching `index.html`. Removed `Keyboard.resizeOnFullScreen`:
  the installed SystemBars implementation warns against using that legacy
  workaround alongside its own inset/keyboard handling. iOS contentInset and
  native Keyboard resize mode remain as before.

References: [Capacitor SystemBars](https://capacitorjs.com/docs/apis/system-bars)
and [Android edge-to-edge layout](https://developer.android.com/develop/ui/views/layout/edge-to-edge).
Implementation details were also checked against installed Capacitor sources.

## Acceptance

`safe-area.spec.ts` uses real temporary Hub servers and deliberately simulated
native inset values, not a physical island or OS keyboard. It checks a 59px top
area, a 34px bottom area, lateral 44px cutouts, zero when already inset, narrow
and wide landscape, header controls, pairing, inbox, creation, preferences,
Markdown preview, draft retention and a native-sized keyboard viewport.

The first Chromium and WebKit runs each passed 23 journeys covering safe area,
keyboard, creation, document preview and mobile navigation. Portrait and
landscape screenshots were visually checked. The final token factoring and
wide-landscape refinement are covered by a subsequent focused run.
That final safe-area and keyboard run passed all 5 journeys in each browser.
The standalone completion gate passed all 213 test files (2,823 tests passed,
1 skipped), and the final client production build passed.

Android `assembleDebug testDebugUnitTest` passed, and the APK's bundled config
was inspected for SystemBars and native keyboard settings. The existing 20
native unit tests passed; they are not evidence of physical cutout behavior.
After the final CSS refinement, assets were synchronized and the debug APK was
built again successfully.

No phone was connected to adb. No new release or installation on the user's
phone is included. Physical-device and iOS-container appearance remain separate
acceptance steps; ordinary expanded OS overlays may temporarily cover content
beyond the safe area the OS reports.

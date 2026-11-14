# Android system-bar overlap after a canvas refresh

An intermittent Android report showed the chat header behind the status bar
when opening the keyboard, with the composer also extending into the navigation
area. The display later recovered. The exact device-specific trigger is not yet
confirmed, but the native failure path is reproduced in the packaged App.

## Cause and change

`NativeInsets` owns the system-bar and cutout padding on the window DecorView.
Android intentionally uses zero CSS safe-area tokens to avoid double padding.
`NativeAppearance.apply()` updates the window background during appearance,
focus and configuration restoration. Android's background update resets the
DecorView padding to the drawable's padding, which is zero for a ColorDrawable.
A later WebView resize can request another inset dispatch and repair it, after
one or more overlapping frames have already rendered. Closely spaced background
updates can also leave the overlap in place until another window change.
The background-padding behavior is visible in Android's
[`DecorView.drawableChanged()`](https://android.googlesource.com/platform/frameworks/base/+/HEAD/core/java/com/android/internal/policy/DecorView.java).

The fix remembers the latest delivered system rectangle for each DecorView,
using weak keys so destroyed windows are not retained. After changing the
background and system-bar appearance, `NativeAppearance` synchronously restores
that rectangle. It does not wait for another inset dispatch. The first window
attachment still waits for its own OS report; full-screen readers still select
zero padding and use the existing exit path.

A second regression exposed a pre-existing page-reload cleanup omission:
Capacitor's Bridge builder replaces listeners registered during `Plugin.load()`.
The reader-reset listener in `AppearancePlugin` was therefore lost, allowing a
reload while full-screen to leave the new document in immersive mode. The
listener now belongs to `NativeInsets.install()`, which runs after Bridge
construction. The obsolete plugin-load listener is removed.

Production changes are limited to `NativeInsets.java`, `NativeAppearance.java`
and `AppearancePlugin.java`. No CSS, keyboard timing, iOS, desktop, dependencies or
version counters change. CLI: not applicable, because this is Android native
window presentation, with no Host/protocol or command behavior change.

## Regression evidence

The isolated API 36 emulator runs the real packaged WebView, Capacitor plugins,
OS keyboard and native TLS/signing transport. It pairs with a disposable Hub and
opens a seeded chat, without user data or a model process.

- Before the fix, 12 keyboard open/close cycles with native appearance refreshes
  produced 24 overlapping pre-draw frames out of 402. End-of-animation geometry
  alone passed and missed this defect.
- An additional synchronous invariant failed immediately after appearance
  restoration: the delivered top inset was nonzero but DecorView padding was
  zero.
- After the fix, both instrumentation methods pass. The final 12-cycle chat
  run records 344 frames with zero top or bottom boundary violations. The other
  method checks keyboard open/close, synchronous padding preservation, landscape
  and portrait, full-screen reader exit, and WebView reload with a reader still open.
- Fable 5 independently reproduced the same native failure and reran its probes
  with byte-identical production files. Three repeated-refresh/focus groups
  passed 68, 44 and 60 cases respectively without sustained overlap; separate
  keyboard checks also passed. The additional reader-open reload regression failed on the old listener
  registration and passes after moving it to post-Bridge initialization. These are independent
  emulator results, not the reporting user's device.
- All 50 Android JVM tests, Android debug/App-test builds, Android Lint, root
  source build, and the pairing helper's JavaScript syntax check pass.

`NativeInsetsTest` is an opt-in native suite requiring the isolated application
ID `com.tarobot.client.insettest`. Run each method separately with fresh test-App
state. The chat method requires a fresh base64-encoded `fixture.json` in the
instrumentation `fixture` argument. Start `client/scripts/android-pairing-peer.mjs`
with a private temporary output directory after building the Host sources. That
helper now issues the current bounded pairing invitation through a disposable
fixture owner; it does not bypass production pairing authorization. Keep its
invitation, certificates and raw logs outside the repository. Its extra fixture
owner is counted separately from the Android device in pairing receipts.

This is emulator acceptance, not physical-device or OEM-keyboard acceptance.
No release was published or installed on a user's device by this fix. The user
reported that the original occurrence had already recovered; that exact device
sequence still needs confirmation in a future installed version.

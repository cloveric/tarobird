# Image viewer: shared canvas, input and native review

The previous viewer reserved separate top and bottom rows, reducing the photo
viewport. Its gesture and file-preview implementations also differed between
message images, image files and draft attachments. This change gives all three
routes the same full-canvas viewer while retaining authenticated original bytes
and the existing save/share lifecycle.

## User-visible behavior

- Header and bottom controls overlay the photo. Single click/tap hides them
  without refitting the image. Hidden controls are inert; Tab makes them reachable.
- On native phones, hiding controls also hides system bars. Android releases the
  decor padding and short-edge cutout area, then restores normal insets on exit.
  Its dark reader canvas is transient and survives share/resume without changing
  the saved app theme. Reload and Activity recreation clear the override.
- Double-click/tap and two-finger pinch zoom around the gesture point. Drag pans;
  touch release retains bounded momentum. Resize/rotation preserves the image
  point at the viewport centre. Reduced-motion users do not get momentum.
- Ordinary wheel/trackpad scrolling pans. Ctrl/Command + wheel and WebKit gesture
  events zoom; keyboard +, -, 0, H and F expose zoom/reset/chrome/fullscreen.
  Arrow/Page/Home/End scrolling works from the initial viewer focus.
- Fit-size horizontal touch swipes navigate within the current message only.
  Mouse drags, vertical drags and zoomed drags do not change images. Failed or
  loading images remain navigable, including when their Blob URL arrives mid-drag.
- Long images start at readable width and can switch to whole-image fit.
- Desktop fullscreen uses the browser document or Tauri window. Escape first
  exits fullscreen, then closes the viewer. Closing restores only fullscreen the
  viewer entered; an already-fullscreen window keeps the user's original state.
- Save/share retains the original Blob without canvas re-encoding. New chat
  messages do not reveal hidden controls or replace the open reader.

The close control is now a plain cross with a quiet rounded hover surface,
retaining its existing touch target. Initial focus goes to the image title,
matching passive App dialogs, so opening an image does not decorate Close with
a large white circular focus ring. Tab still reaches Close first and shows a
thin inset focus indicator; Escape and focus restoration remain supported.

Full canvas does not crop or stretch an image to the screen's aspect ratio.
Letterboxing needed to show the entire composition, and black pixels already
inside an uploaded screenshot, remain part of the image. Zoom is available when
the user wants to examine a smaller portion.

## Joint review

The independent reviewer ran through the production CC1 Claude engine using
`claude-opus-5-5[1m]` with `xhigh`, in a separate worktree. Its baseline probes
reproduced loading/error swipe lock, missing flick momentum, resize-anchor loss,
keyboard scrolling failure and unconsumed WebKit pinch events. It supplied the
native bar/fullscreen module and independent contract tests. The root integration
also corrected ordinary trackpad scrolling after the review and reproduced a
macOS first-responder loss using the native fixture.

The 13-case independent contract distinguishes reproduced defects, intended UX,
and stress coverage. The pinch/rapid-navigation stress checks are not claims that
every hypothetical race was reproduced in the old implementation.

## Validation and boundaries

The close-control follow-up is recorded separately in
`/Volumes/gdrive/taro-tmp/image-viewer-close-control-20261023/`. Both new initial
focus checks fail against the preceding source, which focuses Close. With the
fix, focused Chromium and WebKit regressions each pass 14 cases with one
engine-specific skip. These cover initial/Tab focus, Escape, long-image keyboard
scrolling, zoom, hidden controls, full screen and reader focus restoration.
Default and keyboard-focus screenshots were inspected; client and standalone
Host builds pass. This follow-up has browser verification only and does not
install or verify an updated native App.

Evidence is in `/Volumes/gdrive/taro-tmp/image-viewer-20261023/`, with the
independent baseline and overlay logs under `opus/`. Browser touch injection and
synthetic WebKit gesture events are not physical-device or physical-trackpad
acceptance.

- Full pre-completion Host build and suite: 456 files, 6,217 tests passed,
  5 skipped. The client translation/typecheck/Vite build passes. Native test
  compilation initially lacked the ignored `src-tauri/host` resources in this
  new worktree; after linking the unchanged 0.1.452 prepared Host, all 77 Rust
  unit/integration tests passed (`native-tests-final.log`). This is not packaging
  or release verification. The final fullscreen changes additionally pass all
  15 geometry/native focused tests (`focused-final.log`).
- Final shared-viewer/browser regression: Chromium 44 passed / 1 engine-specific
  skip; WebKit 38 passed / 7 engine-specific skips. This covers the independent
  contract, gallery, export, recovery, draft attachments and new full-canvas
  interaction specs (`chromium-final.log`, `webkit-final.log`). Earlier related
  message-image/file-reader regressions also passed. The final Tauri-only focus
  poll has separate unit/native-fixture builds; it does not certify native input.
- Android `:app:compileDebugJavaWithJavac --offline` passes using the mounted JDK
  and SDK (`android-java-final.log`). No Android device or AVD was connected, so
  immersive cutouts, transient system-bar swipe and share-return behavior still
  require Android device acceptance.
- The isolated Tauri fixture uses the actual shared viewer, production window
  capabilities and an incognito window. Native interaction verified 2560×1440
  OS fullscreen, overlaid/hidden controls, zoom, drag and reset. Its receipt
  captured the exit defect as `windowFocused:true, documentFocused:false`.
  The corrective focus patch requires a fresh native exit/second-Escape check.
  The fixture's save callback is deliberately inert and is not export evidence.
- Physical iPhone 15 Pro Max, iOS 27.0.1: local candidate 1.0.105(2) was installed
  over the existing App, retaining pairing/history. Opening the owner's image
  through the conversation file list reached the shared reader; a tap hid both
  viewer controls and the real iOS status bar, exposing the top screen area.
  This is a candidate acceptance install, not a TestFlight publication.
- Subsequent native interaction was blocked by repeated
  `Sky Computer Use native pipe startup failed`. Physical pinch/double-tap,
  close/return restoration, the final macOS focus fix and Windows fullscreen
  must not be reported as verified. Reinitializing the UI tool did not recover it.

## Scope and reproducibility

CLI is not applicable: this is viewer presentation and native window/system-bar
behavior. It introduces no Host API, authentication, membership or file-storage
semantics. External Markdown images remain explicit links.

The isolated macOS fixture is built with:

```sh
node client/scripts/image-viewer-native-build.mjs /external/path/image-viewer-audit
```

Open the resulting App through the normal desktop UI. `interactions.ndjson`
records changes in viewport, image bounds, pan offsets, controls, fullscreen and
window/document focus. It contains fixture state only, with no production Hub
connection. The prior published 1.0.105 artifacts do not contain this change;
this work does not itself publish a release or replace the production Mac App.

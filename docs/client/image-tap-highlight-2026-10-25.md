# Image-opening touch highlight — 2026-10-25

The [October 26 shared policy](shared-tap-feedback-2026-10-26.md) supersedes the
image-only CSS exception below. Images now inherit the same transparent native
tap feedback as the rest of the App; the original image/keyboard checks remain.

## Confirmed cause

On Android-style Chromium touch input, opening a sent image leaves a pale blue
rectangle at the former thumbnail position, briefly drawn over the new fullscreen
image viewer. A trusted CDP touch sequence reproduced the rectangle in a capture
immediately after touch release on source `9307857`.

The thumbnail, its image and the viewer inherited the browser's default
`-webkit-tap-highlight-color: rgba(51, 181, 229, 0.4)`. The browser draws this
feedback outside the DOM and its fade can outlive the opener's click. It is not
the image title's initial focus: the title's outline was already `none`.

## Change and boundaries

`client/src/message-images.css` sets transparent native tap feedback on sent-image
thumbnails and the shared image viewer. Descendant images, long-image labels and
viewer controls inherit it. Existing CSS pressed states and keyboard focus
indicators remain intact; no gesture, zoom, image decoding, geometry, animation,
native-bar or delivery logic changes. Desktop mouse behavior is unchanged, while
touchscreen browsers and native phone WebViews use the same scoped rule.

`client/e2e/image-tap-highlight.spec.ts` covers real touch activation in light/dark
phone layouts, Bot galleries, uploaded user long images, nested hit targets,
keyboard Tab/Close and focus restoration. The two attachment-action cases now
assert the existing title-first focus contract, then verify Tab reaches Close;
their obsolete Close-initial-focus expectation was not restored in the product.
The unrelated old `text` horizontal-scroll assertion in `card-layout.spec.ts`
is outside this fix.

CLI-not-applicable: this is App image presentation only. Host APIs, CLI, persisted
messages and attachment bytes do not change.

## Evidence

Evidence directory: `/Volumes/gdrive/taro-tmp/image-tap-flash-20261025`.

- `baseline.log` / `baseline/`: original native highlight color and the visible
  stale rectangle immediately after opening.
- `after.log` / `after/`: transparent highlight and matching touch sequence with
  no rectangle. Initial title focus and its outline remain unchanged.
- `chromium.log` / `webkit.log`: focused image-tap, shared-viewer and attachment
  action suites. These cover desktop and phone layouts, wheel zoom/pan, long-image
  fit, hidden-controls behavior, focus restoration and browser fullscreen.
  Chromium passed 16/16; WebKit passed 15 with its Chromium-only browser-fullscreen
  case skipped. Both browser runs completed without failures.
- `client-build.log` / `root-build.log`: translation check, client typecheck/build
  and standalone Host build.

Browser touch emulation is verified; this change has not been installed or
accepted on a physical Android/iPhone, and no release is included.

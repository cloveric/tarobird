# QR image import and pairing recovery — 2026-10-13

## Report and reproduced failure

The Windows report shows the scanner's image-import error, “无法识别二维码”, with the camera idle. The screenshot of that error does not include the original imported QR image, so the exact user input has not been reproduced.

A deterministic regression does reproduce a failure in the same decoder: render a connection QR containing a synthetic host's public certificate at the generic 210 px display size, capture the whole window, and encode it as JPEG at quality 85. Both original ZXing sampling attempts fail. The same captured image now decodes, preserving the pinned public key, route, and certificate. Simply enlarging the image was insufficient; the fractional resampling/contrast fallback was necessary for this case.

## Changes

- Load image pixels once. Try the normal and flat QR samplers at bounded scales, then fractional resampling with two contrast thresholds for grey edges introduced by screenshot scaling and JPEG compression. The working canvas is limited to 6 million pixels and a 3200 px edge; the 10 MB upload limit remains. Yield between attempts and cancel stale operations when closing or switching input methods.
- Distinguish unreadable files, unrecognized QR images, and malformed/non-TaroBot pairing information. Give a recovery action instead of a bare failure.
- Add “复制配对信息” beneath generated connection/approval QR codes and “粘贴配对信息” in the scanner. A denied clipboard write exposes selectable text. Oversized payloads get a route-reduction instruction rather than an unusable copied link.
- Pasted information uses the existing strict parser, including host identity, scoped CA, route validation, and the 8192-character limit. Invalid input leaves the dialog open. A parsed approval still goes through the caller's normal explicit device-approval flow. No certificate validation or trust requirement was relaxed.
- Switching from a pending camera request to pasted information stops any late stream. The text input retains a stable accessible label while editing/retrying.

No new dependencies or QR wire-format changes. Processing remains local.

## Verification

- Original decoder: deterministic compressed screenshot test failed. Updated decoder: passed in Chromium and WebKit.
- QR scanner suite: Chromium **10 passed**; WebKit **9 passed**, **1 skipped** (the canvas-camera fixture only supports Chromium).
- Other targeted browser suites (`device-settings-ux`, `native-transport`, `pairing-design`, `pairing`, `tailscale-pairing`): **46 passed in each browser**. These include actual test-Hub two-device approval, scoped identity/CA handling, desktop return navigation, and narrow layouts. Native calls in browser fixtures are mocked; this is not Windows-native acceptance.
- Root `desktop-tailscale`: **5 passed**. Root standalone build and client translation/type/Vite build passed.
- Manual computer-use check in an isolated local fixture: selected the previously failing JPEG through the visible image picker, observed decoded connection data with its certificate intact; entered malformed pasted data, corrected it, and observed successful decoding. Checked the new entry at desktop and 390 px mobile widths. No real host was enrolled by this fixture.

Paste pairing information in the isolated fixture (historical image omitted from this clean snapshot)

## Acceptance limits

The original user-selected QR image is unavailable. This fixes a reproduced image-recognition failure and adds an independent recovery route; it does not claim recognition of every blurred photograph. Windows WebView2/camera hardware and Android physical-camera acceptance were not run. Installers were not rebuilt or published for this change, so an already installed client does not yet contain it.

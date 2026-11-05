# Pairing camera and device UI follow-up — 2026-10-29

This change targets slow/failed pairing scans, inconsistent network headings,
the desktop revocation-result outline, and oversized phone disconnect notices.
It is a source-level PR; it does not update any installed App or establish
physical iPhone/Android camera acceptance.

## Final merge scope

The compact QR encoding experiment was removed before merging. Some undersampled
camera fixtures decoded the original encoding better, and no physical-camera
acceptance justified changing the displayed code. QR rendering, copying, length
checks and parser now use the original `pairingLink` representation byte-for-byte.
The diagnostic comparison retains the rejected encoding only in its test fixture;
there is no compact encoder in production. Scanner recovery and the requested UI
changes remain included. The earlier candidate measurements below are historical.

Final integration validation, with Android foreground-recovery PR #96 already
included from main:

- 10 focused pairing-invitation and multipath unit tests passed.
- Chromium: 33 passed across camera frames/lifecycle, image/paste/copy, phone
  connection notice, device layout and device-action recovery.
- WebKit: 30 passed, three Chromium-only synthetic-camera cases skipped.
- In both engines, all 40 samples using the retained production QR encoding
  decoded with the new reader, versus 33/40 with the old reader. The rejected
  compact encoding remains in the diagnostic matrix (32/40), not in the App.
- Client translations/TypeScript/production build and standalone Host build
  passed. No installed App was replaced, and no optical-camera result is claimed.

## Pairing camera

- Request the rear camera at an ideal 1920 × 1080 resolution, rather than
  accepting the browser's default resolution. Continuous autofocus is an
  optional capability hint; unsupported focus controls do not fail the stream.
- Use serial 100 ms retry gaps instead of ZXing's default 500 ms gap. These are
  gaps after decoding, not a guaranteed ten frames per second.
- Preserve ZXing's first pass and add jsQR 1.4.0 (Apache-2.0) when it misses a frame.
  The second decoder recovers actual pixel fixtures that the first decoder
  misses. Decoding remains local and lazy loaded. Input is bounded to a
  1920-pixel edge and 2.1 million pixels; there is no unbounded crop/scale loop.
- An unexpected draw/decoder failure or ended camera track leaves the scanning
  state, releases the stream and exposes retry. Closing, changing input modes,
  successful decoding and late permission results keep their existing cleanup.

The pixel comparison retains low-resolution failures in its JSON evidence.
It covers old/compact encodings, all eight masks, 640/1280-pixel frames and
additional dense-code frames at three pixels per module. Assertions require
all sufficiently resolved cases and every old-decoder success to decode.
Very small, aliased dense codes may still require moving closer; neither a
synthetic pixel result nor a requested camera resolution proves physical-device
performance. The test does not silently remove those difficult samples.

The final Chromium comparison decoded 72/80 samples versus 62/80 for the old
reader. All ten recovered cases and all previous successes passed. The eight
remaining misses were the compact certificate-bearing QR at 640 pixels, where
its 105-module grid occupied only 268.8 pixels (about 2.38 pixels/module after
the quiet zone). The corresponding three-pixel/module samples passed. In this
specific sampling phase, the legacy encoding decoded better than the compact
one; fewer modules alone is not proof of easier scanning. This is why the compact
presentation is excluded from the final merge.

## Rejected compact QR candidate (not shipped)

The earlier candidate used a compact URL encoding for QR presentation. It preserved the existing
v1 JSON, public key, TLS certificate, invitation and routes; the unchanged
strict reader consumes the same query values. Query delimiters `% & + #` remain
escaped. Clipboard links retained the existing fully escaped representation,
including the existing maximum-length guard. No server short-link service,
compression format, new trust mechanism or pairing permission is introduced.

For the public synthetic certificate fixture and a 60-character key:

| Sample | Old / compact bytes | Old / compact modules per side |
| --- | --- | --- |
| Approval code | 188 / 140 | 53 / 49 |
| Direct connection with certificate and invitation | 874 / 756 | 109 / 105 |

These sample reductions are not a guarantee for every route configuration.

## UI changes

- Network name, host-address synchronization and add-device titles use the
  existing 14 px host-name size. Add device is semibold; network name stays
  regular. The settings title and other screens keep their existing sizes.
- A confirmed desktop revocation uses a neutral result card and a circular
  accent check. The status still receives programmatic focus and announces the
  result. Keyboard focus styles on actual controls remain intact; the phone
  result is unchanged.
- A phone's routine disconnection is one compact, keyboard-accessible disclosure.
  It expands to show the full host name, cached-reading information and pending
  message count, and disappears when the connection returns. Only the exact
  duplicate automatic-retry error is suppressed. Authentication, trust and
  message/local errors retain their existing alert paths.

## Earlier candidate verification

- Root focused unit tests: **13 passed** (including three now-removed compact-encoder tests) (`client-pairing-qr`,
  `client-pairing-invites`, `client-multipath-routes`).
- Chromium: **46 distinct focused browser cases passed**, including the original
  41-case device/pairing set, three camera cases, compact reconnect and the phone
  chat/draft journey. One original pair-approval test first timed out during
  context cleanup, then passed unchanged in isolation (17.9 s); it also passed
  in WebKit. This was not counted as a clean initial 41-case run.
- WebKit: **42 passed, 3 skipped** across the device/pairing/camera/reconnect set.
  The skips are explicitly Chromium-only synthetic `canvas.captureStream`
  journeys. Real-pixel decoder coverage and real host reconnect both passed in
  WebKit; this is not native iOS container or optical-camera acceptance.
- Standalone host build passed (462 modules); client translations, TypeScript
  and production build passed. The existing Capacitor Keyboard mixed-import
  warning remains non-blocking.
- Reviewed actual browser screenshots for network title sizing at phone width,
  desktop revocation result, and the compact phone notice with a long host name.
- `git diff --check` passed.

The tests use isolated hosts, synthetic identities and public certificate data;
they do not revoke real devices or modify the owner's running host.

Physical acceptance still required before claiming the camera issue resolved:
scan displayed pairing QRs on the affected iPhone and Android;
check focus, distance, permission-denied retry and camera shutdown after success.

## CLI and integration

The headless CLI, host API, schema and authorization rules are unchanged. The
CLI continues to produce/read existing pairing links. The App-only scanner and
presentation changes need no parallel CLI command.

This PR was prepared from GitHub main `213d1a31eb32ab0d0e0d36f69c8db877d0d92e72`
in an explicitly authorized temporary internal-disk checkout while removable
volume access was unavailable. Original external-disk edits were not discarded
or presumed identical. Once access returns, compare and preserve those edits
before retiring the temporary checkout and its task-specific build caches.

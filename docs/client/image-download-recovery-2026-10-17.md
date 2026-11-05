# Image download recovery — 2026-10-17

## Confirmed defect

The Android screenshot showed two successful photos followed by two raw
`unexpected end of stream on https://…` errors in the same gallery. The error
text overflowed the narrow columns and there was no retry action. The screenshot
establishes an interrupted HTTP transfer, not which network hop interrupted it
or that the original attachments were damaged.

Android's `HubTransportPlugin.complete` serializes IOExceptions as ordinary
bridge errors. `transport.ts` previously preserved these as `Error`, while the
bounded downloader recognizes browser `TypeError` / network DOM exceptions.
A native EOF therefore skipped the existing range recovery and remained failed
until the image was remounted or the Hub connection status changed. Both native
HTTP-open failure and response-body failure were reproduced before the fix.

## Changes

- Normalize only known native HTTP interruptions (EOF, connection reset, the
  response-idle watchdog) into transient network errors. Existing authenticated
  range recovery retries the unconfirmed range, retains completed ranges and
  validates the complete SHA-256 before exposing bytes. The existing five-minute
  recovery bound and cancellation remain in force.
- This normalization does not retry requests itself. Identity/certificate,
  lifecycle, malformed-chunk and unknown errors remain terminal. Native traffic
  never falls back to unpinned browser networking. Non-idempotent POSTs are not
  replayed by the transport.
- Failed image tiles now show a contained, localized “图片加载失败” state with a
  44px retry target. Endpoint addresses and raw exception strings stay out of the
  tile and viewer. Healthy photos keep their current object URLs when another
  tile is retried.
- `useAttachment` provides a scoped, single-flight manual retry after failure.
  Retry also works on another selected photo inside the full-screen viewer,
  without closing the viewer or reconnecting the Hub. Original-byte export,
  image navigation and zoom remain unchanged.
- Add `image-gallery` and `image-recovery` to the WebKit suite allowlist so both
  photo-gesture and failure-recovery checks are actually collected.

CLI impact: not applicable. This changes App-native HTTP error classification
and image presentation only; Hub APIs, authorization, message delivery and
headless CLI capabilities are unchanged.

## Verification

Verification artifacts and logs are on the external drive:
`/Volumes/gdrive/taro-tmp/tarobot-image-recovery-20261017/`.

- Before-fix reproduction: gallery failure/reader failure and native HTTP-open /
  body EOF recovery regressions fail against the old implementation.
- Focused native bridge and download checks exercise known transient failures,
  failed-range-only recovery, exact bytes, terminal security errors, cancellation,
  request-slot cleanup and no unpinned fallback or POST replay.
- Browser gallery checks cover 320px/390px containment, English/Chinese labels,
  repeated-click suppression, independent tile recovery, reader recovery, zoom,
  navigation and original-byte save/share.

Results: 21 download-logic cases passed. 58 browser/native-bridge scenarios
passed in each of Chromium and WebKit (116 engine-specific executions). The
client production build, TypeScript and translation checks passed. Hub-backed
image navigation, thumbnail and message-action regressions were rerun against
the newly built client. Phone failure-state screenshots were inspected at
320px and 390px.

These are local automated checks using browser engines, isolated test Hubs and
injected native-bridge failures. They do not establish Android physical-device
or live Tencent relay acceptance. This change does not release or install an App.

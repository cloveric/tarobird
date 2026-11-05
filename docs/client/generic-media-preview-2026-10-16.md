# Generic media attachment previews

A previously delivered MP4 opened the unsupported-file fallback in the installed
Mac App 1.0.78. Its stored attachment type was `application/octet-stream`; the
original file was a valid H.264/AAC MP4. This was reproduced in the native App
and with failing regressions before changing code.

Two paths contributed: the shared Gateway `send` file/video path always uploaded
generic MIME, while `previewAttachment` routed media only by Blob MIME. Native
App delivery tools already inferred MP4 correctly, so previews varied with the
delivery path rather than the video's actual format.

`client-protocol/attachment-mime.ts` now supplies the common filename MIME hints
to native App file/batch delivery and Gateway file/video delivery. Image and
audio-specific Gateway behavior is unchanged. For historical attachments and
file-picker drafts with absent or octet-stream MIME, the client uses that
allowlist to open inert image/audio/video elements. Explicit HTML/text types
remain escaped text; SVG is never inferred as an image. Unknown extensions stay
unsupported. Media decoders still decide whether the bytes are playable.

Preview normalization uses a Blob slice with identical bytes. It does not rewrite
stored attachment rows, duplicate messages, transcode files, or change the bytes
saved by the user. Existing conversations, conversation-file lists and drafts use
the same preview path.

## Validation

- Pre-fix reproduction: both Gateway file/video tests stored the wrong MIME;
  generic MP4 preview returned `unsupported`.
- Focused Gateway, App-tool, download, conversation-file and link-preview suites:
  99 tests passed. Independent read-only Opus review found no blockers.
- Full standalone build and test gate: 302 files passed, 3999 tests passed and
  one opt-in test skipped. The client production build passed.
- Chromium and WebKit each passed 19 browser cases covering real decoding,
  play/pause/seek/close, generic audio/video,
  draft preview/dragging, conversation-file preview, byte-identical download,
  video covers and document/active-content safety. An opt-in test reads the
  reported file locally into a disposable Hub without changing live state. The
  reported 1280×720 H.264/AAC video passed actual playback and seeking in both
  engines, with the existing generic metadata and original bytes.
- Clean and packed/extracted CLI installations and the 0.1.428 → 0.1.429 upgrade
  passed, preserving host/controller identity and workspace. Real Codex protocol
  checks passed text/two-client sync, file bytes, local ASR, questions and
  stream/stop/resume. Other real engine accounts were not exercised.
- Android signed-package checks passed with the previous certificate, 30 JVM
  tests and no lint errors (22 warnings). An emulator upgraded 1.0.78 → 1.0.79
  and cold-launched without a crash; this is not physical-phone playback proof.

## CLI and release

App 1.0.79 uses host/CLI 0.1.429; protocol v1 and Hub schemas 1–15 are unchanged.
The MIME fix is shared by headless and desktop Gateway delivery, with no new CLI
command or engine-specific behavior. Codex, Claude, Antigravity, Kimi and DeepSeek
use these same delivery paths. Browser playback is client presentation; it is not
a headless CLI capability. Platform/provider acceptance and final artifact
checks are recorded separately in the release verification receipt.

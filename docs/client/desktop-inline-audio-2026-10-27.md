# Desktop inline voice player — 2026-10-27

The Mac WebView's native inline audio chrome appeared as a thin, dark bar,
while the Android player used a rounded surface. Desktop voice messages now
use App-owned rounded controls around the same HTML audio element: play/pause,
elapsed and total time, mouse/keyboard seeking, and mute/unmute. Colours follow
the existing theme. No extra media decoding or animation loop was introduced.

`InlineAudioControls.tsx` owns the visible controls; `Content.tsx` still owns
attachment leases, the media element, playback retention, inactive-host pause,
source replacement and the undecodable-original save fallback. Pending play
can be cancelled, stale play rejections are ignored, and a rejected start can be
retried. Duration/position come from actual media events.

Native Android/iOS retain their current controls, even in expanded iOS layouts.
Narrow native desktop windows retain the new controls. Phone-width browsers
continue to use native controls. Draft audio and document/media preview dialogs
are unchanged. CLI impact: none; attachment bytes and Host APIs are unchanged.

## Follow-up: captioned audio outside the bubble

The attachment layout in `porcelain-details.css` matched images and files but
omitted `.attachment-audio`. A user message containing text and audio therefore
painted one background around both, reproducing the Android screenshot on current
source. Audio now follows the same attachment layout in the default, Porcelain
and Monochrome palettes: text keeps its own bubble, and the player sits below it,
right aligned with the existing 3 px gap. Reference and link-preview colours use
the same page-colour rules as image/file messages. Other palettes retain their
existing image/file layout policy.

This is a client CSS change; playback, attachment bytes, message blocks and
Host/CLI APIs are unchanged. The inline audio browser fixture now includes
captioned messages, narrow widths and both native-phone and desktop controls.
It checks the painted surfaces and relative geometry, as well as existing real
playback behavior. Source/browser verification does not update installed Apps.

The Android-width case failed before the CSS correction because the shared
container still had a grey background. Afterward, all 9 Chromium inline-audio
cases and the 6 WebKit layout/native-control cases passed, including 320 px and
390 px phone widths and light/dark desktop layouts. Rendered screenshots were
inspected. Client translation checks, TypeScript and production build passed;
the existing Capacitor keyboard import warning remains. Evidence:
`/Volumes/gdrive/taro-tmp/followup-audio-bubble-20261027`.

## Verification

- Chromium and WebKit: 12 focused cases each passed. They cover actual playback,
  pause, keyboard/mouse seek, end/replay, muted playback, retry/cancel races,
  source replacement, inactive conversations, narrow/dark layouts, native-phone
  boundaries and desktop/phone/ADHD virtualization retention.
- Unchanged undecodable bytes can still be saved.
- Final slider styling and zero-volume unmute correction: 3 Chromium checks
  and 1 WebKit check passed; these overlap the focused cases above.
- Host/client builds and final client typecheck passed. The existing Capacitor
  keyboard dynamic-import warning remains.
- Screenshots use real browser rendering with synthetic audio and simulated
  platform identity. Native Mac/iPhone/Android shells have not been installed
  or physically verified for this change.
- Separate follow-up after the frozen 1.0.116 release; not installed or released.

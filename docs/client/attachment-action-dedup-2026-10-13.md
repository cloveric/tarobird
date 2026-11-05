# One desktop quote/forward toolbar

Audio, images (including images nested in reply cards) and file cards each
rendered inline quote/forward shortcuts. The desktop message already rendered
the same actions underneath, so a single attachment displayed two pairs and
image batches displayed still more. Both pairs act on the owning message.

`App.tsx` now supplies attachment actions only in the phone layout.
`MessageContent` accepts their absence and clears the attachment context on
desktop. The one desktop message toolbar retains copy, quote, forward, export
and eligible retry controls. Phone attachment shortcuts and the message sheet
remain available. Changing window size switches action ownership with the
existing layout breakpoint; it does not change attachment data or the draft.

## Regression coverage

`attachment-message-actions` first reproduced the desktop defect: the expected
single quote button resolved to two. The updated journeys check single desktop
quote/forward controls for files, audio and nested image batches, layout
transitions, draft retention, streaming/archived restrictions, quoted-message
receipts, destination Bot selection, byte-identical forwarded copies and
preview focus/dismissal. `live-quoted-media` follows the new desktop entry point;
its real-model runs remain opt-in.

The four attachment-action journeys, two media-playback journeys, four message
action journeys and desktop context-menu journey passed in WebKit (11 tests).
This includes real playback/seeking of WAV, MP3, M4A and MP4 fixtures and
stopping playback when the preview closes, on desktop and phone layouts.

In a separate native macOS `com.tarobot.attachment-actions-preview` profile,
an audio message displayed only the message toolbar. Its remaining quote
button opened the audio reply preview, forwarding opened the destination
picker, and muted playback advanced from 0 to the 3-second fixture's end.
The preview and temporary Hub were stopped afterward; the user's installed
App and real conversations were not modified.

Client production build and the complete pre-complete hook passed: 226 test
files, 2910 passed and one skipped. The initial full run had six failures in
the unchanged service test file (four timeouts and two assertions). That file
then passed independently (172 tests), and the whole hook passed on rerun;
no service source or expectations were changed for this UI fix.

Local build and acceptance logs use
`/Volumes/gdrive/taro-tmp/attachment-actions-dedup-*`.

Mac installer 1.0.47 (Apple Silicon) passed mounted-DMG version, icon, bundle
identity, arm64, bundled-host and deep/strict signature checks. It is ad-hoc
signed, not Apple-notarized. SHA-256:
`563decfca89d2ca7156751ccc550abce2a92d01bb1e757115831065f5ed67cac`.
This is a local installer, not an in-place update of the installed App.

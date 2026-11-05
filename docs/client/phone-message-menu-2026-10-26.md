# Phone message action consistency

Phone attachment messages no longer reserve a row for quote and forward icons.
Text, photos, files, video and audio use the existing message action sheet.
The quoted source and reply-status indicators remain visible information.
Desktop hover/focus and context-menu actions are unchanged.

Image, file and video preview buttons already opt into holding their owning
message; a short tap still opens the viewer. The author/time area now also opens
the sheet, providing an entry for audio-only messages without taking over native
playback or seek controls. Links, forms, code selection and media controls keep
their existing exclusion from the hold gesture. Movement, cancellation, leaving
the conversation and release-click suppression reuse the existing implementation.

Quotes and forwards still target the entire original message, including all
attachments. Streaming forward and archived quote restrictions are retained.
Only App presentation and a phone-only gesture entry change; Host APIs, stored
messages and headless CLI commands do not change. This does not publish or
install a release.

Regression coverage uses isolated fixture Hosts: narrow phone layouts,
desktop/phone transitions, image and file hold versus tap, an actual Chromium
touch hold on an audio message's time, native-player gesture exclusion, forwarding
original bytes, archived/streaming restrictions and quote draft retention.
Browser evidence is distinct from physical Android/iPhone acceptance.

## Results

- Client translation, TypeScript and bundle build passed.
- Chromium initial integration: 22/24 passed. The two failures came from test
  navigation: a phone details dialog returned after archive, and a helper moved
  all holds to metadata. The fixture now waits for the archive receipt, returns
  to chat explicitly, and keeps ordinary bubble holds while using metadata only
  for audio-only messages. The corrected archive/media cases passed 2/2; the
  cross-device quote/forward journey also passed on rerun.
- WebKit initial integration: 22/24 passed. The archive fixture was corrected
  and passed in the final 6/6 media/attachment run. The other failure is the
  desktop offline-forwarding test: an error banner intercepts its toolbar click.
  The same failure reproduced on unmodified main (`3de4e8fc`). It is recorded
  separately, not described as fixed or caused by this phone change.
- Additional Chromium playback and media-cover checks passed 4/4. The final
  WebKit 6/6 set includes playback, seek, close, video hold versus short tap,
  image preview and archived/streaming message restrictions.
- Real-model quoted-media fixtures were updated to use the shared menu helper
  but were not executed. No physical device or installed App was changed.

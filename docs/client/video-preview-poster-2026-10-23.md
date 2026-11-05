# Video preview opening cover

The Android report showed a stretched play graphic underneath the actual native
play button. `MediaReader` did not set a video `poster`, even though chat cards
already had extracted covers. Android WebView uses a default poster when that
attribute is absent ([Android API contract](https://developer.android.com/reference/android/webkit/WebChromeClient#getDefaultVideoPoster())).

The reader now supplies a neutral, icon-free placeholder from its first render
and replaces it with a decoded video frame. Sent attachments reuse their
connection-scoped cover cache and already-downloaded Blob; drafts use the same
serialized decoder with a weak Blob cache. Cover preparation never plays or
seeks the visible player, fetches a second original, or changes attachment bytes.
Closing cancels the reader's cover job. Failed extraction keeps the plain
placeholder; an unsupported video retains the existing save/open fallback.

The player keeps the original dimensions from metadata or the cached cover's
source dimensions. This matters because a cover is capped at 640px: letting its
pixel size determine layout would shrink a 720p player before playback. Native
controls and the established phone/desktop preview layout remain in use.

Validation evidence: `/Volumes/gdrive/taro-tmp/video-preview-poster-20261023/`.
The baseline phone browser check failed on the missing poster. Final Chromium
and WebKit each pass 12 cases across `media-playback`, `media-thumbnails` and
`media-preview-drag`; each skips the opt-in original-user-file case. These cover
real frame pixels, paused opening at time zero, stable cover/playback geometry
with a synthetic 720p clip, playback/pause/seek, sent/draft/file-list previews,
unchanged downloads, large-video download limits and unsupported media. Desktop
and phone screenshots were inspected. An outdated draft-focus assertion was
updated to the existing October 23 contract: desktop preview returns to the
composer for another paste. No focus behavior changed in this patch.

Client translation/TypeScript/production build and the host standalone build
pass. Android was not connected during this run; browser results do not establish
physical Android/iPhone acceptance. No installed App was updated or restarted.
This is presentation-only: shared delivery, permissions, host APIs, schemas and
headless CLI capabilities are unchanged, so no new CLI command applies.

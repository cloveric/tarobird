# Clipboard image intake

Issue #20 reports a Windows DingTalk image paste that inserts only `[图片]`.
The old composer only inspected `clipboardData.files`. An HTML data image or
a standard native image representation unavailable in that file list was lost.

The main and side composers now prefer the event's files (including file items),
then, for image-only pastes, inline PNG/JPEG/GIF/WebP data images from inert HTML. Electron additionally
asks its main process for a standard clipboard image when an image-like paste
has no event files. It uses the current asynchronous `clipboard.read()` API,
not the removed `readImage()` API. Native reads require the owned, focused App
window, current document authority, bounded sizes and matching clipboard text.
The original clipboard is never changed. The App never fetches clipboard URLs,
opens clipboard file paths or decodes opaque application-specific formats.

Only empty text or an image placeholder enables the HTML fallback. An explicit
image file item whose `getAsFile()` returns null also enables native recovery,
including with a caption; the text keeps its native insertion and undo history.
If the event's text is also unavailable, recovery waits for the browser's
default paste and uses the actual insertion between the unchanged draft prefix
and suffix. The main process still requires that text to match the clipboard;
edited drafts or mismatches are preserved and receive retry guidance. Synthetic
tests cover this shape; the affected Windows clipboard has not been captured.
Prose with only embedded HTML icons or avatars keeps the browser's native insertion and
undo history, including when side attachment capability is unavailable. Mixed
file captions stay at the selected caret. A sole `[图片]` / `[image]` placeholder
is omitted only when an image is actually added; an asynchronous placeholder is
removed only if the text and selection remain untouched. Attachment-policy
rejections preserve the original clipboard text. Navigation, hiding,
disabling and a newer image paste retire pending results. An edited draft is
preserved and gets retry guidance. The side conversation ID also scopes pending
results across a restart. Ordinary mobile image/file selection is unchanged.

Verification includes Electron clipboard/service/authority tests; real React
composer tests in Chromium and WebKit; and an App + isolated Hub regression that
uploads an HTML-only image and compares its exact bytes. Existing combined
attachment, drag/drop and voice-draft regressions cover shared intake behavior.
All fixtures are synthetic. Browser fixtures model native IPC; they do not
establish which formats the affected Windows DingTalk installation publishes.

This fixes the confirmed intake gap. A clipboard containing only a private
DingTalk format or a remote/local image URL still cannot supply image bytes;
the App preserves its text and suggests copying again or saving/dragging the
image. Windows DingTalk and installed-App acceptance remain required. No release,
installation, version change or new Host/CLI capability is included. CLI is
not applicable because this is a local App clipboard action.

Reference: [Electron clipboard API](https://www.electronjs.org/docs/latest/api/clipboard).

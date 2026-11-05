# One phone attachment-action footer per message

Two images in one sent message displayed two quote/forward pairs. Each pair
acted on the entire message, so the per-image placement misrepresented its
scope. Nested image cards, mixed media and separated file groups had the same
ownership problem.

`MessageContent` now owns one footer after the complete message content.
The existing protocol attachment walker includes nested card attachments.
Images, audio and file cards retain their individual preview/save behavior,
while quote/forward continue using the original complete message and existing
archive/streaming restrictions. The desktop toolbar and phone More sheet remain
unchanged. File-library rows do not acquire message actions.

CLI impact: this is client action placement only. No host capability, API,
message schema, engine adapter or headless CLI command changes.

## Validation

- The pre-fix phone nested-image test reproduced two quote controls where one
  was expected. The revised test also checks forwarding and mixed image/audio/
  file messages, plus resizing between desktop and phone layouts.
- Translation checks, TypeScript and the client production build passed.
- Chromium and WebKit each passed 22 relevant journeys across
  `attachment-message-actions`, `message-images`, `message-actions` and
  `file-actions`. Coverage includes 320/390/1360px layouts, draft/focus retention,
  archive/streaming restrictions, offline forwarding, file saves and previews.
  User image batches were actually uploaded and forwarded through an isolated
  Hub; all three destination images matched the original bytes and the source
  message identity was preserved.
- Two Android saved-file renderer fixtures also passed after removing their
  obsolete per-file message-actions prop. Their native bridge is mocked.
- WebKit's three image journeys initially timed out in screenshot font waits
  after the interaction checks. Explicitly loading both bundled CLI font faces
  before theme cycling resolved the fixture wait; all three image journeys
  then passed in both engines. No font/product behavior was changed.
- Reopened phone gallery, CLI and grouped-document screenshots show one compact
  footer. Logs and screenshots are on the mounted disk:
  `/Volumes/gdrive/taro-tmp/tarobot-single-media-actions-20261016/`.

New native installers are outside this source correction; browser checks do
not establish physical-device acceptance. The installed Apps are unchanged.

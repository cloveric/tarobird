# Quiet composer autosave

Every text edit starts a durable draft write. The composer previously switched
between “正在保存草稿…” and “草稿已保存” for those writes, producing a distracting
flash while typing.

Routine saving/saved text is now visually hidden on desktop and phone, with
automatic live announcements disabled. The surrounding flex spacer stays in
the toolbar so hiding the text does not move the send button. A text or rich
draft failure remains visible and politely announced as “草稿未保存”. Existing
save calls, unload protection, rich-draft retries and recovery are unchanged.

## Verification

- WebKit: the existing desktop/phone complete-draft journeys and failed-write
  recovery journey passed (3 tests). These cover reload, text, attachments,
  quotes, recipient isolation and protection after a rejected storage write.
- Client production build and the required pre-complete hook passed (226 test
  files, 2910 passed / 1 skipped). An earlier full run hit the unrelated
  `board-phase2` concurrent-edit assertion; that file passed independently
  (12 tests) and the complete hook passed on rerun, without board changes.
- Actual macOS WKWebView in `com.tarobot.quiet-draft-preview`: native typing
  showed no saving/saved text in the toolbar; the send button remained at the
  right. The typed draft survived quitting and reopening the preview. The
  reopened view used cached messages; no live-model or delivery claim is made.
- The preview and temporary fixture Hub were stopped after verification. The
  user's installed App and existing hosts were not replaced.

Local verification logs: `/Volumes/gdrive/taro-tmp/quiet-draft-*`.

Mac installer 1.0.45 (Apple Silicon) passed mounted-DMG version, icon, bundle
identity, arm64, bundled-host and deep/strict signature checks. It is ad-hoc
signed, not Apple-notarized. SHA-256:
`74a3d28284349e79b614211a4f654223dea2fa271b56210a9c616500cead1d87`.
This is a local installer; updating the installed App is a separate step.

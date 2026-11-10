# File Center › 附件管理 (2026-11-07, issue #1)

Host attachments (`<state>/attachments/*.blob`) could not be removed from the
App: clearing history or deleting a message only hides it for the reader, and
daily GC only collects attachments that no message references. File Center now
has a second view, **附件管理**, and the CLI has `tarobot attachments`.

## Behaviour

- **Owner only.** The Hub advertises `attachments.admin.v1`; the tab appears only
  for the host owner on a Hub that supports it.
- **View.** A summary of attachment space and count, then conversations sorted by
  space. A conversation lists its attachments by size or upload time (100 per
  page), with name, type, size, time and 定位消息 (main window only; it closes File
  Center and opens the message).
- **Delete.** Select attachments or use 删除全部附件. A confirmation states the
  count and space freed, that it cannot be undone, and that only the host copy is
  removed. The Hub retires the attachments in one transaction, then removes the
  blob and upload chunks at once under the maintenance lock. Repeating a request is
  a no-op.
- **Messages.** Text and the attachment reference stay. Downloads answer
  `attachment_deleted` (410) after the normal membership check, so images, audio
  and the viewer show 附件已删除 without a retry button; file cards show the same
  text when saved. The deleting device drops its own cached copies immediately.
  Other devices keep any copy they had already cached; that is the device's copy,
  not the host's.
- **Bots.** A Gateway acknowledges an input only after its turn settles, so an
  attachment in a message with a `pending` delivery is refused (「Bot 未处理完」).
  A running turn already has its own workspace copy. A later quote of a deleted
  attachment cannot re-download it. Workspace copies under `.tarobot-files` are
  separate and remain managed in 工作区文件.
- **Clear history** now says it does not free host space or delete attachments
  and points to 文件中心 › 附件管理.

## Storage and recovery

- Deleted rows remain as tombstones. Daily GC deletes any bytes of retired
  attachments an interrupted purge left, but keeps referenced rows.
- Daily automatic backups contain the database only, not attachment files, so they
  hold no copy of the deleted bytes. Restoring an older database snapshot brings
  back rows whose blobs are gone; those attachments read as unavailable.
- Forwarding a message whose attachment was deleted fails with
  `attachment_not_found`, as for any missing attachment.
- Sizes are logical file sizes. A forwarded copy can share disk blocks through a
  hard link, so the space actually freed can be smaller than reported.

## CLI

```text
tarobot attachments list [--conversation ID [--sort size|time] [--offset N]]
tarobot attachments delete (--ids ID,ID | --conversation ID) --yes
```

`list` without `--conversation` prints the per-conversation summary. `delete`
requires `--yes` and reports `deleted`, `freedBytes`, the deleted `ids` and any
`pending` IDs refused because a Bot has not finished.

## Verification

- `hub-attachment-admin` (summary/list/sort, owner-only, purge of blob and chunks,
  tombstone and `attachment_deleted`, membership before disclosure, pending refusal,
  idempotency, audit, GC sweep), `host-cli-attachments` (real Hub routes through the
  local owner controller), plus `hub-maintenance` and `hub-conversation-files`.
- Browser `attachment-manager`: delete one, then all; blobs removed; locate;
  reload shows 附件已删除 from the Hub; English at 1360, 820 and 390 px without
  overflow.
- Browser and unit tests are not an installed App or physical phone run.

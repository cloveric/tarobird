# File drops during local draft refresh

Returning from the file manager focuses the App window and revalidates its
local rich draft. Previously that read temporarily disabled the drop target,
so a first multi-file drag could be refused while a second attempt succeeded.
The rejection was local UI state, not evidence of a slow network. Windows and
macOS use this shared renderer path.

The conversation now accepts file appends while its draft is loading. The
existing draft hook holds those edits in memory and replays them onto the
validated stored revision. Sending still waits for readiness. Upload/send,
read-only, archive, deletion, modal, pane and conversation-scope guards remain.
No files are automatically uploaded or sent by dropping them.

A failed read keeps its pre-edit baseline until recovery succeeds. Retrying an
unchanged disk revision therefore does not replay an append onto a visible
draft that already contains it. An externally changed revision still supplies
the new base; revision-checked writes continue to reject concurrent conflicts.
Removing an attachment captures the selected File identity, rather than
replaying its old list index against a newly loaded list from another window.
An intervening refresh cannot remove a different file or restore the removed
new attachment.
If another window has replaced an existing File with a new stored object, an
old removal leaves that new object intact. The user can remove it again after
refresh; a stale action must not guess which foreign file to delete.

Drop rejections have their own dismissible notice. Successful file intake
clears only that notice, leaving independent upload, send, connection and local
storage errors visible. Changing conversations or hiding a workspace retires
its drop notice. A mixed directory/file drop still adds real files and warns
about the skipped directory.

## Verification

- Before the fix, two real App/Hub browser regressions failed: a gated local
  draft read refused the first disk-backed multi-file drag; a later successful
  drop retained an earlier rejection.
- A separate real IndexedDB/hook regression reproduced duplicate append after
  failed-read recovery. Retained coverage checks unchanged/foreign revisions,
  background conversation ownership, exact bytes, read/save failures, capacity,
  identity and revocation boundaries.
- Chromium CDP exercises disk-backed file drops and delayed focus reads. Shared
  draft/storage coverage also runs in WebKit. Neither is Windows Explorer,
  macOS Finder, an installed App or physical-device acceptance.
- Phone picker/rotation, ADHD routing, side-panel refusal, upload/send locking
  and completed voice draft retention are covered by the existing focused suites.

CLI-not-applicable: this changes App input and local draft recovery only. Host
attachment APIs, CLI behavior, schemas, iPhone/Duo layout and release versions
are unchanged. This source change publishes no installer and updates no
installed App; native file-manager drag acceptance remains a release check.

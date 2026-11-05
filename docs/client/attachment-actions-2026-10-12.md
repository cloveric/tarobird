# Chat attachment replies and forwarding

Files, images (including card image batches) and audio now show compact **引用**
and **转发** actions on the attachment. They act on the owning message: quotes
keep the current draft; forwarding retains its original text, all attachments
and provenance. Desktop right-click and phone message/hold menus still work.
Archived chats disable quoting; unfinished messages disable forwarding. File
library rows outside a message retain their preview/save controls.

Selecting a direct conversation now defaults to notifying its Bot. The previous
default saved a forward without a delivery record, so the target Bot never
received a turn. Groups/topics still require an explicit reply choice and Bot
recipients. The dialog explains whether it will notify a Bot or only save a copy,
and supports finding conversations by Bot name. Changing recipients or the reply
option creates a fresh idempotency key; retrying unchanged input retains it.

The existing Hub forwarding transaction copies attachment blobs and metadata
into the destination conversation, rewrites IDs, and creates deliveries for the
chosen Bots. Quoting resolves resources from the same-conversation parent in
the Gateway. These paths were exercised without broadening source permissions.

## Verification

- Focused Hub/Gateway suites: 46 tests passed (`hub-forwarding`, `gateway-service`).
- Chromium: 13 focused cases passed across attachment actions, message menus,
  phone sheets/hold, offline forwarding, file library and attachment safety.
- WebKit: 9 focused cases passed across attachment actions and message menus,
  phone sheets/hold and offline forwarding. Initial new-test fixture failures
  (pairing wait, asynchronous send receipt, archive closing its own panel) were
  corrected and affected cases rerun successfully.
- Root/client builds and translation validation passed.
- Required `scripts/pre-complete-hook.sh` passed: 207 suites, 2,749 tests passed
  and 1 skipped.
- Real Codex CLI 0.162.1 / `gpt-6-astra`: two independent native sessions read
  randomized codes from quoted/forwarded PNG and PDF copies. Both native input
  hash sets matched the original files, after original-message deletion and
  orphan collection. The target Bot was denied access to source attachment IDs.
  Direct forwarding was enabled by default; an unselected Bot received no turn.
  [Machine-readable receipt](images/attachment-actions-2026-10-12/real-codex-receipt.json).
- Independent Tauri debug App: paired to an isolated local Hub, quoted a Word
  attachment while retaining the draft, searched a second Bot by name, forwarded
  with the reply checkbox selected by default, and opened the copied Word in
  the destination conversation. The test App and owned Hub were then stopped.

Native attachment quote (historical image omitted from this clean snapshot)
Native forwarded copy (historical image omitted from this clean snapshot)

The phone checks use browser contexts, not a physical Android/iOS device. The
real-engine receipt covers Codex; other engines were not rerun in this change.
The isolated desktop build is not an installed production App update or release.

# Conversation multi-select — 2026-10-24

Source feature; no release or installed-App update is implied. Baseline: `03b2e3e`.

## Interaction

- Phone: long-press a conversation or group and choose **多选**. Desktop: right-click or Shift+F10 and choose **多选**. The originating row is selected immediately; subsequent row clicks toggle selection instead of opening chats. The same control is available in ADHD without changing panel membership.
- Selection is limited to one Host and 100 explicit targets. Other Hosts explain why they are unavailable; deselecting every item unlocks the Host choice. Search/folder folding can hide selected rows; the count opens their full review list. Desktop layout/Host-filter transitions and leaving the phone Messages tab exit selection; search and phone inbox filters preserve it. Native Back/Escape closes the dialog before leaving selection.
- **移至分组** offers existing folders, Unfiled and atomic create-and-move. Topics follow their parent group's folder; selecting topics disables moving and offers a one-click exclusion. Personal folders remain scoped to the authenticated user on that Host. The new-folder field accepts Enter and excludes IME composition confirmation.
- **删除** asks for confirmation and uses recoverable archive. Records, attachments, drafts, session bindings and Bots are retained. Current replies continue; automatic group discussions pause after the current speaker finishes. On phones the destructive confirmation is placed away from the bottom-right entry, so repeated taps cannot confirm the delete by landing on the newly opened button. A selected parent absorbs its selected topics without separately archiving them, so restoring the parent reveals the same previously visible topics.
- Deleting a currently selected conversation chooses a surviving visible root by activity, or the surviving parent of a deleted topic. It never activates another Host or forces the phone out of its list. ADHD panels retain existing archive behavior.
- Mixed ownership disables archive and offers to keep only owned targets. A stale/unavailable selected item rejects the whole operation; the review identifies it and offers one-click removal of unavailable items. Nothing is silently skipped. Selection-dependent guidance stays in a fixed single-line status row, so toggling the last item, a topic or ownership cannot move another row under a repeated click. The count or **查看** opens full guidance and exclusion controls; long status text may be abbreviated in the narrow toolbar.

## Shared Host contract and compatibility

New capability: `conversations.batch.v1`. Old Hosts show an upgrade explanation and never receive a loop of individual writes masquerading as one transaction. Old clients keep their existing single-item controls and receive standard `conversation.updated` / `conversation-folders.updated` frames. The feature does not change any engine adapter.

`POST /api/conversations/batch`, authenticated as the current user:

```json
{"action":"archive","requestId":"cb_example","conversationIds":["chat_a","chat_b"]}
```

```json
{"action":"move","requestId":"cb_move","conversationIds":["chat_a","chat_b"],"revision":4,"target":{"folderId":"folder_work"}}
```

`folderId:null` means Unfiled. `target:{"newFolder":{"id":"folder_new","name":"Project"}}` creates the folder and assigns every target in the same transaction. Folder revision and all membership/ownership checks occur before mutation. The ordinary folder endpoint retains its original individual-edit schema; batch-only variants are internal to the shared transactional primitive.

Response:

```json
{
  "receipt":{"requestId":"cb_move","action":"move","conversationIds":["chat_a","chat_b"],"completedAt":1792830000000,"folderId":"folder_work"},
  "replayed":false,
  "conversations":[],
  "folders":{"revision":5,"folders":[],"assignments":[]}
}
```

The arrays above are abbreviated. `receipt.conversationIds` contains effective targets; `conversations` and optional `folders` contain **current** state, including on replay. The client receives conversation changes through its ordered socket, avoiding a delayed HTTP snapshot overwriting a later restore.

Additive table `conversation_batch_requests` stores `(user_id, request_id, payload_hash, receipt_json)`. The fingerprint uses parsed input and sorted IDs. Same ID plus different content fails; same ID plus identical content returns the original receipt and current state without executing again. It shares the transaction with archive/folder changes, survives restart and travels with SQLite backups. Schema range remains 1–21. Receipts are durable rather than age-pruned: deleting their identity would let an old retry reapply a destructive operation. Future compaction must preserve non-replay tombstones.

## Unknown results and concurrency

The per-Host client cache stores the exact request under `operation:conversation-batch`, using the existing IndexedDB compare-and-swap primitive. Two windows cannot replace each other's pending request. A conflicting pending batch closes the current confirmation and preserves this window's selected rows; the user must explicitly choose to inspect the other record before its original targets are shown, rather than having a destructive button silently change targets in place. Retry also requires the saved record still to match atomically; a record cleared by another window cannot be resurrected from stale in-memory state. Reload restores the pending selection; opening the list or reconnecting does not resend anything. HTTP writes never enter the message outbox.

**重试删除 N 个对话 / 重试移动 N 个对话** explicitly means: if the request previously did not run, it runs now; an already committed request returns its receipt without repeating writes. **不再重试** requires confirmation and only clears this device's matching local record; it does not undo an applied operation or cancel a request already in transit. Unreadable records also have this recovery path. Confirmed pre-commit rejection codes clear the record; network/timeout/final-authentication uncertainty retains it. We do not infer “no commit” from every HTTP 4xx because final response authentication can fail after mutation.

## Headless CLI

The same authenticated Host API and business logic are exposed through:

```sh
tarobot conversations local --json
tarobot conversations archive --ids chat_a,chat_b --yes --request-id cleanup_1 --json
tarobot folders list --json
tarobot conversations move --ids chat_a,chat_b --folder folder_work --revision 4 --request-id move_1 --json
tarobot conversations move --ids chat_a,chat_b --new-folder Project --revision 5 --request-id move_2 --json
tarobot conversations move --ids chat_a,chat_b --unfiled --revision 6 --request-id move_3 --json
```

`conversations list --host … --bot …` remains the existing cross-Bot directory command. The new `local` command reads the current Host's visible directory, including archived rows. Missing `--yes`, ambiguous targets, duplicate flags/IDs and unsupported capabilities fail before mutation. Known Host rejections retain their code/status and include an actionable explanation. CLI prints the request ID; explicit retries must preserve both the ID and original arguments. A new-folder ID is derived from the request ID so retries remain identical.

## Validation and independent review

Evidence: `/Volumes/gdrive/taro-tmp/conversation-multiselect-20261024`. CC1 uses **Claude Opus 5.5 [1m], xhigh**, independently reviews design/diffs and clicks the new isolated fixture. Root owns product changes and automated regression. Synthetic fixture Bots do not execute model tasks; production sessions and the installed Host are untouched.

Focused suites cover atomicity, permissions, parent/topic normalization, restart/replay after later restore or move, bounds, authenticated CLI, backup regressions, phone/desktop entry, cross-Host identity, ADHD, lost receipts before/after commit, corrupted local records, competing windows and old Hosts. Browser evidence includes 320/390 phone widths, desktop, light/dark and WebKit; it does not establish real iPhone/Android or native-shell acceptance. The full unit run passed **6,649 tests in 483 files**, with **5 conditional skips** (`full-tests-v5.log`). All **20 multi-select scenarios** were covered successfully in both Chromium and WebKit. The final full runs passed 19 and 18 respectively (`chromium-stable.log`, `webkit-stable.log`); the initial failures used a desktop-only button locator in the new phone geometry test. After correcting that test locator, all **3 geometry scenarios passed again in each browser** (`chromium-stable-retry.log`, `webkit-stable-retry.log`), completing coverage of all 20. The existing mobile action suite passed **5 cases**; the expanded folder/ADHD/density run passed **68 of 69**, with the baseline failure detailed below. Final focused Host/CLI/folder/backup checks passed **82 cases** (`focused-final.log`); the last UI/CLI refinements passed **23 focused cases** (`focused-u14.log`). Host and client translation/type/build checks passed. Opus independently reviewed the design and source, then performed multiple rounds of desktop mouse/keyboard and 320/390 touch interaction in the isolated fixture. The audit reproduced and drove fixes for stale cross-window retries, selection replacement, phone double-tap confirmation, ADHD search retention/counts, selected-row contrast, Enter/IME submission and revoked-device feedback. The final cross-window checks confirmed preserved local selection, explicit inspection of the competing record, no resurrection after discard, and normal creation of a fresh selection. Evidence is in `opus-diff-review.md`, `opus-ui-acceptance.md`, `opus-final-review.md` and `opus-ui/`. Opus found no blocking defect and reviewed the final fixed-height toolbar increment in code; its final geometry acceptance is root’s browser evidence, not a claimed extra manual run. The independent browser sessions were closed and the isolated fixture was gracefully stopped after the audit. The manual fixture kept its initially loaded backend; the final backend/CLI changes are covered by the automated authenticated tests, not represented as manually reloaded.

## Deliberate boundaries

- No cross-Host batch, bulk permanent purge or bulk restore is introduced.
- No automatic retry. Pending operations require explicit retry or discard after checking the list.
- No server cancellation of an already submitted request; discarding local bookkeeping is not cancellation.
- No app release, production restart or local installation is part of this source change.

### Existing regression reproduced on the baseline

The broader `adhd-board` browser suite failed its background-report reader’s **查看关联请求** location assertion (`adhd-board.spec.ts:460`). A fresh detached worktree at the unmodified `03b2e3e` baseline, with a fresh client build, failed at the identical assertion (`baseline-adhd.log`, `baseline-results/`). This is recorded separately from multi-select acceptance; this feature does not change the report reader or claim to repair that pre-existing path.

The independent browser audit also observed an existing lazy-chunk 404 when the development client directory was rebuilt under an already open page. This change does not alter asset-version deployment or claim to fix that separate upgrade-recovery behavior.


## October 28 selection and confirmation presentation

The phone screenshots showed a neutral black selection check, an expanded list
followed by several dense paragraphs, and an ambiguous retry label. The shared
phone/desktop/ADHD selection check now uses the saved accent's solid-control fill
and contrasting ink. With no monochrome accent selected, the user's neutral
choice remains intact; the ordinary palette accent remains the fallback.

Delete confirmation leads with what is retained: history, drafts and Bots. Current
replies and automatic-discussion behavior remain visible. Selected conversation
names and exact restore paths can be expanded separately. A bounded scrollable
body leaves the title and action footer visible on short screens. The destructive
phone action stays on the left, away from the underlying delete-entry position.

An uncertain response now has one action-specific explanation. The accessible
retry button names are `重试删除 N 个对话` / `重试移动 N 个对话`; the former
`放弃此记录` entry is `不再重试` and still opens the existing explicit local-record
discard confirmation. Retry uses the exact original request and target. It can
execute a previously unreceived request; it never repeats a committed operation.
There is no automatic retry or new server-side cancellation.

CLI impact: presentation only. Host batch APIs, authorization, archive/move
semantics, idempotency receipts and headless commands are unchanged. No installed
App, user conversation, model session or production Host was modified.

Validation evidence is under
`/Volumes/gdrive/taro-tmp/conversation-bulk-ui-20261028`. Chromium passed all 23 initially collected cases; a final 4-case run also passed,
including the subsequently added move-retry case (24 distinct Chromium cases).
WebKit passed 8 focused cases and the final 4-case rerun. Selection helpers passed
3 unit tests; Host/client builds and translation checks passed. Captures cover
1360px desktop, 390/320px phones, light/dark sage checks, collapsed confirmation,
and expanded recovery at 568px height. Final captures use disabled animations;
a recapture helper initially targeted a shrinking `details[open]` list, timed out,
and was corrected to stable summary locators before both final runs passed.
Browser validation does not establish physical Android/iPhone or installed desktop
acceptance.

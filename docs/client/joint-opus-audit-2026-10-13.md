# Joint source and runtime audit — 2026-10-13

Baseline: `9719aca9fa1a5738eb15002f1e754992e7454e2e`. This audit covers the
App/Hub/Gateway message paths, asynchronous questions, scheduled jobs, session
and workspace ownership, reconnect/authentication, client navigation and native
attachment boundaries. It builds on, rather than repeats, the
[previous review](joint-opus-review-2026-10-12.md).

## Method and scope

Codex reviewed the source and callers, reproduced defects with controlled
asynchronous boundaries, then added regression coverage. Supplementary reviews
covered client navigation and portable/native integrations. A separate real
Claude Code process used `claude-opus-5-5[1m]` with `--effort xhigh`, read-only
source tools, no session persistence, no Chrome and no external MCP servers.
Provider transcripts and reproduction logs stay outside the repository.

The independent Opus review completed successfully; its returned model usage
identifies `claude-opus-5-5[1m]`. Its source findings were treated as hypotheses
until local reproductions established the affected paths. In particular, it
identified group retry fan-out, folder rollback recovery, handshake metadata
ordering, optional-folder corruption, oversized-text feedback and the missing
macOS quarantine boundary.

Opus also completed a separate review of the repaired patch. It identified a
replacement-file risk in the new quarantine flow: opening with truncation before
marking could empty an existing file if marking failed. A real temporary-file
regression reproduced that loss. The final flow opens without truncation, marks
the file, then truncates and writes through the same handle. A marking failure
preserves the old bytes and asks the user to select another folder. Native tests
also verify the corrected order and an actual marking failure after a target move.
An additional Opus xhigh review checked the installed JavaScript/Rust plugin
implementations, capability grants and regressions and found no remaining blocker.
Its follow-up wording observation is also addressed: marking is still the
preparation stage, so its failure does not incorrectly label an intact destination
as a partial write. Chromium/WebKit verify that distinction from actual write errors.

The pre-change default suite passed 227 files, with 2,917 tests passing and one
skipped. This clean baseline did not rule out the defects below: the new
reproductions exercise previously untested state transitions.

## Confirmed defects and repairs

| Area | Trigger and previous behavior | Repair and regression evidence |
| --- | --- | --- |
| Bot connection ownership | An instance closes while its authentication read waits in the database queue. Its already-completed close handler has no Bot ID; the continuation then registers the dead socket as online and can replace a healthy instance. A second pipelined hello can also continue after the first is rejected. | Guard queued work and authentication continuations by socket lifecycle, rejection and current ownership. Real WebSocket tests hold the credential read, close the candidate, and verify both empty and already-online cases; rejected pipelined authentication cannot set online. |
| Asynchronous question ownership | A question's ordinary turn ends while a background Goal still owns the conversation run slot. An answer can keep retrying an idle engine or be steered into a later unrelated turn. The same defect affects questions from answer-follow-up turns. | Identify the actual originating turn controller, including a turn attached to a Goal or promoted after the Goal ends. Completed-origin answers queue normally; live-origin answers still steer. Tests cover both origins, a surviving Goal, a newer turn, and actual Goal completion/promotion. |
| Scheduled workspace | A scheduled task in an externally resumed conversation uses the default workspace and file-delivery roots. | Resolve conversation-scoped resume state before the turn and use the same workspace for execution and delivery. Tests cover App and Feishu profiles, reuse and fresh-per-run modes, and two distinct projects with byte-checked attachments. |
| Pending session selection | A scheduled App task runs before an ordinary message applies the user's new native-session selection. | Prepare the conversation inside its queued run. Real Hub/Gateway coverage verifies selected-session execution, project file delivery, and rejection of a missing selection before engine invocation. Fresh-per-run jobs keep their fresh session override. |
| Schedule editor | Change an existing daily/workday schedule to weekly without changing the weekday control. The displayed weekday and saved cron field disagree, preserving the old frequency. | Initialize weekly state to a valid weekday; browser tests save and re-read the durable job for both original frequencies. |
| Hidden folder dialogs | A notification switches hosts or opens a phone conversation while a folder create/manage dialog is open. Its hidden, still-mounted native modal makes the new screen inert. | Gate dialogs by owner visibility and close them on layout transitions. Browser tests cover desktop/phone host switching, same-host phone navigation, return to the first host and resizing; the destination composer remains usable. |
| Android share retention | Pinning a recipient before a failed send atomically rewrites the share manifest, refreshing the directory timestamp and extending the intended 24-hour retention. | Expire published items by validated original creation time; retain bounded age-based fallback for malformed/unpublished metadata. A real temporary-filesystem rewrite and JVM cases cover the retention boundary, recent manifests, invalid/future timestamps and bounded reads. |
| Group reply retry | Retrying one Bot's failed reply resends the user's original mention list, repeating successful Bots' work or failing if an unrelated recipient has left. | Retry only the failed Bot, validate its current membership and preserve explicit user-message resend behavior. Forwarded messages retain forwarding semantics with the narrowed recipient. |
| Oversized text | A message over the protocol's UTF-8 text limit reaches schema parsing after attachments have uploaded, exposing a raw validation dump. | Check the same text-byte limit before composer/share uploads and before transport parsing. Preserve the draft and show the existing friendly file-send guidance. |
| Folder revision rollback | After restoring an older Hub backup, cached revision numbers make the authenticated snapshot and every conflict refresh look stale, leaving folder edits stuck in repeated conflicts. | Accept new authenticated snapshots as authoritative. Conflict refresh may replace a lower revision only if no newer update arrived during that read; serialize cache/state updates and fence old connection work. |
| Handshake metadata | An authenticated device can receive Bot/conversation/folder/avatar changes before `ready`; the client correctly ignores pre-ready application data and then misses the change. | Buffer bounded metadata publications until the authenticated snapshot has been sent, preserving ordering and authorization checks. A saturated handshake reconnects for fresh state. |
| Optional folder corruption | An unreadable folder record throws while building `ready`, preventing an otherwise trusted device from chatting and showing misleading pairing errors. | Omit unavailable optional metadata, disable folder editing and report a fixed warning; preserve the corrupt authoritative record for repair. |
| macOS attachment provenance | A saved incoming file has no system quarantine metadata before being opened with its default handler. | Open the save-dialog-authorized file without truncation, apply the OS quarantine API, then truncate and write. Failed marking preserves existing bytes and cannot produce a successful save receipt. Actual Mac tests check the attribute, retained bytes/mode, subsequent writes and moved-target failure; no test opens or executes an attachment. |
| Immediate navigation recovery | The displayed conversation changes before asynchronous cache checks and the selected-conversation write complete. Immediate reload or close can restore a previous chat. | Keep a small synchronous pending-selection hint scoped to database, pairing and cache generation, while retaining IndexedDB as the main store. Unique hint tokens prevent an earlier A-to-B-to-A save from clearing a newer selection; transaction identity checks reject an old pairing's delayed write. |
| Incomplete legacy schedules | The durable CronStore accepts an old one-shot job without an execution time, but the App list rejects the entire response because of that record. | Expose the existing job as needing repair, with no invented next-run time. It remains pauseable, removable and editable; strict writes still reject an empty time and invalid jobs cannot be enabled. Reading does not rewrite the original record. |
| Question-only stop receipt | Stopping a conversation with only a pending asynchronous question cancels it but returns `stopped: false` and logs a no-op. | Include cancelled questions in the stop result and timeline count; the real Gateway regression verifies the receipt and cancellation. |

## Disposition of other observations

Opus also suggested expiring Gateway operation receipts and notification claims.
Those records deliberately prevent replay from repeating side effects or showing
the same notification. The current protocol has no finite replay horizon; deleting
them after an arbitrary TTL would weaken that contract. They are retained in this
checkpoint. Long-term storage compaction needs a durable watermark or equivalent
replay fence, rather than expiration alone. This remains a scaling consideration,
not a claim that retention is bounded.

Forwarded-message retries use the immediately stored forwarded copy as their
source, consistent with ordinary forward-of-forward behavior. That preserves the
stored content and current authorization boundary; the displayed provenance names
that copy's sender, rather than rewriting it to the original historical author.

The macOS finding is specifically the missing provenance marker. Newly created
`.command` files are not given executable permissions, and `.app` directories do
not pass the existing regular-file opener. The audit did not execute handler
files or demonstrate a Gatekeeper prompt. Windows Mark-of-the-Web is outside this
Mac repair and is not claimed as implemented.
Destinations that reject quarantine remain unsupported for this save operation:
the App reports failure and asks for another location while preserving an existing
destination. Non-APFS/FUSE/network-filesystem behavior was not tested on an actual
mount; the browser regression injects the marking rejection.
A new destination can remain an empty file after a marking failure, but contains
no attachment payload and is never reported as a successful save.

## Verification boundaries

- `scripts/pre-complete-hook.sh`: standalone build and **230 test files passed;
  2,935 tests passed, one skipped**. The standalone graph has 295 modules and
  excludes legacy transports and the Feishu SDK.
- `npm run test:legacy -- --maxWorkers=4`: optional legacy build and **56 files,
  1,217 tests passed**.
- Android `:app:testDebugUnitTest :app:lintDebug`: native Java compilation,
  **27 unit tests** (including six new expiry regressions) and lint passed.
- Full Tauri `cargo check --locked --offline` passed; `cargo test ... saved_file`
  passed **five tests**, including four OS-backed quarantine tests and the
  save-dialog/path/symlink authorization test.
- DeepSeek plugin verification with its own locked dependencies passed: typecheck,
  **29 tests**, committed bundle parity and package dry-run. An initial check
  used parent-repository dependencies because the plugin's own dependencies
  were absent; installing its lockfile resolved that environment mismatch.
- Client translation, TypeScript and production Vite build passed. The final
  client state/navigation suite passed **17 Chromium and 17 WebKit cases**;
  additional mobile navigation journeys passed **17 Chromium cases**.
- Attachment export, file actions and the new group-retry/text-limit journeys
  passed **25 Chromium cases** across focused runs. File actions and the new
  retry/text-limit journeys also passed **13 WebKit cases**. The new test file
  is included in the WebKit configuration so future runs cannot silently omit it.
- A redacted Gitleaks scan of all changed source, tests and documentation found
  no secrets. `git diff --check` passed.

Tests use isolated Hubs, real local WebSockets, temporary databases/files and
browser UI journeys. Provider engine execution is substituted where necessary;
no test sends messages to a user's real conversations. Native Java tests and
lint do not establish physical-device behavior. Source review of iOS, desktop,
relay and external-service paths is not a live deployment or credential check.

This source checkpoint does not replace installed Apps, publish a release or
restart the user's services.

# Baoyu canvas and PPT audit — 2026-11-03

The owner narrowed the integration to **canvas and PPT** and explicitly held
publication until a new approval. This work does not bump a version, publish
artifacts, or update the installed App. The previous release baseline is App
1.0.127 / Host 0.1.472, source `f22db812b0f6c76074d791b78a3bf63f276e4250`.

## Scope and compatibility

Both editors and their adapted skills are pinned to upstream
[2.8.2](https://github.com/JimLiu/baoyu-design/releases/tag/v2.8.2), commit
`a87e91ffdf77362e0061feeeeecf7f6e588cfda4`. The build checks each vendored hash
before applying narrowly matched host adapters. Ordinary design/PPT requests
keep their normal skill routing; only explicit Baoyu selection uses these tools.
The secret scanner's existing exact shortcut-expression exceptions now include
the two new asset filenames, while retaining the old filenames for history
scans. The two new negative regressions failed before that path update; all
11 final scanner/resource checks passed, including credential and wrong-path
rejection. A further staged scan found the new PPT compiler's keyboard modifier
constant; inspection confirmed its declaration is the Shift-key array. Its
exception is also restricted to the exact compiler path and matched syntax,
with a failing-then-passing regression for that expression and negatives for
other paths, changed identifiers, quoted strings and actual credential syntax.
No directory-wide or generic-expression exemption was introduced; the pinned
upstream compiler bytes remain unchanged.

Public create/open, tab registration, the UI and packaged editor assets accept
`canvas` and `slides`. Motion and dashboard are not shipped. Existing internal
design-system source documents can supply a project's theme; this does not
expose a third standalone editor. The browser sandbox excludes the Slides Node
compiler while preserving that compiler, its hash and notices for export
regressions. PPT sandbox output fell from 21,067,561 to 6,587,325 bytes in the
controlled build comparison (68.7%); this measures payload size, not installed
App startup latency.

The App still embeds executable project content in an opaque origin. The
trusted loader has no project-data handler before navigating to that origin.
No Host filesystem, ambient network, cookies, App DOM or native preload is
exposed to the editor. Export remains a user action; when compilation outlasts
transient activation, a parent-owned Save file action obtains a fresh click.
Oversize exports receive an immediate refusal instead of waiting for timeout.

## State and routing

- `workbench-design-session.ts` is the common authority for local edits, Bot
  changes, comments, history and relayed edits. Document CAS and comment CAS
  have separate revisions. Writes check lifecycle and actor authority at the
  actual commit boundary.
- IndexedDB version 13 adds `workbenchDesignMeta` and
  `workbenchDesignObjects`. Document/history writes, imported backup/layout
  writes, and deletion of their sidecars are atomic. Reset and desktop migration
  include all three Design stores.
- Backup version 2 includes comments, bounded version history and verified
  content objects. Version 1 remains readable. Import creates an independent
  document, removes execution receipts and remaps imported author identities.
- History includes the initial content before the first change, making it
  restorable. Quota fallback explicitly reports missing history; conflicts and
  cancellation are not silently retried as successful writes.
- Comments and history use the shared App/Gateway/CLI contracts. Comment pages
  have both item and byte limits; Host validation accepts the same pagination
  fields as the App. A Bot author is attested by the Host, never by project code.
- Send to Agent prepares a conversation draft. It does not send a chat message.
  Drafts bind the original device, conversation and design. Another design's
  comments cannot silently replace that target; same-design thread IDs merge
  without losing the original revision. The outbox freezes the selected thread
  snapshots. A real message acceptance receipt marks only unchanged comments
  delivered, with the Host message ID; a later reply or edit is not accidentally
  marked sent. The editor says “Sent to Bot”, which does not imply that the Bot
  has started work. Unsupported automatic group discussion preserves the draft
  and explains how to send it through a normal chat instead.
- Canvas comment locations match complete, registered filenames, including
  Chinese text, spaces, parentheses, literal plus signs and combining marks.
  A missing file cannot match another board with the same filename suffix.
- Sharing uses the existing authenticated App socket and a source-device
  session. Grants are explicit and checked again on admission/commit. It does
  not create a cloud document or permit writes while the source is unavailable.
  Old asynchronous request callbacks cannot remove a new request with the same
  ID. Closing a share creates a tombstone that a late change cannot reopen.

## Shared-design behavior

An empty Workbench exposes “Baoyu designs shared with me” when the Host supports
sharing. Opening that list does not create an empty local design. The source
owner can grant a conversation member view, comment or edit access, pause the
source, or end the share. The joined editor renders in the normal content area;
it is not hidden underneath a menu or modal. Closing its list is disabled while
a join is pending or the joined editor is open.

Owner sources reattach after reconnect; participant copies retire immediately
when disconnected and require an explicit rejoin. They do not accept offline
writes. Leave first flushes the editor while it still has write authority. If
that save fails, the editor stays open with retry and explicit discard choices.
Deletion closes the source share; disposing a window detaches its provider and
preserves the share's grants. Retired providers cannot revive during reconnect
or detach a newer replacement. A first open is registered before its first await;
close/forget invalidates that operation and cleans up its late Host binding.
Repeated calls made before cancellation share the same result. A new call made
after cancellation waits for cleanup and checks its own lifecycle again before
opening. Four independent delayed-response probes passed for single and repeated
opens followed by close or forget; no obsolete source remained registered.

The participant manifest is reused until a change, reconnect, own commit or
15-second expiry. File bytes retain only the current remote document and the
session's preceding snapshot needed for conflict handling, rather than every
historical SHA. Failed loads and saves also prune unneeded bytes. These are
bounded cache and request-count checks, not a measured physical-device memory
or network-latency benchmark.

Shared copies explicitly do not offer Send to Bot: the source device owns the
conversation draft and exact local design target. Local comment-to-draft and
message-acceptance behavior remains available on that source. The UI explains
this boundary, and the session refuses unsupported remote send/mark-sent calls.
The sharing controls are App presentation; Bot and headless CLI content,
comment and history operations continue through the same exact-target
Workbench API, with no alternate file-access authority.

## Validation ledger

Evidence is kept under the physical `.noindex` task directory
`/Volumes/gdrive/taro-tmp.noindex/baoyu-resume-release-20261103/`.
Counts from overlapping reruns are deliberately not added together.

| Boundary | Evidence |
| --- | --- |
| Two-editor scope, asset resources, PPTX font export, protocol, backup and DB | 75 focused tests plus 13 signed protocol scenarios passed; `scope-two-editors.md` |
| Actual PPTX package | Pinned exporter and real browser download inspected as ZIP/XML; bilingual text preserved; East Asian font fallback verified |
| Browser local storage | 10 Chromium tests passed using real IndexedDB and production sessions, including atomic writes/import/reset and history restoration; `root-idb.log` |
| Native migration validation | 6 Rust export/validation tests and 6 Electron import/receipt tests passed, including Design metadata and content objects. The opt-in cross-language fixture writer was not run in this check; `root-native-migration.log`, `root-electron-migration.log` |
| Real editing journeys | Canvas/PPT Chinese and English input, close/reopen, backup/import, undo/redo, hidden/visible editor lifecycle and restored initial history exercised in Chromium; `human-qa.md` |
| Comments and actual chat acceptance | 4 Chromium journeys passed: cross-design draft isolation and reload, canvas/PPT real Host ACK with matching message ID and visible static delivery label, and complex Unicode filename location. Build hashes were unchanged throughout; `comment-final-ui.md` |
| Final browser rerun | All 11 scenarios passed: 8 final-build App journeys with isolated real Hub/IndexedDB (the four comment journeys, same-owner sharing/edit/reconnect/leave, another member's view-only grant/revocation, bilingual empty-Workbench entry and an old-Host capability negative), plus 3 frozen-source history-error component scenarios. All 1,005 final-build files retained their hashes; `final-browser.log`, `final-build-readback.json`. The fixture emitted HTTP 503 console messages; the assertions passed and no page crash was observed |
| Common Workbench send | All 7 browser scenarios passed: history-full context omission, cancelled/navigated annotation hashing, restored draft target, undo/export updates, touch menu and split-canvas viewport behavior; `root-workbench-send.log` |
| Offline browser | Service worker enabled; disconnect WebSocket, edit/reopen, reload and reopen the Workbench, reconnect and verify content. The original cold-start failure was a test missing normal Workbench reopening, not a confirmed production fault; `offline-cold-start-diagnosis.md` |
| Isolated native editors | Final frozen build: canvas 17 checks and PPT 8 checks passed under the production Electron sandbox/CSP with synthetic local data, including active editing, reopen and native quit save/failure/retry. Sandbox/loader bytes matched the final build and source hashes stayed unchanged; `final-native-canvas-ppt.md`, `final-native-verification.json` |
| Combined source tests and production builds | Final frozen source: 115 test files / 1,070 tests passed with a 30-second timeout and two workers, covering all client units and the affected Workbench, sharing, ticket/queue, CLI and screen-opening Host contracts. Both the client build (translation/type/resource checks included) and standalone Host build (489 modules) passed; `final-source-tests.log`, `final-client-build.log`, `final-host-build.log` |
| Independent review | Root read the execution transcript: 1,019 assistant responses used actual `claude-opus-5-5`; `opus-final-model-proof.json`. Other helpers are not represented as Opus executions. The four final delayed-open probes passed independently against unchanged source hashes; `sharing-pending-open-ownership-independent.md` |
| Earlier non-Baoyu revisions | Extension/settings/window/error-handling review: 52 Electron contract, 187 Host/adapter and 14 browser scenarios passed; `post-release-audit.md`. These are bounded test scopes, not installed-App acceptance |

The post-release review also reproduced and repaired two ticket issues: pausing
a Bot-origin worker input could occupy a ticket's concurrency slot indefinitely;
an older Host's unsupported removal action was shown as an uncertain result.
New pauses are disallowed for these inputs while existing paused inputs retain
resume/cancel recovery. Removal capability is opt-in so older strict response
readers retain their original contract. The focused Host/CLI suite passed 135
tests and the bilingual component browser suite passed 6; `queue-ticket-fixes.md`.
CLI impact: both fixes use the shared Host API; existing command syntax is unchanged.
The final ticket UI integration passed all 11 scenarios, including polling,
late responses, uncertain action retries, removal and desktop/iOS/Android
browser sizes (`dispatcher-integration-final.md`). Mobile sizes are simulated.

Two remote-screen visibility races were also reproduced before fixing them:
a hide/show before the renderer's MessagePort arrived incorrectly advanced its
generation floor, and a hide/show during TLS pinning left the main process
rejecting control as if the viewer were still hidden. The patch preserves
explicit control acquisition and existing hidden-window guards. Validation
passed 95 source/Host tests and an isolated foreground Electron synthetic stream
(41 decoded frames, correct pixels/copy, maximum heartbeat gap 593 ms).
The synthetic fixture now explicitly shows/focuses its own window; its original
inactive window could decode without running the animation callback that
returns credits. Original test thresholds and failed receipts are preserved in
`remote-screen-fixes.md`. No real desktop capture/input or installed-App action
occurred. The original installed 1.0.127 pause trigger and hypothetical encoder
drop recovery remain unconfirmed, and were not declared fixed. The CLI screen
policy and command interface are unchanged.

This is a source checkpoint with publication held. Browser fixtures, real local
sockets, isolated Electron and review-model execution establish different
boundaries. They do not establish two physical devices, a real phone, real-model
execution of the new Design tool operations, a new installed version or
publication. The original installed remote-screen pause trigger remains open.

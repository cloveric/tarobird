# Lightweight workspace diff review

> **2026-10-20 product correction:** the reply-card entry now opens the saved
> edits from that reply, rather than scanning the Bot's current workspace. See
> [Recorded run changes](run-diff-2026-10-20.md). The workspace viewer described
> below remains a separately labelled **Current workspace (live)** view and its
> existing CLI commands remain supported. The original results below are the
> historical acceptance record, not the verification of the new entry.

## Behavior and ownership

The owner can open **Current workspace (live)** from the recorded-run viewer. Opening this secondary view fetches a file list; selecting a file fetches only that file. No repository scan runs while rendering the conversation timeline. These are **current workspace** values, never claimed as changes made by a historical run. The reply-card headline now comes exclusively from saved run evidence.

The comparison is the Bot's configured workspace versus its current HEAD, including staged, unstaged and untracked nonignored files. An unborn repository uses an empty baseline. A workspace nested within a repository exposes only paths inside that workspace. v1 does not record a turn-start HEAD or expose a historical diff. Conflict files, symlinks and submodules show metadata only. Generated output and lockfiles are collapsed by default.

Mobile/native iOS/native Android use the unified readonly view. Desktop eligibility is exactly `adhdSupported(nativePlatform(), width)`: width above 760 and neither native mobile platform. Desktop supports unified/split views, click-to-comment and Shift-click continuous ranges within one hunk. Clipped lines cannot be annotated. Annotations preserve their selected old/new line coordinates and excerpts; they do not relocate after edits. The captured HEAD labels the old baseline, not a snapshot of a changing working tree.

The viewer lives in a lazy module and uses the existing `@tanstack/react-virtual` and `rehype-highlight` dependencies. No editor or new production dependency was added. Small-file highlighting preserves span ancestry across newlines and renders React text/spans, never raw HTML. Only fragments starting at file line 1 are highlighted; fragments with unknown preceding lexical state stay plain text. No extra whole-file fetch is performed for highlighting. The run-card overlay follows the active runtime host and pins its message while open, including in ADHD panes.

## Readonly API and permission boundary

Capability: `workspace.diff.v1`.

```
GET /api/conversations/:conversationId/changes?botId=:botId
GET /api/conversations/:conversationId/changes/file?botId=:botId&path=:workspaceRelativePath[&preview=1]
```

Both routes use existing Hub HTTP session authentication, owner checks, conversation membership and Bot membership, revalidated around asynchronous work and before the response. Revocation, connection closure and Hub shutdown cancel active reads. Old hosts lacking the capability or route show an update-host message. Permission/offline/unsupported states never show a fabricated diff.

Workspace ownership is resolved from the managed Bot's state directory or authenticated worker `files.root` RPC, then bounded `config.json` parsing (`workspacePath`, `resume.workspacePath`, or the default Bot workspace). A malformed explicit configuration does not silently switch workspaces. No path is supplied as a shell command. Git is resolved to an absolute executable outside the workspace from absolute host PATH entries, with a neutral process cwd and argument arrays.

Allowed commands are readonly `config`, `rev-parse`, `status`, `diff`, `ls-tree` and `cat-file`. No index/worktree writes, checkout, staging, commit, push or repository initialization are performed. Inherited `GIT_*` overrides are removed, optional locks and lazy fetching are disabled, global/system configuration is excluded, and safe.directory checks are not bypassed. The effective included local configuration is checked before status/diff; executable filters, diff helpers, executable fsmonitor values and partial-clone/promisor configurations are rejected. Boolean fsmonitor values are allowed but disabled by command-line configuration. Nonempty core.worktree is rejected, and workspace/repository Git metadata identities must agree. On macOS the selected installed Git is resolved through xcode-select; the installer-triggering /usr/bin/git shim is never executed. Submodule inspection and rename detection are disabled. The API pins Git output prefixes, color, relative paths and literal pathspec handling.

Paths reject absolute paths, traversal, `.git`, controls, Windows device names and ambiguous components. Credential-style paths use the existing credential-file policy and are denied before content access, including deleted HEAD blobs. This is a filename/location policy, not a scanner that detects secrets embedded in or renamed to ordinary source files. A single-file request must also match the literal path in the current changed set; unchanged/ignored arbitrary files are refused. Filenames are parsed from NUL-delimited status/numstat records, not patch headers.

v1 supports ordinary in-repository `.git` directories only. External metadata, linked worktrees, alternates, symlinked object/ref trees and repositories rooted at HOME or the filesystem root are rejected with explicit explanations. Relevant metadata is scanned with a limit of 8192 nodes and depth 32; consumed file identity/time changes are rechecked before returning. The exact disabled-fsmonitor IPC socket and Git-defined ordinary lock files do not count as content changes; symlinks with those names remain refused. Root/refs directories use bounded filtered child snapshots, while irrelevant hooks/logs runtime changes do not invalidate the result. This conservative limit may reject otherwise legitimate large repositories rather than blocking the Hub.

Ordinary file reads use bounded buffers, no-follow/nonblocking flags where available, bigint file identity checks and parent/leaf/fd rechecks. Symlinks, multiply-linked workspace/config leaf files, special files and Windows files without reliable inode identity are refused. Node does not provide a portable directory-fd/openat boundary: this protects against static traversal and symbolic links and refuses multiply-linked workspace/config leaves and detects ordinary changes, but is **not a sandbox against an attacker already able to race arbitrary filesystem/config changes on the host**. No claim of such isolation is made. Ordinary Git object-store hardlinks are not rejected; their data provenance is within the same host-user trust boundary, not asserted by this API. Git configuration exclusions can make results differ from a terminal using global autocrlf/excludes/LFS settings. Repository stderr and absolute workspace paths are not returned.

## Resource limits

| Boundary | Limit / behavior |
| --- | --- |
| Active host operations | 2, excess returns busy; no unbounded waiting queue |
| Whole operation | 10 seconds including workspace resolution and all Git commands |
| Timed-out work | Response returns promptly; admission slot remains held until underlying work settles |
| File list | 200 files, explicit truncation; status/numstat output capped at 1 MiB |
| Optional aggregate counts | 2 seconds within the operation budget; unknown counts remain null |
| Single file / patch | 200 KiB content budget; tracked text uses actual patch limits of 1000 aggregate hunk/line rows and 200 KiB, not whole-file line count. Larger changes default to metadata |
| Explicit preview | Large patch: first 200 diff rows. Unsafe-to-compute large file/untracked content: first 200 text lines. Both clearly labeled as partial |
| One rendered line | 4096 characters, clipping marked; no annotation on clipped lines |
| Highlighting | At most 200 rows and 32 KiB |
| Rendering | Fixed-height virtual rows plus bounded overscan; no whole long diff DOM |
| Draft notes | 50 notes, 2000 characters per comment; excerpt at most 5 lines / 4096 UTF-8 bytes |
| Sent review text | Actual formatted UTF-8 checked against the existing 200 KiB message limit before enqueue |

Binary content shows status only. Non-UTF8 text, nested repositories/directories, and staged-removal-plus-existing-worktree cases show explicit metadata explanations, not fabricated text diffs. Files changing during list collection keep metadata with unknown counts, while unsafe paths are omitted with an incomplete-list notice. Single-file reads remain strict snapshots and ask to refresh when content changes. A binary detected while reading a large-file prefix is not displayed as text. HEAD blobs are read by validated object ID, without hardcoded SHA-1 empty-tree IDs. Lists and content are refreshed explicitly, not polled on every streaming token.

## Draft and delivery lifecycle

`ClientCache` owns drafts keyed by pairing identity, conversation ID and Bot ID, independently of normal composer text/files. Empty comment editors are valid persisted drafts. Writes use revision checks and per-note versions; delayed saves or ACKs cannot overwrite edits, including A → B → A changes.

Sending creates the immutable ordinary `message.send` frame and pending receipt in the **same IndexedDB transaction** as the outbox entry. It mentions the exact Bot and uses existing conversation queue semantics. `HubConnection.send()` alone is not a delivery receipt. Cleanup occurs in storage only on an authenticated message-accepted ACK, independent of the viewer being mounted. Only unchanged notes in that sent snapshot are cleared; new/edited notes remain. Failed or uncertain sends retain the original message ID/frame and notes, with explicit retry or abandon controls. Generic outbox writes cannot mutate a pinned review frame. No automatic new-ID resubmission is added. Hub dedup uses author plus clientMsgId and rejects scope conflicts.

Passive review refreshes use scoped draft/outbox signals and a readonly transaction, coalesced over 150 ms; ordinary token events do not repeatedly read drafts. Local mutations alone invalidate in-flight reads. An explicit discard-unsaved close path preserves saved drafts and queued messages if storage is unavailable.

The viewer explains that sent code/comments are visible to conversation members. Excerpts use fences longer than their longest backtick sequence. The resulting message asks the Bot to check/modify the listed file and old/new line range; no engine protocol changes are required.

## CLI

These commands connect once to the running local Hub using the existing local controller and permission checks; they never start a second Hub:

```sh
tarobot changes list CONVERSATION_ID --bot BOT_ID --json
tarobot changes show CONVERSATION_ID --bot BOT_ID --path src/app.ts --json
tarobot changes show CONVERSATION_ID --bot BOT_ID --path large.txt --preview --json
```

Output is the shared structured list/file response, including hunk lines, old/new coordinates, scope, HEAD and truncation notes. Readonly CLI needs explicit IDs; name resolution is outside this feature. Mobile cannot author annotations; the CLI does not add annotation editing.

## References and dependencies

Reviewed [Orca](https://github.com/stablyai/orca), [Paseo's Git helper](https://github.com/getpaseo/paseo/blob/main/packages/server/src/utils/checkout-git.ts), [git-diff-view](https://github.com/MrWangJustToDo/git-diff-view) and [react-diff-view](https://github.com/otakustay/react-diff-view) for architecture and rendering constraints. No upstream code was copied, so no additional third-party copyright entry is required. Package unpacked sizes were compared as an evaluation aid, not claimed as bundle sizes. Existing virtualizer/highlighter were chosen to avoid new dependency weight.

## Codex self-test results

| Check | Result |
| --- | --- |
| Backend/protocol/readonly CLI focused suites | 102 passed, 1 opt-in real-Git integration case skipped |
| Existing Hub / host CLI regression suites | 62 passed |
| Review formatting, byte limits and note-version settlement | 8 passed |
| Diff row pairing, Unicode width and highlighting | 5 passed |
| Conversation preview + native run UI unit suites | 50 passed |
| Chromium viewer | 12 passed after the last font/410 changes; an earlier integrated viewer/run run passed 22 cases |
| Chromium review IndexedDB | 13 passed |
| Chromium hook/lifecycle races | 8 passed |
| Existing persistent draft / outbox Chromium | 28 passed |
| Existing ADHD Chromium | 36 passed in the broad matrix |
| Five-engine run-presentation Chromium | 10 passed in that earlier 22-case integrated build (five engines × desktop/mobile); not repeated after isolated lazy-viewer font/410 changes |
| Root `npm run build` | Passed, standalone 378 modules |
| Client `npm run build` | Passed: check-translations, TypeScript, Vite |

Counts are reported per suite, not summed across repeated runs. Controlled Git-output tests use real temporary filesystem paths; runner tests execute harmless real child processes; authorization tests use real Hub HTTP sessions. These do **not** replace live Git semantics validation. The original live-Git attempt failed during `git init` with exit 128 and `Operation not permitted`, before assertions. The follow-up now passes with real Git; see the closeout record below.

An original desktop sidebar context-maintenance defect was found by the required regression matrix. The task-start component snapshots reproduced the same failure. A narrow conversation-preview repair prioritizes an actively running native compaction/checkpoint status over a generic card summary, preserving all other previews. Its two new tests failed before the repair; 50 unit tests and five engines' isolated desktop acceptance passed afterward. This is a separately verified preexisting issue, not attributed to the diff viewer.

The lazy viewer production chunk is 27.63 kB (gzip 10.52 kB), CSS 7.19 kB (gzip 1.83 kB) in this build. Existing highlighting remains a separate lazy chunk. Small entry/schema/draft integration code is added to existing modules; this is not a claim of literally zero initial-bundle bytes. No new production dependency or heavyweight editor is added.

## Opus review findings and disposition

1. **Before implementation:** actual Claude Opus5.5, effort xhigh, accepted the architecture after requiring hardened Git execution, current-change membership for file reads, and atomic pending/outbox storage with accepted-ACK cleanup. All were incorporated before their affected implementation. A delayed longer independent plan review additionally hardened external Git metadata and fresh environment boundaries. Its phase-cut suggestions were not adopted because the owner explicitly requested split view, annotations and file counts.
2. **After implementation:** actual Opus5.5/xhigh directly reviewed code/screenshots and found three blockers: code button content centering, whole-file line thresholds suppressing small tracked patches, and notification-driven draft-read livelock/contention. Each was reproduced or verified and fixed with focused tests. Fourteen other findings were handled: active-write list resilience, index-removal metadata, Unicode scroll width, short split width, nested directories, repository/config consistency, boolean fsmonitor, Darwin Git shim, failure-close escape, disappeared selection state, hardlink boundary, bounded parent-stat caching, nonUTF8 explanation, and protected-file fixture accuracy.
3. **Before delivery:** actual Opus5.5/xhigh completed the direct closeout: all three original blockers are resolved and source handoff is acceptable, but release/full acceptance is not. It identified fsmonitor IPC rejection and questioned strict metadata rechecks; Codex reproduced and corrected the IPC and irrelevant lock/log churn subset with real filesystem fixtures; 102 backend tests pass after the final error-mapping correction. WebView font shorthand fallback, deleted-Bot 410 explanation and unsafe-file copy were also tightened. A completed narrow follow-up review confirms these final deltas introduce no blocker and accepts source handoff, not release or full-platform acceptance. Its final first-snapshot-ENOENT suggestion is fixed: only a vanished metadata path maps to changed-during-read, while cancellation reasons and other safety failures are preserved. A deterministic filesystem test covers the mapping and cancellation precedence. A final actual Opus5.5/xhigh confirmation accepted this sole remaining patch with no new blocker; the root build passed afterward. Opus accepts ordinary-internal-Git-only and same-user race limits as explicit v1 design boundaries, but treats real Git semantics as a mandatory release gate; Codex agrees.

**Product tradeoff decided by Owner:** Opus prefers availability for the file list during actual concurrent index/HEAD/object changes (relax timestamp checks or retry); Codex retains strict change detection and asks the user to refresh, prioritizing consistent scope and results. Irrelevant socket/lock/log churn is already fixed. Owner explicitly selected “retain strict checks and ask to refresh” in the native choice card. The implementation follows that decision. The original Opus/Codex difference is retained for transparency, not represented as technical consensus.

**Known nonblocking annotation conflict:** an accepted send receipt can commit between keystrokes, invalidating the draft revision before the next save. CAS then preserves the visible unsaved text and shows an explicit save conflict with copy/reload/confirmed-close actions. It does not silently overwrite another window. Automatic rebasing is not implemented: it needs an atomic proof of the exact ACK revision transition plus edit deltas, otherwise retrying a full draft can resurrect already-sent notes or overwrite another window's ABA edit. Both the preserved-error path and unload guard are tested. This limitation is disclosed, not described as seamless concurrent editing.

Reviewer findings and Codex test results are distinct. Opus did not claim to execute the tests. The private task evidence directory contains original model verification, requests, completed replies, before/after patches and individual disposition records.

## Incomplete and blocked acceptance

- The original macOS external-volume Git denial is resolved. Real-Git integration now passes, including unchanged index/HEAD bytes; source delivery is covered by the closeout record below.
- The original WebKit attempt failed before page creation (one failure, 23 not run). WebKit now starts successfully; the follow-up browser results below supersede that environment blocker without claiming native-device acceptance.
- Native Windows, iOS and Android checks were not performed. Browser mobile viewports and native-platform predicates do not substitute for physical-device acceptance.
- Private GitHub Actions are blocked by account billing/allowance; local checks above are the verification source.
- Linked worktrees/external Git metadata, repositories rooted at HOME/filesystem root, unsupported encodings, metadata trees exceeding the safety budget, and hostile same-user concurrent filesystem mutation have the conservative boundaries described above. No historical turn-start snapshot or comment relocation is implemented.
- No release, App installation or existing-host update was requested or performed in this task.

## 2026-10-19 follow-up delivery

The earlier permission/runtime blocker statements are historical. See the
[pending-delivery closeout](pending-closeout-2026-10-19.md) for final verification,
independent review dispositions, source delivery and remaining native/release gates.

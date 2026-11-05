# DeepSeek max review and independent verification — 2026-10-24

Audit baseline: `3ff9f788bbb9427cedd0fc57ad516327adfc6c5a`.

The owner requested DeepSeek at max effort for a broad program review, followed
by root and Claude Opus 5.5 at xhigh to reproduce claims, reject weak findings,
and repair confirmed defects. Six DeepSeek reports cover client/native surfaces,
engine/queue/goal handling and Hub/network/state/CLI paths, including supplements.
The configured DeepSeek effort was verified before the review; the installed
harness identified its model as `deepseek-flash`. Opus used
`claude-opus-5-5[1m]` with host configuration `xhigh`.
These are code and test reviews, not proof that every execution path is defect-free.

## Verified corrections

- **DS-C01 — conversation previews:** inline code and links split the string for
  Markdown cleanup, but the resulting fragments were wrongly treated as line
  starts. Operators and separators could disappear: an inline-code 5 followed
  by `+ 3` became `53`. Cleanup now checks original line boundaries. Stored text,
  copy/export and search contents are unchanged.
- **DS-C03 — group draft preparation:** editing the local draft during an awaited
  preparation step aborted the send correctly but blamed another window. The
  local-edit reason now differs from the genuine persisted-identity conflict;
  both preserve the unsent draft and the original CAS protection.
- **DS-H01 — route monitoring:** explicit private certificate authorities now
  work with HTTPS health checks. Certificate and hostname verification remain
  enabled; requests have a two-second timeout and bounded response, and do not
  follow redirects. Loopback HTTP routes with an unused CA field retain their
  prior behavior. Health remains an availability hint, not proof of identity.
- **OP-CI-01 — background group disclosure:** a location request reveals a task
  once. Scrolling a manually folded group out of and back into the virtual
  window no longer replays the old location and unfolds it. A new explicit
  location still reveals it; completion still folds the group. This uses the
  existing bounded UI view cache and preserves read-only controls and journals.
- **OP-CI-02 — desktop editor style scope:** main-composer font and text-lift
  rules now select that editor directly. The inline pending-message dialog no
  longer inherits them. Main chat retains its requested lift; ADHD, side panes
  and phone typography keep their separate rules.
- **DS-HS01 / OP-GR-02 — personal note deletion:** discussion reads return an
  optional opaque `viewRevision` that also reflects the reader's personal
  deletions. The shared run revision, scheduler and control CAS are unchanged.
  The App invalidates the note projection on its own message tombstone, so
  terminal discussions refresh too. Older Hosts omit the field; newer clients
  fall back to the old token. Older clients ignore the field and receive a full
  view when their legacy token cannot represent the personal deletion.

- **DS-E01 — DeepSeek goal observation:** an unbudgeted goal keeps its observer
  across transient read failures, with bounded backoff only for failing reads.
  It does not replay work, clear the native goal or bypass budget-stop policy.
- **OP-ID-01 — cross-Bot wait:** an accepted foreground delivery no longer means
  completion while recorded replies for the same input still have active run
  phases. `activeReplies` is additive; timeouts keep partial results and do not
  retry the request. Overall completion is not a guarantee every subtask succeeded.
- **OP-HO-01 — old Host updates:** before draining an older Host, the new lifecycle
  waits for known dispatched inputs, foreground replies and active background
  cards of online member Bots, including foreground-to-background handoff. Card age alone
  does not establish completion. This cannot observe unpublished tasks or work
  from disconnected/removed workers; the current Host's native barrier is unchanged.
- **OP-HO-02 — online database backup:** a writer barrier precedes a consistent
  read-only snapshot copy. The copy no longer holds the main Hub queue or requires
  a FULL checkpoint; committed WAL data is included and backup permissions remain
  private. Tests check concurrent reads/writes and reopening the result.
- **OP-GR-03 — group note CLI:** status/control may resolve a group's topic, but a
  note must name its actual conversation. The CLI now reports a known mismatch
  before upload, naming the correct target. It does not silently redirect or
  change exact-run, attachment, reference or idempotent-replay boundaries.

- **OP-CL-01 — shared native-session ownership:** only the conversation holding
  the native turn can expose or submit its in-flight input controls. A first turn
  that confirms a native alias retains ownership until release; another bound
  conversation waits rather than failing with an in-flight-turn error. Cancelling
  the waiter does not stop the owner. Ownership is shared by authenticated Bridge
  surfaces in the same process; this does not add cross-process alias migration.
- **DS-HS02 — deleted Agent Bus coordinator:** the committed deletion invokes the
  existing settlement path immediately. Bound member-stage cards and run state
  reach the same terminal outcome as a later read, with committed notifications,
  so opening the Bus panel is no longer required to refresh those records.

- **OP-CI-03 — side capability negotiation:** a transient failure retries the
  same read-only opt-ins with bounded delay, preserving this runtime's previously
  confirmed capability if retry is exhausted. Only an explicit HTTP 400 rejection
  steps down to an older request shape. Runtime changes clear the old capability;
  open/ask requests, attachments and drafts are not retried or rewritten. This is
  App-side negotiation; the CLI continues to use the existing shared Hub API.

## Claims intentionally not used to change behavior

- Duration and file-size boundary rounding are display choices, not corrupted
  values or broken execution.
- Already decoded images retain local dimensions when the shared LRU evicts an
  entry. The proposed iPhone scroll change lacked a reproduced defect. Existing
  scroll compensation was preserved.
- The compact task-management icon alongside the task dock is intentional; the
  accepted A+C presentation was not made larger again.
- A synthetic Claude trace that omits the native terminal task notification
  does not establish a production drain bug. A task disappearing from a level
  snapshot can mean foregrounding or uncertainty; it is not completion.
- Durable deduplication receipts were not pruned to satisfy a speculative
  storage concern. Release dependency pinning, actual push-provider delivery,
  old raw DeepSeek transport behavior and platform service installation remain
  separately identified suggestions or verification boundaries.

## Regression infrastructure

The WebKit selection now includes the existing engine-task scroll suite. Vite
fixtures sharing dependencies through an external worktree permit that exact
resolved dependency directory, so bundled fonts no longer silently fall back
after HTTP 403. Clipboard tests use the real Chromium clipboard; WebKit tests
explicitly exercise the API boundary with a test substitute, not the OS clipboard.
The overscan/dock test waits for existing Markdown and virtual measurement
settlement before moving to history. No product scrolling logic was changed to
make that fixture pass.

## CLI and delivery boundary

The same Host implementation serves App and CLI. Preview, disclosure and editor
style changes are presentation-only. Discussion cache tokens are additive and
route monitoring retains configured-route semantics. No App installer, native
mobile package, published CLI package, live Host or local Mac was updated as a
side effect of this audit.

## Verification and remaining boundaries

- Baseline: 478 test files, 6,544 passed and five conditional skips. Final full
  regression: 479 files, 6,590 passed and the same five skips. The four side
  capability unit cases added after full-suite collection passed separately.
- Production TypeScript, the standalone Host build and client build pass. The broad test
  tsconfig still emits 133 pre-existing diagnostics: comparing against an
  isolated baseline using the same dependencies finds no new diagnostic after
  normalizing checkout paths and shifted source locations. This is not a claim
  that the broad test typecheck is clean.
- Chromium and WebKit cover group draft preservation, personal-deletion refresh
  with new and old Hosts, pending-message editor styles, main/ADHD/phone scope,
  grouped background cards, text formatting and side reading position. Browser
  results are not physical-device acceptance.
- The final side capability change passes two saved complete Chromium runs
  (26 cases each) and five repetitions of each of three negotiation/compatibility
  cases (15 passes), plus the complete WebKit spec (26 passes). The first complete run had one visibility failure whose
  identity was lost by output filtering and overwritten temporary results. Its
  cause remains unidentified; subsequent passes do not prove it was repaired.
- Shared-session tests exercise actual Bridge queues and locks with a controlled
  adapter. The cross-Bot probe uses a real isolated Hub, Gateway and Claude stream
  adapter with a scripted CLI; it is not a real-model round trip. The Host tests
  include pre-card dispatched inputs, foreground-to-background handoff,
  cancellation during preflight and concurrent backup writes.
- Old Host preflight has a non-atomic final-read-to-drain admission window and
  cannot observe disconnected workers or work not recorded in the Hub. Native
  alias ownership is coordinated within a Bot process. Cross-Bot wait describes
  known reply records; overall completion does not imply all subtasks succeeded.
- No physical iPhone/Android, native Windows, provider push or actual production
  upgrade was performed for this audit. The source fixes are distinct from a
  published installer or activation of the installed Mac.

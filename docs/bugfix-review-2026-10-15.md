# Confirmed audit bug fixes — 2026-10-15

Baseline: `b6deb6c567d0dbd5f23e333d4a19c37ba6569867` (App 1.0.70,
standalone host 0.1.423). This is a source correction checkpoint. It does not
replace an installed App, restart any service, or constitute a new release.

The implementation follows the Kimi K3 Max audit and its Opus review. The
original audit returned 35 of 50 Kimi batches; missing batches are not claimed
as reviewed here. Optional refactoring and unproven production allegations are
not silently promoted to bugs. Actual Claude Code collaborators used
`claude-opus-5-5` with requested effort `xhigh`, on isolated tests and this source
checkout. The primary reviewer independently reproduced and reviewed changes.

## Behavior corrected

- Search/reference message positioning no longer repeatedly recenters after
  new messages or a reader gesture; the located message remains highlighted.
- A run card can recover from an unconfirmed stop. No stop is automatically
  replayed; a new explicit user action targets the card's conversation and Bot.
- Card inputs without a name use their action ID consistently for reading,
  editing, defaults and validation.
- Failed schedule toggles/deletes refresh their state and no longer claim that
  a later click reuses the same request. Creation retains its existing receipt.
- Codex autonomous goal questions get an answerable form. Answers use the
  conversation queue, not steering into an unrelated ordinary turn. Stop and
  replacement revoke the originating goal's questions.
- Codex blocking goal questions, elicitation and permission requests retain
  their callbacks and route only to the exact live native turn. Stopping or
  ending the pursuit closes open requests. Missing, retired and ambiguous IDs
  remain denied; the configured approval mode and native policy are unchanged.
- Bus pruning compares the original registration under the registry lock and
  requires a confirmed dead process. A temporarily unresponsive live Bot stays
  registered while live discovery still requires a successful health probe.
- The optional concurrency pool atomically replaces its file, refuses malformed
  lease state without erasing evidence, and validates its default temporary
  directory and regular file type without blocking on a FIFO. Its historical
  path is preserved to avoid separate old/new limits.
- Board block-operation replay checks idempotency before validating a new state
  transition, so a repeated operation can be recognized after task completion.
- Link previews omit URLs whose encoded form exceeds the protocol limit. The
  original message body still sends. An unusable cover degrades to a text
  preview, letting newer messages leave the preview queue.
- Log rotation removes only numbered rotations of the exact log filename.
- Diagnostic date ranges compare instants instead of different ISO spellings.
  Stored timeline timestamps retain their canonical format and validation.
- CLI update cancellation retains exit code 130 along with the recovery state
  and instructions. It does not roll back databases or reset host identity.
- Legacy reaction handling recognizes confirmed cancellation without changing
  incomplete-stop failures into success. Mention-only Telegram groups remain
  closed to ordinary messages when startup has not learned the Bot username;
  explicit listen-all groups keep their configured behavior. If startup identity
  lookup failed, ordinary group messages are ignored until a successful restart;
  they are not deferred for later delivery.
- DeepSeek session approval grants require a live originating turn or goal; a
  late approval after an unconfirmed stop cannot reuse a cached grant. Repeated
  question text receives separate presentation keys and answers retain their
  distinct native question IDs.
- Kimi TaskStop fences the stopped review's late terminal hook, preventing it
  from being inherited by a subsequent task review. Already-observed terminals
  do not create a second expected terminal; both arrival orders and nested
  intermediate stages are covered.

## Build and regression corrections

Browser acceptance exposed a separate offline-shell defect: the cache manifest
was generated before Vite removed a CSS-only JavaScript chunk. That nonexistent
URL made `Cache.addAll` reject the entire service-worker installation. The
manifest plugin now runs after Vite's CSS/HTML output cleanup. All 387 listed
URLs resolve to emitted files; the actual card/attachment offline flow and both
desktop/phone offline recipient journeys pass. The card fixture's stale
"open" selector was also corrected to the existing "preview" action.

Android/iOS workflows install the root build dependencies used by the
translation checker before building the client. The Android instrumentation
smoke assertion uses the actual target/test application relationship, including
isolated acceptance IDs. Password-menu tests reject Copy and Cut separately.
Bus tests use dynamically allocated listening ports. Service spies and Kimi
hook-relay directories are cleaned up. The historical acceptance ledger points
to the later recorded browser matrix without converting its remaining failure
or unexecuted follow-up into a pass.

## Entry-point and verification boundaries

The shared host changes apply to desktop-bundled and headless CLI hosts. No
separate CLI implementation or new management command is needed. Focus,
rendered-card controls and schedule feedback are presentation-only; the
headless host keeps the same API and authorization. Codex goal and Kimi hook
changes apply only to those engines' supported protocols; no other engine is
claimed to support a capability it does not expose.

All native platform checks and installed-product delivery are separate from
unit tests, Chromium journeys and clean dependency/build verification. No live
Bot, real schedule, user file, pairing or service configuration is used as a
test fixture. Conditional Android provider blocking, native subprocess output,
legacy delivery PID reuse, uncommon protocol events and prior flaky-test
allegations remain distinct from reproduced fixes unless additional evidence
is recorded below.

## Verification evidence

Final host source: `VITEST_MAX_WORKERS=4 ./scripts/pre-complete-hook.sh` with
the installed App's standalone Node 24.14.0 passed 284 files / 3,806 tests, one
skipped. The optional adapter gate (`npm run test:legacy`, three workers)
passed 57 files / 1,230 tests. The legacy unknown-turn fixtures now supply the
watcher's new interaction controller while retaining their deny assertions.

Root and client builds passed both in the working tree and in a separate
checkout with freshly installed locked dependencies. Kimi's 107 tests include
terminal-before-stop, stop-before-terminal, intermediate-stage and resumed-stage
orders. The 19 new Codex goal tests include exact ownership, permissions modes,
abort, replacement and buffered requests; 272 related tests also passed.

An initial host-update run used Homebrew Node 26, whose external `libnode`
correctly fails the existing standalone-freeze safety check. The supported
bundled Node passed those checks. Two subsequent default-parallelism timeouts
passed independently and in the complete four-worker run; no assertion or
production timeout was weakened.

Chromium: diagnostics, link previews, native context menus, questions, input
cards, focused reading, stopping/reconnecting, schedules, run details/scopes,
search/references and offline flows passed their focused journeys. The Opus UI
pass recorded 55 passing cases; the primary pass independently checked 13
preview/question/diagnostic/menu cases, seven reading cases and three offline
cases. These sets overlap and are not a complete browser matrix. Five opt-in
live-stop cases were skipped. The initially failing stale card selector was
corrected; its complete offline journey passes after the cache-manifest fix.

WebKit is **blocked before product execution** on this machine: page fixture
setup times out, and an isolated launch + blank `newPage()` reproduction also
hangs. Chromium touch/phone-sized journeys do not substitute for WebKit or real
iOS/Android acceptance. No Android instrumentation, native App build, live
engine run, service restart, installation or release was performed.

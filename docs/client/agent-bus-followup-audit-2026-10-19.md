# Agent Bus follow-up interaction and execution audit

This audit follows the long-turn/per-stage-task change (`0b73849`). It includes
an independent backend review, Claude Opus 5.5 xhigh exploratory browser
operation, and parent verification using the production UI, Hub API, persistent
queue, Gateway, local Bus HTTP and stage records. Test models return controlled
outputs; the owner's saved workspaces and real research tasks are not modified.

## Verified execution repairs

### Output delivery must be part of the run result

The shared Bus reply path awaited `deliverCoreResponse()` but discarded its
`ok` result. A missing file, or a valid file outside the coordinator's permitted
directories, could therefore produce a visible delivery failure while the Bus
reported completion.

The run-local reply context now retains an incomplete delivery receipt. If the
workflow subsequently succeeds, the Agent Bus run fails with
`agent_bus_output_not_delivered`. Completed execution stages keep their real
status; the run error points to the initiating conversation's delivery failure.
Existing failed/stopped outcomes are preserved.

This is deliberately not a thrown retry/recovery exception: the chain/verification
recovery paths can include previously delivered file directives. The patch does
not replay those directives, rerun models or widen file permissions. Five-mode
regressions each deliver one valid artifact once and reject one missing artifact;
an all-success control remains completed. Normal-permission rejection is also
covered. Processing-level Crew records and command audits retain their execution
semantics; the Hub run records the overall delivery outcome.

### A retired default record must not prevent repair

Selecting the default record conversation could repeatedly resolve an archived
or otherwise invalid former dedicated conversation and reject Save. The implicit
allocator now skips unusable historical candidates and chooses a usable/new one.
Explicitly selected invalid bindings still fail. Archived history is never
restored, rewritten or made shared, and participant authorization is unchanged.

Candidate selection and conversation creation remain in the same transaction.
Reserved/used bindings keep repeated Bot slots separate. Regression coverage
includes repeated retirement beyond the old 12-attempt bound, reuse on subsequent
saves, preservation of instructions, and explicit restoration of an old record.
Both App and CLI call this same API; no protocol/schema change is needed.

### Keep owned automatic record titles consistent

New dedicated conversations use the role for the selected mode. On rename,
reorder or mode changes, the Hub maintains an existing title only when both its
creation action proves ownership by this Bus and its current title exactly
matches the previous generated title. The legacy step-name form is recognized.
User titles, ordinary explicitly bound history, another Bus's records and
archived records are preserved. Messages and run snapshots do not change.

Record and workspace updates share the same transaction; ordinary conversation
updates are published only after commit. Tests cover five-mode naming, repeated
Bot reordering, legacy and replacement records, title ownership and rollback.
If old names already diverged from the stored configuration, or missing historical
allocation keys prevent proof, the title is preserved rather than guessed.

## Browser evidence and interpretation

`client/e2e/agent-bus-real-runtime.spec.ts` adds browser journeys without mocked
Bus HTTP responses. They create/reopen a two-step same-Bot chain, check distinct
tasks and records, exercise success, model failure, explicit stop and incomplete
file delivery, and return to ADHD. A second journey repairs an archived binding
through the actual editor and verifies that old history stays archived.

An initial WebKit run reported caught fetch failures during document reload as
Playwright `pageerror` events. Independent repetition and a bare HTML reproduction
showed the same diagnostic with a successful `catch`, and no `window.error` or
`unhandledrejection`; the requests after reload succeeded. No production transport
or authorization change was made for this diagnostic. The new journeys monitor
actual uncaught error/rejection events across documents. Separate deliberate
throw/rejection probes verified that both are detected, without message filters.

## Existing limits

- Crew research sub-questions retain their explicit 60-second deadline; analysis,
  writing and review retain 120 seconds. These are separate from the ordinary
  delegation default of 30 minutes. The transport repair does not remove them.
- Member record conversations mirror execution text. Compatibility file
  directives are delivered through the initiating conversation and its existing
  file permissions. A normal-permission coordinator cannot automatically read
  another Bot's private workspace.
- Browser WebKit checks are not native WKWebView or installed Mac acceptance.
  Controlled engine output is not a real generated research/valuation result.

## Independent interaction findings

Opus operated five collaboration modes, repeated Bots, explicit record bindings,
remote edits/deletion, delayed/lost responses, narrow/compact layouts, dark/light
presentation, cancellation and Crew revision states. The isolated exploratory
harness used the real Hub store/API for definitions, revisions and receipts;
worker status events and collaboration-readiness responses were controlled.
This is distinct from the parent runtime journeys, which attach real Gateway
and Bus services with scripted engines.

The review reproduced parked-task loss during binding conflicts; silent truncation
of pasted text; an editable workspace after remote deletion; duplicate creation
and false save conflicts after lost replies; absent reload draft protection;
ambiguous reload wording; stale automatic record titles; an off-screen failure
reason; ambiguous same-name Bots; a rename-only execution-change notice; and
Escape handling during composition. Each disposition is checked against source
and a focused reproduction before being called repaired.

The parent independently reproduced the duplicate-create case against the real
Hub: the original implementation persisted two Buses and four dedicated records
after a lost create reply followed by a name correction. The regression also
covers a lost update reply; saving/reconciling must not execute any Bot task.

## Interaction repairs and recovery boundaries

- Mode changes retain parked task text even when another visible slot has claimed
  its record conversation; the restored slot gets a dedicated binding instead
  of being silently dropped. Clicking the selected mode is a no-op.
- Oversized pasted per-step tasks and shared goals remain intact. Counts and an
  explicit error block Save/Start; the browser no longer silently cuts the text.
- Remote deletion locks mutations and keeps a visible explanation. Draft text
  remains selectable/copyable; closing collapses the panel without discarding
  it. Leaving that draft for another Bus still requires the existing discard
  confirmation.
- Creating after an uncertain response replays the original request ID **and
  original payload**. A deleted receipt is terminal, not permission to create a
  new identity. A name-only correction preserves the recovered configuration and
  uses its revision; other changed or conflicting drafts require review. The
  original request is retained even across authorization/network errors. Exact
  create-validation errors known to roll back before the receipt allow the owner
  to correct the invalid Bot/record and try again. Other errors never implicitly
  authorize a new identity. A recovered draft that needs review has an explicit
  reload action and discard confirmation; the latest configuration is fetched
  before replacing anything.
- A lost update response is acknowledged only when exact resolved configuration
  and bindings match. An omitted/default record is not a wildcard for another
  device's arbitrary conversation. Recovery updates also retain their resolved
  payload so losing that response does not create a retry loop.
- Refresh/close protection includes unsaved division-of-labour and shared-goal
  drafts. Reload wording explicitly says per-step tasks are replaced and only
  the shared-goal draft is retained. Generic retry text no longer claims that a
  revision-based Save has a request ID.
- Failed-run reasons are visible near the run status. Duplicate Bot names have
  ID suffixes throughout the view. Renaming alone does not claim the execution
  configuration changed. Escape during IME composition does not close the panel.

The parent additionally reproduced recovery races using real committed Hub
mutations with only the response deliberately dropped: a remote binding must not
be acknowledged as this device's save; a remote task edit must not be overwritten;
a remotely deleted creation must not resurrect; and losing the response of the
name-correction update must still be recoverable. No automatic task execution or
resubmission is introduced.

The backend allocator, record titles and final delivery outcome are shared by
App and CLI. Draft handling, layout and browser event fixes are presentation-only;
existing CLI commands remain the same.

## Final independent review

Opus re-read the integrated recovery code without further production edits and
confirmed the strict save comparison, original-request replay/CAS boundaries,
and copyable retained deleted drafts. Its two additional recovery findings were
then reproduced before repair:

1. An older strict member schema can reject a create with `invalid_request`.
   Request/schema validation runs before commit; its exact rejection now releases
   the rejected identity so a corrected payload can be submitted. A browser
   compatibility fixture models that old schema response explicitly; it is not
   claimed as an installed old Hub test. Auth/network/ambiguous errors still retain
   the original identity.
2. A just-created Bus deleted elsewhere left a new-workspace panel locked with no
   obvious reset, especially when no Buses remained. The real-Hub regression now
   confirms that closing retains the draft; explicit **Discard draft** uses the
   existing confirmation, after which a fresh editor can create a distinct Bus.
   This is deliberate user action, never automatic resurrection.

Deleted panels also stop publishing stale ADHD badges and say that the Bus was
deleted in their header. Generic CAS-conflict wording no longer attributes every
mismatch to another window: an earlier response may simply have been lost.
Both added browser counterexamples fail before this final correction.

## Validation

- Full pre-completion gate: **342 files, 4,683 tests passed, 3 skipped**.
  The skips are the Windows-only check and two opt-in 305-second transport probes
  already exercised in the preceding long-turn change; they were not re-run here.
  The standalone build reports 372 modules without legacy transport/Feishu SDK
  imports. Historical and staged secret checks pass.
- Shared Hub/CLI/Gateway instruction and execution regressions pass, including
  five-mode delivery outcomes, archive/default allocation, automatic titles and
  cross-entrypoint behavior. Legacy TypeScript checking passes.
- Opus's full workspace journeys pass **56/56 in Chromium and 56/56 in WebKit**.
  Its 9 new journeys fail before the initial UI repair and pass afterward.
- After the final independent-review corrections, the main-checkout bundle passes
  **21/21 in Chromium and 21/21 in WebKit**: 7 real-runtime/Hub journeys and
  14 affected UI journeys. The full pre-completion gate is repeated on this final
  main tree with the same 4,683 passing tests. The real Hub journeys
  cover consecutive lost replies, stale binding conflicts, remote edits/deletion,
  explicit recovery confirmation and correction after a rejected creation.
- Client build and translation/type checks pass. An external hash manifest verified the integrated
  checkout against main; final-review corrections are then built and tested
  directly on main. No test alters the owner's production workspaces.

No App/CLI release, native installed-Mac replacement or real-model research run
is performed by this follow-up audit. Remote CI is checked separately after pushing; these local results do not
depend on GitHub runner availability.

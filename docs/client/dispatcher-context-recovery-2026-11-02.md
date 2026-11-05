# Dispatcher ticket context delivery and recovery

## Incident and cause

The installed 1.0.125 Chancellor could read `tickets targets`, including an
installed, allowed Claude engine, but its `tickets create` command omitted
`--context-message`. The Host correctly returned `dispatch_context_not_active`.
No ticket was created. The Bot described this as an inactive interface and ran
Claude directly, outside the ticket workflow.

The incident's Codex rollout contains a 4,043-character `tarocub.app` developer
message with a literal middle-truncation marker. Neither the ticket context ID
nor `--context-message` survived in that message. The Gateway had assembled
the authorization instructions together with the App, role and media guidance
in one application-context entry. A persistent engine also cannot rely on
receiving a new `TAROBOT_MESSAGE_ID` environment variable each turn.

This is not evidence that the ticket service or the engine installation was
disabled. The Host's existing active-turn and Bot-identity checks remain intact.

## Changes

- The Gateway creates a short, Host-owned `executionInstructions` contract for
  each Chancellor turn. Codex sends it separately as `tarobot.execution`, even
  when resuming a thread without native App tool registration. It is not saved
  as a persona, worker setting, user message or tool-schema change.
- The same short contract heads the existing turn instructions used by the
  other adapters. All ticket-writing examples contain the actual current ID.
  The contract forbids replacing failed ticket calls with direct engine CLI
  execution, changing identity or starting another Hub. A rejected current ID
  is a blockage to report, not permission to guess another one.
- The Bot-run CLI checks missing context before reading the request file or
  issuing a request receipt. A Host 403 with `dispatch_context_not_active`
  retains its machine code/status and explains missing, inactive, expired or
  foreign context and the explicit `--context-message` recovery step.
- No turn is inferred from the live queue, no owner credential fallback is
  added, and no automatic retry is performed. Timeouts, unrelated permission
  errors and server errors remain unchanged. An uncertain operation keeps its
  original request ID and arguments for read-back/reconciliation.
- CLI help documents the parameter. Local owner commands still use the owner
  API without requiring a Bot context; read-only Bot commands still work
  without one. Workers and group discussions receive no Chancellor contract.

## Verification

Evidence directory:
`/Volumes/gdrive/taro-tmp.noindex/dispatcher-context-20261102/`.

- Before the fix, three new focused cases failed: two Codex resume paths lacked
  the independent execution context, and a missing-context create read its
  request file before providing actionable context recovery (`regression-red.log`).
- Final focused regression: **9 files, 259 tests passed**
  (`final-regression.log`): `host-cli-tickets`, `gateway-dispatcher-context`,
  `gateway-dispatch`, `app-server-adapter`, `gateway-app-tools`, `hub-dispatch`,
  `hub-dispatch-auth`, `hub-dispatch-health`, `hub-dispatch-efficiency`.
- Real isolated Hub/Gateway tests cover two successive turns of a persistent
  scripted engine with no per-turn environment; missing context is refused,
  the supplied current context creates the ticket, and subsequent turns use
  a different ID. CLI tests cover explicit rejection, expiry, idempotent
  read-back, owner-only operations and no replay after uncertain failure.
- **Real Codex `gpt-6.1-sol`, low effort, same isolated session, two turns:**
  each returned its own independently supplied context ID, despite long
  synthetic App guidance. Both persisted `tarobot.execution` developer entries
  were 783 characters with no truncation. See `real-codex-context.json` and
  `real-codex-developer-readback.json`. This validates actual context delivery;
  it did not create tickets, run workers, use a production Bot or call tools.
- `npm run build` passed; standalone graph contains 484 modules with no legacy
  transport or Feishu SDK. `git diff --check` passed.

## Boundaries

This is a source repair, not a release or installed-App replacement. The
owner's ongoing video task was not rerun. Real Codex transport evidence and
scripted-engine Hub integration are separate checks; this run did not repeat
all five live engines' ticket-worker workflows. Guidance reduces erroneous
model fallback but is not an OS restriction on an independently authorized
full-access shell. No claim is made that a model can never choose incorrectly.

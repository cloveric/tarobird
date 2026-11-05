# Agent Bus transport residue audit — 2026-10-18

## Result and scope

The desktop Agent Bus definition, participant binding, run protocol and headless
CLI do not require Telegram accounts or credentials. Hub/Gateway collaboration
uses the local authenticated Bus and the existing App conversation queue. This
audit inspected `client/src/AgentBus*`, `client/src/agent-bus*`, the corresponding
Hub/Gateway/CLI/protocol modules, `core/bus.ts`, shared delegation/Crew/Mini/Board
commands, Bus transport and their audit/delivery boundaries.

There was genuine transport coupling below the visual feature. Removing every
historical string would also break compatibility, so the following dispositions
are intentionally different.

| Finding | Evidence and disposition |
| --- | --- |
| Shared delegation, Crew and Mini commands used `chunkTelegramMessage` with the Telegram 4,000 UTF-16-unit default | Reproduced: an App reply containing a long fenced block was split into separate logical deliveries with additional closing/opening fences. Shared commands now let Core own App/Feishu delivery limits. Actual Telegram callers retain bounded, fence-safe chunks. Success and retained partial results use the same policy. |
| App Mini Bus rejection instructed the user to use a Telegram group/forum | Reproduced in Chinese and English. Guidance now follows the actual surface; App guidance points to groups/topics and Agent Bus. Telegram and Feishu guidance stays specific to those integrations. |
| Mini validation replies counted chunks without sending those chunks | Reproduced with a long missing-peer list: Telegram received an oversized single send despite a multi-chunk audit count. Sending and audit now use the same chunks. App receives one logical validation reply. |
| Shared Bus interfaces imported `NormalizedTelegramMessage` / `TelegramApi` and fabricated `{ message_id: 0 }` receipts | Replaced with Core-owned message and reply interfaces; optional adapters remain structurally compatible. Core converters now use neutral names, and no fake native receipt is needed. This was architectural residue, not evidence of a Telegram network call. |
| App command contexts were hard-coded as `lark` | Core now explicitly selects `gateway` for App channels. Existing timeline normalization already corrected real Gateway turns; this is clearer ownership, not a newly claimed historical timeline defect. Legacy Feishu contexts remain `lark`. |
| Markdown splitting lived under `telegram/message-renderer.ts` | Moved the unchanged fence-safe algorithm to `runtime/markdown-chunks.ts` with a caller-specified limit. The Telegram export remains a compatibility wrapper with its original default. The standalone graph guard rejects new direct Telegram imports from shared Bus/delivery owners. |

## Names retained deliberately

- `kind: "cc-telegram-bridge"` is the local Bus health fingerprint. Existing
  listeners and registry readers use it to distinguish the expected process
  from an unrelated service on a reused port. Changing just one side would
  invalidate live peers. This audit preserves the wire contract.
- Stable `telegram_conflict` / `telegram_delivery` error classifications remain
  accepted by the shared protocol. They describe real optional-adapter failures;
  they are not Telegram routing fields in Agent Bus definitions.
- Historical `telegramChatId` state fields, logical session aliases, `lark:*`
  conversation keys and Mini routing-hash salts are existing identity contracts.
  They are not rewritten. Old queues, sessions, grants, cards and Mini peers
  remain addressable. See [neutral naming](../neutral-naming.md).
- Shared commands still recognize the actual `telegram` channel, and an omitted
  channel retains the old Telegram entrypoint contract. App callers explicitly
  identify themselves as `gateway`. Real integrations keep their proper names.
- Existing shared delivery options and prompt compatibility symbols with `lark`
  names are outside this narrow Telegram-coupling repair; they remain documented
  migration boundaries, not a claim that every legacy name has been removed.

No stored identity, credential, authorization rule, Bus protocol version or Hub
schema is changed. No live state is migrated or optional adapter fleet restarted.

## CLI and presentation impact

The App and CLI execute the same host collaboration code, so the reply fix applies
to both. No new CLI flags or commands are needed. There is no client layout change;
ordinary chat and ADHD read the same preserved logical reply. A future release
must package the App host and standalone CLI from the same revision. Source
validation does not replace installation/update acceptance.

## Verification

- Before repair: the six initial transport checks produced four failures
  (App/Feishu premature splitting and incorrect Mini guidance); a real isolated
  Hub + Gateway + local peer Bus reproduced the long-reply failure while the short
  reply passed. The original Mini validation-send path also failed its focused
  oversized-reply check.
- After repair: 12 transport tests cover all four delegation modes plus `/btw`,
  Crew, Mini, Chinese/English guidance, retained partial results, audit counts,
  and the real Telegram chunk limit. These use isolated state and mock engines.
- The isolated real localhost Hub/Gateway/Bus integration verifies short/long
  replies, ephemeral peer sessions, usage/audit, denied peers and shutdown.
  It does not claim two physical hosts or live Telegram account acceptance.
- Focused Bus/Hub/Gateway/CLI/queue suites: 245 passed before the final two Mini
  validation cases were added; shared command/Markdown suites: 125 passed;
  optional Feishu slash-command compatibility: 7 passed.
- Final full host regression: **339 files passed, 4,622 tests passed, 1 skipped**.
  The first full run overlapped a rebuild and one packaged-host test saw its
  `dist` entry temporarily missing; after fixing the verification order, the
  complete run passed against a stable build. No product workaround was added.
- Standalone build and optional-adapter TypeScript build passed; the standalone
  graph checked 369 modules, including the new direct-import guard.
- Adjacent engine/session/bookkeeping checks: 62 passed. Privacy guard checks:
  3 passed. Staged and reachable-history Gitleaks scans passed. CI execution is
  separate from these local results.

This change is source-only: it does not publish a release or replace the installed
Mac App.

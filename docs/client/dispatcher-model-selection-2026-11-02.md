# Chancellor per-task model selection follow-up

## Observed behavior

The owner's Chancellor `高达sol` ran the simple lookup, table work and local
process inspection in its own Codex session (`gpt-6.1-sol`, `xhigh`). Its
ticket ledger had no entries at inspection. The weather request used search
tools directly in that session, before the later video request's failed
ticket creation. This was actual self-execution, not just an unchanged model
label in the App.

The installed 1.0.125 Codex developer context was middle-truncated and lost
both the current message ID and the per-ticket model-selection paragraph.
The preceding source fix `6143a55` preserves a short execution context, but
that context initially carried identity and failure recovery without model
selection. The full guidance also invited omitted model/effort arguments,
which mean CLI defaults; the Host does not classify the task and choose a
model when those parameters are absent.

## Repair

The short, separately delivered dispatcher contract now includes:

- Actual execution requests, including small tasks, go through tickets.
  Conversation, clarification, planning, status and result review remain
  coordinator work. The coordinator must not substitute self-execution for
  worker selection just because a task is simple.
- Choose the engine, model and supported effort from current targets using
  complexity, risk and required capabilities. Bounded low-risk work prefers
  a capable lightweight model and low effort; complex or uncertain work can
  use stronger reasoning. No topic keyword, including weather, determines
  the tier by itself.
- Respect explicit owner model choices and target availability, permissions
  and required tools. Pass the chosen model/effort explicitly. If the catalog
  has no selectable setting, deliberately use its default and explain the
  limitation. Do not invent model IDs, capabilities, prices or savings.
- State the selected worker configuration and a short reason. Selection is
  not proof that it ran: actual-use statements need execution evidence.
- Preserve ask/auto, concurrency and retry boundaries. Ask mode still requires
  confirmation before dispatch. Changing a ticket's model does not change the
  coordinator or worker Bot's saved default configuration.

The full shared contract uses the same rules for other engines. CLI/API
parameters and owner defaults remain compatible; no new task classifier or
provider-specific topic routing is introduced. The live Bot configuration and
ongoing work were not changed.

## Evidence

Directory: `/Volumes/gdrive/taro-tmp.noindex/dispatcher-model-selection-20261102/`.

- New Gateway assertion failed before the fix: the independently delivered
  context lacked model-selection instructions (`regression-red.log`).
- **7 suites, 74 tests passed** (`regression.log`): Gateway dispatch/context,
  CLI tickets, App tools, engine overrides, Hub dispatch and authorization.
  An extended real Hub/Gateway test sends two same-engine tickets with
  `gpt-6-luna/low` then `gpt-6.1-sol/high`. Each distinct hidden conversation
  reaches the scripted worker with its own override; Bot defaults remain
  unchanged. This is a transport test, not a live worker-model run.
- **Real Codex plan-only check:** `gpt-6.1-sol/low` reviewed eight scenarios
  across two turns of one isolated session, with a controlled model catalog.
  Simple lookup and CSV reordering selected the lightweight model/low;
  multi-year statistical weather analysis and cross-module concurrency work
  selected the stronger model/high; an explicit Opus request retained Opus;
  greeting and status stayed direct. A second-turn catalog without the
  lightweight model produced an available model/low and explained the limit.
  See `real-routing-verification.json` and `routing-turn-*.json`.
- Both actual Codex `tarobot.execution` developer messages were 2,024
  characters and retained the model/effort, task-selection and ask-mode rules
  without truncation (`real-context-readback.json`).
- `npm run build` and `git diff --check` passed; the standalone graph has
  484 modules and no legacy transport or Feishu SDK.

The real model check made plans only: it called no tools, created no tickets,
performed no requested tasks and used no production Bot. It does not prove
all future model judgments, actual price/latency savings or all engines'
end-to-end execution. Policy compliance remains model-mediated; Host authority
checks remain enforced in code. This source change is not an App release or
installed-version acceptance. The current 1.0.125 installation is unchanged.

## Follow-up real execution

The later [Opus recheck and real coordinator/worker run](dispatcher-live-recheck-2026-11-02.md) adds two actual Codex ticket executions, same-session context readback and an ask-mode confirmation check. It remains isolated from the installed App.

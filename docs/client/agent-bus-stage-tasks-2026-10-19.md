# Agent Bus: long turns and per-stage tasks

## Confirmed defects

A chain failed after 301,141 ms even though the receiving Bus was healthy. Its
request waited for a complete engine turn before returning HTTP headers. Node's
global `fetch` imposed a 300-second header timeout, earlier than TaroBot's
30-minute delegation deadline. Disconnecting correctly aborted the receiver;
the caller incorrectly reported `instance_unavailable` and `retryable: true`.
An isolated Node 24.14.0 experiment reproduced both errors at 301,535 ms:
`fetch failed` / `UND_ERR_HEADERS_TIMEOUT`, and the misleading Bus error.

The failure was independent of the selected model. A separate product problem
made a chain appear to include its initiating Bot even though only its member
slots executed. A shared prompt could not reliably specify each slot's work.

## Transport repair

`bus/bus-http.ts` uses a private, one-shot `node:http` POST, with no global
agent/dispatcher mutation, redirects or automatic retries. The existing total
deadline covers connection, headers and body; explicit cancellation remains
connected to the receiver's disconnect handler. Only an actual refused
connection is reported as unavailable/retryable. Accepted-but-interrupted work,
malformed responses, response overflow and deadlines are non-retryable.

Responses are bounded to 16 MiB by declared **and** received bytes, buffered as
bytes and decoded once. Non-2xx success-shaped bodies cannot claim success.
Known error codes survive Gateway reports and have readable record-card and
coordinator-message explanations. Uncertain failures never claim that the
remote engine definitely completed, stopped, or did no work.

The 256 KiB request bound remains: task + background + previous output must fit.
We do not silently truncate the previous result. A failure explains the combined
input limit. This change does not add resumable remote jobs, transport-level
idempotency, heartbeat streaming or cross-host Agent Bus routing.

References: [Undici Client timeouts](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)
and [Node HTTP request/abort behavior](https://nodejs.org/api/http.html).

## Task and execution model

- `members[].instruction`: optional saved task, trimmed, maximum 8,000 characters.
  It belongs to the step, travels with the member and conversation on reordering,
  and supplements the workflow's existing prompt. Empty fields retain the
  previous prompt byte for byte.
- `coordinator.instruction`: supported only when the coordinator executes work
  (`fan`, `verify`, `crew`). It is rejected for `ask` and `chain`, rather than
  silently ignored or interpreted as an extra step.
- Run `text` remains a required common goal. A run captures the entire saved
  configuration; subsequent edits never change its instructions or bindings.
- A chain executes member slots in order. To research with Bot A then value with
  Bot B, explicitly include both in `members`, even if A also initiates the run.
  A's two slots have different record conversations. Existing local-slot
  execution avoids self-peer grants and socket recursion.
- Gateway injects instructions only after verifying the immutable dispatch slot.
  Duplicate Bots and out-of-order parallel results retain their own tasks and
  record conversations. Crew retries/revisions retain the same role task.
- Each record retains its own task and the existing bounded composed-prompt
  excerpt (up to 16,000 characters). The execution prompt is not truncated. Brief task
  sections start expanded; long sections start collapsed. Record conversations
  remain records of independent temporary turns, not resumed chat sessions.

The desktop UI exposes a separate task box for each executing slot, a concise
initiator explanation in chain/ask, and an explicit action to add the initiator
as the first chain step. The run view uses snapshot tasks. Phone UI does not
expose the desktop Agent Bus editor.

Mode changes may temporarily hide extra members or a coordinator task that the
new mode does not execute. These remain unsaved drafts: leaving or reloading
requires an explicit discard, and polling cannot replace them. If only hidden
drafts differ, the saved Bus can still run unchanged; saving an unchanged form
cannot silently discard those drafts. The editor explains how to restore them
by switching back, or discard them through reload.

## Compatibility and CLI

Worker capability advances to `agent-bus.runs.v3`. New Hubs reject older workers
before sending a run. New workers also advertise v2 for older Hubs, and still
parse old dispatches. The peer HTTP protocol stays at v1; no new capability is
sent to the old strict peer parser.

Hub schema advances from 18 to 19 because the stored configuration and snapshot
JSON gained fields. New code reads old definitions and queued snapshots without
adding tasks. Old runtimes must refuse schema 19; downgrade requires the
pre-update backup. Package compatibility metadata and update guards match this
boundary. No live owner state is migrated during source verification.

No additional slot identifier is needed here: unique conversation bindings and
immutable array positions already identify execution slots. The UI keeps tasks
inside member objects, never in a map keyed only by Bot ID. Broad permissive
schema parsing and automatic deletion of corrupt rows are not part of this fix.

CLI uses the same schemas and Hub API. `create/update --from` and `show` preserve
instructions; config files accept up to 512 KiB to accommodate maximum-length
Chinese tasks. The common goal still comes from `run --text-file`.
An older standalone CLI uses strict workspace parsing and cannot read a new
workspace containing instructions. Ship/update the CLI together with the Hub;
this mismatch fails closed rather than dropping instructions.

```json
{
  "name": "Company research and valuation",
  "mode": "chain",
  "coordinator": { "botId": "research_bot" },
  "members": [
    { "botId": "research_bot", "instruction": "Research the company and industry. Provide figures and sources." },
    { "botId": "valuation_bot", "instruction": "Use the previous research to build an income-based valuation and deliver a spreadsheet." }
  ]
}
```

```sh
tarobot bus create --from bus.json --request-id CREATE_ID
tarobot bus show WORKSPACE_ID
tarobot bus run WORKSPACE_ID --text-file goal.txt --revision REV --request-id RUN_ID
```

## Review and verification

Claude Opus 5.5 with xhigh effort independently reviewed the timeout diagnosis,
protocol boundaries, execution semantics and UI, then implemented the desktop
editor. Findings were checked against code and reproductions rather than adopted
wholesale. In particular, writing an initiator instruction does **not** implicitly
insert a chain step; the UI must make that change explicit.

The independent backend pass confirmed the single-request transport and the
slot/permission boundary. Its reproducible fan error-copy omission was fixed
and covered by a failing-then-passing regression. The schema-19 backup allowlist
omission was found by the full suite and fixed before delivery. Its separate
loopback probe verified truncated replies, user cancellation and deadlines.
Additional integration coverage exercises coordinator tasks and repeated-Bot
roles in fan, verify and Crew, including Crew revision rounds.

Conditional observations remain documented rather than treated as confirmed
defects: the 16 MiB response bound is per concurrent request; a verifier sees the
common goal and answer rather than the coordinator's private instruction; Crew
decomposition still expects question lines. These do not change the workflow
contract or justify silently rewriting user tasks.

The parent review also reproduced hidden-draft loss when returning to the saved
mode. Opus corrected the leave/reload/poll guards and demonstrated that both
added-member and coordinator-task browser regressions fail without the fix.
Structured error-code prefixes now take precedence over incidental words in a
diagnostic, preventing a Bot name or secondary error text from changing the
reported failure category.

Wall-clock checks with real loopback HTTP and Node 24.14.0:

| Case | Result |
| --- | --- |
| Original client, headers delayed 305 s | Failed at 301.5 s; unavailable/retryable; receiver disconnected |
| Fixed client, headers delayed 305 s | Complete at 305.0 s; exactly one request |
| Fixed client, response body delayed 305 s | Complete at 305.0 s; exactly one request |

Fast regressions cover deadline/cancel before and after headers, resets,
malformed/non-2xx replies, response bounds and UTF-8 chunk boundaries; tasks cover
strict validation, repeated-Bot slot identity, snapshot/reorder/CLI persistence,
old worker rejection, old-state migration and real Hub/Gateway/HTTP chaining with
scripted engine outputs. The opt-in wall-clock test can be rerun with:

```sh
TAROBOT_BUS_LONG_HTTP_TEST=1 npx vitest run tests/bus-client-timeouts.test.ts
```

Final verification:

| Check | Result |
| --- | --- |
| Isolated full pre-completion gate | 342 files; 4,657 passed, 3 intentional skips |
| Secret scans and standalone production build | Passed |
| Chromium Agent Bus workspace journeys | 47 passed |
| WebKit affected Agent Bus journeys | 15 passed |
| Chromium ADHD, prompt queue, collaboration setup and delegation | 48 passed |
| Client Agent Bus unit checks | 31 passed |
| Client translation, TypeScript and production build | Passed |
| Legacy TypeScript check (`--noEmit`) | Passed |

The hidden-draft regressions were also run against a temporary build with the
guard removed: both failed, then both passed with the restored implementation.
The parent inspected light/dark/narrow screenshots and separately exercised
WebKit layout and task editing. Browser tests use isolated Hubs and controlled
Bus API responses; they do not represent native Mac installation or live model
execution. Gateway integration tests use real HTTP but scripted engine outputs.

One overlapping full-suite/browser run hit five unchanged Gateway tests' 5-second
test deadlines. Their six matching cases passed with the original deadlines in
a focused single-worker rerun; no timeout or assertion was relaxed. The final
full gate ran separately from browser tests and passed in 180.8 seconds. Its
three skips are the Windows-only check and two opt-in 305-second HTTP checks;
their delayed-header/body scenarios passed the separate wall-clock HTTP probes
documented above.

The long HTTP checks do not claim a live model-generated valuation. The owner's
research/valuation was not rerun, the saved Bus was not rewritten, and the
installed Mac App/host was not replaced. Deployment and real-engine acceptance
remain release-time work.

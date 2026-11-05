# Agent Bus goal queue classification — 2026-11-01

Issue #103 independent review was reassigned from Kimi to Claude Opus 5.5 by the owner after the provider rejected the Kimi subscription. This is finding F-01, isolated from other audit fixes.

## Confirmed behavior and cause

With an ordinary coordinator message already dispatched and another ordinary message queued, starting an Agent Bus goal beginning with `/review` or `/stop` made the Hub classify the goal as a control-command barrier. It prematurely dispatched both waiting inputs. The ordinary message lost its edit/move/cancel controls, and stopping the Bus required a worker acknowledgement instead of cancelling before dispatch. This does **not** establish concurrent model execution or duplicate execution: the worker still serializes the conversation.

Core executes durable Agent Bus inputs by their run metadata, not their text. Hub claim and reorder now use that same distinction. Real slash commands keep their ordering barriers. Only slash-shaped candidates add a lookup by indexed `agent_bus_runs.message_id`; there is no history scan. Bus inputs remain uneditable and must be stopped through their run.

App, mobile and headless `tarobot bus run` use the same Hub queue; no new CLI command or permission is introduced.

## Verification

- Root independently reproduced two failures with desired assertions: `/review` and `/stop` goals flushed the waiting queue; the plain-text control passed.
- Five focused Hub queue, Agent Bus, Gateway and CLI suites: **233 passed**, serial execution with a 15-second per-test timeout. A prior concurrent run hit four existing 5-second test timeouts (229 passed); those were not counted as passing.
- Added direct queue-head dispatch checks for ordinary/slash goals and pull workers, to verify that the fix does not strand a Bus input.
- Three direct head-dispatch checks passed; two are additional cases beyond the 233 above (235 distinct focused cases). `npm run build` passed: 481 modules.
- Independent Opus diff review is retained in the task evidence and final audit index.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/agent-bus-103-20261101/queue-{red,green,green-serial,head,build}.log`, independent Opus report and `queue-fix-review.md`. All execution used isolated Hub state and scripted engine responses. No release, installed-App replacement, or production Host restart.

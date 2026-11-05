# Native CLI stop acceptance

An App stop must settle the visible turn promptly and cancel the native work.
These are measured separately. The composer, run card and `/stop` share the
authorized conversation cancellation path. Other conversations and queued turns
retain their existing behavior.

Baseline 2026-10-03 local samples, all with exact-title recall in the same native
session after stopping:

| Engine | Chromium native boundary | WebKit native boundary | Visible interruption, both browsers/devices |
| --- | --- | --- | --- |
| Codex | 13 ms | 13 ms | 18–26 ms |
| Claude Code | 710 ms | 705 ms | 20–23 ms |
| Kimi | 12 ms | 11 ms | 38–40 ms |
| DeepSeek Harness | 12 ms | 12 ms | 22–34 ms |
| Antigravity | 700 ms | 687 ms | 20–41 ms |

Each browser passed seven cases: five native engines, Bot effort scope/conflict
handling, and controlled group stop/queue/topic isolation. Focused tests passed
162 cases. The required hook passed 231 files, 3,629 tests and one existing skip,
followed by the root build. Evidence, source hashes and screenshots（本地材料：`evidence/native-stop-2026-10-03.json`）.

## Bounded process cleanup

Real Claude acceptance reproduced a 1,523 ms CLI exit even though the two clients
displayed interruption after 26/25 ms. Its existing SIGTERM cleanup allowed a
2,000 ms grace period. Antigravity also approached the limit in an initial sample.

Explicit App stops now carry an in-process cancellation reason. Claude and both
Antigravity process paths use a 650 ms SIGTERM grace for that reason, followed by
the existing process-tree helper's identity-checked SIGKILL if needed. Feishu,
Telegram, shutdown, preemption and timeout cancellation keep their original
policy. This is a bounded graceful cleanup attempt, not unconditional SIGKILL.
Codex, Kimi and DeepSeek keep their native protocol cancellation.

## Reproduce

After the root and client builds, run in `client/`:

```sh
TMPDIR=/tmp/t TAROCUB_LIVE_STOP=1 npx playwright test e2e/live-stop.spec.ts
TMPDIR=/tmp/t TAROCUB_LIVE_STOP=1 npx playwright test --config=playwright.webkit.config.ts e2e/live-stop.spec.ts
```

The explicit opt-in invokes paid, installed CLIs. `TAROCUB_LIVE_ENGINE` can select
one engine. Temporary workspaces contain only synthetic prompts. The test uses
real managed Gateway workers, a real local Hub, and independently paired desktop
and phone browser contexts. It waits for model output before the phone clicks
stop, then checks:

- Both views show interruption and the runtime settles within 1 second.
- Codex reports `turn/completed: interrupted`; Kimi returns
  `session/prompt: cancelled`; DeepSeek acknowledges its native `session.cancel`.
  Claude/Antigravity must actually exit the exact spawned CLI process.
- A subsequent answer recalls the synthetic theme in the same native session.
  The stopped message remains unchanged and no pending delivery is left behind.

The final prompt asks for an ordinary long science-fiction story with an exact
title and synthetic work number. An earlier counting/control-marker prompt was
refused by Kimi in one WebKit trial; no stop was attempted in that case. The
test was changed to exercise a normal writing task, without weakening latency,
actual answer-stream or exact-title recall assertions.

The test-only worker preload observes native event metadata without changing
arguments, prompts, permissions or results. The saved receipt distinguishes UI,
runtime settlement and native protocol/process boundaries. The cancellation RPC
receipt is not proof of cessation of provider compute or billing.

The first fixture searched the whole card, including thinking. A DeepSeek trial
therefore stopped before any answer, and its later exact-theme assertion failed.
That trial did not capture the final answer, so it does not establish why recall
failed. The corrected fixture requires top-level answer text, excludes reasoning
from recall assertions, and retains synthetic answer diagnostics on failure.
Four subsequent optional early-marker reproductions passed; two actually stopped
before answer text and two reached answer text first. This is recorded separately
from the default answer-stream acceptance, not treated as proof of a production
DeepSeek fix or an exhaustive reasoning-phase matrix.

Set `TAROCUB_STOP_REASONING_REPRO=1` with the explicit live opt-in to repeat that
early-marker experiment. Its receipt records whether an answer had really begun.

## Stop with queued or immediate follow-up messages

The r6 frontend passed all 20 native cases (five engines × two browsers × two
flows), with 50 observed native prompt submissions. Native cancellation/exit
took 10–796 ms, visible interruption 21–70 ms, and the immediate follow-up
reached the Hub in 54–91 ms. These are local samples, not native-container or
public-network guarantees. Receipts and 40 screenshots（本地材料：`evidence/native-stop-continuity-2026-10-03.json`）.

`TAROCUB_LIVE_STOP_FLOW=queued` sends two follow-up messages, one from each paired
device, while the real native answer is streaming. Both must reach the worker
before stop, and only the original prompt may have been submitted to the CLI.
The phone then stops that answer. Both queued inputs must complete in FIFO order,
each with exactly one successful reply and one native prompt submission, in the
original native session with its exact story title still available. Each input
requests a different response prefix; matching the title alone cannot conceal
swapped replies or the same prompt being executed twice.

`TAROCUB_LIVE_STOP_FLOW=immediate` prepares a follow-up in the desktop composer
and submits it within 500 ms of the phone's stop click, without waiting for CLI
exit or protocol acknowledgment. The receipt separately records Hub acceptance,
native cancellation/exit, and the next native prompt submission. Whether these
overlap depends on the engine; the test does not force or simulate that timing.

Both modes check the stopped card remains unchanged, the durable outbox drains,
and both clients can reload and read the replies without another native prompt.
The observer counts submitted native protocol prompts, not provider-internal
retries or billing events. Run either mode with the existing live opt-in and
either Playwright browser configuration above. The default `after-native` flow
continues to wait for the observed native boundary before its follow-up.

Temporary Hubs and workspaces are removed after each case. The test archives only
its owned Codex threads with readback; it removes only its owned Claude fixture
transcripts. Kimi uses an isolated temporary home with credential references.
Antigravity may retain its native synthetic conversation history; no unsupported
global history deletion is attempted.

## Stable send target during remote stop

A real DeepSeek/WebKit immediate-follow-up trial exposed a client click race:
the running-state button was 64.84375 px wide, but shrank to 32 px when the
phone's stop arrived. Its original center (x=1160.57) fell just outside the new
left edge (x=1161). The click completed without invoking Send; the draft remained
in the composer and no follow-up reached the Hub. This was a UI hit-target
problem, not a failed model recall or a lost Hub delivery.

The button now reserves the same label space for Send and Queue and keeps its
dimensions through either state. Controlled browser regressions hold a real
pointer down while the other paired device invokes the stop UI handler, then
release it after the state update. They require unchanged geometry, one Hub
message, one engine invocation, a cleared draft and both devices' reply. The
other device uses its DOM click handler in this regression to avoid its synthetic
mouse press cancelling the held pointer in the shared browser process; the
separate real-CLI tests retain normal Playwright stop clicks.

Reconstructing only the original App/CSS send-button code through a test-build
transform reproduced the failure without changing the worktree or normal dist.
The corrected regression passed for desktop and phone senders in both Chromium
and WebKit, along with effort, steering and group/topic stop checks (5 per
browser, with the WebKit steering check passing on a focused recheck). That
combined WebKit run had emitted a `/health` browser diagnostic during reload;
its functional assertions passed and no connection-code fix or error filter is
claimed. Click-race receipts and screenshots（本地材料：`evidence/native-stop-click-2026-10-03.json`）.
Browser phone viewports are not physical-device acceptance.
At widths up to 360 px, Send and Steer retain their accessible names and tooltips
but use compact icon buttons. A 320 px regression verifies the toolbar does not
overflow and Send remains in the viewport.

These are local browser measurements with specific installed CLI/model versions,
not percentile guarantees, native-container, physical-phone, cellular or VPS
performance acceptance. Gate 2 remains open for the full native-device matrix.

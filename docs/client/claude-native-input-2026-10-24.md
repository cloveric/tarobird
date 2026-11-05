# Claude ordinary input and native send-now

This change applies to authenticated human input in the Claude App path. Other
engines, Agent Bus, cross-Bot messages, group discussion scheduling and the durable
next-turn queue keep their existing behavior. The standalone CLI calls the same
Hub APIs; it does not implement a second queue.

## Native behavior checked before implementation

The local executable is Claude Code **2.1.309**. The native keymap and
[interactive-mode documentation](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works)
map Enter to submit and Ctrl+Enter / Ctrl+X Ctrl+S to send-now. Enter admits input
to the native queue without deliberately interrupting work. Input can fold into
the next model request after tools, or become a subsequent native turn when the
current turn has no further model requests. It is not an unconditional wait for
the entire task to finish.

Opus 5.5 xhigh independently examined the local executable's protocol and fresh
Sonnet low probe sessions. The probe model and the reviewing model are different.
An initial foreground-sleep probe was blocked by Claude and was excluded; later
probes ran actual foreground work. No production conversations were used.

The live `system/init` capability list, rather than the executable version or
`initialize` response, is authoritative. In this version:

| Action | Stream protocol | Meaning / limit |
| --- | --- | --- |
| Ordinary send | `user` with native UUID, no priority | `queued` proves native admission; `started` proves dequeue, not model receipt |
| Send now | `interrupt {send_now:true,message_uuid}` after admission | Requires `interrupt_send_now_v1`; never send this to an old CLI that could interpret it as Stop |
| Withdraw | `cancel_async_message {message_uuid}` | Only `cancelled:true` proves removal; false cannot restore a supposedly withdrawn message |
| Model receipt | Request markers plus a real main-model response | A lifecycle event, local error, or result marker alone is insufficient |

Real human-origin input must carry `origin:{kind:"human"}` for the native
background-capable send-now path. Host prompts, schedules, task notifications and
other Bot messages must not inherit that marker. `priority:"now"` is not used:
its behavior depends on origin and version and it lacks the dedicated control
receipt.

Native send-now replies are deliberately not collapsed into a false model ACK:

- `delivering`: the CLI accepted the control path; it may background a tool or
  deliver during another transition. This does not prove that the model received
  the input.
- `stopped`: the CLI interrupted the current output/turn. The original queued
  input must continue under the existing ownership, without a second user write,
  cancelling that input, or stopping background agents.
- `nothing_waiting`: this UUID is no longer waiting. The control did not alter the
  task; it does not independently prove model receipt.

## Difference from the previous TaroBot path

Ordinary in-flight plain text already used native user messages with lifecycle
admission. That path is retained; replacing it with a full-turn-only queue would
be a regression. The missing pieces were the dedicated guarded send-now control,
atomic withdrawal, persistent App retry identity, and a separate receipt that
does not equate native `started` with a model response. Older explicit steering
receipts remain on their compatibility path.

Three adapter bugs were reproduced while integrating send-now: an aborted native
segment could cancel the input that should continue; a foreground tool moved into
the background was absent from the adapter's task ownership; and a result for a
batch of late inputs could be ignored when its last opener differed from the
first continuation input. The fixes preserve existing turn ownership while
following the actual native lifecycle.

## Host and App lifecycle

The existing steering transport is reused with an additive `mode:"message"`.
Old explicit steering remains separate. Ordinary Claude sends query the live
run before delivery even if many intervening user messages pushed the running
reply out of the UI's short recent-message window. A negotiated `claude.native-input.v1`
capability covers the new receipt/control path; its native flags are separately
read from the exact worker. Optional progress is durably journaled and retired
when reconnecting to a Hub that lacks the capability, so it cannot block final
reply replay.

Each input has an authenticated-author-scoped identifier. Hub transcript entries
bind author, conversation, Bot, target and content. Gateway send/control receipts
are fsynced before side effects, and controls bind the original input in the
existing native session. They never create or resume another session. Uncertain
requests are checked with the same ID; neither reconnect nor a timeout resends
text or falls back to Stop. Local draft and control IDs also survive page reload.
Draft cleanup and receipt updates use compare-and-swap to preserve newer edits.
Native retry metadata uses a separate `operation:` namespace, not the user draft
index. Confirmed control results retire the control attempt; uncertain controls
retain their exact ID. Admission retires the original input identity after draft
cleanup, including after navigation. A new edit cannot be silently swallowed as
an old identical message. Recovered receipts in another window do not clear an
originating retry based on that window's unrelated draft.

The receipt separately represents pending, CLI accepted/queued, dequeued awaiting
model response, model received, confirmed withdrawal, verified non-delivery and
uncertainty. None is an execution-complete indicator. A completed native turn with no model receipt is
shown as reception unconfirmed, without withdrawal/send-now controls; it does
not stay labelled as running forever on old CLIs. `started` is not reported as
model received. For a new native opener, a main-model response can carry its UUID.
For a folded input, the requesting marker list and the subsequent real main-model
response must be correlated within the same live request/turn; unrelated child
responses, local errors and interrupted requests cannot provide that evidence.

On phones and desktops, each still-pending native input offers send-now and
withdraw/edit when supported. Known dequeued/model-received input does not show
withdraw. Confirmed withdrawal prepends its original text to the current draft,
retaining newly typed text, files and references. A pending cancellation does not
change the draft. If another message is being sent when withdrawal succeeds,
restoration waits until that send settles, preventing already-sent text from
being reintroduced. The App button and Ctrl+Enter invoke the same guarded send-now operation; they
do not call the existing Stop button. The terminal's Ctrl+X Ctrl+S chord is not
reserved in the App editor, which retains its standard cut shortcut. A fresh
status explicitly reporting idle lets Ctrl+Enter send the initial normal message;
unknown status or missing send-now support during work keeps the draft instead.
The send-now capability check runs before recording or posting fresh input;
unsupported Ctrl+Enter cannot accidentally send an ordinary message first.
Slash commands keep the original command path, including when submitted with
Ctrl+Enter.

## Visible send-mode follow-up

The [composer send choice](claude-send-choice-2026-10-24.md) now exposes ordinary
native input and durable next-turn delivery directly above the field on phone
and desktop. It keeps the protocol mappings below, remembers an explicit
next-turn choice within the conversation's current task, and prevents a pending
native attempt from being sent again through the durable route.

## Deliberate differences from the terminal

- TaroBot's **作为下一轮发送** is an additional durable option that waits for the
  current task to finish. It is not the native temporary queue.
- Attachments, quoted references, commands and input during an unaddressable
  background-review turn retain the existing durable path. The App explicitly
  says attachments/references wait for the current task to finish. Their bytes,
  reference ownership and queued order are preserved; they are not silently
  converted into text-only native input.
- Terminal Up can pull pending lines into one draft; the App withdraws an explicit
  individual message using an atomic native receipt. It does not claim to rewind
  input that has entered a model request.
- Old CLIs without the necessary native capability do not expose send-now or
  withdrawal. Existing supported ordinary input remains supported; otherwise it
  uses the durable next-turn queue. There is no version-only or plain-interrupt
  fallback. When send-now is unavailable during work, Ctrl+Enter preserves the draft and
  reports that limit instead of silently acting as ordinary Enter.
- Explicit Stop retains its existing scope. This task does not opt into the newer
  `perTaskStopAffordance` initialize flag or change unrelated Stop semantics.
  Send-now uses its separate native operation and preserves background tasks.

## Headless entry

`tarobot steer status CONVERSATION --bot BOT` reports the live native capability.
`steer send ... --mode message` uses the ordinary native-input receipt.
`steer send-now CONVERSATION --message MESSAGE --request-id ID` and
`steer cancel CONVERSATION --message MESSAGE --request-id ID` address the original
Hub message. A timeout must be checked with the same request ID. No command
reinjects the text as a new message.

## Verification record

The final isolated real-App journey uses a managed **Claude Code 2.1.309**
worker with Sonnet low. A foreground tool and a separate background agent are
running when two clients send input. The raw native record verifies:

- Ordinary A is queued without an interrupt; C is withdrawn with `cancelled:true`.
- D uses one `interrupt/send_now` control and receives `delivering`; A and D are
  subsequently confirmed by model responses in order.
- There are exactly four user writes, each with its own UUID, in the same native
  process. Follow-up input has human origin and no priority override. Withdrawn
  C is absent from successful model-result marker lists.
- No `cancel_queued`, process restart, or background-agent stop occurs. The
  original background agent is still running in the App task list at acceptance.
- Separate live adapter probes cover text-generation `stopped`, last-turn input,
  and two messages combined into a later native turn, including their ownership.

Browser acceptance covers desktop and phone layouts in Chromium and WebKit:
per-message admission/model states, withdrawn text restoration, Ctrl+Enter/menu
send-now, rich input and explicit next-turn retention, lost HTTP/reload,
capability downgrade, offline durable outbox, repeated identical text after
editing, and cancellation returning during another send. Fault injection blocks
the browser service worker so intercepted HTTP failures cannot be bypassed.
The existing legacy steering and persistent-draft suites also pass.

Opus 5.5 xhigh performed the adapter review and a separate App/Hub/Gateway
review. Reproduced findings include stale retry identities swallowing later
identical text, cached transient control rejection, downgrade uncertainty,
restore/send races, and fresh pre-delivery rejection. The implementation and
regressions address these individually; unrelated engines retain their paths.

Browser phone screenshots cover the responsive App and WebKit renderer, not a
physical iPhone, native keyboard or operating-system input transport. Evidence
for this run is under `/Volumes/gdrive/taro-tmp/claude-native-input-20261024/`,
including `live-app-verified`, `opus/findings.md`, the independent review, browser
traces, and final build/test logs. No installed host was restarted or upgraded.

Final checks:

| Check | Result |
| --- | --- |
| Host build, Git identity and history secret checks | Passed |
| Full Vitest run | 472 files; 6,438 passed, 5 conditionally skipped |
| Final preflight and immediate-send guards | 6 related files, 51 tests passed after the full run |
| Client build | Translation checks, TypeScript and production bundle passed |
| Native desktop | 77 Rust tests passed, including real pinned TLS transport |
| Latest native-input browser flows | 6 Chromium + 6 WebKit passed |
| Other relevant browser checks | Persistent drafts, legacy steering and queue/task separation passed |
| Real Claude App journey | Repeated passes; same process, ordered receipts, confirmed cancellation, background agent retained |

The worktree initially lacked the generated `src-tauri/host` bundle, so the
pre-complete runner stopped at native resource preparation. The official
`prepare-desktop-host.mjs` built and loaded the bundle successfully; the native
stage was then rerun and all 77 tests passed. This was build preparation only,
not a change to the installed host.

The last App review also caught failed read-only capability probes blocking a
fresh ordinary send. Such preflight failures now permit the durable fallback
only before any native write, with no older uncertain attempt. POST uncertainty
and the explicit send-now path never use that fallback.

The independent final App review rebuilt the current source and reproduced all
reported fixes, including missing send-now capability, old CLI, slash commands
and idle Ctrl+Enter. Its final sign-off is recorded in
`opus/shared-review-final.md`, with the last four browser cases in
`opus/shared-review-independent/final/e2e/run-ce-guards.log`.

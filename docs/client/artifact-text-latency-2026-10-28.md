# Attachment arrives before the reply — 2026-10-28

**The ordering is not Claude-specific.** A later Codex example confirms the same
delivery sequence: the file tool publishes a caption and attachment immediately;
the assistant then produces its final reply after the tool receipt. That sequence
explains why a ready file can precede the final reply in either engine. Effort
measurements below concern the duration of one later stage, not the reason for
this ordering, and must not be presented as an answer to the ordering question.
The [Codex follow-up](#codex-follow-up-the-same-ordering) records the independent
case and distinguishes existing commentary, the file caption and the final reply.

The screenshot shows a delivered presentation below a still-running reply card.
The reported delay is real: the attachment's Host event preceded the first
reply-text event by **12.705 seconds**. Opus 5.5 independently reviewed the
Claude transcript, adapter and reply-card lifecycle alongside the Host/worker
timeline investigation.

The installed App was read back as **1.0.117 / Host 0.1.462**, with source
`5950ea656c74150498f41b44dc52f613d5c68fb8`. This investigation started from
`34452f70`. The Claude streaming adapter and Markdown job
queue were unchanged between those revisions. No installation or restart was
performed, and no production database or persistent Bot/model settings were changed.
The later real probes below varied only flags of independent temporary CLI sessions.

## Observed boundary

Times are local UTC+08:00 on October 28. Business content, native session/message
IDs and private reasoning are omitted from this report.

| Stage | Time | Evidence |
| --- | --- | --- |
| User input saved | 00:44:54.829 | Host message |
| Attachment published | 00:45:54.914 | Host `message.created` event |
| File tool result reaches worker | 00:45:55.264 | Worker timeline |
| Claude records its next API request metadata | 00:45:55.355 | Native transcript request metadata |
| First public text delta reaches worker | 00:46:07.551 | Worker `assistant_text`, two characters |
| Complete public text block recorded | 00:46:07.576 | Native transcript, 911 characters |
| First reply text reaches Host event history | 00:46:07.619 | First body-bearing `message.updated` |
| Next reply update | 00:46:07.688 | Remaining body text |
| Reply becomes complete | 00:46:08.264 | Host terminal update |

The **12.287-second** tool-result-to-public-text interval occurs before the
worker receives public text. Once received, its first Host body update follows
in **68 ms**. The native transcript independently places the follow-up API
request and completed text block around the same interval. This identifies an
upstream native-model/CLI wait as the dominant observed boundary, rather than
a twelve-second client-rendering or Host-publication hold.

This is not a measurement of pure model inference time. Historical raw network
chunks and stdout-read timestamps were not retained; provider/network waiting,
generation and native CLI buffering cannot be fully separated retrospectively.
The follow-up below narrows the interval to an observed thinking-stream block,
without treating its elapsed time as pure inference time. The transcript's
completed-block timestamp is not a first-token timestamp. Host
event timestamps also do not establish socket receipt or physical screen paint.

The screenshot's `1m 10s` counts elapsed turn time, not time since file delivery.
It is consistent with the gap above; it does not prove a later display stall.
An adjacent file-then-reply turn in the same conversation had about 5.48 seconds
between attachment publication and first text. These are individual observations,
not a latency distribution or evidence that all deliveries behave identically.

## Follow-up: the native thinking-stream interval

A second investigation with Opus 5.5, based on source `4d226d6a`, verified how to interpret a retained
field, **`thinkingDurationMs: 10499`**. The initial investigation recorded it but
withdrew the inferred timing split because the field definition was unverified.
The relevant native request, thinking record and text record all identify Claude
Code **2.1.311**. The current native executable has the same reported version;
its modification time predates the incident and its SHA-256 is
`85d8c08707fcfd1e78ffa0204eefbc6ec9e4fe22f375fb2767ef85d957ed3161`.
The incident transcript has no executable hash, so identical historical bytes
are inferred from version/mtime, not established by a retained incident hash.

The current 2.1.311 implementation starts a monotonic timer when it processes a
thinking `content_block_start`, and computes the elapsed interval when processing
that block's `content_block_stop`. The completed block's wall-clock timestamp is
created in the same stop handler. This measures **the thinking stream block's
lifetime as observed by the CLI**. It includes possible service generation,
service buffering, transport gaps and CLI scheduling delays; it is not a server
compute timer.

| Additional observation | Value | Limit |
| --- | --- | --- |
| Request metadata → thinking-block completion | 12.140 s | Request metadata is not a socket-write timestamp. |
| CLI-reported thinking-block lifetime | **10.499 s** | Does not split computation from delivery or scheduling. |
| Approximate remainder before thinking-block start | 1.641 s | Derived from the two values above; not measured TTFT. |
| Thinking completion → worker's first public text | **56 ms** | Native record and worker timeline, not physical paint. |
| Thinking completion → completed text-block record | 81 ms | Does not establish when the server generated the text or when each raw delta arrived. |
| Per-request input context, counted once | **923,539 tokens** | 923,263 cache reads, 274 cache-creation input tokens and 2 uncached input tokens. |
| Per-request output usage, counted once | 1,067 tokens, including **249 thinking tokens** | Repeated usage on thinking/text records is the same request total. |
| Effort / thinking display | `xhigh` / `updates` | Recorded effort and CLI-selected default display path, respectively; the production Bot was not reconfigured. |

The native thinking record contains no visible thinking text, despite reporting
thinking-token usage. This explains why absence of visible thinking text cannot
be interpreted as absence of model activity. The large context and `xhigh` are
confirmed conditions, **not proven causes** of the delay. Another request in the
same turn is an observation, not a controlled context/effort comparison. We do
not extrapolate its token rate to infer when this request's answer was generated.
Clearing personal App history preserves the native session and therefore does
not reduce this model context.

The recorded stop hook took 344 ms after the first public text had arrived. It
cannot account for the earlier twelve-second wait.

### Native CLI calibration, without a real model

Five bounded loopback fixtures ran the actual current 2.1.311 executable with
stream-json and partial messages. Each used a fresh temporary config, fake API
key, no tools/session persistence, and a child sandbox permitting only loopback
connections. They did not run a model, resume the user's session, change Bot
settings or exercise the production Host.

- Early text followed by late stream completion, delayed first event, and thinking
  followed by text all forwarded the first text before `message_stop`; mock-server
  text-event write → CLI stdout was **8.2 / 22.7 / 8.6 ms**, respectively.
- A fourth case sent response headers and a ping, then delayed `message_start`
  by one second. The CLI's debug “first chunk” appeared only at `message_start`.
  Its “first byte” label measures the first non-ping parsed event, not raw network
  TTFB. Text forwarding in this case was 3.8 ms.
- A fifth case sent an empty thinking block and delayed its close by about 1.3 s.
  The CLI still reported **`thinking_duration_ms: 1293`**, confirming that waiting
  inside the stream counts toward this metric without any thinking text or real
  inference. Text forwarding was 7.0 ms.

These are individual protocol calibrations, not a latency distribution or a
replay of the incident. They demonstrate that this CLI path can forward partial
text before completion. The minimal `--bare` profile, small synthetic context and
loopback HTTP do not reproduce production plugins/hooks, a large-context model,
HTTPS/proxies, or the server's `updates` delivery behavior. They do not exclude
an intermittent CLI scheduling/socket-read stall in the original incident.

### Six bounded real requests: display mode and effort

After the historical audit and local calibrations, six real API requests used
**independent nonpersistent CLI sessions**. A pre-run native auth-status check
reported `claude.ai` / `firstParty`; endpoint and proxy routing were not captured
per request. They used the same synthetic prompt: explain a fictional tool result
with 100 records and produce an approximately 700-character Chinese summary.
No real file was delivered, no tool was available, and no existing user session
was resumed. `--safe-mode`, an empty strict MCP configuration and `--no-chrome`
limited the profile. The scripts retained only event types, times, lengths,
counts and usage; no generated prose, reasoning text or credentials were saved.

The first four requests used `claude-opus-5-5[1m]` / `xhigh` in
**default → summarized → summarized → default** order. Two subsequent controls
kept default display and changed only the process's effort flag to `medium`.
The actual stdout display field confirmed `updates` versus `summarized`.
The effort controls were not alternated with the `xhigh` requests.

| Effort / display | Samples | Native thinking-block interval | `message_start` → first text | First → last public text delta |
| --- | --- | --- | --- | --- |
| `xhigh` / default `updates` | 2 | 10.918 / 19.536 s | 10.923 / 19.542 s | 6.890 / 5.531 s |
| `xhigh` / `summarized` | 2 | 13.309 / 15.727 s | 13.315 / 15.737 s | 2.952 / 2.639 s |
| `medium` / default `updates` | 2 | 0.339 / 0.373 s | 0.358 / 0.379 s | 10.249 / 9.921 s |

These stage timings are not click-to-first-text or complete-reply timings. Native
TTFT was 1.334–2.164 s across the six requests. Input context was only 745–748
tokens, so a 923,539-token history is **not necessary** for a long pre-text wait.
It may still contribute to the original incident; no context-size control was run.

The two `xhigh`/default streams emitted 10 and 13 estimated-token-only thinking
deltas. Their largest thinking-block event gaps were 1.229 and 1.942 s, showing
continued CLI stream activity during those waits. Public text then arrived in
139 and 109 deltas over several seconds. Thus default `updates` does not
necessarily hold all public text until a single final burst. `summarized` did
not reliably shorten the thinking interval in this small comparison. The
original pair of completed-block timestamps only 81 ms apart was not reproduced.

The `medium` controls produced 42/54 thinking tokens, compared with 961/1,833 in
the `xhigh`/default requests, and substantially shortened the observed wait before
public text for this synthetic task. This is evidence that effort is a practical
latency factor. It is **not** proof that effort alone caused the original incident,
a guarantee for large sessions, or a quality-equivalence result. Outputs differed
in length (787–994 characters across all six), service variability remains, and
there were only two observations per condition. Longer medium text emission also
shows why a faster first text must not be reported as an equal improvement in
complete-reply time. The production Bot remains configured as before.

### Missing evidence is now specific

Code inspection identified `ttft_ms` on `message_start` and thinking progress
containing `estimated_tokens` without thinking text. The fresh real probes above
then captured both fields in actual stdout; the earlier five loopback fixtures
did not collect them. TaroBot's current
partial-event reader accepts textual thinking deltas but does not retain those
request-start/progress timing fields in its diagnostic timeline. The incident
records do **not** establish whether such progress events actually arrived during
the gap.

No relevant local debug, telemetry or event-loop-stall record survived for the
incident window. This is absence of retained evidence, not proof that no retry,
network gap or event-loop stall occurred. The first investigation's generic
“upstream wait” is therefore narrowed to a **10.499-second thinking-stream
interval**, while its internal cause remains unresolved.

The next useful capture is a bounded, content-free per-request summary of
message-start/CLI TTFT, block start/stop, progress counts and maximum gaps,
first text arrival, and any correlated CLI event-loop stall. Routine full debug
logging is not an appropriate substitute: it can retain unrelated content and
paths, and its streaming-stall warning threshold does not catch this ten-second
interval. A future large-context reproduction would need those stage records in the same
request. The small-context controls above cannot reconstruct the missing original
stream or replace native Mac/physical-phone acceptance.

## Source review and disposition

The native file tool publishes its caption and file as one message, then returns
a receipt. Claude can make another model request afterward to compose its final
explanation. File publication is not a turn-completion signal. The active reply
correctly remains live while that request is pending, though its generic running
label does not explain this intermediate state.

The Claude adapter already enables partial messages and forwards text deltas;
it does not wait for the final result before forwarding ordinary foreground text.
The first text's timeline record has no `suppressedBy` marker and that text
reaches the Host normally. The shared native card
controller retains bounded aggregation; the actual 68 ms worker-to-Host interval
does not support attributing this incident to the prior streaming optimization.
The earlier [outgoing-message investigation](send-latency-investigation-2026-10-28.md)
identified separate shared-queue scans. Those source repairs remain uninstalled
and must not be represented as active fixes for this screenshot.

The existing delivery tool can already send a concise conclusion in its caption;
the screenshot's caption did so. An additional caption instruction was considered
and tested, then removed after independent review because it would not address
the observed wait. No production behavior is changed by this report.

The native request can remain active after file delivery, so neither marking the
whole turn complete nor holding the ready file until final text is an appropriate
repair. The follow-up supplies small-context effort controls, but does not
establish the right default for the user's large production session or justify
a synthetic typing cadence. The generic running label could be clarified
in a separate, tested lifecycle change, but that would improve status clarity,
not native model latency.

Further attribution needs timestamps at the native API/CLI boundary: request
start, incoming stream events and stdout emission, without recording content or
credentials. Completed transcript blocks now establish the thinking-block
interval above, but cannot recover the missing within-stream and socket history.
The initial investigation performed no fresh real-model probe. The follow-up
real probes are explicitly scoped above; no network interception or production
instrumentation was performed. The original within-stream delay remains
partially attributed, without a deployed latency fix.

## Codex follow-up: the same ordering

The new screenshot is a Codex foreground run. It shows a completed reply card
above a separate document-delivery message. The ordering is established from
retained Host events and the native Codex transcript, not inferred from the
static screenshot or the card's total elapsed-time label.

The incident occurred at **12:12**, while **App 1.0.117 / Host 0.1.462**, source
`5950ea656c74150498f41b44dc52f613d5c68fb8`, was still installed. The later 1.0.118
installation started at 12:38:39 and reconnected at 12:40:36. The retained prior
App's version and relevant 5950ea65 code paths were checked. Current main
`cdedc916` has the same file-tool, Gateway publication, Codex delta adapter,
card-reducer and prose-selector code; its subsequent scoped-card layout changes
do not establish what the incident's physical screen displayed.

All times below are local UTC+08:00 on October 28. No business text, document
names, native session IDs or private reasoning are included.

| Stage | Time | Boundary |
| --- | --- | --- |
| Pre-delivery commentary block recorded | 12:12:16.250 | Native completed-block record; this is not the later final reply. |
| File tool invocation recorded | 12:12:23.954 | Native tool-call record. |
| Caption and file published together | **12:12:24.103** | One Host `message.created`, containing 63 caption characters and the attachment. |
| Delivery receipt recorded in Codex | 12:12:24.182 | Native tool-output record identifying the delivered message. |
| First final-reply delta reaches the card reducer | **12:12:27.414** | The final text entry's `at` in the retained run journal. |
| First final-reply text published | **12:12:27.452** | The final prose element contains 3 characters while the run is still streaming. |
| Full visible final reply published | **12:12:30.652** | The same element has all 106 characters, still streaming. |
| Native final-answer block recorded | 12:12:31.959 | Completed-block timestamp, not the first-token timestamp. |
| Reply becomes complete | **12:12:32.159** | Host terminal update; the 106-character final reply is retained. |

Thus file publication preceded the first final-reply text by **3.349 s**, the
full visible final reply by **6.549 s**, and the terminal update by **8.056 s**.
Sixteen pre-terminal Host updates contain successively longer prefixes of the
same final reply. They prove that the Host did not hold this final text until
completion. Earlier commentary is a separate prose element and must not be
mistaken for either missing final text or already-complete final text.

The native completed final block contains 324 characters including Codex
memory-citation markup. Removing that non-body block gives exactly the Host's
106-character final reply. The retained raw-delta journal text already lacks
the citation markup; its omission is not evidence of lost reply prose. The
records do not establish exactly where the markup was withheld or how much
time its generation took. Token-level Codex
`assistant_text` deltas are deliberately omitted from the diagnostic timeline;
their absence there is not evidence that the adapter received no deltas. This
case does **not** provide a historical app-server/adapter-first-delta timestamp.
However, Opus identified a retained timestamp at the **reply-card reducer**:
`recordRunEvent` gives a new text entry `at: Date.now()` and retains that `at`
when subsequent deltas extend it. Independent read-back confirms the final
text entry starts at 12:12:27.414, immediately after the file-tool entry.

### Shared mechanism and limits

1. `src/gateway/app-tools.ts` awaits `channel.sendArtifact`, then returns the
   durable delivery receipt. `src/gateway/channel.ts` uploads the bytes and
   publishes the caption and file blocks in **one** message before returning.
2. The final reply is a different message, updated by the native engine stream.
   The Codex adapter forwards `item/agentMessage/delta` as `assistant_text`;
   the card reducer appends it, and `RunPresentation` renders `runProse` without
   waiting for the run to become `done`. These paths also exist in 5950ea65.
3. Both observed turns followed **send file → receive tool result → write final
   summary**. That is a shared App-tool workflow, not a Claude-only behavior.
   It is not inevitable for every file response: an assistant can write public
   commentary first, and the file's own caption is already delivered atomically
   with the attachment. This Codex case contains both.

The 3.349-second interval splits into **79 ms** from file publication to the
native recorded receipt, **3.232 s** from that receipt to the worker's reply-card
reducer receiving the first final delta, and **38 ms** from that reducer to the
first Host publication. The 3.232-second part includes the upstream continuation
and forwarding into the reducer. Retained records do not split provider
generation, network, Codex scheduling and the in-process adapter path; it must
not be labeled pure inference or pure network delay. No incident socket receipt
or physical screen-paint trace exists. The prior isolated WebKit result below
remains separate evidence and was not rerun or presented as a replay of this case.

The product experience still separates an already usable deliverable from a
later summary and terminal state. A useful future UI change would distinguish
**file delivered** from **turn complete**, without claiming that generation has
finished. That would clarify the wait, not remove it. Adding another caption
instruction would not fix this example, which already includes a usable caption;
neither delaying a ready file nor prematurely completing the turn is justified.
No production behavior, default effort or installed runtime was changed in this
follow-up, and no fresh real-model request was run for comparison.

Local content-free evidence is retained in
`/Volumes/gdrive/taro-tmp/codex-artifact-text-20261028/`: the final prose-element
Host timeline, native event metadata, source/version readback and independent
Opus 5.5 review. Opus confirmed the ordering mechanism, incident version and
three publication intervals; its additional reducer timestamp was independently
verified and incorporated above. No causal claim is made from the absence of
recorded reasoning or from the timing of memory-citation markup.
The existing `gateway-app-tools` and `run-presentation` suites
passed **46 tests** on current main. These are synthetic delivery/presentation
regressions, not a replay of the incident or physical-screen timing.
This follow-up explains cross-engine ordering; it does not claim
that every reported display delay has been fixed.

CLI impact: this is a documentation-only investigation. No CLI command, Host
runtime, transport, protocol, storage, receipt or App rendering behavior changes.
No new package or installation is required for the report.

## Validation and evidence

The following adapter/build/browser results belong to the initial investigation,
not reruns in the follow-up. The follow-up validated five loopback native cases
and six independent real requests as detailed above; it changed no product code.

- Installed-source Claude adapter: the existing partial-text-before-completion
  and structured tool/text/result tests both passed using fake processes.
- The discarded guidance candidate passed 27 existing contract/tool/instruction
  tests and the Host build (456 modules). These results validate that candidate's
  compatibility, not a latency repair; its two instruction changes were reverted.
- An isolated WebKit desktop fixture used the installed Node and installed
  `client/dist` assets with source `5950ea65`, a temporary database and a fake
  engine. All **40 markers** arrived with correct terminal state: body event-to-DOM
  p50/p95/max **131/211/221 ms**; public process-summary p95/max **414/462 ms**.
  This is a single local observation, not incident replay, provider timing or
  native/physical-device acceptance. WebKit did not expose Long Tasks metrics;
  no zero-long-task claim is made. Headless frame cadence is not screen paint.
  The first attempt pointed at the assets' parent directory and received HTTP
  `not_found`, then timed out. Its failed log is retained; the corrected `dist`
  path passed without changing the test timeout or assertions.

Local evidence is under `artifact-text-latency-20261028/` on the external disk:
`target-events.json`, `target-worker-timeline.json`, `nearby-comparison.json`,
`opus-report.md`, adapter/guidance test logs and the final investigation receipt.
Production SQLite reads used read-only mode plus `PRAGMA query_only=ON` and a
bounded conversation/time range. Only sanitized conclusions enter the repository.

Follow-up evidence is under `/Volumes/gdrive/taro-tmp/artifact-text-followup-20261028/`:
`root-incident-metrics.json`, `native-window-redacted.jsonl`,
`turn-request-metrics.jsonl`, `native-stream-verification.json`,
`native-first-chunk-verification.json`, `native-thinking-timer-verification.json`,
the corresponding isolated scripts, native timer-definition evidence, and
`opus-upstream-findings.md` / `opus-final-review.md`. The subsequent real
controls are in `probe-real-display.mjs`, `probe-real-effort.mjs`,
`real-display-probe.json`, `real-effort-probe.json`, `real-comparison-summary.json`
and `opus-real-probe-review.md`. Only sanitized conclusions
are published. This follow-up remains documentation-only; no latency repair,
installation, persistent model-setting change or physical-device acceptance is claimed.

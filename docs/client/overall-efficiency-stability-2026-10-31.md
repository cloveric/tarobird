# Overall efficiency and stability follow-up (2026-10-31)

The owner clarified that this review concerns the whole TaroBot after the recent
revisions, not only Design. Source baseline: `43c841506a4e6a745c522035db9d3bd5a5d38dd8`;
the change inventory starts at released `2aee119c15deec1917113ccff16db048a4d6bb65`.
This is source-only work: no release, installed App replacement, production Host
restart, real-model request, system-screen capture, OS-level remote input or
system-permission change.

GG1 covers client synchronization, streaming, shared binary decoding, rendering,
avatars, persistence and surface lifecycle. Claude Opus 5.5 independently reviews
Host/Gateway/CLI and desktop lifecycle. Findings and file ownership are exchanged
before edits. The earlier broad audit and Design conversation-isolation audit
remain separate evidence; their test totals are not counted as new runs here.

## Confirmed fixes

### Shared large-payload decoding

Browser paths used `Uint8Array.from(atob(data), callback)`, paying an iterator and
callback cost for every byte. The shared decoder now allocates once and fills the
array with a loop. It retains native `atob` validation, including padding,
whitespace, invalid-input rejection and exact byte values. Existing size bounds,
fragment hashes, file hashes, revision checks and access checks remain in place.

Consumers include fragmented App transport, incoming native shares, desktop and
browser screenshots, whiteboard image import and Design files/editor messages.
The Node fragment receiver's injected Buffer decoder is unchanged. No new CLI
command is needed; existing shared protocol and standalone Host build still apply.

Isolated actual-helper browser benchmark, seven samples per size, 4 MiB:

| Engine | Previous median | Candidate median |
| --- | ---: | ---: |
| Chromium | 122.1 ms | 6.1 ms |
| WebKit | 25 ms | 8 ms |

All decoded bytes matched. This is decode time, not end-to-end transfer or App
speed. Small/cold samples were variable: WebKit's 160 KiB median was 4 ms before
and 7 ms after, so the result does not establish improvement at every size.
Node's `applyDesignFiles` validation with a retained 4 MiB asset fell from about
159–175 ms to 21–24 ms; that measurement excludes IndexedDB and rendering.

### A late refresh could roll a live Design revision backwards

A public refresh started outside the mutation queue. If its old read completed
after a save, the live session showed revision zero while storage already held
revision one. The negative test reproduced that mismatch; it did not establish
that persisted content was lost.

Refresh now shares the same per-session queue as edits. Operations already inside
the queue call an internal refresh to avoid recursive waiting. A failed refresh
does not poison subsequent saves. Content, revisions and conflict rules are
unchanged; the fix controls ordering.

### Cancelled commands and closed brokers cannot resume into dispatch

A cancel could arrive while the command was still authenticating or resolving
its target, before the pending-command record existed. The cancel was then lost.
The first candidate remembered only a bounded, expiring cancel marker. Root's
four independent tests showed that a slow live request could still execute after
that marker expired or was evicted. That candidate was not accepted.

A received request now owns its cancellation state until it settles. Cancel keys
still include user, conversation, source turn and request ID. The received-request
count is bounded at 32 per user and 128 overall, including duplicate IDs; otherwise
requests held before authentication could bypass the existing flight limits.
Every settled or rejected request releases its slot. Closing immediately drops
the broker's intake records and counters; a later completion cannot decrement
them again or dispatch. This does not forcibly resolve arbitrary validation
promises.

Closing the broker is terminal. New/late window registration is rejected, and a
command that resumes from target resolution cannot dispatch. An App window that
vanishes during resolution now receives a clean refusal instead of a TypeError.
Commands settled before dispatch still record their definite outcome, so retrying
the same ID does not become an unnecessary `previous_outcome_unknown`.

Root's final independent checks cover eight real signed-socket cancel timings,
24 concurrent commands (eight accepted, sixteen clean capacity refusals),
controlled held requests, and a registration returning after close. These use
isolated real Hub/HubStore instances and test peers, not production devices.

### Distinguish refusal from an uncertain write

The Gateway now labels the Host's pre-dispatch capacity/target/capability
refusals `not_executed`. Capacity advice refers to the Host command limit and
keeps the original request ID and arguments for retry. Missing targets must not
be silently replaced with another conversation/window.

Transport failure, turn expiry, Bot disconnect and request-ID conflict stay
conservative when an operation may already have executed. Only the four explicit
read-only operations may obtain fresh content with a new ID and the same exact
target, subject to the current turn and permissions. A write retains its original
identity for reconciliation.

### Browser history no longer keeps every visited conversation loaded

The shared desktop store kept up to 500 entries for every visited conversation in
memory until the whole store was destroyed. A churn control verified this was
retention by the store, not just delayed garbage collection. Reusing the same
scopes stayed level; visiting more distinct scopes continued growing.

The store now unloads saved idle history lists beyond the 16 most recently used.
Small scope/ticket records stay valid, so an already open page can still record a
visit or update a title after a list is reloaded. Operations, loading, unsaved
changes and pending writes prevent unloading. Clear/reset still invalidates old
tickets. No history file is deleted by cache recovery; in-memory-only stores keep
their only copy.

Under synthetic maximum-length URL/title data, 300 scopes with 500 entries each
retained about 351.1 MiB before and 18.6 MiB after; after another 300 scopes,
701.9 MiB versus 19.2 MiB. Fresh-store reload verified all 600 scopes. A more
ordinary 50-scope fixture retained about 10 MiB before and 3.4 MiB after. These
are isolated JS heap differences, not total installed-App memory savings.

Reloading has an I/O cost: the maximum-size 300-scope churn took about 3.65 s
before and 4.04 s after, while initial fill was 2.71 s versus 2.85 s. The change
bounds idle memory rather than claiming all history operations are faster.

### Clarify read replay without weakening write idempotency

The shared App/CLI Design guide now explicitly says that a repeated read's
durable receipt may omit its body. Missing `result` is not an empty file. A fresh
read of the exact target uses a new request ID; an uncertain create/publish still
keeps the original ID and arguments. This clarifies recovery without deleting
write receipts or silently repeating a mutation.

## Whole-App observations

- **Message delivery and reconnect:** tested queued sends, refresh recovery,
  independent conversation synchronization, foreground recovery, route changes
  and Workbench reconnect. Cross-window outbox reads must not be skipped just
  because this window last saw an empty queue.
- **Directory and avatars:** a 202-conversation desktop/phone fixture with 20
  background updates did not repeatedly write the native title or badge. The
  phone's hidden list stayed frozen. Avatar URL and computed-face caches have
  explicit lifetime/capacity handling; animation was not disabled to obtain a
  performance result.
- **Reconnect query volume:** the fixture performed 204 outbox reads. Count alone
  does not prove meaningful latency. The metric now also records cumulative IDB
  query time: 41 ms on desktop and 78 ms at phone width, summed over all 204
  calls. These are asynchronous waits across reconnect, not one main-thread
  block. There is no speculative empty-queue cache or delayed-send change.
- **Large streamed answers:** the 5,000-line answer exercises ten tables, ten
  equations, text integrity, node retention and editing a draft during streaming.
  The baseline's draft input took 25 ms and recorded no long tasks, but its frame
  p95 was about 133 ms and failed the existing 35 ms gate. An independent visible
  `about:blank` Chromium page also measured about 133 ms p95. This is evidence of
  an environment scheduling limitation, not proof that native App rendering is
  smooth. The threshold is unchanged; complete content checks now run before it
  so a frame failure does not hide data-integrity results.
  The first runs overlapped some of Opus's isolated probes. After those probes
  finished, a further blank-page control still measured 133.4 ms p95; the answer
  measured 133.4 ms, 34 ms draft input and zero recorded long tasks. It again
  passed content checks and failed the unchanged frame gate. Other work on the
  owner's Mac was not stopped, so this is not a dedicated-machine benchmark.
- **Persistence and targeting:** share recipients remain pinned through retry,
  drafts survive failures, stale results after changing chats/Hosts are discarded,
  and separate Design conversations retain separate files and revisions.
- **Multiple surfaces:** 2/3/4 real Excalidraw editors with image mixtures retained
  their saved scenes and images across close/reopen. Closing the Workbench left
  zero editor canvases and zero held whiteboard locks. Post-GC JS heap was about
  12.8 MB with chat only, 19.9 MB with four boards and 18.7 MB after closing. Lazy
  modules and cached documents remain; this is not proof that all memory returns
  to baseline or a measurement of total Electron RSS/GPU use. Input-frame timing
  was similarly slow in chat-only and board phases, consistent with the blank
  frame control; no physical-device latency claim follows.

Opus's isolated signed-socket Host probes add these measurements (test App/Bot
peers, local network, no model, not end-to-end device latency):

| Shared path | Observation |
| --- | --- |
| 300 chat rounds, send to Host ACK | p50 3.85 ms, p95 4.8 ms |
| Chat round trip under ~420 Workbench requests/second | p95 13.07 ms vs 5.14 ms control |
| 200 conversations × 20 messages, cursors already current | 34 ms / 49 KiB with actual App capabilities |
| Fresh synchronization of those 4,000 messages | 396 ms / about 2.8 MiB |
| Bot reconnect with 50 pending conversations | All 50 redelivered in 22 ms |
| Isolated Hub restart with 30 pending deliveries | After restarting the test Hub, all 30 redelivered once within 14 ms of Bot reconnect; Gateway deduplication excluded |
| 60 reconnect cycles plus 3,000 chat rounds and 1,200 Design reads | Client/window/pending/flight/RPC counts returned to zero; post-warmup Hub JS heap roughly 34 MiB |

The first soak probe retained its own peers and frames, producing a misleading
growth result. Opus removed those probe references and reran reconnect-only,
chat-only and combined controls. Only the corrected runs support the table.
The bounded run does not rule out all long-duration leaks.

## Deliberate limits retained

- Cancellation before the command has entered the broker still uses a bounded
  early-arrival cache (one command timeout, 64 markers per user, 1,024 globally).
  This covers the measured normal socket race; it is not an unlimited guarantee
  if actor construction is delayed beyond that window or the cache is flooded.
  Other users cannot change a live request's cancellation state, but enough users
  can evict an unmatched early marker at the global bound. No claim that such a
  delay is impossible is made. Eliminating that earlier window would require a
  separately verified server-intake change; `server.ts` is unchanged here.
- Workbench's durable command/context history has a global 32 MiB / 20,000-entry
  safety budget with 4 KiB reservations per command. The isolated fill reached
  the byte bound after 8,191 reads plus context; other Workbench commands then
  returned `not_executed / workbench_history_limit`. Ordinary chat delivery and local editing remain separate, but new frozen
  Workbench contexts share this budget and can also be omitted; the Bot then
  receives `workbench_context_unavailable`. Eligible read/completed-turn records retire after a day;
  retryable failed turns and local mutations retain deduplication. This remains a
  high-volume usability limit. Arbitrarily deleting mutation receipts after a
  TTL would let an old request execute again, so this audit does not do that or
  claim to remove the limit. Per-actor budgets/compact durable tombstones require
  a separately verified retention contract.
- A disconnected Bot or expired command may have an uncertain write outcome.
  This audit does not relabel an authenticated but stale result as success or
  replay the mutation with a new ID. Stopping the CLI process does not send a Workbench cancel, including while
  the App still awaits admission. It cannot retract that command; reconcile its
  original request ID.
- Repeated actor checks measured only a few milliseconds here. They are not
  removed to improve a microbenchmark at the expense of current permissions.
- The Design guide adds context to the browser/widget capability response.
  Splitting capability topics is a possible future token-cost improvement, not
  an observed latency regression or a reason to change persisted tool schemas
  during this correctness pass.

## Evidence and limits

Evidence lives under
`/Volumes/gdrive/taro-tmp.noindex/overall-efficiency-stability-20261031/`, with the
initial narrower probes retained under
`/Volumes/gdrive/taro-tmp.noindex/design-efficiency-stability-20261031/`.
Current root validation (overlapping suites are not added into one total):

| Boundary | Result |
| --- | --- |
| Shared protocol/client/queue/reconnect focused logic | 18 files, 209 passed |
| Root final shared protocol/Host/Gateway/CLI regression | 14 files, 234 passed |
| Additional window/persistence/reset and refresh-recovery checks | 7 files, 126 passed; includes repeat Base64/Design cases |
| Desktop lifecycle, browser, screen, updater unit regression | 155 passed; native dependencies are doubles |
| Streaming/directory/outbox/reconnect Chromium baseline | 22 passed, 1 frame-time gate failed |
| Affected share/screenshot/Design + long-answer Chromium | 41 passed, 1 frame-time gate failed; complete content checks passed |
| Timed directory reconnect follow-up | 2 passed |
| Targeted WebKit decoding/Design paths | 6 passed; 1 CDP-only whiteboard case skipped |
| Same whiteboard case run on Chromium | 1 passed |
| Actual isolated Electron Design lifecycle smoke | 15 checks passed |
| Post-cache full Electron unit suite | 284 passed; native dependencies are doubles |
| Actual isolated Electron browser page tools | 9 checks passed, including persisted history after relaunch and clear/reset |
| Host/standalone CLI and client builds | Passed |

The repository-wide root `tsc --noEmit` check is not green. A complete archive
of the unchanged baseline with the same dependencies reproduces the same 154
diagnostics as the final candidate (paths and line positions normalized).
This includes older test typing/configuration issues; it is not counted as a pass
or inferred solely from an incomplete archive. The client
production build has its own typecheck and passed.

GitHub checks for the implementation commit did not start: the source,
desktop-native and gitleaks jobs failed at scheduling because the account's
payment/spending limit blocked Actions. This is infrastructure evidence, not a
remote test pass. The check annotation was freshly read after pushing.

The actual Electron smoke used a separate profile and the production CSP/preload,
with the upstream editor, local uploaded image, manual/Bot edits, save/reload,
resize, retirement, close protection, failed-save recovery and canceling quit.
It never launched or changed the installed App or production Host.

Browser fixtures use real App code, Hub and local browser storage with isolated
test peers. Native bridge doubles are not physical iPhone/Android/Windows or
installed Electron acceptance. No claim is made that all possible bugs are absent
or that an unmeasured network/model wait has been optimized.

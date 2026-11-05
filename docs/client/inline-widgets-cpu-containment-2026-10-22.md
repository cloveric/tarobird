# Data reports and terminable widget scripts

Follow-up to the [three-day audit](../audits/2026-10-22-three-day-joint-review.md)
and [measured iframe limitation](inline-widgets-performance-2026-10-22.md).
The previous iframe sandbox restricted permissions but could let generated
JavaScript block the chat UI. This implementation removes authored JavaScript
from the rendering thread.

## Two publication formats

Policy updated 2026-10-31: use HTML by default. Structured reports are retained
for explicit user requests and old-message compatibility; their renderer and
validation remain supported. The format descriptions below are capabilities,
not a recommendation to choose report for ordinary charts.

The shared `app_show_widget`, `send.widget` and Host API accept exactly one of
`html` and `report`, alongside `title` and a readable `summary`.

- **Data report:** App-owned React/SVG components render bar/line charts, tables,
  timelines, computed metrics, filtering and record selection. No generated
  script, iframe or Worker is involved. The same DOM remains mounted during
  expansion, retaining filters and selection. Reload/unmount may reset local
  selection; source data remains in history.
- **Custom HTML:** a trusted renderer sanitizes static content and DOM updates.
  Authored scripts execute in an opaque-origin dedicated Web Worker with a
  LinkeDOM virtual DOM. Captured private transport sends bounded JSON strings;
  the renderer never inserts authored scripts or event-handler attributes into
  the real DOM. A blocked Worker is terminated from outside its thread.

Report data is strict version 1 JSON: up to 12 columns, 200 rows (60 with a chart),
4 numeric series and 4 metrics, at most 64 KiB serialized. Strings are text, not
HTML. Numeric values must be finite and within ±1e12. Column references are
validated. Null represents missing data: sum, average, minimum and maximum ignore
it, while count reports the number of displayed rows (as already published
reports compute it).
Metrics recalculate from the displayed, filtered rows. Use tools to aggregate
larger datasets and deliver full records separately when requested.

```sh
tarobot widgets publish CONVERSATION \
  --report-file report.json --title 'Weekly delivery' \
  --summary 'Six items completed; Tuesday contributed four.' --request-id UNIQUE_ID
```

```json
{"version":1,"columns":["Day","Items"],"rows":[["Mon",2],["Tue",4]],"chart":{"kind":"bar","category":0,"values":[1],"unit":"items"},"metrics":[{"label":"Total","column":1,"operation":"sum","unit":"items"}],"source":"User-provided figures"}
```

`--html-file` remains available and cannot be combined with `--report-file`.
Both use the same Host validation, conversation authorization, idempotency and
publication setting. CLI publication remains a user-authored message and does
not silently start a Bot turn. Viewer pause/retry is local App presentation,
so it has no separate Host CLI mutation.

## Compatibility and instructions

New enabled native sessions receive tool contract v5; persisted v1–v4 contracts
remain byte-for-byte stable. Their on-demand procedure can publish data reports
through the existing compatibility directive. Disabled new sessions retain v3;
stale native calls and compatibility publication still obey the Host switch.

Cards retain the v1 widget envelope and a bounded, escaped, script-free HTML
preview for older clients. The typed `extra.report` survives history and
forwarding. There is no schema migration or renderer code stored in messages.
Old installed clients still use their old HTML execution behavior; new source
alone does not upgrade them.

The short standing native instruction did not grow for this change. The v5 widget tool definition grows from 969 to 1,118 UTF-8 bytes (+149),
advertising the data format; the detailed report schema and
HTML authoring procedure are fetched on demand. Compatibility engines retain
request-sensitive guidance. The report format reduces generated code; it is not
a claim that every model turn becomes faster or cheaper.

Custom scripts support virtual DOM queries/mutations, ordinary events,
SVG/CSS, throttled pointer movement, local filters and asynchronous real-size
`ResizeObserver` callbacks. Basic media queries cover reduced motion, dark mode
and minimum/maximum pixel width; this is not a full CSS media-query parser.
Canvas/WebGL, complete browser DOM APIs, synchronous accurate layout, external
libraries/resources, storage, networking and native App APIs are unsupported.
Use the fixed format or SVG/CSS for those reports. There is no fallback that
re-enables authored JavaScript on the UI thread. Older Canvas-based reports
may need regeneration; their saved text summary remains readable. An independent
OffscreenCanvas/ImageBitmap compatibility prototype was evaluated but not merged:
its per-image limits do not yet provide total canvas/in-flight bitmap budgets or
complete bitmap lifecycle verification. That follow-up needs its own resource
and native acceptance rather than reopening an unbounded transport path.

## Execution and resource bounds

The Worker exchanges heartbeat messages every 250 ms and is terminated after
about two seconds without a response. An unusually late parent timer resets
its observation window rather than misattributing parent scheduling delay to
the Worker. The tested failure classes include initialization loops, click
loops and endless promise microtasks. Removing the frame also ends its Worker.
Each ping carries a fresh random nonce, and the runtime encodes its messages
from own data without `JSON.stringify`/`toJSON`, so guest code that replaces
shared prototypes cannot answer heartbeats while it never yields.

The Worker capability boundary is ECMAScript built-ins, timers, microtasks,
random values and the virtual DOM. Networking, storage, messaging, nested
workers, WebGPU/WebNN (`navigator.gpu`/`navigator.ml`), WebCodecs encoders and
decoders, `ImageDecoder`, font loading and `OffscreenCanvas`/`createImageBitmap`
are removed before authored code runs; CSP and the opaque origin still bound
syntax such as dynamic `import()`. These are presence checks in Chromium and
WebKit, not WKWebView, WebView2 or Android acceptance.

Worker DOM snapshots are limited to 2,048 elements and 128K authored characters
plus up to 32 annotation characters per element; transport
messages to 256K characters, with a total Worker outbound budget of 128 messages
and 2M characters per second. These runtime string caps count JavaScript UTF-16
units (K = 1,024), not UTF-8 bytes. Exceeding either closes that transport and emits one terminal limit
notice, so an infinite focus/scroll loop cannot build an unbounded message queue. Background snapshots are coalesced to at most four per second,
interactive updates to roughly 25 per second; unchanged snapshots are omitted.
Script-free markup and the initial static rendering have no element cap beyond
the 128 KiB publication limit. A scripted document whose first snapshot exceeds
these bounds, or whose scripts cannot run, keeps its static rendering, shows
one warning and is not quarantined; later growth past them remains a limit
stop. Whether the runtime ships is decided from a textual superset of parsed
scripts and non-empty handlers; the viewer's parsed DOM decides what runs.
Only the trusted renderer handles focus/scroll after a recent real user gesture.
Root/body attributes and resize observations are bounded. The relay forwards
only a small reconstructed protocol and coalesces height messages.

Confirmed CPU/error/limit failures record source SHA-256, reason and time in
`tarobot-widget-quarantine-v1` localStorage: up to 64 records, seven-day expiry.
No source code is stored there. History, expansion and reload do not automatically
rerun quarantined source; explicit Reload clears its record, and changed HTML
has a different identity. If storage is unavailable, suppression lasts only in
that window. Records are local to a reader profile, not synchronized Host policy.

The Worker runtime is a lazy client chunk (~293 kB / 102 kB gzip in this build).
Ordinary chat and fixed reports do not evaluate it; the offline service worker
can still pre-cache it. Script-free HTML does not create a Worker. This is a
thread execution boundary, not a separate OS process or hard memory quota:
large allocations, browser defects or pathological CSS can still affect the
renderer. A busy script that yields often enough to answer heartbeats can
continue using CPU; this is a responsiveness watchdog, not a per-Worker CPU quota. No private WebKit process API or blind PID termination is used.

## Validation

Evidence is kept under `/Volumes/gdrive/taro-tmp/tarobot-widget-cpu-20261022`.
The complete local gate passed 426 test files: **5,845 passed, 5 skipped**,
Host build (414 modules), client translation/TypeScript/Vite and 77 native Rust
tests. After follow-up compatibility and message-budget fixes, focused CPU,
flood, virtual-DOM and media tests passed on both Chromium and WebKit. Final
browser freeze passed **44 Chromium tests with 1 skip**. WebKit recorded
**42 passed, 2 skipped and 1 conversation-entry failure**, before the widget
loaded; that entry/history case passed three immediate isolated repeats. The
original failure remains recorded rather than describing the entire run as
green. Ten focused containment/compatibility cases passed on both engines;
the shared CLI/API report publication, replay-after-off and disabled-new-write
contract also passed.

Opus independently reproduced a focus/scroll message flood that could crash
Chromium before the watchdog. The global pre-transport budget addresses this
separate failure from ordinary script loops. Its compatibility corpus also
identified missing pointer movement/media queries and sanitizer removal of IDs
such as `method`; these were repaired and covered by browser regressions.
A follow-up reproduction also caught native timer receiver errors through
`window.setTimeout`; virtual-window timers now bind to their real Worker
receiver, with a browser regression covering the asynchronous update.

Opus then archived and rebuilt the actual `bcffbb9` commit and repeated its
independent corpus and adversarial probes on both engines. Nine supported
examples passed on each engine (timeline, SVG hover/click, resize, sorting,
slider, details, keyboard, inline handlers and media preferences); the Canvas
example failed as explicitly unsupported. Do not report this as 10/10 compatible.
In focus/scroll flood probes, the stopped component stayed retired after reload;
maximum parent timer gaps were 44 ms on Chromium and 34–37 ms on WebKit,
with measured composer fills no slower than 48 ms. These are that isolated
sample's measurements, not device guarantees. Its yielding-CPU probe remained
running, consistent with the documented absence of a hard CPU quota.
The corpus harness catches individual compatibility failures, so a successful
Playwright process alone is not proof that every corpus example passed.

In the Chromium steady-state sample, browser-process CPU over two seconds was
2.54% of one core for ordinary chat, 2.01% for one idle interactive HTML report,
2.77% for six reports and 2.39% for six ordinary panes. Composer fill p95 was
10.0, 5.1, 45.0 and 43.6 ms respectively. These are one-machine short samples
with concurrent verification work, not device guarantees or a regression budget.
Heap samples from the main page exclude Worker heaps; they are not total memory.

An independent Opus public-API macOS WKWebView prototype measured a busy Worker
at 1.00 CPU core and 0.21 ms parent evaluation RTT; after termination its sampled
CPU fell to 0.10 core. This validates the primitive, **not the production Tauri
frame chain**. The production-protocol native probe was blocked by the locked
Mac: its document reported `visibilityState=hidden`, so rAF/timer-dependent
acceptance could not complete. The user confirmed they are away and cannot unlock now. It is retained for
an unlocked rerun; no native pass is inferred from the browser or prototype results.

A real Codex turn (`gpt-6.1-sol`, low effort), with no tool name or chart request,
chose a 644-byte report. It displayed six daily rows, computed total 29 (14/15),
and delivered one durable native receipt. Record selection and expansion were
exercised and the rendered screenshot inspected. Turning generation off produced
no new graphics in both the existing v5 session and a new v3 session, while saved
history remained readable. This is one real-model run, not a universal choice or
latency guarantee.

The source implementation is committed as [`bcffbb9`](https://github.com/cloveric/tarobot/commit/bcffbb9098d2a211f291dc88548673b1f8f02d04).
Both GitHub push workflows were created but their jobs did not start. Their
annotations report failed account payments or a spending limit: [Source
checks](https://github.com/cloveric/tarobot/actions/runs/39724863256) and
[Secret scanning](https://github.com/cloveric/tarobot/actions/runs/39724863133).
The local checks above are separate evidence, not a GitHub CI pass.

No installed App replacement, package release, physical phone, Windows native,
paid transcription or real Tailscale round trip is included. A release still
requires matching version-bumped App/CLI artifacts and the release checklist.

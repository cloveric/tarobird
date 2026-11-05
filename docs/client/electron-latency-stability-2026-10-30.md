# Electron latency and stability: measured follow-up

Codex and actual Opus 5.5 reviewed the migrated desktop at
`3cdb88642a2b8f458838f0e541cbf04d714efe0c`. That revision contains the independently
adjudicated [Kimi migration and recovery fixes](electron-kimi-audit-2026-10-30.md).
This follow-up adopts one measured optimization: Electron upload and save chunks
use the runtime's native typed-array base64 encoder. The compatibility fallback,
body/chunk limits, cancellation checks and document authority remain intact.

Publication and installation remain **held until a new owner request**. The
prepared 1.0.121 artifacts predate these fixes. Neither a source commit nor this
isolated runtime verification updates the installed App.

## Measurements and decisions

The [evidence ledger](electron-latency-stability-2026-10-30.json) retains raw receipt
hashes, scope and source-label corrections. Measurements ran serially without
heavy builds; Opus and Codex used separate measurement windows.

| Three independent runs, five uploads per size per run | Before | After |
|---|---|---|
| 8 MiB upload plus complete echo, each run's median | 195.1 / 183.1 / 174.7 ms | 76.7 / 73.5 / 67.7 ms |
| 64-byte WebSocket echo, each run's p95 | 0.9 / 2.0 / 2.0 ms | 2.9 / 2.1 / 1.9 ms |

This exercises actual sandboxed Electron 45.1.0, preload IPC, main process,
the Rust helper and pinned TLS on loopback. Every returned byte is compared.
It measures one request/echo, not the full multi-chunk attachment workflow or
internet upload speed. The production upload chunk is 8 MiB; save chunks are
1 MiB. Encoding alone for 8 MiB occupied the renderer synchronously for
120–123 ms with the old loop, versus 0.3–0.4 ms with the runtime encoder in the
three baseline rounds. Eliminating that intermediate binary string reduces
work; peak-memory savings have not been quantified.

There is **no claim that ordinary chat became faster**. Its measured small-frame
latency is already low, and it does not use this body encoder. The first cold
health request in baseline run 1 took 905.6 ms; the next two runs began at about
8.4 ms. That outlier is retained, with no assumed cause or claimed fix.

Opus also measured these alternatives independently:

- Coalescing already-ready native HTTP chunks reduced read calls by about 20%,
  but 50 MiB HTTPS median time was 120.7 ms before and 121.1 ms after; HTTP
  changed from 121.7 to 118.7 ms. The small, inconsistent difference does not
  justify adding deferred EOF/error state. The candidate was **not adopted**.
- Existing per-frame WebSocket acknowledgments delivered roughly 45,000 small
  frames/second in a helper/main fixture. Batched ACKs helped artificial small
  bursts, with no corresponding benefit for large frames. The existing
  eight-credit flow control and message ordering were **not changed**.
- Native HTTP sparse-stream, mid-response disconnect, cancellation and retry
  tests preserved byte counts and errors. These exclude renderer IPC; they
  cannot be added to the Electron results as if they measured the same boundary.

Large legacy-profile scans, startup Host gating, multiple maximum-size events
and recovery-snapshot retention remain candidates requiring representative
measurement. No migration validation, trust check or recovery data was removed
to shorten startup. Base64 decoding, mobile/Tauri paths and model settings are
unchanged. The headless CLI does not use this renderer encoder, so no CLI/API
change is required.

## Regression and review

The new `transport-codec.smoke.mjs` uses real Electron and native services. Only
the save-dialog choice is supplied by the harness. It checks native/fallback
byte equivalence, six body forms, offset views, limits before reading/encoding,
abort/error behavior, document-lease rotation, socket reconnection and actual
file hashes/quarantine. Failed encoding must preserve the previous destination
and remove the temporary sibling. A separate fault injection kills only the
verified child helper of the isolated Electron instance, observes its failed
state and confirms a new PID and working upload after explicit recovery.
Rotating a healthy document lease alone is not called helper replacement.
There was no upload in flight during that actual crash; its in-flight POST
behavior is not directly proven by this test.
`installedAppChanged: false` and
`productionHostUsed: false` in its receipt describe the isolated construction;
they are not a separate inspection of the installed App or production service.

Two initial test failures were investigated rather than omitted:

1. The streaming measurement could wait on a pagination button that does not
   exist for a short run. HTTP and DOM evidence already contained the thought
   row. The test now checks whether the optional button exists before reading
   its enabled state. Product rendering was unchanged.
2. Headless Chromium failed the 35 ms frame-p95 gate at 133 ms despite zero
   long tasks and 31 ms draft input. An empty page in the same browser also
   produced 117 ms p95; the ordinary-window control was 33 ms. The unchanged
   5,000-line test passed in an ordinary window: draft input 15 ms, frame p95
   18.6 ms, maximum frame gap 82.3 ms, no long tasks, all 5,000 paragraphs,
   10 tables and 10 equations retained. The threshold was not relaxed.

The shared React streaming test covers a real isolated Hub/Gateway with
synthetic engine events. Two desktop cases passed, including 50 current-run
tools and two background Bots. Body event-to-DOM p95 was 166–212 ms; expanded
thinking p95 was 236–275 ms. These are headless browser observations with the
frame-cadence limitation above, not native compositor paint, physical-device
delivery or model response latency. No timing change is inferred from a single
post-change UI run.

| Executed boundary | Result |
|---|---|
| Base64/upload-limit unit tests | 5 passed; 1 native-only test skipped on Node 24 |
| Focused Electron file/helper/owner/renderer recovery tests | 38 passed |
| Browser native transport and desktop export regressions | 58 passed |
| Real Electron codec, helper crash/recovery and native save | 10 checks passed |
| Real isolated renderer crash and persistent synthetic draft/outbox | 6 checks passed; one stored pending record remained one record |
| Shared UI streaming | 2 passed after fixing the optional-button test race |
| Long-text content/render test | Headed passed; original headless frame gate failed and is retained above |
| Builds | Host and client builds passed |

The renderer crash test uses a synthetic localStorage draft and IndexedDB
outbox fixture, not the entire production conversation/send workflow. Its
storage result is not proof of all real-device message-delivery scenarios.

Opus's final source-and-receipt review found no required fixes within the reviewed
scope. Its documentation suggestion about the real helper crash and the limit
above was incorporated. This does not guarantee that no bugs remain. Final
focused-suite results and review evidence are recorded in the ledger.
Earlier full migration checks are documented separately; their 7,154
passing tests are not represented as a fresh full-suite run for this small
frontend change. Windows physical runtime remains deferred, as the owner
requested. A newly signed installed package and real internet/mobile behavior
still require the next authorized release's acceptance.

## Reproduction

After the repository's usual Node/native environment is configured, from the
repository root:

```sh
node node_modules/vitest/vitest.mjs run client/src/desktop-base64.test.ts
node client/electron/tests/transport-codec.smoke.mjs \
  /path/to/lab.noindex /path/to/electron-cache.noindex \
  /path/to/core.noindex/tarobot-desktop-core \
  /path/to/addon.noindex/tarobot-desktop-native.node
```

The native smoke is macOS-only and explicitly refuses ambiguous helper-process
ownership before injecting a helper failure. It requires a compatible native
addon and helper; it is not an automatic CI test. Node 24 lacks `toBase64`, so
the native-only unit is explicitly skipped there; the real Electron smoke
requires the native implementation and validates it rather than mocking it.

Browser measurements run from `client/` with one worker, serially:

```sh
TAROBOT_STREAMING_PERF=1 node node_modules/@playwright/test/cli.js test \
  e2e/streaming-latency.spec.ts --grep '1360px' --workers=1
node node_modules/@playwright/test/cli.js test e2e/performance.spec.ts --headed --workers=1
```

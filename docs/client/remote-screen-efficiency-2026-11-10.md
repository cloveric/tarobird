# Remote screen responsiveness review — 2026-11-10

Baseline: `1982243c04cd81b65806f39663642f3be004f531`.
This is a source change, with no release, installation, real desktop capture,
permission request or native input. The video protocol, three-frame credit
window, byte budget, encoding profiles and lease checks are unchanged.

## Retain the final pointer position

The panel previously forwarded the first pointer movement in each 32 ms window
and discarded later ones. If the pointer stopped inside that window, no timer
sent the final position. A browser test moving from 20% to 80% of the picture
confirmed that the baseline left the remote hover position at 20%. A button-up
carries its own coordinates, so this is not evidence that every drag drop landed
at the wrong location.

The viewer now owns one 32 ms movement scheduler. It sends the first movement
immediately, retains the latest intermediate position, and sends that position
when the window expires. Buttons and keys remain immediate and flush an earlier
queued movement in order. Local focus loss, hiding, disposal, a new lease or a
new stream generation discards pending movement. Sending rechecks current
control/focus/freshness and uses the current confirmed picture.

The panel passes only client coordinates. Canvas bounds are read when a movement
is actually sent, avoiding a layout measurement for every raw pointer event.
A synthetic burst of 1,000 raw events performs two measurements: first and last.
A one-second virtual-clock stream produces 33 movements including the final
trailing event. The old panel already limited movement to approximately 31 per
second: the improvement is retaining the final position and centralizing queue
ownership, not a claim of reducing ordinary UI traffic from 1,000 messages.

A direct-controller overload probe intentionally bypasses the old panel gate.
The Host still rejects unbounded input; this does not establish that the old
normal UI flooded the Host. No rate limits or authorization checks were relaxed.

## Validation

- The final-hover browser regression fails on the baseline and passes with the
  fix; the baseline probe restores the exact candidate source afterward.
- 122 focused renderer/Host/protocol/network tests pass across 12 files, including
  lease/generation/focus retirement, movement/key/button ordering and concurrent
  movement/scrolling budget. Two Host probes retain rate-limit enforcement.
- 43 Chromium UI cases pass with a synthetic Host and decoder, including the
  three new pointer cases and existing quality, hide/resume, fullscreen,
  connection replacement and text/keyboard behavior.
- 103 Electron screen tests pass. The actual isolated Electron viewer smoke
  decodes and acknowledges 40 synthetic frames, verifies pixels and retained
  copied buffers, and retains two canvas-size assignments and three UI updates.
- Client TypeScript/translations/build and standalone Host build pass.

These tests are not physical Windows/Mac control or off-network latency
acceptance. The synthetic viewer's event-loop samples are not comparative
end-to-end latency measurements. Real input still requires an agreed safe test
window. The CLI has no pointer renderer; its shared screen management commands,
Host authorization and transport contracts remain unchanged.

## Further efficiency candidates

Fable provided bounded read-only guidance. The pointer change received no
blocking finding; the implementer ran its regressions. Its coordinate conversion
uses the canvas bounds at send time: if the viewport moves within the 32 ms
window, the last raw pointer coordinate is interpreted against those new bounds.
No claim is made that coordinates stay anchored to an old viewport during a
simultaneous layout change.

Three video/transport ideas remain separate from this patch:

1. **Encoding cadence:** anchoring each interval to the previous actual send
   time carries arrival/timer delays forward. A schedule-based candidate passes
   a deterministic late-arrival regression and a fast-source/idle-recovery bound.
   It permits a one-time quarter-interval tolerance. This candidate is retained
   outside the repository while its benefit and cadence tradeoff are assessed;
   the production capture core in this patch is unchanged.
2. **Resampling:** slightly different captured/encoded dimensions can trigger a
   canvas resize path every frame. Actual device dimensions and cost must be
   measured before changing resolution or scaling behavior. No new runtime
   diagnostic/logging protocol is introduced in this patch.
3. **Relay small-packet handling:** WAN measurements are needed before changing
   TCP behavior. A local loopback probe showed no material delay; no relay was
   deployed or reconfigured.

Ordinary-Node byte-copy/masking microbenchmarks did not justify replacing the
existing copied MessagePorts. They are not Electron CPU or network benchmarks.
The existing pinned TLS, decoder/display ACK, frame freshness, byte limits and
complete encoded-reference-chain protections remain intact.


### Encoding candidate measurement and decision

The implementer ran three alternating baseline/candidate pairs in isolated
Electron, each with a 60-second steady segment. A hidden generated WebFrame
was captured; real Chromium timers, WebCodecs and copied ports were used, with
10 ms simulated capture credits. No real desktop or OS input was involved.
Instrumentation measured from the raw-frame reader returning to the encoder
call. This includes local preparation/resampling, and excludes remote-network
round trips; it is not end-to-end screen latency.

| Pair | Baseline preparation/wait p95 | Candidate preparation/wait p95 |
| --- | ---: | ---: |
| 1 | 63.9 ms | 48.8 ms |
| 2 | 64.9 ms | 57.6 ms |
| 3 | 64.7 ms | 58.1 ms |

Actual source rates were 14.984–15.001 fps. All six measured steady segments had zero byte starvation and no more than
one outstanding frame. Every run completed without reported decode/capture
errors, and all emitted frames decoded. Source/encoded counts in the steady segment were
899/881 in each baseline and 899/899, 899/898, 899/899 in the candidates. A count
difference can include a held frame at reset, so it is not an exact drop count.

The candidate did **not** meet the predeclared requirement to halve p95 in every
pair. Its measured preparation/wait medians were also inconsistent: 16.9, 23.3,
24.7 ms versus baseline 24.3, 24.5, 24.4 ms. Short smoke samples and virtual-clock
predictions therefore do not justify a general speedup claim. The candidate
and its proposed regressions remain private experiment artifacts; neither is
included in the production patch. Future work should distinguish scheduling
wait from local frame preparation before changing the cadence or resolution.

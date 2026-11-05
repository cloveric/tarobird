# Interactive widget efficiency and stability audit — 2026-10-22

Codex and the independently running CC1 (`claude-opus-5-5[1m]`, effort `xhigh`)
audited model context, host publication, rendering, background work and recovery.
CC1 used frozen source copies for its baseline measurements and was read-only in
the shared repository. The baseline under audit was `a53c8fb`; the pre-feature
comparison was `58a852ea4b0d480a4cb2804c86f2078bbb2a1e38`, the parent of `6e383f9`.

Evidence is under `/Volumes/gdrive/taro-tmp/tarobot-widget-performance-20261022`.
The independent report is `opus/findings.md`; its scripts and measurements are in
`opus/scripts`, `opus/harness` and `opus/evidence`. Measurements use isolated test
Hubs and browsers, never production conversations or stress in the installed App.

## Confirmed issues fixed

| Problem | Reproduction | Result |
| --- | --- | --- |
| Full authoring recipe on unrelated turns | “分析报错”, “比较急” and “Visual Studio Code” appended 4,590 characters, approximately 908 o200k tokens, to persisted model history. | Native tool sessions read `app_capability(topic=widgets)` on demand. Compatibility sessions receive the recipe only for explicit visual/data-comparison requests. Standing proactive guidance and frozen tools are unchanged. |
| Duplicate document serialization | Both shell-ready and iframe load initialized a 120 KB report: two messages, 253,742 document characters. | One initialization, 126,871 characters. The relay's existing idempotency alone did not avoid the parent's serialization/clone cost. |
| Invisible reports continued executing | A phone's hidden conversation accumulated 27 timer ticks in about 500 ms. A 40-report history mounted six outer frames, four offscreen. | Host activity, document visibility and actual viewport intersection gate execution. Hidden reports release both frames; history keeps measured placeholders. The final history probe mounted two visible reports. |
| Unbounded relay traffic | A 500-message height burst forwarded all 500 messages and arbitrary 4 KB extra fields. | The trusted relay reconstructs bounded protocol fields, coalesces height per animation frame, deduplicates ready/height, caps error messages and throttles close. The final burst forwarded one host height update in Chromium and two in WebKit, without extra payload. |
| Alternating height feedback | A plausible height media query kept oscillating: another 15 messages in 500 ms after warm-up. | Repeated rapid heights settle at the larger reading height. Both browsers stopped at six messages; clicking to change content still resized to 640 px. Existing equal-step growth protection remains. |

Transient widget selections can reset when a report leaves the viewport or the
App is hidden. Stored HTML/data and the text summary remain available. Expansion
and collapse of the same running widget retain its local selections. This is an
intentional execution-lifecycle tradeoff, not persistent form storage.

Viewport observation uses thresholds 0 and 0.01. With only 0, a report whose
edge touched the scroll boundary was reported as intersecting with zero area;
scrolling it 150 px into view then produced no newer observation, so it stayed a
blank placeholder until it left and re-entered. The App/Hub regression in
`widget-performance.spec.ts` scrolls to that exact edge in Chromium and WebKit.

The native audit fixture was also updated: it no longer relies on forwarding
arbitrary guest properties, and a native 25-second watchdog bounds the audit
process even if the renderer cannot run its JavaScript timeout. This watchdog is
test infrastructure, not a production CPU-isolation mechanism.

## Measured overhead

The 5,000-line ordinary-message benchmark ran three times before and after the
feature, using the same browser, host and fixture:

| Measurement | Before feature | After fixes |
| --- | --- | --- |
| Input operation latency | 9 / 10 / 10 ms | 11 / 11 / 13 ms |
| Frame interval P95 | 16.8 / 16.7 / 16.7 ms | 16.8 / 16.7 / 16.8 ms |
| Long tasks | One 78 ms task in the first run | None in the three runs |

These short desktop samples show no material ordinary-message frame regression;
they do not establish zero overhead or a device-wide latency guarantee. Input
timing measures the test's operation, not browser INP. Evidence:
`ordinary-before.json`, `ordinary-after.json`.

A later instrumented 2400×1000 Chromium pass compared the same static report in
one chat and six ADHD panes against ordinary text. CPU sums this test browser's
processes as a percentage of **one core** over about two seconds, including the
sampling animation frames; it is not whole-machine utilization or true idle
battery cost. JS heap is the main renderer after GC, not total process RSS.

| Surface | CPU, one-core % | Frame P95 | Input operation P95 | JS heap |
| --- | --- | --- | --- | --- |
| Ordinary chat | 3.5% | 16.7 ms | 6.4 ms | about 10.5 MiB |
| One static report | 3.5% | 16.8 ms | 10.2 ms | about 12.7 MiB |
| Six ordinary ADHD panes | 4.1% | 16.7 ms | 44.0 ms | about 12.2 MiB |
| Six static reports | 9.9% | 16.8 ms | 44.4 ms | about 17.4 MiB |

Evidence: `load-profile.json`, `load-profile-artifacts`. No frames attached or
detached and no height messages occurred during these samples. The six-report
CPU profile was mostly idle and did not reproduce a widget reload/height loop.
The extra documents, heap and browser work are real costs; six widgets are not
free simply because the input/frame sample remained responsive.

**Variability remains unresolved:** other short passes included a six-report
sample with 150 ms frame P95 and 497 ms input operation (`load-final.json`), and
an ordinary six-pane input outlier of 1,753 ms (`load-clean.json`). The latter
overlapped Opus's additional style-control experiment despite that filename;
it is not a clean baseline. The targeted profile pass did not reproduce either
outlier. No cause was established, so these observations are retained instead
of declaring all six-pane workloads stable or attributing the spikes to widget
code without evidence. These desktop samples are insufficient for tail-latency
or physical-device guarantees.

The complete client JS/CSS build grew from 6,168,722 to 6,184,904 bytes: +16,182
raw bytes, or +5,308 bytes when each file is gzip-compressed. This is the entire
feature's delta from the pre-feature baseline, not just this patch and not the
initial route's download size. Both builds have 116 JS/CSS files.

Opus measured native standing guidance growth of approximately 31 o200k tokens,
and approximately 203 tokens for the new tool schema. Compatibility/older native
standing guidance grew by about 60 tokens. These are tokenizer estimates, not
Claude billing measurements. A model-authored HTML tool argument still occupies
history once per publication; native receipts do not echo the HTML.

Host-side validation was small in the measured fixtures: approximately 0.03 ms
median for the shipped example, 0.26 ms for a near-limit data-array report, and
3.2 ms median / 6 ms maximum for a pathological 4,149-script report. A maximum
widget's Hub publication added about 2.2 ms median versus ordinary text. Durable
native publication used a stub transport and took 25–36 ms, dominated by receipt
fsyncs; this is not a network round-trip benchmark.

Storage remains linear. Messages and the existing event log together use about
2.0–2.3 times the HTML bytes, plus up to 32 KiB in the existing run journal. A page
of 50 maximum-size widgets can approach 7 MB JSON. The payload cap is not a
long-term history/storage budget.

## Resource lifecycle and verification

In the actual App fixture, 26 report/plain-conversation switches left one document
and 291 event listeners after GC at iterations 5, 15 and 25. Heap use was
11.32 / 11.70 / 12.05 MB: documents/listeners were stable, but this short run does
not prove an absence of all long-session heap growth. Opus separately measured
20 cycles of six widgets with no retained listeners/observers in its harness.

Verification records cover:

- The 18 existing functional widget scenarios in Chromium and WebKit, including
  layout, theme, errors, history, delivery and native-guard fallback.
- Eight Chromium performance/behavior scenarios; the load fixture was corrected
  to reopen the ADHD board after reload and rerun separately. WebKit runs the
  behavioral scenarios; process CPU measurement is Chromium-only.
- Focused host/tool/engine/CLI regressions: 159 passed across six files. Supported
  host standalone build, client translation/type/Vite build and the Rust fixed
  sandbox-protocol regression passed.
- Isolated macOS Tauri WKWebView receipt `native-macos-2.json`: passed embedded
  image decoding, local interaction, parent/storage isolation and native bridge
  denial with the production relay/protocol. No installed App was replaced.
- After removing automatic recipe injection, real Codex (`gpt-6.1-sol`, low)
  still proactively published one interactive report in the isolated acceptance:
  48.9 seconds, 6,218 HTML bytes, one durable native publication receipt, rendered
  total 29. The user prompt named neither a chart nor a tool. This is one model
  run, not an output-quality guarantee for all adapters. Evidence:
  `live-verified.json` and `live-verified-artifacts/**/live-widget.json`.

The CPU probe is opt-in and bounded to 1.2 seconds. Reproduce with the supported
Node/cache environment, built host and built client, then from `client/`:

```sh
TAROBOT_WIDGET_CPU_PROBE=1 npx playwright test e2e/widget-performance.spec.ts
TAROBOT_WIDGET_CPU_PROBE=1 npx playwright test -c playwright.webkit.config.ts e2e/widget-performance.spec.ts
TAROBOT_LIVE_WIDGET=1 npx playwright test e2e/live-inline-widget.spec.ts
```

Use `TAROBOT_PERF_CLIENT_DIR` with `e2e/performance.spec.ts` to compare a separately
built revision. Run resource benchmarks sequentially and keep other stress jobs
out of the sample; do not equate headless CPU samples with battery life.

## Remaining execution limits

**The iframe is a permission boundary, not a preemptive CPU sandbox.** In the
actual App fixture, a visible guest's 1,200 ms synchronous loop delayed a 250 ms
parent timer to about 1,300 ms in Playwright's Chromium headless shell and WebKit. Opus independently
reproduced a three-second App stall. An unbounded guest can prevent the loading
timeout, retry UI and visibility cleanup from running, and persisted bad HTML
can stall again on reopening. Lazy execution and relay throttling do not solve
that case. Strong CPU containment needs separately scheduled execution; a
same-thread JavaScript watchdog cannot supply it. Do not describe this feature
as having complete execution isolation or as safe from arbitrary hangs.

The later three-day audit distinguished full Chromium from its headless shell:
full Chromium with default sandboxed-frame isolation kept the parent responsive
(52–84 ms heartbeat gaps), while WebKit and the headless shell stalled for about
1.5 s. A separate native macOS probe confirmed a same-WebView iframe delayed the
parent JavaScript round trip by 1,396 ms; a separate WKWebView kept it near 0.69 ms
while the other view was busy. This demonstrates a feasible isolation direction,
not a shipped child-WebView feature. Windows WebView2, Android and iOS process
behavior still require native validation. Loop rewriting or crash quarantine
would be partial mitigations with their own compatibility/recovery semantics,
not a substitute for a verified isolation boundary. The proposed startup-lease
prototype was not merged: multi-window ownership and post-startup loops need a
complete design before a persisted pause can be trusted.

Per-widget theme watchers still read tokens on root style changes. Opus withdrew
its initial performance finding after adding an equivalent unobserved style-write
control: the original sample also counted style recalculation that would happen
anyway, and corrected desktop results overlapped. Shared observation remains an
optional improvement, not a demonstrated regression. Hidden widgets no longer
participate; physical phone cost was not measured.

Opus independently reran the final renderer/relay code from a frozen copy in both
browsers. It confirmed that alternating CSS and JavaScript height loops stopped,
the three-second flood produced only 52–83 host messages and five frame resizes,
and hidden/inactive guests stopped executing. The same-thread flood can still
consume CPU even when forwarded messages are bounded. It retained the synchronous
guest-hang finding and documented the intended local-state reset on scroll-out;
neither was presented as solved by the other fixes.

CLI publication, validation, receipt semantics and history remain shared with the
App. The new execution lifecycle and relay limits are client presentation changes;
they require no additional CLI command. Prompt selection applies to the same
headless host adapters. This audit does not publish an App or standalone CLI
release. Physical phones, Windows native performance, battery life and prolonged
production workloads remain unverified.

# OpenClaw source comparison

Inspected OpenClaw main at `6b16cf629434102f12f821346e3e4e8da88655ce` on
2026-10-22. This is a source review, not a performance measurement of OpenClaw.
The user identified OpenClaw and the author's related demonstration as the
reference; no unrelated product is assumed to be that demonstration.

## Findings

### Common reports can be data instead of generated programs

OpenClaw's [report schema](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/src/boards/board-report.ts)
accepts text, metrics, tables, bar/line charts and links in strictly validated JSON.
It limits a report to 8 KiB UTF-8, 24 blocks, 40 rows/chart points and bounded finite
numbers. The [fixed renderer](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/ui/src/lib/board/widgets/report.tsx)
owns layout and SVG geometry. This report format does not accept model-provided
HTML, CSS, JavaScript or executable actions.

The [tool](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/src/canvas/widget-tool.ts)
prefers this format for supported reports, but currently requires `pin: true`:
this is a pinned dashboard path, not proof of a native report renderer in every
chat client. It is a useful architecture for TaroBot's common charts and tables,
not a drop-in replacement for all interactive HTML.

### Native widgets have a separate WebView lifecycle

The [shared native view](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatInlineWidgetView.swift)
creates a `WKWebView` with nonpersistent website data, configurable script
execution and automatic popup creation disabled. Navigation is restricted. On
content-process termination, it reloads once and then shows failure; dismantling
stops loading and detaches its navigation delegate. Recovery resets when the
resource changes, not on every reload.

TaroBot currently renders chat and nested widget iframes within its main native
WebView. A separate WebView object is a meaningful architectural difference,
but does not by itself prove a dedicated process or CPU isolation. OpenClaw's
termination callback is not a watchdog that preempts a still-running JavaScript
loop. Neither its responsiveness nor process allocation was measured here.

### Browser permissions and lifecycle still need separate CPU analysis

OpenClaw's [sandbox host](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/src/agents/sandbox-host.ts)
uses a trusted proxy on a distinct origin and an opaque inner iframe. Its
[canvas view](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/ui/src/components/canvas-widget-view.tsx)
also supports a scripts-disabled mode. The
[host lifecycle](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/ui/src/lib/widget-sandbox-host.ts)
bounds retry delays and clears pending initialization data after delivery.
Deactivating its loader is not proof that already-running guest JavaScript stops.
Parent-window timeout callbacks cannot preempt synchronous guest work on a shared
thread. No general CPU-preemption mechanism was found in the inspected browser
host/view files.

TaroBot already releases executable frames when hidden and bounds relay payloads
and height feedback; see the [measured audit](inline-widgets-performance-2026-10-22.md).
Its synchronous-loop risk and the unresolved six-pane latency outliers remain
open. A source comparison does not close either finding.

### Proactive visuals come from instructions and a rendering contract

The tool description encourages visual use when helpful. The
[visualize recipe](https://github.com/openclaw/openclaw/blob/6b16cf629434102f12f821346e3e4e8da88655ce/skills/visualize/SKILL.md)
supplies composition, theme and compact-authoring rules: aggregate large data,
avoid embedding library distributions, prefer simple SVG/CSS when sufficient,
and keep local interactions local. It is not a hidden capability obtained merely
by changing UI frameworks.

TaroBot already has host-owned selection guidance plus an on-demand authoring
recipe. This keeps the full instructions out of ordinary native-tool turns.
We retain self-contained resources and local interactions. OpenClaw's permitted
external libraries and bounded automatic model repair are not adopted: the former
adds network dependencies; the latter creates additional model turns and needs an
explicit cost/recovery policy.

## Implemented in this change

The shared authoring recipe now asks for a normal source target of 24 KiB UTF-8,
static SVG/CSS where sufficient, no embedded framework/library distributions,
and aggregated widget data with requested complete records delivered separately.
24 KiB is a TaroBot soft target informed by the joint audit's source/token cost
finding, not an OpenClaw limit or a runtime performance guarantee. Validation still
accepts compatible documents up to 128 KiB. No standing prompt, frozen tool
definition, protocol, renderer, dependency or native sandbox changes are included.

The headless CLI and Apps share this host recipe and publication validation.
There is no new command or reduced CLI implementation. Installed Apps and the
published standalone CLI have not been updated by this source change.

## Concrete next implementation boundaries

1. Add a versioned, strictly validated data-only report envelope and a fixed App
   renderer for text, metrics, tables and charts, with consistent typography,
   themes, labels and accessible data. Keep the existing HTML v1 reader and text
   fallback. Do not disguise JSON as HTML or change frozen Codex tool contracts.
   Share the new publication path across native tools, compatibility directives
   and an additive headless CLI entry point. Reject unknown fields and excessive
   data before persistence. Initially require explicit selection of the report
   kind; measure authoring cost and coverage before making it the default.
2. Prototype a separate native WebView for executable HTML, with explicit layout,
   theme, focus, teardown, navigation and bridge boundaries. Measure App input
   latency during bounded busy scripts and after content-process termination on
   each supported native platform. Reload at most once per resource, then retain
   the summary and an intentional retry. A separate object alone is not acceptance.
3. Provide a scripts-disabled recovery view and a way to stop repeated execution
   of a failing document. Do not label a parent timer a CPU kill switch. Persisted
   document quarantine needs a reliable failure signal and must account for
   background suspension, sleep and ordinary navigation before automatic use.

These three items are design recommendations, not implemented features. Browser,
native, physical-phone and model acceptance must be recorded separately when
they are implemented.

## Verification

Evidence root: `/Volumes/gdrive/taro-tmp/tarobot-widget-openclaw-reference-20261022`.

- Focused widget, core-instruction and App native-tool tests: 33 passed in 3 files.
- Standalone host build: passed, 407 modules. No client code changed in this patch.
- Real Codex (`gpt-6.1-sol`, low), isolated Chromium acceptance: passed in 52.7 s.
  The prompt named neither a tool nor a chart. The model published one 5,802-byte
  SVG/JavaScript report with one durable native receipt. Its rendered total was
  29, matching the supplied data; expansion and initial rendering passed. The
  captured source and screenshot are retained under `live/`. This run did not
  separately exercise the generated date buttons or measure CPU/latency.
- The on-demand recipe grows from 4,901 to 5,218 UTF-8 bytes. Standing instructions
  and tool definitions are unchanged. This is a byte count, not a token estimate
  or a measured cost reduction; model-generated output length is nondeterministic.

Opus's final read-only review of `c424a71` completed and reconfirmed the previous
audit's renderer fixes and CPU limitation. Its source-size recommendation informed
this patch; it did not independently review this later guidance-only diff. That
report is retained at the previous audit's `opus/findings.md` and
`opus-final-reference.json`. Previous browser/native/performance results are not
presented as new runs. No native/device, release/install or hosted CI pass is
claimed by these local checks.

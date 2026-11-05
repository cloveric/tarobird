# Inline interactive widgets

TaroBot can publish self-contained interactive reports inside a conversation.
Charts, timelines, tabs, local filters and SVG/Canvas share the App theme, have
an expanded reader, and are restored with message history. Source and data are
saved; transient selections reset after a reload or when a report or App window
becomes hidden and its executable frames are released. Offscreen history rows
retain their measured placeholder height without running guest code. Expanding and collapsing
the same mounted widget preserves selections.

## Why Bots choose a visual

The OpenClaw GitHub source was inspected at
`79ab1c490784224dc38d6d0e409a2e2da105fdf2`:

- [show_widget tool](https://github.com/openclaw/openclaw/blob/79ab1c490784224dc38d6d0e409a2e2da105fdf2/src/canvas/widget-tool.ts)
  explicitly encourages proactive visual use when it clarifies the answer.
- [visualize skill](https://github.com/openclaw/openclaw/blob/79ab1c490784224dc38d6d0e409a2e2da105fdf2/skills/visualize/SKILL.md)
  provides composition, theme, responsive layout and verification guidance.
- [presentation routing](https://github.com/openclaw/openclaw/blob/79ab1c490784224dc38d6d0e409a2e2da105fdf2/src/agents/openclaw-tools.widget-presentation.ts)
  selects the surface from trusted channel context.

The important combination is proactive tool guidance, authoring conventions and
an executable display surface. It does not depend on switching React to Solid.
This implementation uses TaroBot's own protocol, delivery, themes and permissions;
it does not import OpenClaw's runtime or grant its dashboard APIs.

`gateway/agent-instructions.ts` adds a short standing visual-selection rule.
`app_capability(topic=widgets)` supplies the full host-owned recipe on demand to
native tool sessions. Compatibility engines receive the recipe for explicit
visual/data-comparison requests; ordinary words such as “比较急” or “分析报错” do
not select it. The recipe in `gateway/widget-guidance.ts` favors a useful single
visual, responsive controls, labeled data, computed aggregates, plain text when
clearer, and a readable summary. It never edits the user's Bot persona or project
instructions. Model-generated claims still require factual verification; visual
rendering is not a factual validator.

The [OpenClaw source comparison](inline-widgets-openclaw-reference-2026-10-22.md)
records the later native-report and WebView findings. Authoring guidance now favors
SVG/CSS for static visuals, a 24 KiB soft source target, and aggregated embedded
data with requested full records delivered separately. The 128 KiB validation
limit is unchanged; guidance is not CPU enforcement.

## Publication and compatibility

`app_show_widget({title, summary, html})` publishes to the current authenticated
conversation through the existing Gateway transport and durable tool-call receipt.
HTML is limited to 128 KiB UTF-8. Inline classic JavaScript is syntax-checked by
Node's parser without executing it. Invalid syntax returns a repairable error.
Ended/cancelled turns and muted scheduled runs cannot publish. Tool arguments
cannot override the conversation or recipient. Replaying a call ID does not send
a second message; changing its arguments is rejected. A publish without an ACK
is uncertain, not permission to resend with a new ID.

New Codex threads, Claude's private MCP and the DeepSeek native plugin expose the
new tool. Frozen Codex tool contracts v1–v3 retain their exact definitions and
session history. Older Codex sessions, Kimi and Antigravity use the existing
`tool-call` output directive with `name: send.widget` and the same payload. The
Gateway validates and builds the same message on both paths.

The document is a versioned `card.extra.widget` with a plain title and summary in
ordinary card elements. No database migration or protocol-version change is
needed. Older Apps show the summary; search, copy, quotes and Google Docs exports
use readable text instead of executable source. Forwarded widgets remain local
presentations and gain no action authority. Existing HTML/SVG attachments remain
escaped source; they do not implicitly become executable widgets.

## Renderer and native boundaries

`client/src/Widget.tsx` hosts a fixed outer sandbox relay and an inner opaque-origin
`srcdoc` guest. Both frames omit `allow-same-origin`, navigation, popups, downloads
and forms. The relay only accepts initialization/theme from its parent and relays
bounded size/readiness/error messages from its exact child. Resize bursts are
coalesced per animation frame; unused guest properties are never forwarded.
Initialization serializes/sends each document once per frame. The parent checks the
exact frame and per-load key. No widget message becomes a command, approval,
question answer, follow-up prompt, native call or Hub request.

The guest CSP blocks fetch/WebSocket requests, external scripts/styles/fonts/images,
objects and nested frames. CSP alone does not cover WebRTC/STUN: the trusted
bootstrap removes its constructors with non-writable, non-configurable properties
before authored code runs. Loopback UDP tests cover initial viewing and reload in
Chromium and WebKit. This is not proof against every browser networking channel;
DNS-prefetch behavior has not been verified. Images/fonts may be embedded as data URLs. The outer
frame's policy also blocks guest self-navigation. Theme variables are passed as
values, not executable markup. Three runtime errors within two seconds unmount
the guest and leave a visible summary/explicit-retry path; incidental errors
retain the report with a warning; reopening the reader alone does not retry.
heights are clamped and oversized documents scroll inside the frame. This is a
permission boundary, not a preemptive CPU sandbox: synchronous guest computation
can delay the shared renderer, including the App. Generated code should use small
datasets and short handlers; hidden reports are unloaded to stop background work.

Browser hosting gives only `widget-sandbox.html` its own sandbox CSP. The App's
script policy remains unchanged. Tauri serves the fixed relay on the `widget`
protocol; the untrusted document remains in the inner opaque `about:srcdoc` frame.
The macOS native runtime probe confirmed rendering/JavaScript, parent/storage
isolation, and absence of the Tauri bridge in the guest.

Capacitor sync/copy hooks run `widget-native-guard.mjs`. iOS uses the App-owned
`WidgetMessageGuard.swift`, installed before the WebView loads in
`TaroCubBridgeViewController.capacitorDidLoad()`. It wraps Capacitor's `bridge`
message handler and validates WebKit's main-frame and WebView identity. This code
is compiled into the App even when Capacitor comes from its prebuilt SwiftPM
framework. A main-frame-only script reports the installed guard to the renderer.
Patching node_modules Swift source alone does not protect the SwiftPM binary.

Android reports whether its active message bridge validates the main frame;
legacy fallback remains usable for ordinary App operations. Both iOS and Android
require the native runtime proof and the build marker before rendering executable
widgets; older or unguarded binaries show only summaries. Android's source patch
checks exact anchors and fails the build on dependency drift. Update the App (or
Android system WebView for the legacy bridge) to enable guarded rendering.

## Headless CLI parity

The headless host runs the same Bot publication tools without a desktop window.
Operators can also publish their own report through the authenticated Hub API:

```sh
tarobot widgets publish CONVERSATION_ID \
  --html-file /absolute/report.html \
  --title 'Delivery report' \
  --summary 'Key conclusion and source' \
  --request-id widget_report_20261022 --json
```

This creates a user-authored transcript item, never a forged Bot reply or an
implicit engine turn. Membership, archived-state, device revocation and request-ID
conflicts are checked transactionally. Reuse the same request ID and content to
reconcile an uncertain response. `messages list` returns the persisted widget
source and fallback using the existing history API.

A self-contained authoring example is
[`widget-release-timeline.html`](../examples/widget-release-timeline.html).
Its data is explicitly illustrative.

## Acceptance on 2026-10-22

The subsequent [joint audit](inline-widgets-audit-2026-10-22.md) and
[efficiency audit](inline-widgets-performance-2026-10-22.md) record additional
fixes and updated native, visual, performance and regression evidence. The counts below are
from the initial implementation, not a rerun during that audit.

Evidence root: `/Volumes/gdrive/taro-tmp/tarobot-widgets-20261022`.

- Full Vitest: 416 files, 5,797 tests passed, 5 skips.
- Final focused native tool, legacy contract, Gateway, Claude MCP, DeepSeek and
  CLI tests: 173 passed.
- Host standalone build and client translation/type/Vite build passed.
- Chromium and WebKit: five widget scenarios each, including the real Gateway
  tool and output-directive delivery, local filtering, opaque sandbox/network
  denial, errors, expansion, light/dark, phone/ADHD widths, reload, fallback data,
  publication idempotency, membership denial, no unintended Bot dispatch, and
  summary-only fallback for an Android bridge without frame isolation.
- Real Codex (`gpt-6.1-sol`, low): user prompt named neither a tool nor a chart;
  the model autonomously published one interactive report with a durable native
  receipt. Rendered total matched 29 input items. The initial trial exposed a
  model arithmetic error; guidance was strengthened to derive aggregates from
  the plotted data before the successful rerun. This does not guarantee future
  model calculations.
- Native Rust: 71 tests passed. Isolated macOS Tauri WKWebView runtime probe passed
  with the production sandbox handler (`native-macos.json`). This is not an
  installation/update of the user's App.
- Android Capacitor Java bridge compilation passed. Physical Android/iOS devices,
  a full iOS build and a Windows native run remain unverified.

Source is implemented; no App/standalone CLI release or installed-App replacement
is included in this change. Host and client must both be updated to expose the
interactive experience. The installed 1.0.97 App still shows the older interface.

# Interactive widget audit and fixes — 2026-10-22

This audit covers the feature introduced in `6e383f998db7f59f67d6668dc362802c034cae36`.
Codex reproduced and fixed issues; CC1 independently reviewed the baseline with
`claude-opus-5-5[1m]`, effort `xhigh`, then reviewed this run's screenshots and the
new iOS guard. CC1 was read-only in the shared checkout. Several early probes read
the changing worktree; baseline-sensitive findings were subsequently rerun from
`git show` copies. Do not interpret every intermediate result as a HEAD result.

Local evidence: `/Volumes/gdrive/taro-tmp/tarobot-widget-audit-20261022`.
The independent report is `opus/findings.md`. This file records the integrated
outcome, rather than reproducing every proposed improvement as a confirmed bug.

## Fixed behavior

| Area | Reproduction and resulting behavior |
| --- | --- |
| iOS native isolation | The project links the prebuilt Capacitor SwiftPM framework, so the previous node_modules Swift patch did not enter the App. An App-owned `WidgetMessageGuard` now replaces the bridge handler before page load, validates WebKit's main frame and WebView identity, and exposes a main-frame-only capability. Both iOS and Android require that capability and the build marker before mounting executable widgets. Unguarded Apps show the summary. |
| Embedded images/fonts | The outer CSP overrode the guest's data-resource allowance. Hub, fixed HTML relay and Tauri now permit `data:` images/fonts while keeping network resources blocked. Image decoding is covered in browsers and native WebKit. |
| Input focus | A newly arriving guest calling `focus()` could divert typing out of the composer in Chromium. Programmatic focus and scroll calls now require an earlier trusted pointer/key event inside that guest. HTML autofocus is removed. This is a usability guard, not a security boundary against code in the same guest realm. Actual clicks and typing inside widgets continue to work. |
| ResizeObserver | A responsive chart changing its observed dimensions produced browser loop warnings, including opaque WebKit `Script error`, which looked like failed rendering. Guest observer callbacks now run in the next animation frame; disconnect/unobserve also clear pending deliveries. Real script errors still show the summary and retry. |
| Loading/recovery | A successful load after the eight-second timeout clears the loading error. Runtime errors remain visible and automatically open the summary. Retry preserves keyboard focus on the reader button. |
| Keyboard/readers | Escape inside the guest closes its expanded reader and restores focus, while retaining selections. The check runs after event dispatch so widget-local Escape handlers can consume the key. Inline content has group semantics; only the expanded reader is a dialog. The inner iframe gets the report title. |
| Theme and type | Explicit primary buttons now use App contrast tokens. Global pressed/selected-button fill rules were removed so custom controls do not inherit an invisible primary text color; segmented controls use their own distinct plane/track colors. The guest inherits App or ADHD board text size. The reading plane matches the raised App card; inset controls use the surface token. Missing theme values retain CSS defaults instead of substituting a color for a font. Theme events are sent only when actual theme values change. |
| Width and safe areas | CLI user-authored reports no longer collapse to the iframe's 300px intrinsic width; they use a 560px desktop reading width within the message limit. Phone readers respect App safe-area tokens. Rapid equal-step autoheight growth is stopped before viewport-height/padding feedback reaches the limit; the frame remains scrollable. |
| Authoring and CLI | Legacy engines receive compact theme/layout rules without changing frozen tool definitions or exceeding the standing-prompt budget. CLI help keeps widget publication separate from queue options. The example uses valid pressed-button semantics and derives displayed totals/highlights from its data. |

## Visual walkthrough

All images below were captured and inspected during this audit, from isolated
fixtures or the newly executed real-model acceptance. They are not production
conversation data. The earlier model output was rerendered to establish the
baseline; the final real-model report was generated in this run.

1. **Read an inline report — improved.** `01-inline-before.jpg` stacked a title,
   eyebrow, slogan, subtitle and KPI row ahead of the chart. `13-light-example-final.jpg`
   puts a factual conclusion first, uses neutral segmented controls and emphasizes
   the relevant bar. Card material, type and expansion affordance follow the App.
2. **Select data and expand/collapse — passing.** `02-expanded-before.jpg` records
   the original detail view; keyboard failure was reproduced while focus was in
   the guest. The browser regressions now verify local filtering, Escape, focus
   restoration and preserved selections. The final real-model interaction in
   `10-new-model-dark.jpg` selects October 16 and displays 2 + 1 = 3 items.
3. **Read on a phone — passing at the tested width.** `04-phone-before.jpg` shows
   the dense prior output. `11-new-model-phone.jpg` shows the new generated report
   at 390×844; guest client/scroll width both equal 372px. It has a nearby legend,
   patterned second series, local detail selection and a collapsible methodology.
4. **Recover from an error — passing.** `05-error-before.jpg` hid the summary until
   manually opened. `12-error-recovery-final.jpg` shows it automatically, alongside
   a retry button. Timeout recovery is separately verified with a delayed response.
5. **Use an ADHD board — passing in the tested layout.**
   `chromium-layout-settled/inline-widget-native-tool--fa4ac-nsion-reload-phone-and-ADHD/widget-adhd-six.png`
   uses six columns (the board scrolls horizontally), with a sub-300px widget and
   16px board text. The test verifies no guest horizontal overflow and live 12→16px
   font updates. This is a browser fixture, not a physical-device screenshot.

The host recipe now asks for one short conclusion and one main visual, restrained
labels, theme-aware type/colors, local controls, computed totals, readable source
notes and content-driven height. It discourages decorative KPI grids, repeated
headings, semantic status colors for arbitrary categories, viewport-height layouts
and automatic focus/scroll. These instructions improve subsequent generations;
they do not rewrite previously saved report HTML or guarantee every future output.
Opus read the final desktop/phone screenshots and corresponding HTML and found
substantial improvement over the old report, with no blocking display issue in
those images. It retained nonblocking preferences about paragraph density, stronger
series fills, a more visible source note and short-report whitespace. Its final closeout confirmed the custom selected-text
fix and rapid-height-loop fix, and withdrew a false positive about identical tab
surfaces after checking the actual token mapping. No confirmed blocking issue
remained in the reviewed worktree. Full iOS App runtime smoke remains open.

## Verification

- Chromium: 18 widget scenarios passed, including service-worker-on history reload.
  The final suite passed 17; the detail-view journey was rerun successfully after
  its test waited for the asynchronous height update before clicking the header.
- WebKit: the same 18 scenarios passed. The opt-in real-model test is skipped in
  these normal suites and was run separately.
- Real Codex `gpt-6.1-sol`, low effort: passed in 50 seconds, one 4,766-byte report,
  one durable native publication receipt. The user prompt named neither a chart
  nor the widget tool. Manual browser interaction verified its date selection,
  dark theme and phone layout; this is not a claim about all engines' output quality.
- Isolated macOS Tauri runtime: passed parent/storage isolation, image
  decoding and local interaction. A direct `webkit.messageHandlers.ipc` call with
  a forged invoke key did not execute the native audit command.
- App-owned iOS guard: the exact Swift source compiled and ran in a macOS WKWebView
  probe; only the main-frame bridge call was forwarded, and the capability was
  absent in the guest. The actual iOS SwiftPM Release simulator App also compiled
  successfully for arm64 and x86_64. These are not physical iPhone acceptance.
- The focused host/engine/CLI regressions passed 227 cases. Supported host build,
  client translation/type/Vite build and the Rust widget protocol check are
  recorded in the evidence logs.

The standalone iOS guard probe is retained as
`client/ios/audit/WidgetMessageGuardAudit.swift`. Compile it with
`client/ios/App/App/WidgetMessageGuard.swift` using `xcrun swiftc`, then run it with
`TAROBOT_WIDGET_GUARD_OUTPUT` pointing to a new JSON receipt on the external disk.
The Tauri probe remains the `widget-audit` binary with `native-transport-audit`.

## Boundaries retained

- HTML/data persist, but transient local selections reset on reload or when the
  virtual message list unmounts an offscreen widget. Expansion within one mounted
  widget preserves them. We clarified the contract rather than retaining unlimited
  hidden executable frames.
- The rapid-growth guard only addresses the reproduced equal-step layout cycle;
  it is not a general validator of arbitrary model CSS. Oversized content remains
  scrollable and the 720px bound still applies. The recipe forbids viewport-height
  layouts.
- Browser screenshots and mocked safe-area values do not prove physical phone
  gestures, a screen reader audit or Windows native behavior. Those remain outside
  this run. The installed App was not replaced or released.
- CUA-driven reloads sometimes left an empty outer frame and the browser tool
  reported a paused document response. Manual retry worked; independent Chromium
  and WebKit tests with the real service worker enabled passed history reload.
  No product cause was established for that automation-specific observation.

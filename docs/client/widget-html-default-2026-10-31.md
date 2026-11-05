# HTML-default visual replies

New visuals use self-contained HTML/CSS/SVG/JavaScript components by default,
including ordinary charts, tables, comparisons and timelines. The structured
`report` format is used only when the user explicitly requests that format.
Ordinary prose or Markdown tables remain appropriate when clearer.

## Shared policy and compatibility

- `gateway/widget-guidance.ts` holds the shared default and authoring guide.
  Removed the recommendation to prefer report for ordinary charts, the report-first
  example, and the instruction to reserve HTML for custom interactions. The short
  report compatibility recipe follows the HTML guide and is explicitly opt-in.
  Narrow-screen guidance preserves full company/category names rather than tiny
  or clipped labels. Explicit report-format requests also fetch the compatibility
  recipe on engines without native widget tools; a written analysis report does
  not select the structured format.
- Native `app_show_widget`, compatibility `send.widget`, `widgets publish` and
  Bot-authorized `workbench publish` all receive the same format choice. The CLI
  still accepts `--report-file` for explicit requests. Its help and error usage
  share one definition; no desktop App is needed to publish through the Host API.
- Native tool contract v8 changes descriptions, not accepted payloads. Persisted
  v1-v7 definitions and hashes remain exact. In particular the old report-preferring
  description is retained **only** inside the frozen v5-v7 contract, so native
  sessions do not lose their tools or history. Current standing/capability
  instructions override that advice on subsequent turns. Codex injects restored
  `appTools.instructions` into each turn in `app-server-adapter.ts`.
- The widgets-disabled tool set remains v7 minimal; disabling publication does not
  enable a new route. Publication switches, receipts, retry identities, validation,
  sandbox limits and routing are unchanged. This is model guidance, not a new
  heuristic that guesses user authorization from text and rejects report payloads.
- Existing report cards keep `report` data, readable fallbacks, forwarding and the
  existing `Report.tsx` renderer. No history is rewritten and no old message is
  republished. HTML runtime security boundaries and interactions are unchanged.
- Browser acceptance exposed an existing CLI HTML-card width regression: the
  workbench entry wrapper made the direct-child width selector stop matching.
  Extend that selector to the known wrapper, keeping the original 560px width
  and 100% maximum. The CLI publication browser case now also checks 390px fit.

## Verification

- Related logic suites: 195 distinct cases across widget policy, HTML/report
  publication, settings, Gateway service/tools, workbench CLI/tools and Claude /
  DeepSeek adapters passed. The final prompt-budget adjustment was rechecked in
  the 26-case policy/Gateway-tool subset; the 1,600-character budget is unchanged.
- Standalone build passed (471-module graph, without legacy transport / Feishu SDK).
- Frozen v5/v6/v7 digests, restored instructions, new v8 registration, five-engine
  policy, CLI help, and HTML/report fence delivery are covered. Existing HTML and
  explicit-report native/CLI receipts and old-reader/forwarding tests still pass.
- One pre-existing test-fixture defect was reproduced on the unchanged baseline:
  `reports.test.ts` removed the last tool assuming it was `app_show_widget`, but it
  is now `app_workbench`. The test now selects tools by name, restoring its intended
  exact-v4 coverage. The v5 fixture likewise uses the frozen descriptor explicitly.
- Opus review prompted the explicit-format recipe trigger, a written-report
  distinction, the retained report-only leading-metric rule, and literal v4/v8
  digest checks. The follow-up six-suite run passed 52 cases; the additional v8
  digest assertion is verified separately.
- Independent Opus 5.5 review confirmed exact persisted digests and per-turn
  instruction replacement, and passed 234 cases including the Codex adapter.
  The follow-up review also approved the explicit-format trigger, v4/v8 digest
  assertions and HTML width selector; see `opus-final-review.md` in the evidence.
- Chromium/WebKit browser coverage exercised 70 cases across HTML and old-report
  rendering, interaction, sandbox restrictions, CLI publication and persistence.
  The initial run exposed the HTML width defect in both engines and two Chromium
  coordinate-fixture failures. Targeted final reruns verify CLI width/persistence
  at desktop and phone sizes, plus all six coordinate-helper cases per engine.
- The coordinate probe recorded an initial `600 × 236` SVG viewBox changing to
  `304 × 186` before pointerdown; the test's old pixel position correctly hit
  record 18, not its intended 22. Wait for responsive measurement before sampling,
  and recalculate after moving away/back. The forced paused entry animation and
  original record assertions remain. No report-renderer or motion code changed.
- Final targeted runs passed: both CLI publication cases (desktop width plus
  390px fit and reload) and all 12 coordinate-helper cases across Chromium and
  WebKit. Opus also approved the test-fixture corrections after reading the
  recorded pointer/viewBox evidence. Earlier failed logs remain in the evidence
  folder; the final results do not erase those runs.
- Review observations outside this change: user-authored structured reports may
  need their own width investigation; the DeepSeek workbench tool-count limit
  also deserves a separate check. Neither was changed or claimed fixed here.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/widget-html-default-20261031`.
This change updates source and guidance only; it does not publish a release,
update the installed App/Host, or establish physical-phone acceptance. Policy
and rendering tests do not guarantee that every future model-generated chart is
visually correct; generated HTML still needs responsive/interaction inspection.

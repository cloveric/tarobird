# Theme retirement — 2026-10-28

The owner requested removal of White Teal (白瓷青), Plum (暮紫) and Sand (暖砂),
plus the four previously hidden themes: Pixel, TTY, Paper teletype and Agent
terminal. These seven themes are now removed rather than merely hidden.

The supported catalog has nine choices: CLI, Monochrome, Porcelain Blue,
Green, Violet, Rose and Orange, Sage, and Ocean. CLI remains dark-only with
JetBrains Mono Latin and Sarasa Chinese. Monochrome's independent muted accent
choices, including Warm Gray and Sage, remain available.

## Implementation and existing settings

- The picker and preference validator use one supported catalog. No hidden
  secondary catalog or test-only selection path remains.
- Removed theme tokens, Pixel properties/glyphs, terminal-family styles, chart
  tokens, previews and exclusive translations are deleted. Shared selectors
  keep their CLI branch; the remaining palettes retain their existing tokens.
- `HostRegistry.preferences()` now validates the global saved palette; previously
  this path could restore arbitrary retired IDs after the startup mirror had
  already rejected them. The legacy cache reader already validates the catalog.
- The synchronous appearance mirror and normal appearance application use
  Monochrome for missing, removed or unknown palette IDs. Saved light/dark/system
  mode, muted accent, reading size, language, quiet hours, model-icon choice and
  other settings are retained. A subsequent preference edit saves the normalized
  palette. Reads do not overwrite the full preference record or touch pairing,
  conversations, messages or drafts.
- Old theme-specific browser cases are removed from shared feature matrices;
  unique size/layout cases now use a retained theme. Terminal-family-only tests
  are replaced by current/legacy preference migration coverage.

This is device-local App presentation. The standalone headless CLI, Host APIs,
protocol, message/session data and model settings are unaffected.

## Verification

Evidence directory: `/Volumes/gdrive/taro-tmp/theme-cleanup-20261028`.

- Client translation check, TypeScript and production build: passed.
- Host build: passed (`host-build.log`).
- Focused Chromium/WebKit journeys: 23 distinct engine/case combinations passed
  across the initial run and targeted reruns; one Chromium-only touch-driver
  case is intentionally skipped in WebKit. Initial runs were not all green:
  Chromium had 8 passes and 4 failures; WebKit had 10 passes, 1 failure and 1 skip.
  `chromium-r2.log` passes the all-palette and phone-recording checks;
  `webkit-r2.log` passes the phone-recording check. The final migration fixture
  passes both global/legacy cases in each engine (`migration-r3.log` and
  `webkit-migration-r3.log`). The isolated touch test exits 0 and its
  `font-r2/.last-run.json` reports passed. Its raw log also contains output from
  an earlier command launched from the wrong directory; that failed launcher
  is not counted as a test run or a pass.
- Full browser discovery: 2,276 tests in 341 files parse successfully. This is
  discovery only, not a full-suite execution.
- New migration journeys exercise all seven retired IDs in both the global
  registry and legacy cache. They hold asynchronous reads to inspect the startup
  mirror, then release hydration and verify the selected theme, retained accent,
  font size, model-icon choice, connected host and composer draft. An ordinary
  settings edit verifies preservation of quiet hours and durable Monochrome.
- Existing journeys cover all supported palette previews and contrast, dark and
  system modes, CLI typography, phone settings, recording and font sizes.
- The first run exposed an existing test-calculation error: computed
  `color(srgb 0.933333 0.933333 0.933333)` was parsed as 0..255 RGB. A before/after
  stylesheet probe confirms identical recording colors (238/238/238 over
  37/37/37). The test now resolves CSS colors through canvas sRGB bytes before
  checking contrast. The long all-palette journey also has a 180-second budget;
  its initial Chromium run exceeded 120 seconds during concurrent validation.
  Assertions were not relaxed. Targeted reruns are recorded below.
- The migration fixture now latches its release state: a preference-read event
  that arrives after release resumes immediately instead of being queued forever.
  This fixes a test-induced startup stall, not a production connection change.
- An initial Chromium touch-slider check observed 19 instead of 18; its isolated
  rerun passed with unchanged production code and matching input/parent bounds.
  This transient result is retained in the evidence rather than reported as an
  App bug repair. WebKit skips that Chromium-specific touch-driver case.

No release, installation or Host restart is performed by this change. Browser
checks do not establish native or physical-device acceptance.

## CLI sidebar avatar follow-up (2026-10-31)

The CLI palette's left Bot identity now renders at 30px instead of 40px.
Five-pixel horizontal margins preserve the name column and center the avatar
on the conversation-tree guide; the row retains a 44px click target. Animated
faces and state badges follow the smaller footprint. Other palettes, phone
inbox avatars and chat-header avatars retain their existing sizes. This is App
presentation only; the headless CLI and Host APIs are unaffected.

Client translation/TypeScript/production build and an isolated Chromium journey
passed at 1360px and 900px widths, including working animation, completion badge,
tree alignment and a switch back to Monochrome (40px). Evidence and preview:
`/Volumes/gdrive/taro-tmp.noindex/cli-sidebar-avatar-20261031/`. No new release or
installation; browser verification does not establish physical-device acceptance.

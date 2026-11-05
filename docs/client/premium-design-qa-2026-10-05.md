# Product design refinement — 2026-10-05

The operator requested actual Opus 5.5 participation in improving the app's
design and motion. This iteration uses the existing product, its Bot / group /
topic model and its four palette families. It does not replace the application
with a marketing prototype.

## Current-run visual baseline

Captured through the existing Chrome preview connected to an isolated local
Hub. Messages, files and Bot names in this preview are synthetic acceptance
fixtures. Each saved screenshot was reopened before accepting it as evidence.
The floating translator control at the screen edge belongs to a browser
extension, not TaroCub.

1. **Desktop conversation.** Working navigation and a clear main reading area;
   sidebar controls and information levels compete, repeated beige containers
   give reading a heavy appearance. Before（本地材料：`screenshots/premium-20261005/01-desktop-before.png`）.
2. **Phone conversation and attachments.** Functional controls have generous
   hit areas, but file cards use a large second row for two actions and leave
   less room for the conversation. Before（本地材料：`screenshots/premium-20261005/02-phone-chat-before.png`）.
3. **Phone inbox.** The expected IM navigation exists; title, filters and row
   hierarchy need a more coherent visual rhythm. Before（本地材料：`screenshots/premium-20261005/03-phone-inbox-before.png`）.
4. **Phone profile and settings.** Grouped controls are understandable; repeated
   containers, small labels and inconsistent spacing need refinement.
   Profile（本地材料：`screenshots/premium-20261005/04-phone-me-before.png`）,
   Settings（本地材料：`screenshots/premium-20261005/05-phone-settings-before.png`）,
   Appearance（本地材料：`screenshots/premium-20261005/06-phone-general-before.png`）.
5. **Phone Bot list.** Bot identity and new-conversation controls work and must
   remain distinct. Before（本地材料：`screenshots/premium-20261005/07-phone-bots-before.png`）.

Screenshots alone do not establish accessibility compliance, motion quality,
keyboard behavior, native-container performance or physical-device acceptance.

## Baseline performance

Existing automated scenarios, before rebuilding this iteration:

- 5,000 streamed lines with ten tables and ten equations: input 6 ms,
  frame P95 16.8 ms, maximum frame 33.3 ms, zero measured long tasks.
- Five clean local browser contexts: pairing median 105.6 ms, maximum
  105.9 ms; initial JavaScript 618,619 decoded bytes.
- Offline Markdown startup and retry after a failed chat chunk both passed.

These are local browser measurements, not phone or native cold-start results.

## Implementation and acceptance

Actual `claude-opus-5-5`, `xhigh`, implemented the five existing stylesheets,
then performed a second, read-only review of the rendered screenshots.
[Design record](premium-design-opus55-2026-10-05.md),
model receipt and review（本地材料：`evidence/premium-opus55-2026-10-05.json`）.

The result reduces nested containers: Bot prose is unboxed, human messages
retain a subtle tint, files are inset without extra rings, creation controls
share one track, and identity/section/meta text has a clearer hierarchy.
The four palette choices remain available; only Sand's light human-message tint
was adjusted. Existing motion shares 120/180/220/280ms timing tokens and remains
disabled under reduced motion. No new animation library, font or network asset.

### Rendered steps

| Step | Result | Before | After |
|---|---|---|---|
| 1. Desktop chat | Clearer hierarchy and reading surface; primary controls retained | Before（本地材料：`screenshots/premium-20261005/01-desktop-before.png`） | After（本地材料：`screenshots/premium-20261005/11-desktop-after.png`） |
| 2. Phone chat and files | Compact cards; real 44px control bounds | Before（本地材料：`screenshots/premium-20261005/02-phone-chat-before.png`） | After（本地材料：`screenshots/premium-20261005/12-phone-chat-after.png`） |
| 3. Phone inbox | IM navigation and row readability retained | Before（本地材料：`screenshots/premium-20261005/03-phone-inbox-before.png`） | After（本地材料：`screenshots/premium-20261005/13-phone-inbox-after.png`） |
| 4. Profile and settings | Aligned grouped controls; language/palette behavior retained | Before（本地材料：`screenshots/premium-20261005/04-phone-me-before.png`） | Profile（本地材料：`screenshots/premium-20261005/14-phone-me-after.png`）, appearance（本地材料：`screenshots/premium-20261005/16-phone-general-after.png`） |
| 5. Narrow phone and Bot navigation | Readable names, intact controls, no horizontal page overflow | Bot baseline（本地材料：`screenshots/premium-20261005/07-phone-bots-before.png`） | 320px（本地材料：`screenshots/premium-20261005/18-phone-320-after.png`） |

Desktop, same viewport and conversation:

Desktop after refinement（本地材料：`screenshots/premium-20261005/11-desktop-after.png`）

Phone file-card comparison, same 390px viewport:

| Before | Final |
|---|---|
| Phone before（本地材料：`screenshots/premium-20261005/02-phone-chat-before.png`） | Phone after（本地材料：`screenshots/premium-20261005/12-phone-chat-after.png`） |

Additional palette samples captured by the current-run browser tests and
independently inspected: Sage light（本地材料：`screenshots/premium-20261005/palettes/sage-light.png`）,
Ocean light（本地材料：`screenshots/premium-20261005/palettes/ocean-light.png`）,
Plum dark（本地材料：`screenshots/premium-20261005/palettes/plum-dark.png`）,
Sand dark（本地材料：`screenshots/premium-20261005/palettes/sand-dark.png`）.

### Regressions found and corrected

- Opus initially drew 36px phone file buttons with an extended pseudo-element
  hit area. Existing regression checks rejected the real bounds. Controls now
  measure at least 44×44px; a transparent border paints the Open pill at 32px
  without reducing the real target. At 390px the file card measures 58px tall.
- One-row files compressed a 320px English filename to 86.5px. At widths of
  360px or less, filenames receive their own row. Normal word breaking and an
  anywhere fallback preserve words where space permits.
- The WebKit history test sampled raw `scrollTop` while freshly mounted
  virtual rows were still being measured. Diagnostics showed unchanged visible
  row offsets while the measured content size was corrected. The test now waits
  for three stable measurement frames before the keyboard mutation, then keeps
  the original strict position checks. Five repeated WebKit checks passed;
  no app scrolling or keyboard logic was altered.
- The unrestricted root test run exceeded a 5s timeout while constructing and
  expanding the 128MiB archive fixture. Full validation was rerun with four
  workers; no archive assertions or product limits were relaxed.

### Final browser evidence

- Chromium: **33 passed**. WebKit: **32 passed**.
- Required root gate with four workers: **236 files, 3,792 tests passed,
  one skipped**, followed by a successful root build. Client build passed.
- Includes creation, group topics, independent desktop/phone quoting and
  forwarding, file actions, settings/language drafts, offline startup,
  keyboard layouts and four palettes in both modes.
- 5,000-line streaming scenario: input **5ms**, frame P95 **16.8ms**, maximum
  frame **33.4ms**, zero measured long tasks. No meaningful regression from
  the baseline; these are local browser results.
- Initial JavaScript remains **618,619 decoded bytes**; pairing median
  **105.4ms** across five clean contexts. This is not native cold start.
- Actual CUA phone sheet computed style: `tc-sheet-up`, **280ms**;
  reduced-motion: `none`, **0s** animation and transition.
- Source, frontend, screenshot and log hashes are in the
  acceptance receipt（本地材料：`evidence/premium-design-2026-10-05.json`）.

### Development package

The r17 universal macOS development DMG contains the accepted frontend.
Both arm64 and x86_64, strict local ad-hoc signature verification, DMG integrity,
the read-only mounted bundle comparison and the delivered Downloads copy passed.
All 303 frontend resources match the accepted build and the copied iOS/Android
resources. Mobile native projects were not compiled in this step.

- Delivery: `~/Downloads/TaroCub_1.0.0_universal-development_20261005-r17.dmg`
- SHA-256: `05cc65cb5cc9bc4c47b847d9bbbdf5e180c23f3e6ec3372828d60491d79ccae2`
- Packaging receipt（本地材料：`evidence/macos-r17-2026-10-05.json`）.

This does not install, publish, notarize or certify native rendering.

### Boundaries

This is a verified visual iteration, not a claim that every feature or the
whole v1.0 product plan is complete. Aesthetic quality still needs operator
feedback. Physical iOS/Android devices, native-window rendering, gesture feel
and native cold start remain separate acceptance surfaces. No installed app,
production Hub, VPS, fleet or signing identity was changed.

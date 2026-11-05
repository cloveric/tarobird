# TaroCub visual refinement — 2026-10-05

Follow-up to the existing Porcelain & Ink implementation, requested by the
operator with actual Opus 5.5 xhigh participation. This run starts from the
current application; it does not reset earlier functionality or design work.

## Fresh visual baseline

Captured through CUA from the existing Chrome preview because the in-app
browser was unavailable. The preview uses the real frontend and an isolated
Hub containing synthetic acceptance conversations. A floating Read Frog
translation widget belongs to the browser extension and is excluded from the
audit. Phone viewport: 390 × 844. Desktop viewport: 1345 × 1139.

| Step | Observed state | Before |
|---|---|---|
| 1. Desktop conversation | Bot/group/topic navigation works; many small controls and labels compete for attention. | Desktop（本地材料：`screenshots/refinement-20261005/01-desktop-before.jpg`） |
| 2. Phone chat and files | Bottom composer and file actions work; inspect spacing and action treatments at narrow sizes. A grey ring immediately after resizing disappears in the stable capture. | Chat（本地材料：`screenshots/refinement-20261005/02-phone-chat-before.jpg`） |
| 3. Phone inbox | IM navigation, unread indicators and previews are visible; inspect title/metadata hierarchy and row feedback. | Inbox（本地材料：`screenshots/refinement-20261005/03-phone-inbox-before.jpg`） |
| 4. Profile | Grouped host and capability entries are clear; compare their treatment with Settings. | Profile（本地材料：`screenshots/refinement-20261005/04-phone-me-before.jpg`） |
| 5. Settings categories | Four categories have clear explanations and a working return path. | Settings（本地材料：`screenshots/refinement-20261005/05-phone-settings-before.jpg`） |
| 6. Appearance settings | Theme, language and scope are explicit; repeated outlined controls compete with palette previews. | Appearance（本地材料：`screenshots/refinement-20261005/06-phone-appearance-before.jpg`） |

## Baseline performance

The existing isolated-Hub performance scenario rendered 5,000 streamed lines,
ten tables and ten equations. Input response: 5 ms. Frame P95: 16.8 ms. Maximum
frame: 33.4 ms. No measured long tasks. These are local Chromium measurements,
not native desktop or physical phone acceptance.

## Model execution

The initial tool-enabled Opus 5.5 xhigh attempt reached its 32-turn limit without
returning a completed design or modifying the owned source files. This attempt
is recorded as incomplete. A focused follow-up supplied the current screenshots
and stylesheet text directly and disabled tools to bound the review.

The focused Opus design completed in one turn and returned twelve exact CSS
edits. The parent applied them to the existing brand and mobile stylesheets,
then sent current-run before/after screenshots back to actual Opus5.5 xhigh.
The rendered review reported no blocking visual regression and explicitly did
not certify the entire product as high-end. Two optional refinements from that
review were subsequently applied and re-rendered: left-aligned sidebar creation
actions without a divider, and plain non-interactive scope labels.

Design and review receipt（本地材料：`evidence/refinement-opus55-2026-10-05.json`）.
[Implementation decisions](refinement-opus55-2026-10-05.md).

## Final rendered steps

| Step | Outcome | Final capture |
|---|---|---|
| 1. Desktop conversation | Current chat remains the raised selection. Creation controls align with the sidebar; healthy route and idle steering recede. Controls remain available. | Desktop（本地材料：`screenshots/refinement-20261005/11-desktop-after.jpg`） |
| 2. Phone chat and files | File Open is53×44px; transparent borders no longer animate through grey when crossing the breakpoint. Preview/save entries remain intact. | Chat（本地材料：`screenshots/refinement-20261005/12-phone-chat-after.jpg`） |
| 3. Phone inbox | Trackless filters retain a real56×44px target and32px painted pill. Unread filtering works and the inbox does not inherit the Me background. | Inbox（本地材料：`screenshots/refinement-20261005/13-phone-inbox-after.jpg`） |
| 4. Profile | Raised grouped cells sit on the same canvas as Settings overview. Host and capability entry points remain visible. | Profile（本地材料：`screenshots/refinement-20261005/14-phone-me-after.jpg`） |
| 5. Settings categories |16px outer corners, inset separators and press feedback match the grouped-list language. Return navigation works. | Categories（本地材料：`screenshots/refinement-20261005/15-phone-settings-after.jpg`） |
| 6. Appearance | Recessed selects and secondary actions; scope descriptions are plain icon/text. Four palette families remain. | Appearance（本地材料：`screenshots/refinement-20261005/16-phone-appearance-after.jpg`）, 320px dark English（本地材料：`screenshots/refinement-20261005/17-phone-320-dark-en-after.jpg`） |

Final desktop（本地材料：`screenshots/refinement-20261005/11-desktop-after.jpg`）

| Phone before | Phone after |
|---|---|
| Inbox before（本地材料：`screenshots/refinement-20261005/03-phone-inbox-before.jpg`） | Inbox after（本地材料：`screenshots/refinement-20261005/13-phone-inbox-after.jpg`） |

## Verification

- Chromium main pass:31 tests. WebKit main pass:30 tests. These include mobile
  navigation, four palettes light/dark with measured text contrast, settings
  language/drafts, keyboard geometry, creation, topics, questions, file actions
  and message actions. The Chromium pass also includes streamed performance.
- After the last two CSS-only refinements, the affected mobile/palette/language
  scenarios were repeated:8 Chromium and8 WebKit passes. These overlap the main
  suite and must not be added as unique coverage. No tests or assertions were
  weakened or edited in this iteration.
- Required root gate:236 files,3,792 tests passed,1 skipped; root build passed.
  Client translation check, type check and production build passed.
- Streamed5,000-line scenario after the main refinement: input5ms, frameP95
  16.7ms, maximum33.4ms, no measured long tasks. This is effectively unchanged
  from the baseline and is a local Chromium result, not a native budget claim.
- CUA computed styles: new menu180ms, phone creation sheet280ms. Reduced motion
  changes sheet animation to none/0s and filter transitions to0s. The media
  emulation, temporary viewport, language and theme were restored afterward.
-320px English dark General has320px document width. No horizontal overflow.
- Parent integration uses actual44px filter bounds rather than pseudo-element
  expansion. Neutral settings styles exclude `.text-danger` so destructive
  actions retain their red treatment.

Exact source, frontend, screenshots and log hashes（本地材料：`evidence/refinement-2026-10-05.json`）.

## Limits

This is a concrete refinement of the existing product, not completion of every
original product-plan gate or a claim of subjective premium quality. Physical
phone gesture feel, native rendering and native cold start still require their
own acceptance. General intentionally remains on the detail-page reading plane;
Me and Settings overview use the grouped-list canvas. The native range slider
and field-group separators are unchanged. No installed app, live Hub, VPS or
fleet was replaced, and nothing was published.



## Development package

The r19 universal Mac development DMG contains the accepted frontend. Both
arm64 and x86_64, strict local ad-hoc signature checks, DMG integrity, read-only
mounted bundle comparison and final Downloads copy match passed. All303
frontend files match the browser-accepted build and copied iOS/Android shell
resources. Mobile native projects were not compiled.

- File:`~/Downloads/TaroCub_1.0.0_universal-development_20261005-r19.dmg`
- SHA-256:`60d383196ed0bd36a28ad02c7cd5d06519ba07062028964997a385e225549832`
- Package verification receipt（本地材料：`evidence/macos-r19-2026-10-05.json`）.

This package is not installed, published or notarized. Native runtime and
physical-phone verification remain separate.

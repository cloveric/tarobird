# Studio interface refinement — 2026-10-05

The operator asked actual Opus5.5 to participate in App design and motion because
the current interface still felt amateur. This iteration builds on the existing
Bot/group/topic workspace, IM phone navigation and four light/dark palettes.
It does not claim that passing tests proves subjective premium quality.

## Design and integration

Actual `claude-opus-5-5`, effort `xhigh`, inspected six fresh CUA captures and
current source, then returned24 exact edits in one completed turn (467,279ms).
The parent applied23 of them to `brand-theme.css`, `mobile-im.css` and
`MobileHome.tsx`, with two evidence-led integration adjustments:

- Desktop reading content is an inset surface with14px corners and an8px canvas
  margin. Sidebar groups, unread counts and selected conversation have a clearer
  hierarchy. Bot/group/topic semantics and controls are retained.
- Bubbles and attachment tiles gain a restrained edge and top light; reply
  headings lead their sections. The composer uses the palette's focus halo.
- Phone filter selection matches the tab indicator. Profile gains an explicit
  chevron; phone Settings detail pages use raised grouped surfaces like Me. The
  existing grouped category overview is retained. Custom avatars and four palettes are retained.
- Sidebar selection indicator animates180ms, composer focus180ms, Send glyph
  lifts1.5px on pointer hover. Phone row press feedback starts immediately and
  releases over220ms. No new continuous animation or transform of virtual
  message rows or streamed text was introduced.
- The proposed global message-padding increase was rejected: measured phone
  messages already had80px outside their bubble. The first integration reduced the example attachment row from201.594px to
 189.594px. Opus and browser hit-testing then exposed edge overlap; final controls
 use actual44px bounds with a32px painted pill and a2px tail between rows. The
 bubble remains121.594px and its row is191.594px,10px shorter than baseline.
- The initial10% white bubble sheen reduced dark Sage error-text contrast at the
  upper gradient endpoint to4.133:1. It was reduced to4%. A source-token contrast
  audit covers all8 palette/mode combinations and foreground, muted, link, error
  and accent-counter colours. This is a focused calculation, not full WCAG
  certification; rendered palette checks separately cover rich messages.

## Current-run flow evidence

CUA used the existing Chrome preview because the in-app browser was unavailable.
The preview uses a real Hub with synthetic Bot/group/conversation data, not the
operator's production fleet. The small floating Read Frog tab belongs to a
browser extension and is excluded from the audit. Phone captures are390×844;
desktop1345×1139; narrow English dark320×740.

| Step | Health and change | Before | After |
|---|---|---|---|
|1. Desktop chat | Working navigation and controls; the reading surface and solid unread counters separate content from navigation. |Before（本地材料：`screenshots/premium-20261005/01-desktop-before.jpg`）|Final（本地材料：`screenshots/premium-20261005/39-desktop-accepted-final.jpg`）|
|2. Phone chat and attachments | Healthy; denser message rhythm retains content, file controls and message actions. |Before（本地材料：`screenshots/premium-20261005/02-phone-chat-before.jpg`）|Final（本地材料：`screenshots/premium-20261005/36-phone-chat-touch-final.jpg`）|
|3. Phone inbox | Healthy; selected filter uses the same accent language as the tabs. |Before（本地材料：`screenshots/premium-20261005/03-phone-inbox-before.jpg`）|After（本地材料：`screenshots/premium-20261005/13-phone-inbox-after.jpg`）|
|4. Me | Healthy; profile is distinguishable and its navigation affordance is explicit. |Before（本地材料：`screenshots/premium-20261005/04-phone-me-before.jpg`）|After（本地材料：`screenshots/premium-20261005/14-phone-me-after.jpg`）|
|5. Settings categories | Working four-category navigation and return focus; existing grouped layout retained. |Before（本地材料：`screenshots/premium-20261005/05-phone-settings-before.jpg`）|After（本地材料：`screenshots/premium-20261005/15-phone-settings-after.jpg`）|
|6. Appearance | Healthy scoped controls; detail surfaces match Me;320px English dark has320px document/dialog width. |Before（本地材料：`screenshots/premium-20261005/06-phone-appearance-before.jpg`）|After（本地材料：`screenshots/premium-20261005/16-phone-appearance-after.jpg`）, Narrow dark（本地材料：`screenshots/premium-20261005/17-phone-320-dark-en-after.jpg`）|

Final desktop（本地材料：`screenshots/premium-20261005/39-desktop-accepted-final.jpg`）

| Phone chat | Phone profile |
|---|---|
|Chat（本地材料：`screenshots/premium-20261005/36-phone-chat-touch-final.jpg`）|Me（本地材料：`screenshots/premium-20261005/14-phone-me-after.jpg`）|

## Validation

- Main regression:24 Chromium and23 WebKit cases passed, covering IM navigation,
  creation, settings language, palettes, keyboard geometry, message actions,
  topics and stream recovery. Chromium also includes the5000-line performance
  scenario. No assertions were weakened or screenshot baselines replaced.
- After the4% sheen fix, the affected palette/performance checks passed again:
  Chromium2, WebKit1. These overlap the main suite, not additional unique cases.
- Baseline5000 lines /10 tables /10 equations: input5ms, frameP95 16.8ms,
  max33.3ms, zero long tasks. Final: input5ms, P95 16.8ms, max50ms, zero long
  tasks. Same local Chromium fixture; single-run measurements do not prove
  physical phone performance or native budgets.
- CUA computed-style checks: guide180ms, composer180ms, settings220ms. Emulated
  reduced motion removes the animations and yields0s transitions. Media and
  viewport overrides were restored, along with Chinese/system appearance.
- Client translations, TypeScript and production build passed.

Root gate:236 files,3796 passed,1 skipped; build passed.

Source, screenshots, frontend and logs（本地材料：`evidence/premium-2026-10-05.json`）.
Actual Opus design and execution receipt（本地材料：`evidence/premium-opus55-2026-10-05.json`）.
The additional actual Opus review completed successfully in967,356ms. It returned
“Ship after 3 small corrections”, not an unconditional approval. All three were
resolved and checked by the parent:

- Restore solid primary-colour unread counts, keeping the bold title cue.
- Fix phone action containment. The parent's first spacing fix still exposed
  transparent-border and fractional-position hit-testing problems. Final44×44px
  buttons pass top/bottom-edge checks beside a following message in Chromium and
  WebKit. CUA also verified both user and Bot rows. The painted pill stays32px.
- Declare the inbox transition as background-colour-only,220ms. The existing base
  rule already inherited a background transition, so an all-properties regression
  was not confirmed; the explicit declaration makes the intended scope clear.

After these corrections, Chromium11 and WebKit11 passed (overlapping the earlier
suite). A final pressed-state check caught the need to preserve padding-box
clipping during a press; the background-colour declaration and focused1/1 checks
keep the32px painted pill inside the44px target. Client build passed, and the required root gate passed again with236
files /3796 passed /1 skipped. Solid unread counter contrast across all8 palette
variants is at least6.297:1; the minimum across the focused contrast audit remains
4.916:1. Correction logs and disposition（本地材料：`evidence/premium-review-2026-10-05/`）.

The parent also opened the effort and connection dialogs without clipping and
confirmed that the Me-card chevron opens Settings. Existing command-parity checks
open and use command menus on both layouts. The overview's existing design is
retained; its description is narrowed rather than claiming it was restyled.
Optional attachment-edge, palette-tile and focus-halo aesthetic suggestions remain
open choices. Selection-guide replay on re-insertion has not been live-certified.
Opus did not re-review the final correction patch. Static images and parent
checks do not establish native touch feel. The earlier interrupted review attempt
still has no completed response.

## Development package

The r24 universal Mac development DMG contains the accepted frontend.
Strict ad-hoc signature verification, DMG integrity, read-only mounted bundle
comparison and final Downloads copy all passed. All303 frontend assets match
the browser-accepted build and copied iOS/Android resources; mobile projects
were not compiled.

- `~/Downloads/TaroCub_1.0.0_universal-development_20261005-r24.dmg`
- SHA256:`284d14c8f7f2965401b50d42d1a48afc1a850a40fd0d56558d446eb9357b6b2c`
- Package receipt（本地材料：`evidence/macos-r24-2026-10-05.json`）.

The package is not installed, notarized or published. Native runtime acceptance
remains open.

## Limits

Screenshots establish current rendered states, not physical touch feel. Native
Mac/phone runtime, signing/notarization and the outstanding product-plan gates
remain separate. No installed app, live Hub, VPS or production fleet was replaced.
Nothing was published. The preview fixture's Bot engines are not connected, so
opening effort settings shows its truthful offline status; this does not exercise
changing a real Bot's model. Re-pairing of the isolated fixture during interrupted
preview recovery is not production authentication acceptance.

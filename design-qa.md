# TaroCub — Opus 5.5 visual refinement

final result: passed

Date: 2026-10-04. This verdict covers the rendered visual refinement and sampled
interaction regressions below. It is not user approval of the aesthetic direction,
physical-device acceptance, or completion of the full client product plan.

## Design and implementation

Actual Claude Opus 5.5 with xhigh led the design and directly changed six frontend
files. The parent reviewed the rendered client, corrected avatar highlight
contrast, and ran verification. The model completed successfully; its receipt is
[evidence/atelier-20261004.json](docs/client/evidence/atelier-20261004.json).

- [Design decisions and motion specification](docs/client/atelier-opus55-2026-10-04.md)
- [Previous design QA](docs/client/design-qa-2026-10-02.md)
- Local isolated demonstration: http://127.0.0.1:55648/
- Implementation: `client/src/brand-theme.css`, `palette-tokens.css`,
  `mobile-im.css`, `mobile-shell.css`, `hosts.css`, and `Avatar.tsx`.

The direction is warm porcelain reading surfaces, stone navigation, clearer type
hierarchy and restrained depth. Grok Bot remains the user's quality reference:
its [official interactive demo](https://x.ai/bot) was inspected again, with a
[current reference capture](docs/client/screenshots/atelier-20261004/grok-current-chat.png).
This is a quality comparison, not a pixel-for-pixel clone. Bot/group/topic semantics
and custom-avatar precedence are preserved.

## Normalized visual comparison

The same fictional conversation content, locale, font preference and light sand
palette were used before and after. Each pair was opened together for inspection.
All normalized captures have device scale factor 1.

| Surface | Viewport | Before | After |
|---|---|---|---|
| Desktop chat | 1360 × 900 | [before](docs/client/screenshots/atelier-20261004/before-desktop-rich-1360.png) | [after](docs/client/screenshots/atelier-20261004/after-desktop.png) |
| Phone inbox | 390 × 844 | [before](docs/client/screenshots/atelier-20261004/before-phone-inbox-rich.png) | [after](docs/client/screenshots/atelier-20261004/after-phone-inbox.png) |
| Phone chat | 390 × 844 | [before](docs/client/screenshots/atelier-20261004/before-phone-rich.png) | [after](docs/client/screenshots/atelier-20261004/after-phone-chat.png) |

Text wraps differently because reading text is deliberately one pixel larger and
sidebar width changes from 264 to 272px. Virtual content remains scrollable; these
captures are not compared for identical pixel positions. The Read Frog control
at the right edge belongs to a browser extension, not the app.

## Findings and resolution

| Priority | Finding | Resolution and evidence |
|---|---|---|
| P2 | Similar beige surfaces and weights flattened hierarchy. | Warm-white reading plane, stone sidebar, raised selection and recessed search; paired desktop and inbox captures show distinct levels. |
| P2 | Small rectangular default avatars did not distinguish identities. | Stable-ID muted hues, round Bot monograms and rounded group tiles. Uploaded pictures retain precedence and crop consistency; avatar browser regression passes. |
| P2 | Initial new avatar gradients lightened the base too much. | Parent deepened eight hue bases and capped white mix at 10%. White glyph contrast at the brightest solid gradient stop is 5.04–6.50:1. Final captures and build include this correction. |
| P2 | Phone message toolbars and empty composer were visually heavy. | Icon actions retain accessible names and 44px hit areas; empty input contracts and expands for focus/draft. Quote, forward and draft regressions pass. |
| P2 | Dialog and navigation feedback lacked a shared motion rhythm. | Shared 120/180/240ms feedback and 300ms phone sheet; measured sheet easing is cubic-bezier(.32,.72,0,1). No entry animation on streaming text or virtual message rows. |

No unresolved actionable P0–P2 visual regression was found in the sampled
surfaces. Subjective acceptance remains with the user.

## Required design surfaces

- **Typography:** existing system/CJK stack, stronger title and row hierarchy,
  tabular metadata, 1.62 reading line height. The user's font-size setting remains
  effective. English settings at 320px and desktop pass browser regression.
- **Spacing:** calmer sidebar, consistent control groups, shorter phone composer,
  and phone-specific bottom sheets. A 320 × 812 More-sheet inspection found no
  document horizontal overflow or clipped primary controls.
- **Colors:** only sand-light surface tokens changed; four palette families and
  both modes remain available. Rendered rich-message contrast assertions pass
  at >=4.5:1 across all eight variants. Dark sand and light ocean were also
  visually inspected, including content and controls.
- **Assets:** default avatars are CSS monogram treatments, not newly generated
  mascot artwork. Existing custom images remain supported. No external artwork
  or new UI dependency was added.
- **Copy:** this pass preserves labels, accessible names and translated strings.
  It does not invent status or alter Bot/session/group/topic behavior.

## Interaction and motion acceptance

1. Phone inbox, Back, host navigation, search, draft retention and long-chat
   following pass on Chromium and WebKit.
2. Groups/topics, create flows, native question cards, avatar crop/sync, quote and
   forward (including offline cases) pass in the same two browsers.
3. Closing the live phone More sheet returns focus to `更多聊天操作`.
4. Reduced motion sets the live sheet animation to `none`; sampled virtual
   message rows have animation `none` and transition duration `0s`.
   [Motion receipt](docs/client/screenshots/atelier-20261004/motion-check.json).
5. Captured warning/error console log list is empty. This only covers the
   observed preview session, not every possible engine or backend route.
6. Preview restored to sand / follow system. Temporary viewport and media
   overrides cleared. The preview tab is retained as a deliverable.

Supporting captures: [phone sheet](docs/client/screenshots/atelier-20261004/after-phone-sheet.png),
[320px sheet](docs/client/screenshots/atelier-20261004/after-phone-320-sheet.png),
[settings](docs/client/screenshots/atelier-20261004/after-settings.png),
[dark](docs/client/screenshots/atelier-20261004/after-desktop-dark.png),
[ocean](docs/client/screenshots/atelier-20261004/after-desktop-ocean.png).

## Verification and boundaries

- Frontend translation check, TypeScript and Vite production build: passed.
- Targeted browser suites: Chromium 20 passed; WebKit 20 passed.
- Required repository pre-complete hook after the last source change:
  233 test files passed; 3676 tests passed, 1 skipped; root build passed.
- Logs and hashes are recorded in the evidence receipt. These are functional
  regression checks, not an aesthetic score.
- Demonstration content is fictional in an isolated local Hub without a real
  CLI worker. No real model-speed claim is derived from this preview.
- Physical phone keyboard, native gestures, notifications and installed app
  packages were not accepted in this pass. No production deployment or installed
  client replacement was performed.
- P3 follow-up: default hue hashing may assign the same hue to multiple Bots;
  this preserves cross-device identity. Custom avatars remain the explicit way
  to select distinct artwork. Phone icon-only actions trade visible labels for
  space; their accessible names and behavior are preserved.


## Packaged follow-up — 2026-10-04

The r10 universal Mac development DMG contains the same accepted frontend; all
97 web assets also match both phone-shell copies. See the [package receipt](docs/client/evidence/macos-r10-2026-10-04.json).
The exact production build then passed three Chromium and two WebKit startup /
offline checks. Chromium's 5,000-line stream with ten tables and ten equations
measured frame P95 16.7ms, maximum 33.4ms, input fill 5ms and zero observed long
tasks. Empty-cache browser startup medians were 104.6ms / 111ms. These are local
browser samples, not the native 1.5-second startup or 200MB memory gates.
The installed app and production services remain unchanged.

## Mobile interaction follow-up — 2026-10-04

Actual Opus 5.5 xhigh refined action grouping, archive labels, connection status
and effort summaries. Parent fixed English narrow-grid clipping and completed
rendered QA, translations and 11 Chromium + 11 WebKit regressions.
[Final record](docs/client/interaction-polish-qa-2026-10-04.md).
This source follow-up is not in the r10 package described above.


## 2026-10-04 message actions follow-up

Actual Opus 5.5 xhigh implemented the phone single-entry message sheet. Parent
rendering checks, 44px close-target correction, desktop/phone export-state reuse,
source/host/focus regression and screenshot journey are recorded in
[message-actions-qa](docs/client/message-actions-qa-2026-10-04.md).


## 2026-10-04 settings navigation and startup follow-up

Actual Opus 5.5 xhigh designed and implemented phone settings page depth and
44px controls. Parent verified the screens, corrected 320px English wrapping,
rotation focus, immediate Back guards and WebKit chunk retry, and implemented
Opus's collaboration-label suggestion. The final two-browser core regression
passes are 11 + 11. First-view JS falls 31.7%; this is not native startup proof.
[Full record and screenshots](docs/client/settings-nav-qa-2026-10-04.md).

The `20261004-r11` universal development DMG includes these changes plus the
phone message sheet. Both architectures, strict integrity seal, read-only
mounted bundle and Downloads copy were verified; all 99 frontend files match
the accepted build and both mobile web-resource copies. Native execution and
physical-device acceptance remain separate. [Receipt](docs/client/evidence/macos-r11-2026-10-04.json).

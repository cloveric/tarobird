# Mobile interaction refinement: final QA

2026-10-04. Actual Claude Opus 5.5, xhigh, directly refined `App.tsx`,
`MobileHome.tsx` and `mobile-shell.css` from current screenshots. The parent
completed English translations, replaced the new hand-drawn archive icon with
the existing Lucide library, and fixed an English narrow-layout regression.
This continues the Atelier visual direction; it is not a new visual concept.

## Captured journey

All evidence below was captured this run from the isolated, fictional local Hub
at http://127.0.0.1:55648/. No real Bot was invoked. Browser-extension controls
at the screen edge are not TaroCub UI.

1. **Chat and inbox — usable.** Existing reading hierarchy and navigation remain.
   Header effort text now joins only known values; no leading separator appears
   when engine/model metadata is absent. The running phone composer explains
   steering versus queueing without adding a new row.
   Before chat（本地材料：`screenshots/interaction-polish-20261004/01-chat-before.jpg`）,
   inbox（本地材料：`screenshots/interaction-polish-20261004/03-inbox-before.jpg`）,
   final desktop（本地材料：`screenshots/interaction-polish-20261004/13-desktop-final.jpg`）.
2. **Chat actions — improved and verified.** Separate conversation, connection /
   archive, and task-control groups. “Archived chats” clearly opens a list;
   connection shows route and latency. Idle-looking Stop stays available for
   queued batches or work absent from the visible tail, with an honest note
   about sending a stop request. Steering keeps unsupported-engine feedback.
   Before（本地材料：`screenshots/interaction-polish-20261004/02-actions-before.jpg`）,
   final 390px（本地材料：`screenshots/interaction-polish-20261004/12-actions-390-final.jpg`）.
3. **Settings and language — existing flow preserved.** Captured phone settings
   and general settings; Chinese/English toggles preserve page and drafts.
   No settings page redesign is claimed in this follow-up.
   Settings（本地材料：`screenshots/interaction-polish-20261004/04-settings-before.jpg`）,
   general（本地材料：`screenshots/interaction-polish-20261004/05-general-before.jpg`）,
   desktop（本地材料：`screenshots/interaction-polish-20261004/06-desktop-settings-before.jpg`）.
4. **Narrow English / dark mode and motion — corrected and verified.** At 320px,
   the first implementation's action rows expanded to 314px inside a 288px
   group, clipping chevrons even though the document had no overflow. Parent
   fixed the button minimum width and protected navigation labels from shrinking;
   secondary route values may ellipsize, with full accessible descriptions.
   Observed failure（本地材料：`screenshots/interaction-polish-20261004/09-actions-320-english-dark-clipped.jpg`）,
   final（本地材料：`screenshots/interaction-polish-20261004/11-actions-320-english-dark-final.jpg`）.

## Motion and accessibility checks

No new animations were added. The existing sheet measures 300ms with
`cubic-bezier(.32,.72,0,1)`. With reduced motion, sheet animation is `none`,
transition duration is `0s`, and sampled virtual message rows have no animation.
Motion receipt（本地材料：`screenshots/interaction-polish-20261004/motion.json`）.
Observed menu rows are at least 52px tall. Closing the sheet returns focus to
More chat actions. Accessible names for existing controls remain stable; notes
use `aria-describedby`. These checks are not a complete screen-reader audit.

## Verification

- Final frontend translation validation, TypeScript and production build passed.
- Chromium: 11 passed. WebKit: 11 passed. Suites: `mobile-im`, `native-back`,
  `settings-language`, `steering`.
- Added checks exercise the archive list without losing the chat draft,
  accessible action descriptions, running composer guidance, and English row /
  chevron bounds rather than only document overflow.
- Required root hook: 234 files, 3781 passed, 1 skipped; root build passed.
  This covers the separate [automatic Lark steering receipt fix](lark-steer-receipts-2026-10-04.md).
- Model receipt, logs and source hashes（本地材料：`evidence/interaction-polish-20261004.json`）.

Preview restored to Chinese, sand palette and system theme. Temporary viewport
and media overrides cleared; the live preview remains open. No production
deployment, new package or installed-app replacement occurred. Real-phone
keyboard, gestures and notification acceptance remain outstanding.

## Remaining design considerations

Opus identified message action-row density, mobile Settings navigation style and
the unlabeled collaboration icon as possible future improvements. These are
not claimed fixed here. Aesthetic approval remains the user's decision.

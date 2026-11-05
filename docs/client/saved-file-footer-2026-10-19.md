# Saved attachment footer

The saved file card previously separated its receipt, Open file and Show in
folder buttons across multiple rows. A 160px minimum status basis and two long
pill buttons made the footer wrap unnecessarily, especially in ADHD panes.

## Presentation

- `Content.tsx` groups the status icon and live status text separately from the
  action buttons. Actions follow the receipt and stay together when the receipt
  needs another line. The desktop footer aligns with the file name; videos and
  previews use their own full-width alignment.
- `brand-theme.css` gives the footer compact, quiet controls. Show in folder uses
  the existing Lucide folder icon, with its full accessible name and tooltip.
- The saved receipt keeps its success color. Text actions use the theme accent;
  save/open errors remain separately announced and can wrap without overflowing.
- Open/reveal use `aria-disabled` while busy to retain keyboard focus. The
  existing synchronous operation guard still prevents duplicate activation.
  Retry has extra separation from saved-copy actions when both are available.
- Phone-width and coarse-pointer controls retain 44px minimum targets. Desktop
  controls use 28px height; narrow panes do not inherit a fixed status width.
- Existing theme tokens, keyboard focus outlines and terminal-theme square
  corners are retained. Forced-colors mode adds visible button borders.

Save/download, cancellation, native receipts, retry, APK installation, open and
reveal callbacks are unchanged. The footer is shared by file cards and previews.
CLI impact: not applicable; this changes client presentation only, with no host
API, file operation, permission or persistence changes.

## Verification

- The added layout regression failed before the change: the two saved actions
  occupied different rows, with a 38px vertical offset.
- Chromium: 33 tests passed across `file-actions`, `desktop-export`,
  `android-saved-file` and `mobile-file-export`.
- Layout coverage uses the production message renderer at actual card widths
  of 240–440px, phone viewports of 320/390px, English labels, light/dark and
  CLI/pixel/TTY/paper palettes (11 scenarios).
  Assertions cover adjacent actions, card/page overflow, touch targets and
  open/reveal callbacks. The fixture includes the production `.message-body`
  wrapper and explicitly checks the rendered card width.
- Saved-copy actions remain available after a subsequent preview download
  failure without overflowing a 240px card. The keyboard regression reproduces
  the previous lost focus, then verifies focus during/after reveal and that a
  second Enter does not invoke reveal again.
- Client production build passed.
- The original WebKit attempt could not create a page because its installed
  runtime failed sandbox initialization before test actions. That attempt was
  not a passing result; the follow-up below records the now-working runtime.
- Native dialogs and filesystem IPC are test doubles. These checks do not
  certify physical macOS/Android/iOS execution. No installed App was replaced.

Independent Opus 5.5/xhigh design review and implementation review found the
original layout defect fixed. Its fixture-width finding was corrected before
the final layout run; compact alignment and keyboard-focus suggestions were
also adopted. The follow-up review of those adopted changes found no blocking
defect; all 33 regressions passed again on the final code. Native validation
remains separate from browser evidence.

The original Git permission blocker is resolved. Follow-up source delivery and
WebKit results are recorded below; earlier failures above remain historical
evidence, not current blocker claims.

## 2026-10-19 follow-up delivery

The earlier permission/runtime blocker statements are historical. See the
[pending-delivery closeout](pending-closeout-2026-10-19.md) for final verification,
independent review dispositions, source delivery and remaining native/release gates.

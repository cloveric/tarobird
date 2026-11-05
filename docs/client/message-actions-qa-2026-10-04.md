# Phone message actions: design and behavioral QA

2026-10-04. Follow-up to the [Opus-led interaction refinement](interaction-polish-qa-2026-10-04.md).
Scope: reduce repeated action-icon density in phone conversations while retaining
desktop shortcuts and exact message / conversation / host ownership.

## Captured journey

Evidence is from the isolated fictional local Hub at http://127.0.0.1:55648/.
No real model, production service or cloud document is involved. The floating
browser-extension control at the right screen edge is not part of TaroCub.

1. **Before: repeated tools distract from reading.** At 390 × 844 each message
   reserves a full row for four or five icons with no visible labels. The row
   competes with content and repeats throughout the conversation.
   Saved and inspected capture（本地材料：`screenshots/message-actions-20261004/01-phone-before.jpg`）.

2. **Phone chat and sheet: verified.** One visible 44px message entry replaces
   each row of four or five icons. The sheet identifies its source with author,
   time and a two-line preview, then separates copy/quote/forward from export and
   resend. Existing row height is retained so virtual-list measurements do not
   jump. The parent enlarged phone sheet close controls from 32px to 44px;
   action rows measure 52px. Chat（本地材料：`screenshots/message-actions-20261004/02-chat-after.jpg`）,
   final sheet（本地材料：`screenshots/message-actions-20261004/06-actions-390-final.jpg`）.
3. **Quote and forward: verified.** Quote closes the modal and focuses the
   composer; existing text remains. Forward opens its destination picker with
   the correct source, and cancelling returns to the original message entry.
   Quote（本地材料：`screenshots/message-actions-20261004/04-quote-focus.jpg`）,
   forward（本地材料：`screenshots/message-actions-20261004/05-forward-panel.jpg`）.
4. **Narrow English, dark mode and motion: verified.** At 320 × 568, all four
   rows stay inside the 288px group and the page has no horizontal overflow.
   The existing sheet uses 300ms; reduced motion yields animation `none` and
   transition `0s`, including no virtual-message entrance animation.
   English/dark（本地材料：`screenshots/message-actions-20261004/07-actions-320-english-dark.jpg`）,
   motion measurement（本地材料：`screenshots/message-actions-20261004/motion.json`）.
5. **Desktop: preserved and checked.** Inline hover/focus controls remain;
   resizing out of phone layout closes its sheet. Restored Chinese, sand palette
   and system theme, and cleared viewport/media overrides.
   Final desktop（本地材料：`screenshots/message-actions-20261004/08-desktop-final.jpg`）.

## Implementation and review

Actual Claude Opus 5.5, CLI effort `xhigh`, completed the implementation and
[source review](message-actions-opus55-2026-10-04.md). The parent verified the
rendered result, enlarged close targets and resolved Opus's export-state concern:
`message-export.ts` now shares an in-flight result between desktop `GoogleExport`
and the phone sheet. It is scoped by connection and message ID. Closing,
reopening, virtual-row recycling or layout changes do not restart the request.
An explicit retry is still available after a reported failure.

Clipboard writes remain inside the original click call stack. Success alone
shows “Copied”; a rejection clears success and reports a useful error. Message
updates use the live source; deletion leaves an explanatory sheet with no action
buttons. Archived conversations disable quoting with a reason. Native Back,
Escape, conversation navigation and host-directed notifications respect the
topmost sheet and exact source. No model, backend or production configuration
changed in this milestone.

## Verification and limits

- Frontend translation check, TypeScript and production build passed.
- Chromium: all 30 selected journeys passed, then the adjusted export fixture
  passed its focused rerun. WebKit: 29 of 30 initially passed; the export HTTP
  mock was bypassed by a service worker. The fixture now blocks workers only in
  that HTTP-mock test. All four message-action journeys passed on rerun, including
  the original failure. Offline/worker tests still run separately with workers.
- Checks include raw Markdown copy, failed copy, quote/draft/focus, native Back,
  forwarding rich attachments in both directions, durable offline forward,
  live streaming completion, archive from the other paired browser, source
  deletion, same-ID cross-host navigation, export error/success and no automatic
  duplicate export when closing/reopening/resizing during a pending request.
- Also passed effort, collaboration, steering, long-message, link-preview,
  card-layout, language, inbox and startup checks on both browser engines.
- The startup fixture measured 899,834 initial JavaScript bytes against its
  900,000-byte gate. It passes, but leaves little room for future eager imports;
  these local browser timings are not native cold-start acceptance.
- Required root completion hook: 234 files, 3,781 passed, 1 skipped; root build
  passed on the final source (65.76-second test run).
- Model metadata, source hashes and logs（本地材料：`evidence/message-actions-20261004.json`）.

Screenshots were saved and reopened before acceptance. Clipboard behavior uses
test-controlled success/failure; native OS permissions and the physical iPhone
keyboard still need device verification. Export responses are mocked and do not
certify real Google OAuth or document creation. Screen-reader completeness,
native touch gestures and new installation packages remain separate gates.
The latest DMG is still r10 and predates this follow-up; no deployment occurred.
The complete product plan remains open, and aesthetic approval remains the user's.

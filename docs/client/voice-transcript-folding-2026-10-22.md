# Collapsible audio transcription receipts

Long audio transcription receipts previously filled the conversation with up to
2,000 characters. The shared desktop/mobile renderer now shows a compact excerpt
by default and offers **展开转写 / Expand transcript** and **收起转写 / Collapse
transcript** controls. The status heading and meaningful file name remain visible.

## Behavior

- Completed, partial and stopped transcription cards fold when their body exceeds
  240 characters or five source lines. The folded excerpt contains at most 200
  Unicode code points and displays at most five lines. Short transcripts remain
  directly readable without an extra control.
- Expanding restores the full existing Markdown receipt, including the notice
  about the 2,000-character preview cap. The cap itself is unchanged, and the Bot
  still receives the full transcript.
- Copying a folded message uses its complete original receipt, not the excerpt.
  Stored message blocks and forwarding data are unchanged. Generated recording
  filenames remain hidden by the existing presentation helper.
- Pending/error cards and ordinary cards retain their existing presentation.
  Partial receipts preserve their missing-segment status in the excerpt.
- The native button exposes `aria-expanded` and `aria-controls`, supports Enter
  and Space, and has a visible keyboard focus indicator. Folded-away links and
  code controls are not mounted or reachable by keyboard.
- Expansion is local UI state; no preferences, protocol or database migration.

CLI impact: none. This is a client presentation change; ASR routing, status
publication, canonical message text, CLI output and model input are unchanged.

## Verification

- `tests/voice-presentation.test.ts` and `tests/gateway-voice.test.ts`: 22 passed.
- `client/e2e/voice-card.spec.ts`: 3 passed in Chromium and 3 passed in WebKit,
  covering 390 px and 1,360 px layouts, pending-to-complete updates, default
  folding, mouse and keyboard toggling, full receipt copy, unchanged stored data,
  partial status, short receipts and ordinary-card exclusions.
- Client translation validation, TypeScript/Vite build and standalone host build
  passed. Browser screenshots were visually inspected for both viewport sizes.

These are browser checks, not installed native App or physical phone acceptance.
No installed App was replaced or restarted, and no new release was published for
this change.

# Forwarded message bubble

A forwarded user message displayed its source in a separate gray card above
the text and attachments. These are already one persisted message; separating
the source visually made one forward look like two messages.

`App.tsx` now passes forwarded sources into `MessageContent`, using the same
inline reference surface as sent quotes. `quoted-reply.css` gives the source,
caption and attachments one outer bubble with a quiet source marker. Inline
source buttons stay transparent, including hover, and use the own-message
contrast tokens. Terminal themes retain their square layout.

The rendering applies to existing history as well as new forwards, in ordinary
desktop chat, mobile chat and desktop ADHD panes. Updating the client is enough;
there is no migration or need to forward the message again.

## Preserved behavior

- `blocks`, `forwardedFrom`, `replyTo` and message IDs are unchanged. No distinct
  messages are merged, and forwarding/queue permissions are unaffected.
- The source remains a button that locates the original message. Existing
  unavailable-source handling remains in place.
- Images keep their preview/gallery behavior, and files remain readable copies
  scoped to the destination conversation.
- CLI: not applicable to this presentation change. The shared forwarding API,
  CLI output and all five engine adapters are unchanged.

## Validation

- Reproduced the separate source before the fix with a failing browser check.
- `forwarded-message.spec.ts` covers captioned images, image-only forwards,
  files, 320/390 px mobile layouts and a four-column ADHD board. It checks
  containment, overflow, source contrast across eight theme/mode combinations,
  preview, source navigation and byte-preserving attachment copies.
- Regression coverage includes `quoted-reply`, `forward-lifecycle`,
  `attachment-message-actions` and `hub-forwarding`.
- Results: 22 browser checks passed in Chromium and 22 in WebKit; all 11
  `hub-forwarding` tests passed. Root and client production builds, staged and
  history secret scans also passed.
- Browser checks use isolated Hub state and Chromium/WebKit, not installed
  native App acceptance. This change does not publish a release or replace the
  owner's installed App.

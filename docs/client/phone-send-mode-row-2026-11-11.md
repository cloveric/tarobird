# Phone pending-message and send-mode row

Ordinary iPhone and Android chat windows were spending two rows on the pending
message preview and the Codex/Claude send-mode selector. Following the owner's
chosen first design and FABLE5's source review, native phone windows narrower
than 600 CSS pixels now share one row when there is no native task/progress bar.
The width boundary preserves expanded windows; narrow cover/split windows use
the same phone layout. Desktop, web, ADHD and task/progress arrangements retain
their existing layout.
A later [desktop Codex refinement](desktop-codex-composer-2026-11-12.md) has its
own scope and leaves these native phone rules unchanged.

- With a queue entry, its count and shortened preview occupy the left side and
  the existing segmented selector occupies the right. The queue's actual DOM
  presence controls the layout, including a retained zero-count retry entry.
- Without a queue entry, the left side explains the selected mode or why rich
  input must wait. That text opens the existing help dialog; the extra question
  mark is hidden in this compact row. Desktop and expanded-window help remains.
- The selector uses a raised selected pill with the theme's accent outline and
  text. Counts use existing accent badge tokens, including the neutral fallback
  for monochrome without an accent. The phone stop control uses the theme's
  primary control colors while retaining its existing glyph and 44 px target.
- Controls wrap when enlarged text needs more width. Queue previews yield first;
  paused/offline status, counts and controls retain their own space. No input or
  send button is narrowed to make the accessory row fit.

`PromptQueue` and `ClaudeSendChoice` remain in their original parent with the
same keys. No send, steer, receipt, queue mutation, task, polling or draft logic
changes. Codex still defaults to queue; selecting a mode does not send anything.
The shared current-mode explanation reuses the exact existing localized title
text, including Claude/Codex and rich-input distinctions.

CLI impact: not applicable; this is App presentation and help text placement,
with no Host API, native dependency, protocol or command change. No release or
installed-App update is included.

## Verification boundary

The new Chromium phone-row regression first failed on the original stacked
layout. It exercises real isolated Hub/Gateway routes with deterministic engine
fixtures, not live models. Its coverage includes ordinary iOS/Android widths,
Chinese/English, empty/queued states, theme switching, larger labels, retained
focus/draft, queue-dialog access and returning to a wide layout. Existing
Codex/Claude send-choice tests protect default routing, uncertain receipts,
attachments, touch focus, task controls and desktop/ADHD behavior. The existing
Duo fold/rotate/split case protects the expanded-window boundary.

Browser platform hints and injected insets do not establish native keyboard or
physical-device acceptance. For the initial implementation, FABLE5 supplied
design/source guidance only; runtime checks were recorded separately by the
implementer. The later visual refinement is described below.

Validation results: all 32 existing Codex/Claude send-choice cases and both new
phone-row cases passed in Chromium. After the final wrapping/status refinements,
both phone-row cases passed again, together with the Duo fold/rotate/split case
and all three queue pause/resume cases (desktop, phone and ADHD). Client
translations, TypeScript and production build, standalone Host build and version
consistency checks passed. Full-page phone previews were visually inspected.

## Visual refinement

After reviewing the first full-page previews, the owner asked FABLE5 to directly
refine the selected design. The phone-only CSS now separates the 44 px touch
target from the lighter 36 px visible capsule, increases the hierarchy of the
queue label and selected mode, and aligns the empty-state explanation with the
input text. The selected mode has a raised thumb with a restrained theme-accent
edge and ink; count and stop colors continue to use the existing theme tokens.
The capsules keep an 8 px visual gap above the typing field. A preview with less
than a few characters of room withdraws instead of showing a clipped glyph;
counts, offline labels and paused-state text remain available. Dark themes give
the selected thumb a distinct raised surface. The transition honors reduced
motion.

This refinement changes presentation only. Component identity, keyboard/touch
handlers, queue semantics and native dependencies remain unchanged.

The implementer independently ran 35 existing focused Chromium cases on the
first styling pass. After the final spacing, preview and dark-theme refinements,
the client build and six affected phone/Duo cases passed again on the final CSS:
iOS/Android queued rows, both narrow-phone help/focus cases, Chinese/English
resizing and Duo fold/rotate/split. Full-page previews were inspected. These are
browser layout and deterministic-engine checks; physical iPhone/Android and
installed-App acceptance remain pending. No release or installation occurred.

FABLE5's additional scratch-directory run hit two keyboard-fixture timeouts
before the App loaded: both traces showed HTTP 404 while waiting for the Host
address field. Those Vite fixtures require the client directory as their working
directory. The implementer reran both touch/pointer keyboard cases there on the
unchanged final CSS; both passed. The failed setup attempts remain separate from
this retake and are not counted as successful keyboard verification.

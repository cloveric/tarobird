# History-search pagination containment

The previous sticky pager lived inside the results scrollport. While reading a
long excerpt, the pager covered its text and the scrollport padding exposed a
second strip of content above the controls.

`App.tsx` now renders the existing pager after the scrolling results section,
inside the same column layout. The pager owns a non-shrinking row with a top
separator and 44-pixel controls. Results keep their existing scroll element,
filters, excerpts and click handlers. `styles.css` applies device safe-area
padding to the phone/touch footer; nested ADHD panes keep their own grid inset.
Tablet touch layouts retain the same 24-pixel horizontal alignment as their
results, while narrow phones use 16 pixels.

Queries, cursor ownership, scope checks, request cancellation, failure recovery,
page-reset behavior and conversation drafts are unchanged. This is an App
presentation correction; the headless CLI and Host search protocol are unaffected.

## Verification

- A long-result Android-sized browser fixture failed before the fix because the
  pager intersected the reader; the corrected layout gives them disjoint space.
- Chromium coverage includes Android and narrow iPhone-sized layouts, iPad-sized
  touch and desktop, Chinese and English, maximum reading size, shortened windows,
  last-result reachability, hit testing, both paging directions and scroll reset.
- Existing ordinary and ADHD search journeys retain filters, draft/attachment
  state, current-conversation scope, cancellation and stale-response rejection.
- The existing highlight-contrast test also failed on the unchanged baseline:
  it read the previous foreground during the button color transition. It now
  waits for the unchanged contrast threshold rather than sampling mid-animation.
- Client and Host builds pass. Browser layout coverage is not installed-App or
  physical-device acceptance. The attempted WebKit App journey stalled during
  pairing setup before reaching search; it is not a passing WebKit result.
- Independent review reproduced the baseline overlap and found no blocking
  issue in the corrected footer. Its tablet alignment suggestion is included.
  Real soft-keyboard acceptance, especially on short landscape phones, remains
  outstanding. The footer follows results in keyboard tab order.

No version bump, App installation or publication is part of this repair.

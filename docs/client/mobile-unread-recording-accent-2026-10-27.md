# Phone unread counts and recording accents

The owner selected red avatar unread counts after reviewing colour previews.
The phone's aggregate Messages-tab count should use the selected accent, as
should the active recording waveform and elapsed time.

## Behaviour

- Avatar-corner unread counts use the approved red and white digits across
  palettes. Desktop unread styling, counts, read state and spoken labels stay
  unchanged. Former porcelain and terminal phone colour overrides are removed.
- In Monochrome, the Messages-tab aggregate follows the selected accent. Its
  deeper shade keeps small white digits readable in light and dark modes.
  Choosing no accent restores the existing grey badge; other themes retain
  their palette-controlled aggregate.
- Hold-to-talk and click-to-record use the same recording accent for the
  waveform and timer. This also covers the shared side composer and small-mic
  hold panel. With no selected Monochrome accent, the normal palette colour is
  used. Sliding up to cancel still switches the hold panel to warning red.
- No dimensions, gesture handlers, audio capture, unread calculation, transport,
  Host or headless CLI behaviour changed. CLI impact is not applicable because
  this changes App rendering only.

## Validation

Browser checks cover Android/iOS appearance branches at phone width, desktop
recording, all six Monochrome accents and no-accent, light/dark/system-dark,
legacy palette overrides, preserved counts, desktop neutral badges, recorded
waveform/time colour, cancellation and no accidental send. Canvas resolves CSS
`color-mix()` before checking contrast; small badge digits and the timer must
meet 4.5:1. Existing hold/release, short-press/cancel, small-mic and monochrome
appearance journeys also run. Browser audio uses the existing synthetic
microphone with the real recorder; it is not a physical-device microphone test.

Client TypeScript, translations and production build passed. Chromium **8/8**
and WebKit **8/8** targeted journeys passed, including the new colour matrix
and existing recording controls. Phone-width and desktop screenshots were
inspected; physical Android/iPhone recording was not exercised. No installed
App or production settings are changed by this source revision.

## Desktop follow-up

The owner subsequently requested the same red unread counts on desktop.
Desktop sidebar badges (conversation rows, collapsed Bots/folders and ADHD
lists) now use the phone avatar red with white digits. This overrides selected
row and violet dark/system colours without changing badge dimensions, counts,
read-state handling or the phone's accent-coloured aggregate. App rendering only;
no Host/CLI impact. The existing browser colour journey now checks the desktop
red and contrast across light/dark/system themes and captures desktop previews.

## Desktop choice: small red dots

After comparing dots with avatar-corner numbers in both desktop list layouts,
the owner selected dots. This supersedes the desktop red count-pill treatment
above. Bot lists, conversation lists and the ADHD sidebar use the same small
red dot, including collapsed Bot/folder summaries. The original count stays in
the DOM; conversation/folder badges expose a descriptive accessible name and
hover title, while folded Bots keep their existing spoken/hover summary.
System forced-colour mode uses its own foreground ink so the dot cannot vanish
when the system replaces normal background colours.

Only desktop sidebar rendering changes. Phone avatar counts, phone folder
counts, accent-coloured aggregate totals and recording remain unchanged. No
read receipts, aggregation rules, ordering, Host state or headless CLI changes.
The existing colour journey checks dot size, accessible count, both list modes,
ADHD and disappearance after reading, alongside phone number-badge coverage.
No release or installed-App update is included.

Validation: client translations, TypeScript and production build passed.
Chromium/WebKit passed six focused journeys for colour, phone preservation,
Bot unread/attention aggregation and shared folder operations. The additional
forced-colour check initially reproduced an invisible dot; after the system-ink
fallback, the updated colour/read journey passed again in both engines. Actual
light/dark conversation-list screenshots were inspected. Browser checks do not
claim physical-device or installed-App acceptance.

# UI PR integration review, 2026-10-26

This batch integrates PRs #65–73, #75 and #78–85, retaining their original
commits. The independent reviewer was Claude Opus 5.5 with xhigh effort.
Review covered the combined rendered result, not only each isolated CSS patch.

## Included changes

- Monochrome checkbox, unread badge and active-pane styling (#65, #66, #78).
- Compact cards, recipient control, discussion strip, search results and
  message multi-selection (#67–71).
- Dialog fields, notices and disabled controls (#72, #73). The disabled primary
  button styling is shared across the App, not limited to dialogs.
- Optional Monochrome accent selection and working indicators (#75, #79).
- Phone Bot creation control and unread badge placement (#80, #83).
- Operations cards and removal of an accidentally rendered numeric zero
  for unmanaged Bots (#81, #82).
- A single outlined composer stop glyph and a continuous sidebar/header
  junction (#84, #85). These two PRs were found in the final inventory and
  received an additional review and targeted regression run.

First-run Monochrome with explicit light mode remains the default. Saved
palette, brightness, density and reading-size choices are retained. The optional
Monochrome accent defaults to none; this is separate from the own-bubble shade.

## Corrections made during integration

1. Restore touch targets for card buttons and selects on phones and expanded
   coarse-pointer windows, while retaining compact desktop controls.
2. Remove a permanent fade mask that hid the last forwarding destination.
3. Wrap unbroken Bot names inside operations cards without overlapping the
   avatar control. Correct the avatar-control cascade and the odd action row.
4. Improve Monochrome unread digits, ordered-list markers, working text and
   working-symbol contrast. Keep small decorative bullets on the selected accent.
5. Restore a visible native radio selection in forced-colors mode.
6. Preserve keyboard focus visibility on the empty recipient control without
   reintroducing a pointer-click ring.
7. Normalize unknown stored accent values in the actual multi-host preference
   reader as well as the legacy cache; retain the remaining saved preferences.

The review also reproduced an existing desktop virtual-list race: a location
jump writes the native scroll position before the virtualizer observes it, and
a simultaneous row correction or deferred clamped correction can restore the
old position. Non-iOS reading compensation now waits until the observed and
native positions agree. Accepted immediate navigation publishes the written
position through the existing public observer, cancelling the stale correction
without touching library-private fields. Clamped restores, normal compensation
writes and smooth scrolling retain native observation. The independent iOS
deferred-origin path is preserved.

## Test maintenance

- First-run appearance assertions now expect Monochrome/light. Tests for another
  palette explicitly select that palette.
- Historical hidden theme IDs are exercised through saved preferences, without
  expecting removed Settings controls.
- The recovery fault injector is installed before pairing, so it intercepts the
  subscription it intends to delay.
- The background-report clock is installed before App startup. Installing it
  halfway through the test reset `performance.now()` and mixed timer origins.
  Location assertions also require the destination to be in the viewport.
- The pending-draft test explicitly selects its conversation. Two fixture chats
  can have identical creation times; relying on initial ordering sometimes
  entered text in one conversation and asserted it in the other.

## Verification boundary

Local checks use isolated fixture Hosts and synthetic conversations. Coverage
includes desktop, 320/390-pixel phone widths, expanded touch windows, light/dark
palettes, keyboard navigation and forced colors. Browser WebKit is not physical
iPhone or native-shell acceptance. No production state or running Host is changed.

These changes affect App presentation, local appearance settings and App reading
behavior only. There is no new Host capability, protocol/schema change or
headless CLI command. This integration does not publish or install a release.

### Local results

- Combined UI regression set: 77 passed in Chromium (group settings, search,
  deletion, multi-selection, platform density, phone navigation, operations,
  cards, historical themes and Porcelain details).
- Revised UI and reading set: 33 passed in Chromium. WebKit initially recorded
  31 passed, one forced-colors capability skip and one fixture server startup
  error; the affected phone notification case passed in the later reading run.
- Focused unit set: 19 passed, including a real Virtualizer reproduction of a
  clamped correction followed by a location jump, normal compensation accounting,
  hidden geometry, smooth scrolling and observer teardown.
- ADHD full run: 41 passed; the remaining case was the draft fixture's incorrect
  selector argument during test repair. After correcting it to the conversation
  title, the complete draft-receipt journey passed four consecutive runs.
- Additional reading/composer suites: 11 passed in Chromium, 8 in WebKit.
- Final navigation correction: 20 consecutive background-report location
  journeys passed; the final pane/draft/resize set passed all four journeys.
- The final 18-PR integration passed 39 Chromium checks for Porcelain details,
  sidebar layout/resizing and stop/recovery. The two late visual changes also
  passed WebKit checks covering light/dark appearance and hover behavior.
- Independent Claude Opus 5.5 xhigh review found no remaining blocking issue.
  Its separate Chromium run passed 74 UI checks and 11 targeted probes; the
  reviewer also inspected the final navigation guards and the two late PRs.
- Host build and client translation/type/bundle builds passed. Local privacy
  history checks passed. These results are not GitHub CI or native-device evidence.

One WebKit background-scroll run recorded an anchor displacement before the
synthetic `touchcancel` event. The earlier combined run passed all eight of those
scenarios. The failing scenario then passed three times on both unmodified main
and the revised source, so its cause remains unconfirmed; it is not described as
a fixed bug. The revised observer code explicitly bypasses iOS. Physical-device
scroll verification remains a separate acceptance step.

The deliberately quiet ADHD focus border is retained. Custom message/bulk
selection checkmarks still use their existing filled style. The reviewer noted
these as visual consistency choices, not newly introduced failures.

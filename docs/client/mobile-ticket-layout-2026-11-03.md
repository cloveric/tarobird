# Phone ticket list layout

The phone Chancellor ticket list spread the title/status, update time and
pause/cancel actions across three rows. Queued tickets with no execution metadata
left most of the time row empty, while the actions looked like detached text.

The phone layout now uses one full-width title/status row followed by a shared
secondary row: time/model information on the left, grouped action buttons on the
right. Buttons keep their existing touch height and use the surface background.
Long metadata can shrink; action groups can wrap within a bounded width. Waiting
and stopping explanations and cancellation confirmation remain full-width in
reading order.

This is scoped to widths at or below 760 px. Desktop layout, polling, ticket
ordering, pause/resume/cancel/accept semantics, confirmation and request IDs are
unchanged. Headless CLI impact: none; the existing shared Host actions remain.

Validation:

- Client translation check, TypeScript and production build passed; existing
  bundle-size/mixed-import warnings remain.
- Existing `dispatcher-bot` desktop, iOS-layout and Android-layout journeys:
  **3/3 passed**, including pause, stop-pending, cancel confirmation, acceptance
  and opening the execution conversation. No new policy or action tests needed
  for this CSS-only change.
- Actual App/isolated Hub screenshots were visually reviewed, including the
  owner's single queued-ticket example and the existing mixed-state fixtures.
- At 320/390/412/760 px widths, the single queued row remains 75.5 px high,
  with no horizontal overflow, 36 px action hit areas and no page errors.
  Narrow-screen geometry readback is retained with the preview evidence.
- `git diff --check` passed.

Evidence: `/Volumes/gdrive/taro-tmp.noindex/mobile-ticket-layout-20261103/`.
Browser viewport/platform fixtures are not physical-device acceptance.
No App release or installed-device update is part of this change.

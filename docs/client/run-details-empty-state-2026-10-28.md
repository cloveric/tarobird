# Process reader waiting state

The supplied 478 × 429 screenshot showed the active run's empty journal as a
stack of status, timestamps, technical retention text and a bare empty label.
The reader now separates the current phase from action counts and gives empty,
loading, expired and no-match results a dedicated reading area. A live empty
journal says that records appear as they arrive; it does not imply completion.
Disconnected active runs retain their unconfirmed status and suggest refreshing
after reconnection. Read failures retain their error and retry action rather
than simultaneously claiming there are no records.

Relative freshness and the exact Host timestamp remain visible on two stable
lines. Reporting and retention explanations move into a keyboard-accessible
"About process records" disclosure after the journal. Pagination appears only
when there is another page or a page to return from. Export feedback remains
visible even for a single-page or empty journal. Search, refresh and export keep
their accessible names; icon actions gain hover labels and 44 px touch targets.

The change applies to the shared desktop and phone process reader, with desktop
drawer and phone full-page geometry preserved. It changes no Host API, journal
retention, polling cadence, transport or stored run state. Headless CLI impact:
not applicable; this is App presentation only.

## Verification

Focused browser coverage exercises the waiting state at 320 × 568, 390 × 844,
844 × 390 touch landscape, the supplied 478 × 429 size, and desktop 1360 × 900.
Light/dark screenshots and control bounds cover layout; the same journeys check
the disclosure, no-match search, clearing a query, incoming records, preserved
search drafts/focus, expanded steps and closing. Existing reader regressions
cover slow requests, cancellation, refresh coalescing, scroll restoration and
timestamp changes; scoped-journal regressions cover pagination and export.

Results: 27 Chromium checks and 27 WebKit checks passed. The client translation
check, TypeScript check and production build passed; `git diff --check` passed.
The existing Vite ineffective dynamic-import warning for Capacitor Keyboard
remains unrelated to this reader change. Desktop/phone and short-window
screenshots were inspected, and desktop/phone previews were delivered in App.

Evidence is stored in
`/Volumes/gdrive/taro-tmp/run-details-layout-20261028/`.
Browser verification and a source commit do not update any installed App.
No release, native restart, Mac installation or physical-phone verification is
part of this change.

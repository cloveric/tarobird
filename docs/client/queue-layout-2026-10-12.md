# Queue action alignment

Queue cards already specify two equal-weight columns and fill-width buttons.
The App mapped fill to flex growth only, which grows height inside a vertical
column; the default button `align-self: flex-start` kept its label-sized width.
`card-layout.ts` now also stretches fill-width buttons across that column.
Actions retain their authored order, callback IDs, payloads and danger styling.
Ordinary content-width buttons and weighted-column ratios are unchanged.

Validation:
- Root/client builds pass. Existing Chromium card-layout suite: 5 passed;
  WebKit card-layout and actual question/config callback journeys: 6 passed.
- The existing real-constructor gallery now captures queue cards on desktop and
  phone sizes. The production-style reading fixture supports the same queue card.
- Measured production-style phone layouts: both buttons are 113 x 40 px at
  320px, and 148 x 40 px at 390px, with matching top edges and an 8px gap.
- A separately identified native macOS 1.0.13 App paired to a disposable Hub
  visibly rendered the actual translated queue constructor with symmetric,
  equally wide actions. No model turn or real queue was started for this fixture.
- Physical Android was not tested; its APK includes the shared frontend change.
  The installed App, live Hub and legacy Bot services were left untouched.

Pre-release: `v0.1.386-test.1`, desktop `1.0.13`, Android code `2026101201`.

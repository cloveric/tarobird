# Compact phone chat header — 2026-10-31

## Requested change

The phone chat header repeated the Bot name and current model brand beside the
conversation title. In the reported layout this squeezed the title and status.

`App.tsx` now omits that extra identity whenever its existing phone layout is
active. The conversation avatar/title, detail opener, live reply/offline status,
workbench and More buttons remain. Bot conversation browsing is available through
More and conversation details; removing the redundant shortcut does not remove
that navigation capability. Desktop and ADHD headers retain their identities.
The phone inbox, Bot directory and message author labels are unchanged, as is
the device-local model-icon preference.

The two obsolete phone Bot-shortcut CSS rules were removed. This is purely
client presentation: no Host, schema, pairing, model configuration or headless
CLI behavior changed. It does not change phone layout detection or breakpoints.

## Verification

- Client build passed, including translations and TypeScript. Existing large
  chunk and mixed static/dynamic Capacitor import warnings remain.
- Existing `mobile-im` compact-header journey passed in Chromium and WebKit:
  title and live status remain; phone metadata is absent; a desktop-width resize
  restores the metadata and returning to phone removes it; draft and menu/detail
  Bot browsing survive the round trip and offline navigation.
- Existing `model-brands` journey passed in Chromium: live configuration
  updates reach the desktop header and visible phone list, per-device model-icon
  preferences persist, and offline reload retains the last model brand. The
  fixture now observes the visible phone list rather than its intentionally
  paused hidden render. Its old 14px Bot-directory assertion was corrected to
  the unchanged porcelain theme rule (12px).
- Phone-size screenshots from both browser engines were inspected. These are
  browser layout checks, not installed Android/iOS device acceptance.

No release, local installation or service restart was performed.

## Android title space follow-up — 2026-11-01

The reported Android header left a gap between live activity and the workbench
action while truncating the conversation name. On Android and browser phone
layouts, the title now grows into unused row space, and the action gaps are
removed while retaining the back-button separation. The title/activity gap is
4 px. Workbench and More retain their separate 44 px touch targets.

iOS retains its existing adaptive status threshold; narrowing those gaps there
could reveal the full status at the 240 px container breakpoint and actually
reduce the title width. Desktop/ADHD and history search headers are unchanged.
This is CSS-only and has no Host or headless CLI impact.

Verification uses the existing compact-header journey in Chromium and WebKit
(including desktop resize, drafts, More/details and offline navigation), the
client production build, and an isolated layout comparison at 320/360/390/430
and 1280 px. On the four Android phone widths the title gains 10 px, and the
status-to-workbench-icon gap drops from 17 to 13 px; touch targets stay 44 px.
The iOS and desktop comparison keeps its previous geometry. These are browser
checks, not physical Android/iPhone acceptance. No release or installation.

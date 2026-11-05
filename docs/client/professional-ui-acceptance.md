# Professional UI revision — 2026-10-02

User direction: the prior interface and motion feel too young and lack professional product polish. This revision replaces that visual direction while retaining Bot/chat/group/topic and device behavior. Design and implementation are led by actual Claude Opus 5.5, effort xhigh, with no persisted CLI session. This document records browser acceptance; it is not a native app release claim.

## Baseline audit

Screenshots below were captured from this run before edits, not reused from prior acceptance.

| Step | Surface | Baseline health | Finding |
|---|---|---|---|
| 1 | Desktop navigation and chat | Needs improvement | Repeated animal artwork, pastel role colors, rounded nested cards and large gaps compete with conversation hierarchy. |
| 2 | Welcome and connection | Needs improvement | Mascot hero, animal parade and staggered entrance dominate task entry; action visibility is delayed. |
| 3 | Settings | Needs improvement | Color-coded icon tiles, raised selection and avatar card use excessive visual emphasis for a preferences panel. |
| 4 | Phone conversation | Needs improvement | The same layered card treatment consumes scarce width; message controls and composer need a more deliberate compact rhythm. |
| 5 | Motion and accessibility | Needs improvement | Decorative animation needs to be removed while preserving useful progress indication, reduced motion and virtual row positioning. |

Baseline images: desktop（本地材料：`screenshots/professional-ui/before-chat.png`）, settings（本地材料：`screenshots/professional-ui/before-settings.png`）, home（本地材料：`screenshots/professional-ui/before-home.png`）, pairing（本地材料：`screenshots/professional-ui/before-pairing-live.png`）, phone（本地材料：`screenshots/professional-ui/before-phone.png`）.

The old home fixture at port 57956 was offline; only its visible layout was evaluated. Desktop chat at port 55834 reconnected after an ordinary reload. The new pairing fixture uses a fresh temporary Hub. No production Bot workers or native model sessions were started for visual inspection.

## Result

Implementation completed by Claude Opus 5.5 xhigh, followed by parent review and browser QA. Model receipt（本地材料：`evidence/professional-ui-opus55.json`） and browser measurements（本地材料：`evidence/professional-ui-browser.json`）.

| Step | Surface | Final health | Verification |
|---|---|---|---|
| 1 | Desktop navigation and chat | Pass for this revision | Bot/chat and group/topic hierarchy retained; default monograms and existing custom image both render. Group tabs, native question navigation, answer retention and submitted receipt verified through the UI. A demo reply completed through the real Hub/Gateway; rendered virtual rows have no overlap, animation `none`, transition duration `0s`, and retain their translated positions. |
| 2 | Welcome and connection | Pass | A fresh temporary Hub was paired through its displayed code and normal host CLI approval, then reached the connected home. Three primary actions are immediately visible; welcome elements have zero animations. Pairing at 960px has `scrollWidth = innerWidth = 960`. |
| 3 | Settings | Pass | Desktop light/dark settings and theme switching verified. Grouped fields, neutral category icons and keyboard focus remain visible. |
| 4 | Phone conversation and settings | Pass | At 390×844, document width is 390 with no horizontal overflow. Composer and message-action targets are at least 44×44. Fixed the desktop dialog dimensions overriding the phone rule; settings now measures exactly 390×844. Category navigation and returning to the connection panel verified. Home also checked at 390×700. |
| 5 | Motion and accessibility | Pass for sampled surfaces | With reduced motion, the settings dialog, backdrop and transitions resolve to `none`. Light/dark body contrast is 16.73/14.31; minimum muted text contrast over tested surfaces is 4.58/4.80; primary button contrast is 7.34/5.51. Temporary media/viewport overrides were cleared and the preview theme restored to follow system. |

Parent QA corrections after the Opus implementation:

- Removed the new header “正在回复” spinner because a pending native question can remain waiting for user input. The existing question/run cards and static avatar state remain authoritative.
- Increased phone message-action targets to 44px and reserved matching row height.
- Restated full phone settings width, height and margin in the final stylesheet, correcting the desktop dimensions overriding the earlier responsive sheet.

Current screenshots: desktop chat（本地材料：`screenshots/professional-ui/after-chat.png`）, home（本地材料：`screenshots/professional-ui/after-home.png`）, connection（本地材料：`screenshots/professional-ui/after-pairing.png`）, settings（本地材料：`screenshots/professional-ui/after-settings.png`）, dark settings（本地材料：`screenshots/professional-ui/after-settings-dark.png`）, dark chat（本地材料：`screenshots/professional-ui/after-chat-dark.png`）, phone chat（本地材料：`screenshots/professional-ui/after-phone.png`）, phone navigation（本地材料：`screenshots/professional-ui/after-phone-sidebar.png`）, phone settings（本地材料：`screenshots/professional-ui/after-phone-settings.png`）, phone home（本地材料：`screenshots/professional-ui/after-phone-home.png`）.

## Checks and limits

- Focused tests: 3 files, 15 tests passed (`hub-avatars`, `client-bot-references`, `gateway-card-states`).
- Final required gate: 221 files passed, 3467 tests passed, 1 skipped; root build passed. Frontend translation check, TypeScript and Vite build passed. `git diff --check` passed.
- No dependencies added. Build files decreased from 5,242,737 to 3,573,338 bytes; image assets decreased from 1,928,214 to 247,724 bytes. This is a static package measurement, not a network or model-latency benchmark.
- Browser QA used the Codex in-app browser and isolated local Hub fixtures. CUA locator clicks occasionally targeted the wrong scrolled control; verification was repeated using fresh accessibility targets and checked against the submitted answers. No product change was inferred solely from that automation issue.
- No native app package was rebuilt, no real engine acceptance matrix rerun for this visual revision, and no service fleet or VPS deployment changed. The demo Hub does not enable managed Bot creation, so that dialog was visually inspected without creating a real worker. Existing custom artwork and the favicon remain user/brand assets.

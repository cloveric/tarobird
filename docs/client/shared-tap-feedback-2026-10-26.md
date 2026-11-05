# Shared App touch feedback

## Cause and scope

The October 25 image fix disabled native tap highlighting only on thumbnails
and the viewer. The phone home, attachment plus and message selection each had
their own exception. Process triggers, step summaries and recorded-change
controls still inherited the browser default. A native highlight can outlive
the tapped opener and briefly cover its newly opened dialog.

An isolated touch capture reproduced a pale blue rectangle over the process
dialog and a blue stripe across a step. Chromium reported
`rgba(51, 181, 229, 0.4)`; WebKit reported `rgba(0, 0, 0, 0.4)`.
This is browser tap feedback, separate from message location or model state.

`client/src/styles.css` now sets transparent native tap highlighting at `:root`.
The inherited rule covers the whole App document, including portaled dialogs,
buttons, summaries, links, form labels and nested icon/text hit targets. It is
independent of theme, viewport width and input-device detection, so wide phone
windows and touch-enabled desktop windows use it too. The four component-level
exceptions were removed. New App controls inherit the same policy by default;
do not reintroduce a nontransparent native tap overlay in a feature sheet.

Component CSS pressed/selected states, keyboard focus indicators, focus return,
text selection and touch gestures are unchanged. External pages and sandboxed
HTML widgets own separate documents/styles. This change does not inject styles
into them or alter their scripts. CLI-not-applicable: no Host API, protocol,
message, storage or headless behavior changes.

## Verification

Evidence: `/Volumes/gdrive/taro-tmp/shared-tap-feedback-20261026`.

- `baseline.json`, `after.json` and immediate-release PNGs: real rendered process
  and recorded-diff components, including openers, step/raw-parameter disclosure,
  file list and file details. Both browser engines and light/dark phone layouts
  were checked. All 230 control observations across 28 rendered states changed
  from their browser default to transparent.
- Existing image-viewer touch and keyboard coverage, attachment picker/caption
  flow, process refresh/scroll/focus coverage, recorded-change navigation and
  notes, native text selection, and desktop settings keyboard/focus return were
  run in Chromium and WebKit: 26 tests passed in each engine, with no failures
  or skips. The existing `image-tap-highlight` and
  `run-diff-viewer` suites are now included in the WebKit configuration's allowlist.
- Client translation check, typecheck and production build passed.

Browser engine and touch simulation evidence is not physical Android/iPhone
acceptance. No App release, installation or Host restart is included.

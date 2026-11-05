# Always-enabled App animations — 2026-10-28

The owner explicitly requires App animations to remain enabled on desktop,
Android and iPhone. Removing the App switch alone left a second off path:
`prefers-reduced-motion` disabled reply dots, page motion and loading feedback
through global and component styles, while imperative motion queried the same
system signal. The follow-up removes that suppression from App-owned UI.

## Behavior

- No App animation switch. Legacy `animations: false` preferences still normalize
  to true. System motion signals no longer turn off App-controlled animations.
- Reply indicators, loading spinners, pages, dialogs, keyboard-following layout,
  image inertia, queue/ADHD settling and Bus reveal retain their existing motion.
  iOS immersive-bar calls always request FADE.
- Pointer target stability, input interruption, stale keyboard-event handling,
  resize correction and hidden-page cleanup remain intact. Always enabled is a
  presentation policy, not a request to animate hidden pages or replay history.
- The App's widget wrapper no longer injects a blanket animation-off stylesheet.
  Sandboxed authored content still receives the real system media-query value;
  its own CSS/JavaScript can use that value. We do not falsify device diagnostics.
- Native operating-system UI (keyboard, system dialogs) and browser/native-engine
  scheduling are still controlled by those platforms; no system settings change.

This changes presentation only. Host delivery, model execution and headless CLI
behavior are unchanged; no additional CLI entry point is applicable.

## Verification

Client translation/type checks and production build passed. The standalone
Host/CLI build passed (459 modules). The viewport and native image-viewer suites
passed all 28 unit tests. Across focused runs, 13 Chromium and 11 WebKit browser
cases passed, covering desktop/Android/iOS layout attributes with system reduce
already enabled, live signal changes, reply indicators, dialogs, page geometry,
legacy-off upgrade, queue/ADHD settling, first-click target stability and keyboard
following. These are distinct cases across runs, not one initially green suite.

The first new Chromium assertions used the wrong existing spinner keyframe name
(`run-spin` instead of `spin`); corrected assertions pass. The old keyboard test
also failed on the unchanged switch-removal baseline: it started sampling after
an automation round trip could consume the 285 ms transition. Trigger and sample
now share one browser task; Chromium and WebKit focused reruns pass. An initial
WebKit two-frame timing assertion also passed on focused rerun. An additional
trusted-touch long-image fling test initially observed no coast; the unchanged
baseline and then the candidate both passed isolated runs without a product
change. This timing-sensitive observation is retained in `image.log`,
`baseline-image.log` and `image-r2.log`; it is not a confirmed new product bug.
That adds one passing Chromium case beyond the 24 motion/layout cases above.

Local logs and per-case inventory:
`/Volumes/gdrive/taro-tmp/motion-always-20261028`.
Browser platform attributes are layout coverage, not native or physical-device
acceptance. This source change does not publish or install an App update, and
it does not establish why the owner's currently installed Android was static.

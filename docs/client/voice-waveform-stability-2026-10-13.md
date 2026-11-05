# Stable recording waveform on startup

## Reproduction and repair

Long-pressing the phone's small microphone mounts the recording panel above the
composer. `VoiceWaveform` initially marked its meter unavailable, regardless of
the current AudioContext state. Entering the recording phase inserted the
“音量指示暂不可用” line; the first waveform sample removed it again. This changed
the panel height and its top position. The same component is used by the wide
hold-to-talk button and desktop recording feedback.

A frame-by-frame regression reproduced a **16 CSS px** vertical jump through
permission completion and meter readiness, for both phone recording entry points.

The component now reads current readiness with `useSyncExternalStore`, subscribes
to AudioContext state changes, and removes that readiness update from the waveform
animation loop. The genuine unavailable hint sits within the existing waveform
area, so neither its appearance nor its removal contributes to layout height.
The panel is still sized naturally, including the compact landscape presentation.

Audio sampling, elapsed time, permission handling, release-to-send, slide-to-cancel,
and draft ownership are unchanged.

## Verification

- New regressions sample panel top/height, waveform top, and composer top on every
  animation frame while permission is pending, the meter is suspended, and the
  meter resumes. Both microphone entry points must stay within **1 CSS px**.
  Before the change, both fail at 16 px. They pass in Chromium and WebKit afterward.
- Browser audio input is a synthetic oscillator; MediaRecorder encoding, playback,
  uploads to the isolated test Hub, and draft persistence use the real code paths.
- Existing voice regressions cover short presses, normal sends, slide cancellation,
  denied/late permission, native Back, backgrounding, navigation, narrow and
  landscape safe areas, upload failure, and preserved text/file/audio drafts.
- Client translation/type/production build and root standalone build passed.

The broader WebKit run exposed a pre-existing test-observation race during late
microphone permission: both the analyser and synthetic source context could report
`running` after their real `close()` promises had resolved. Diagnostics captured
this state together with the completed close receipts. The microphone fixture now
records close completion for every AudioContext; cleanup assertions require every
context's completion and every media track's `ended` state. Missing cleanup still
fails the check. The late-permission journey passed three consecutive reruns.
No production recorder lifecycle change was made for this browser test issue.

Final `hold-to-talk`, `voice`, `voice-draft-lifecycle`, and `voice-card` results:
Chromium **23 passed**; WebKit **21 passed**, **2 skipped** (Chromium-only
trusted-touch injection).

## Limits

These are browser and synthetic-touch checks, not physical Android microphone or
OS permission-dialog acceptance. No installed App, APK, desktop installer, or
release asset was updated by this source change.

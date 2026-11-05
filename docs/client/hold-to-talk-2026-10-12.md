# Phone hold-to-talk and microphone waveform

The microphone control now switches the phone composer into a wide **按住说话**
button. Hold to record, release to send just that recording, or slide upward by
64 CSS pixels and release to cancel. Sliding back restores release-to-send.
Existing text, attachments and quote drafts remain intact. The keyboard control
returns to text entry. Desktop recording retains its explicit preview/send flow.

The panel displays elapsed time and a 48-sample waveform driven by microphone
RMS levels, sampled at 20 Hz. Silent input produces dots. An unavailable meter is
labelled rather than animated with fake voice activity. Web Audio has no speaker
output connection. Meter, tracks, timers and animation frames are released after
stop, cancellation or unmount. Colors follow the selected theme; cancellation
uses red. Phone safe-area tokens apply in portrait and landscape.

Only releasing a recording of at least 600 ms sends it. Releasing while waiting
for permission retires the pending capture; a late grant immediately releases
the stream. Denial is retryable. Pointer cancellation, lost capture, window blur,
backgrounding, native Back and navigation cancel a held recording. Keyboard
Space/Enter can be held and released; Escape cancels and repeats are ignored.

Audio is appended to its originating attachment draft before upload starts.
Successful delivery removes only that audio. Failed, cancelled or offline
uploads retain it for preview/retry. Upload progress/recovery and cancellation
remain available in voice mode. A delayed encoder after navigation retains its
output in the original draft instead of sending into a hidden or different chat.
The same existing Hub upload/message and Gateway ASR path handles these files.
No ASR provider or credential changes are included.

## Verification

Focused verification completed:

- Chromium: 11 `hold-to-talk` / `voice` journeys passed, including trusted touch
  injection. The preceding run also passed all 9 `voice-draft-lifecycle` /
  `native-back` cases.
- WebKit: 16 `hold-to-talk` / `voice` / `voice-draft-lifecycle` journeys passed;
  the Chromium-only trusted-touch injection is explicitly skipped.
- Client translation, TypeScript and production build passed.
- Full `scripts/pre-complete-hook.sh` passed: standalone build, 213 test files,
  2,823 tests passed and 1 skipped.
- Android Capacitor sync and `assembleDebug` passed. `testDebugUnitTest` was
  up-to-date; no native source was changed by this feature.
- Screenshots inspected at 390 x 844, 320 x 640 and 740 x 390, including normal
  waveform, cancellation state and injected safe-area insets.

Browser input is a synthetic oscillator with
controllable gain; MediaRecorder encoding, audio decoding/playback, draft storage,
Hub upload and message delivery are real. Gateway ASR in the transport journey is
a deterministic test double. Browser acceptance does not verify a physical phone's
microphone, native permission prompts or touch driver. No installed App update or
new release is implied by this source change.

Primary API references: [Web Audio time-domain samples](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getByteTimeDomainData)
and [pointer capture](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture).

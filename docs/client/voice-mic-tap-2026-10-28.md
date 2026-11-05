# Intermittent phone microphone tap — 2026-10-28

The reported symptom was an unresponsive microphone button that worked on a
later attempt. The screenshot marks the small phone composer microphone. It
does not show a permission prompt, recording panel, upload or ASR error. The
precise failed gesture and the phone's installed package version were not
retained, so the historical incident cannot be uniquely attributed.

## Confirmed local defect

`VoiceMicButton` cancels its long-press timer when a finger moves more than
12 CSS pixels before the 350 ms hold threshold. Previously it also forgot the
pointer. A later `pointerup` consequently did nothing, and the component
discarded the browser's ordinary `click` because it only accepted click events
with `detail === 0` (keyboard/accessibility activation).

Trusted Chromium touch reproduced a 13 px movement inside a 44 px button:
the browser emitted a valid click, but the actual component opened zero times
and never started recording. The same result occurred with the browser network
offline. A regression asserting that this recognized click opens the mode
failed before the change and passes afterward. The isolated fixture uses the
real component with an inert recorder, not a real microphone or model.

The fix still cancels the hold timer on early movement, but retains the pointer
until release or interruption. For this moved gesture only, a genuine subsequent
browser click may open voice mode. Ordinary taps retain their existing
pointer-up behavior; keyboard activation, held recording and upward cancellation
are unchanged. Interrupted gestures clear eligibility, and held gestures cannot
also switch modes when their compatibility click arrives.

## Network evidence and limits

Read-only Host logs contain relay connection failures at 13:42:22.555,
13:44:52.959, 13:47:14.500 and 13:47:37.625 (UTC+08:00), near the screenshot's
13:45 clock. The conversation contains received audio messages at 13:47:58.263,
13:53:12.801 and 13:55:29.031. These establish relay interruptions and later
receipt, not which route the phone used, the failed tap's timestamp or successful
transcription/playback on the phone.

Opening the microphone mode and starting local recording do not make a Host or
ASR request. Network loss can affect later uploading and transcription, but
does not explain the reproduced local dropped-click path. The source fix is
therefore a confirmed defect repair, not proof that every reported voice issue
has the same cause or that the relay issue has been repaired.

## Scope and validation

The source base is `a308e689847d30927bc9fa78ae96709e205e4184`.
`VoiceMicButton`, `HoldToTalk` and `useVoiceRecorder` were unchanged between the
known 1.0.118 release source and that base. No exact phone build identity was
read back. This changes the phone shortcut's gesture handling only; desktop
recording, upload/ASR routing, settings and Host/headless CLI behavior are
unchanged. CLI commands are not applicable to the touch-only correction.

Focused coverage is in `voice-mic-button.spec.ts`: accepted touch movement
online/offline, interrupted and outside drags, one activation per tap/key,
held release, blur and disabling/re-enabling. The existing `hold-to-talk`
journeys exercise synthetic audio with the real browser encoder and isolated
Hubs. They do not use a user's microphone or call a real transcription service.
Build and regression receipts are retained in
`/Volumes/gdrive/taro-tmp/voice-mic-20261028/`. Physical-phone acceptance and an
installed update remain separate; this task does not update the phone or Mac.

Validation passed: the standalone Host build (458 modules), the client
translation/TypeScript/Vite build, and eleven browser cases (eight Chromium,
three WebKit; repeated runs are not added to this count). The WebKit shortcut
check also exercises the moved-pointer click path with native mouse events;
it is not a claim of physical iOS touch coverage. Existing end-to-end cases
cover delayed/denied permission, background/Back cancellation, held sending
with text retained, slide cancellation and stable waveform geometry. Source
format checks pass. The unrelated Android wrapper edit remains untouched.

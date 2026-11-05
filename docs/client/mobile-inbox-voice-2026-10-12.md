# Mobile inbox and microphone refinements

## Behavior in 0.1.399-test.1

- Conversation and Bot rows use spacing without horizontal separators.
- The inbox and Bot directory expose a magnifying glass beside Plus. Search is
  collapsed by default; tapping opens and focuses the field. Closing it clears
  its query, restores the list, and returns focus to the search button. Escape
  and Android Back close search before clearing a Bot scope or leaving a page.
  Nonempty search queries still survive chat and host round trips; an empty
  search closes when switching tabs. Existing history search remains explicit.
- Tapping the small composer microphone still opens hold-to-talk mode. Holding
  it for 350 ms starts recording directly, with the same live audio analyser,
  duration and release/send or slide-up/cancel feedback as the larger button.
  The original pointer target stays mounted. Early movement, pointer loss,
  backgrounding, navigation and releasing before permission arrives cannot send
  a recording. Release sends only that audio and preserves existing drafts.
- ASR cards omit the internal `voice-<timestamp>` recording filename. The client
  also renders existing cards and cards from older hosts cleanly, so updating
  the phone suffices. Meaningful uploaded document names remain; history,
  attachments, transcripts, copy and forwarding data are not rewritten.

## Verification

- Standalone build and all 220 test files passed: 2,858 tests passed, one existing
  skip. Gateway voice tests verify that ASR still passes the transcript and
  original media to the engine, and generated names are absent from the card.
- Chromium and WebKit cover tap/hold, waveform amplitude, release-only sending,
  draft retention, slide cancellation, delayed microphone permission, background
  and Back cancellation. Trusted Chromium touch also covers portrait and short
  landscape with a long text draft. Browsers use a synthetic microphone and the
  real MediaRecorder encoder, never the user's microphone.
- Mobile inbox, cross-host Bot scopes, compact search, history search, settings,
  Back and existing-card presentation passed in both browser engines. Additional
  Chromium voice draft lifecycle checks passed. The first navigation run still
  expected a permanently visible input and synchronous Back rendering; those
  tests were updated for explicit search navigation. One WebKit permission run
  failed its audio-resource cleanup assertion; its isolated rerun passed.
- Inspected screenshots of the compact inbox, recording waveform in portrait
  and landscape, and legacy transcription cards. Clean client installation,
  translations, TypeScript and Vite build passed.
- Android release build, JVM regression task and release lint passed. Final APK
  has version code 2026101214, retains the prior signing certificate, and passes
  the selected-mascot check for all 15 PNG variants and adaptive launcher icons.
  Public assets are compared byte-for-byte with the synchronized native assets.
- Both independently installed production directory and npm archive start their
  isolated Hub and serve the client without the legacy Feishu SDK.

This release is Android-only. No user's paired host, relay or physical phone is
restarted or replaced by these checks. Physical Android/iOS microphone and touch
acceptance remains separate from browser, packaging and JVM evidence.

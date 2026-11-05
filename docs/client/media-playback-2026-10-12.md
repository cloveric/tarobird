# Audio and video playback verification

The existing client already plays inline audio and audio/video file previews.
No application playback code or release version changed in this verification.
The checked source is the implementation included in 0.1.410-test.1.

## Checks

- Chromium and WebKit: two layout journeys each (1360px desktop and 390px phone).
  Every journey downloads four synthetic attachments through a real disposable
  Hub, opens the actual file preview, checks finite duration, advancing playback,
  pause and seeking, then confirms closing the preview stops playback.
  WAV, MP3 and M4A are also delivered as inline audio blocks and played/seeked.
- Android API 36: one native instrumentation journey in the real Capacitor
  WebView, isolated application ID `com.tarocub.client.mediatest`. The same four
  fixture blobs decode, play, pause, seek and resume. MP4 reports 160 x 90 and
  28 decoded video frames. No media gesture preference was overridden.
- Client translation/type/build checks and Android test APK builds pass.
  The disposable Android packages are removed and the test emulator stopped.

| File | Encoding | Android duration | Position after seek/resume |
| --- | --- | ---: | ---: |
| WAV | PCM 16-bit | 3.000 s | 1.707 s |
| MP3 | MP3 | 3.096 s | 1.708 s |
| M4A | AAC | 3.008 s | 1.707 s |
| MP4 | H.264 Baseline + AAC | 3.008 s | 1.735 s |

## Limits

Browser tests prove the actual client UI path. Android instrumentation proves
its native WebView decoder but does not repeat Hub pairing/delivery in the native
shell. WebKit browser checks are not acceptance of the installed macOS App.
The user's physical phone, iOS shell, Bluetooth/headphone output, background
playback and other codecs (including HEVC or unusual MOV/AVI files) are untested.
All probes are muted; these checks validate decode and playback progression,
not subjective speaker quality. Unsupported video formats can use the phone's
Other apps action or a desktop saved file. Media previews currently wait for a
complete, verified attachment download; they do not progressively stream it.

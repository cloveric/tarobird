# Synthetic media fixtures

All samples are generated locally with FFmpeg, contain no user media, and are
three seconds long. Audio is a 440 Hz sine, mono, 16 kHz. Video is the generated
`testsrc2` pattern at 160 x 90 and 12 fps.

- `tone.wav`: PCM signed 16-bit.
- `tone.mp3`: MP3, 48 kbit/s.
- `tone.m4a`: AAC, 48 kbit/s in an MP4 audio container.
- `clip.mp4`: H.264 Baseline / yuv420p + AAC, fast-start MP4.
- `clip-720p.mp4`: the same synthetic pattern scaled to 1280 x 720. Checks that
  a bounded 640px cover does not shrink the player before playback starts.
  Generated with `ffmpeg -i clip.mp4 -vf scale=1280:720 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -preset veryfast -crf 30 -c:a copy -movflags +faststart clip-720p.mp4`.

`media-playback.spec.ts` imports these through a disposable Hub. Android's
`MediaPlaybackTest` bundles the same directory into the instrumentation APK
only, not the application APK. Playback is muted during automation.

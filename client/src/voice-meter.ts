export type VoiceMeter = ReturnType<typeof createVoiceMeter>;

// Create/resume during the user's press, before waiting for microphone approval.
// The analyser has no output connection, so it never plays the mic back aloud.
export function createVoiceMeter() {
  const context = new AudioContext();
  const analyser = context.createAnalyser(); analyser.fftSize = 1024;
  let source: MediaStreamAudioSourceNode | undefined, closed = false;
  void context.resume().catch(() => undefined);
  return {
    context, analyser,
    connect(stream: MediaStream) { if (!closed) { source = context.createMediaStreamSource(stream); source.connect(analyser); } },
    close() { if (closed) return; closed = true; source?.disconnect(); analyser.disconnect(); void context.close().catch(() => undefined); },
  };
}

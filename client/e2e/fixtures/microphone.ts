import type { Page } from "@playwright/test";

// Synthetic microphone; uses the browser's real MediaRecorder and audio encoder.
export async function microphone(page: Page) {
  await page.addInitScript(() => {
    const state = { recorder: undefined as MediaRecorder | undefined, mode: "ok", streams: [] as MediaStream[], contexts: [] as AudioContext[], sourceContexts: [] as AudioContext[], closedSources: [] as AudioContext[], closedContexts: [] as AudioContext[], gain: undefined as GainNode | undefined, calls: 0, resolve: undefined as undefined | (() => void) };
    (window as any).__mic = state;
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) { super(options); state.contexts.push(this); }
      // WebKit may emit a late running state after a pending resume, even after
      // close() has resolved. Record the real API completion for every context.
      override close() { const result = super.close(); void result.then(() => state.closedContexts.push(this)); return result; }
    };
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder { constructor(stream: MediaStream, options?: MediaRecorderOptions) { super(stream, options); state.recorder = this; } };
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getUserMedia", { value: async () => {
      state.calls++; if (state.mode === "deny") throw new DOMException("fixture permission denied", "NotAllowedError");
      if (state.mode === "pending") await new Promise<void>((resolve) => { state.resolve = resolve; });
      const context = new AudioContext(), oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
      state.sourceContexts.push(context);
      const gain = context.createGain(); state.gain = gain;
      oscillator.frequency.value = 440; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
      const stream = destination.stream; state.streams.push(stream);
      let stopped = false;
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => {
        stop(); if (stopped) return; stopped = true; oscillator.stop(); oscillator.disconnect(); gain.disconnect();
        // WebKit can report a late "running" state after close() resolved when
        // this synthetic context was created outside the permission gesture.
        // Keep its close receipt distinct from the application's analyser state.
        void context.close().then(() => state.closedSources.push(context));
      }; }
      return stream;
    } });
  });
}

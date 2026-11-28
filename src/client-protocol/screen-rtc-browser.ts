import { screenRtcCandidateAllowed, screenRtcHasRoute, screenRtcSdpSchema, type ScreenRtcIce, type ScreenRtcMode } from "./screen-rtc.js";

type RtcCodec = NonNullable<ReturnType<typeof RTCRtpReceiver.getCapabilities>>["codecs"][number];

/** The current Electron H.264 RTP encoder does not expose each sample's
 * original presentation timestamp. Require VP8 for the capture proof.
 * Leave the browser's negotiated repair codecs available. */
export function screenRtcCodecs(codecs: RtcCodec[] | undefined): RtcCodec[] {
  const usable = codecs?.filter(value => ["video/vp8", "video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"].includes(value.mimeType.toLowerCase())) ?? [];
  return usable.some(value => value.mimeType.toLowerCase() === "video/vp8") ? usable : [];
}

export function screenRtcConfiguration(mode: ScreenRtcMode, ice?: ScreenRtcIce): RTCConfiguration {
  if (!ice) return { iceServers: [] };
  if (mode === "p2p") return { iceServers: [{ urls: `stun:${ice.address}:${ice.port}` }] };
  return { iceTransportPolicy: "relay", iceServers: [{ urls: `turn:${ice.address}:${ice.port}?transport=udp`, username: ice.username, credential: ice.credential }] };
}

export async function screenRtcGather(peer: RTCPeerConnection, description: RTCSessionDescriptionInit, mode: ScreenRtcMode, signal: AbortSignal) {
  await peer.setLocalDescription(description);
  if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); peer.removeEventListener("icegatheringstatechange", changed); };
    const changed = () => { if (peer.iceGatheringState === "complete") { done(); resolve(); } };
    const abort = () => { done(); reject(signal.reason); };
    const timer = setTimeout(() => { done(); resolve(); }, 2400);
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
  const sdp = screenRtcSdpSchema.parse(peer.localDescription?.sdp.split("\n")
    .filter(line => !line.startsWith("a=candidate:") || screenRtcCandidateAllowed(line, mode)).join("\n"));
  if (!screenRtcHasRoute(sdp, mode)) throw new Error("screen_rtc_candidate_unavailable");
  return sdp;
}

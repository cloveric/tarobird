import { z } from "zod";

export const SCREEN_RTC_FEATURE = "screen.rtc.v1";
export const SCREEN_RTC_CONTROL_CAPABILITY = "screen-rtc-v1";
export const SCREEN_RTC_SEQUENCE_START = 0x80000000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const timestamp = z.number().int().nonnegative().safe();
const revision = z.number().int().min(1).max(0xffffffff);
export const screenRtcModeSchema = z.enum(["lan", "tailscale", "p2p", "relay"]);
export type ScreenRtcMode = z.infer<typeof screenRtcModeSchema>;

export const screenRtcSdpSchema = z.string().min(100).max(11_000).refine(value => {
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(value)) return false;
  const lines = value.split(/\r?\n/);
  const media = lines.filter(line => line.startsWith("m="));
  const fingerprints = lines.filter(line => line.startsWith("a=fingerprint:"));
  return media.length === 1 && /^m=video [1-9]\d{0,4} UDP\/TLS\/RTP\/SAVPF(?: \d{1,3})+$/i.test(media[0])
    && fingerprints.length === 1
    && /^a=fingerprint:sha-256 (?:[a-f\d]{2}:){31}[a-f\d]{2}$/i.test(fingerprints[0])
    && lines.filter(line => line.startsWith("a=candidate:")).every(line => /^a=candidate:\S+ 1 udp /i.test(line));
}, "screen_rtc_description_invalid");

const scope = { sessionId: id, generation: id };
export const screenRtcRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prepare"), ...scope, mode: screenRtcModeSchema }).strict(),
  z.object({ type: z.literal("offer"), ...scope, nonce, sdp: screenRtcSdpSchema, signature }).strict(),
  z.object({ type: z.literal("close"), ...scope, nonce }).strict(),
]);

export const screenRtcIceSchema = z.object({
  address: z.ipv4(), port: z.number().int().min(1).max(65535),
  username: z.string().regex(/^[A-Za-z0-9_-]{24}$/).optional(),
  credential: z.string().regex(/^[A-Za-z0-9_-]{32}$/).optional(),
}).strict().refine(value => !!value.username === !!value.credential);
export type ScreenRtcIce = z.infer<typeof screenRtcIceSchema>;
export const screenRtcPrepareSchema = z.object({ nonce, mode: screenRtcModeSchema, ice: screenRtcIceSchema.optional() }).strict();
export const screenRtcAnswerSchema = z.object({ sdp: screenRtcSdpSchema, signature }).strict();
export type ScreenRtcAnswer = z.infer<typeof screenRtcAnswerSchema>;

export const screenRtcServiceCommands = [
  z.object({ type: z.literal("rtc-offer"), sessionId: id, nonce, sdp: screenRtcSdpSchema, mode: screenRtcModeSchema, ice: screenRtcIceSchema.optional() }).strict(),
  z.object({ type: z.literal("rtc-close"), sessionId: id, nonce }).strict(),
  z.object({ type: z.literal("rtc-activate"), sessionId: id, nonce }).strict(),
] as const;
export const screenRtcServiceEvents = [
  z.object({ type: z.literal("rtc-answer"), sessionId: id, nonce, sdp: screenRtcSdpSchema }).strict(),
  z.object({ type: z.literal("rtc-failed"), sessionId: id, nonce }).strict(),
  z.object({ type: z.literal("rtc-frame"), sessionId: id, nonce, streamGeneration: revision, frameSequence: z.number().int().min(SCREEN_RTC_SEQUENCE_START).max(0xffffffff),
    rtpTimestamp: z.number().int().min(0).max(0xffffffff), captureMs: timestamp }).strict(),
] as const;
export const screenRtcFrameSchema = screenRtcServiceEvents[2];
export const screenRtcViewerFrameSchema = screenRtcFrameSchema.extend({ generation: id }).strict();
export type ScreenRtcFrame = z.infer<typeof screenRtcFrameSchema>;

export function screenRtcOfferText(scope: { sessionId: string; generation: string; deviceId: string; nonce: string; mode: ScreenRtcMode; sdp: string }) {
  return JSON.stringify(["tarobird/screen-rtc-offer/v1", scope.sessionId, scope.generation, scope.deviceId, scope.nonce, scope.mode, scope.sdp]);
}
export function screenRtcAnswerText(scope: { sessionId: string; generation: string; desktopId: string; deviceId: string; nonce: string; mode: ScreenRtcMode; sdp: string; offer: string }) {
  return JSON.stringify(["tarobird/screen-rtc-answer/v1", scope.sessionId, scope.generation, scope.desktopId, scope.deviceId, scope.nonce, scope.mode, scope.offer, scope.sdp]);
}

export function screenRtcHostRoute(address?: string) {
  if (!address) return;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(address) || /^fd7a:115c:a1e0:/i.test(address)) return "udp_tailscale_direct" as const;
  if (/^(?:(?:10|127)\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::1$)/i.test(address)) return "udp_lan_direct" as const;
}

/** Both ends explicitly eliminate TCP and candidates outside this attempt's
 * route from the authenticated SDP. Local mDNS host candidates are LAN only. */
export function screenRtcCandidateAllowed(line: string, mode: ScreenRtcMode): boolean {
  const [, component, protocol, , address, , typ, kind] = line.trim().split(/\s+/);
  if (component !== "1" || protocol?.toLowerCase() !== "udp" || typ !== "typ") return false;
  if (mode === "relay") return kind === "relay";
  if (mode === "p2p") return kind === "srflx";
  const route = screenRtcHostRoute(address);
  if (mode === "tailscale") return kind === "host" && route === "udp_tailscale_direct";
  return kind === "host" && (route === "udp_lan_direct" || /^[^.]+\.local$/i.test(address ?? ""));
}
export function screenRtcHasRoute(sdp: string, mode: ScreenRtcMode, endpoint?: ScreenRtcIce): boolean {
  const candidates = sdp.split(/\r?\n/).filter(line => line.startsWith("a=candidate:"));
  return candidates.length > 0 && candidates.length <= 32 && candidates.every(candidate => {
    if (!screenRtcCandidateAllowed(candidate, mode)) return false;
    const address = candidate.trim().split(/\s+/);
    return mode !== "relay" || !endpoint || address[4] === endpoint.address && address[5] === String(endpoint.port);
  });
}

export function screenRtcDirection(sdp: string, direction: "recvonly" | "sendonly"): boolean {
  const attributes = sdp.split(/\r?\n/).filter(line => /^a=(sendrecv|recvonly|sendonly|inactive)$/.test(line));
  return attributes.length === 1 && attributes[0] === `a=${direction}`;
}

import { z } from "zod";
import { SCREEN_MAC_KEYCODES } from "./screen-keys.js";
import { idSchema } from "./index.js";
import { deviceActionProofSchema } from "./device-actions.js";
import { SCREEN_QUALITIES, SCREEN_STREAM_MAX_AREA, SCREEN_STREAM_MAX_EDGE } from "./screen-quality.js";

export const REMOTE_SCREEN_CAPABILITY = "desktop.screen.v1";
/** Hub → App (`serverCapabilities`): `screenOpen` accepts `quality`. Whether the
 * registered target can honour it is decided per open: an explicit refusal
 * (`screen_quality_unsupported`), or `join.quality` confirming it. */
export const REMOTE_SCREEN_QUALITY_CAPABILITY = "desktop.screen.quality.v1";
/** Host control socket → target (`controlCapabilities`): the hello may carry `features`. */
export const SCREEN_CONTROL_QUALITY_CAPABILITY = "screen-quality-v1";
/** Target → Hub (hello `features`): `start` may carry `quality`. */
export const SCREEN_SERVICE_QUALITY_FEATURE = "screen.quality.v1";
export const screenQualitySchema = z.enum(SCREEN_QUALITIES);
export const SCREEN_MAX_VIEWERS = 2;
export const SCREEN_LEASE_MS = 6000;
export const SCREEN_FRAME_FRESH_MS = 2000;
export const SCREEN_TICKET_MS = 30000;
export const SCREEN_MAX_FRAME_BYTES = 1024 * 1024;
export const SCREEN_MAX_CONTROL_BYTES = 16384;
const integer = z.number().int().nonnegative().safe();
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicKey = z.string().regex(/^[A-Za-z0-9+/]{59}=$/);
const revision = z.number().int().positive().max(0xffffffff);
const displayId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const screenGrantSchema = z.object({ deviceId: idSchema, publicKey, permission: z.enum(["view", "control"]) }).strict();
export const screenPolicySchema = z.object({ revision: integer, enabled: z.boolean(), grants: z.array(screenGrantSchema).max(64) }).strict()
  .refine(v => new Set(v.grants.map(g => g.deviceId)).size === v.grants.length, "duplicate_screen_device");
export type ScreenPolicy = z.infer<typeof screenPolicySchema>;
export const screenConfigureSchema = z.object({ operation: z.literal("screen.configure"), expectedRevision: integer, enabled: z.boolean(), grants: z.array(screenGrantSchema).max(64), requestId: idSchema }).strict()
  .refine(v => new Set(v.grants.map(g => g.deviceId)).size === v.grants.length, "duplicate_screen_device");
export type ScreenConfigure = z.infer<typeof screenConfigureSchema>;
export const signedScreenConfigureSchema = z.object({ command: screenConfigureSchema, proof: deviceActionProofSchema }).strict();
/** Stable, domain-separated signed intent, shared by App/CLI/Host. */
export function screenConfigureText(command: ScreenConfigure): string {
  const v = screenConfigureSchema.parse(command);
  return JSON.stringify(["tarobot/screen-configure/v1", v.expectedRevision, v.enabled,
    [...v.grants].sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0).map(g => [g.deviceId, g.publicKey, g.permission]), v.requestId]);
}
export const screenDisplaySchema = z.object({
  id: displayId, nativeId: z.string().regex(/^[0-9]{1,20}$/), name: z.string().min(1).max(128), revision,
  x: z.number().int().min(-65536).max(65536), y: z.number().int().min(-65536).max(65536),
  width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
  scale: z.number().finite().min(.25).max(8), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
}).strict();
export type ScreenDisplay = z.infer<typeof screenDisplaySchema>;
export const screenDesktopSchema = z.object({
  desktopId: idSchema, instanceId: idSchema, loginSession: idSchema, platform: z.literal("macos"),
  capture: z.enum(["granted", "denied", "not-determined", "unavailable"]),
  accessibility: z.boolean(), locked: z.boolean(),
  displays: z.array(screenDisplaySchema).max(16),
}).strict().refine(v => new Set(v.displays.map(d => d.id)).size === v.displays.length, "duplicate_screen_display");
export type ScreenDesktop = z.infer<typeof screenDesktopSchema>;
export const screenOpenSchema = z.object({ desktopId: idSchema, displayId, displayRevision: revision, requestId: idSchema, codecs: z.array(z.enum(["h264", "vp8"])).min(1).max(2).default(["vp8"]),
  // Omitted: the legacy default (balanced), exactly as before quality existed.
  quality: screenQualitySchema.optional() }).strict();
export const screenSessionSchema = z.object({
  id: idSchema, desktopId: idSchema, deviceId: idSchema, deviceName: z.string().max(128),
  generation: idSchema, display: screenDisplaySchema, controlAllowed: z.boolean(),
  state: z.enum(["connecting", "viewing", "paused", "controlling", "closed"]),
  createdAt: integer, reason: z.string().max(128).optional(),
}).strict();
export type ScreenSession = z.infer<typeof screenSessionSchema>;
export const screenStatusSchema = z.object({
  supported: z.literal(true), enabled: z.boolean(), canManage: z.boolean(), permission: z.enum(["none", "view", "control"]),
  policy: screenPolicySchema.optional(), devices: z.array(z.object({ id: idSchema, name: z.string(), platform: z.string(), publicKey }).strict()).max(256).optional(), desktop: screenDesktopSchema.nullable(),
  sessions: z.array(screenSessionSchema).max(SCREEN_MAX_VIEWERS), serverTime: integer,
}).strict();
export type ScreenStatus = z.infer<typeof screenStatusSchema>;
/** `quality` is present only when the open requested it and the Host and its
 * target accepted it; it is that session's fixed quality. */
export const screenJoinSchema = z.object({ session: screenSessionSchema, controlTicket: token, mediaTicket: token, expiresAt: integer, serverTime: integer, quality: screenQualitySchema.optional() }).strict();
export type ScreenJoin = z.infer<typeof screenJoinSchema>;

const point = { x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) };
export const screenKeyCodeSchema = z.string().max(32).refine(code => Object.hasOwn(SCREEN_MAC_KEYCODES, code), "screen_key_unknown");
export const screenInputEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), ...point }).strict(),
  z.object({ kind: z.literal("button"), ...point, button: z.union([z.literal(0), z.literal(1), z.literal(2)]), down: z.boolean(), clicks: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
  // W3C pixels only: positive dy scrolls content down. Convert line/page modes before sending.
  z.object({ kind: z.literal("wheel"), ...point, dx: z.number().finite().min(-2000).max(2000), dy: z.number().finite().min(-2000).max(2000) }).strict(),
  z.object({ kind: z.literal("key"), code: screenKeyCodeSchema, down: z.boolean() }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(2048).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) && [...s].every(c => c.length === 2 || !/[\ud800-\udfff]/.test(c)), "invalid_screen_text") }).strict(),
]);
export type ScreenInputEvent = z.infer<typeof screenInputEventSchema>;
export const screenInputSchema = z.object({
  type: z.literal("input"), sessionId: idSchema, desktopId: idSchema, generation: idSchema,
  displayId, displayRevision: revision, leaseId: token, sequence: revision,
  frameSequence: revision, expiresAt: integer, event: screenInputEventSchema,
}).strict();
export type ScreenInput = z.infer<typeof screenInputSchema>;
export const screenViewerCommandSchema = z.discriminatedUnion("type", [
  screenInputSchema,
  z.object({ type: z.literal("control"), sessionId: idSchema, generation: idSchema, frameSequence: revision }).strict(),
  z.object({ type: z.literal("renew"), sessionId: idSchema, generation: idSchema, leaseId: token, frameSequence: revision, challenge: token }).strict(),
  z.object({ type: z.literal("release"), sessionId: idSchema, generation: idSchema }).strict(),
  z.object({ type: z.literal("visibility"), sessionId: idSchema, generation: idSchema, visible: z.boolean() }).strict(),
  z.object({ type: z.literal("keyframe"), sessionId: idSchema, generation: idSchema }).strict(),
  z.object({ type: z.literal("ack"), sessionId: idSchema, generation: idSchema, frameSequence: revision }).strict(),
  z.object({ type: z.literal("disconnect"), sessionId: idSchema, generation: idSchema }).strict(),
]);
export type ScreenViewerCommand = z.infer<typeof screenViewerCommandSchema>;

/** Each input is authorized again at the target; a queued command is not a lease. */
export const screenServiceCommandSchema = z.discriminatedUnion("type", [
  // `quality` is sent only to a target whose hello advertised SCREEN_SERVICE_QUALITY_FEATURE.
  z.object({ type: z.literal("start"), session: screenSessionSchema, mediaTicket: token, streamGeneration: revision, codecs: z.array(z.enum(["h264", "vp8"])).min(1).max(2), quality: screenQualitySchema.optional() }).strict(),
  z.object({ type: z.literal("stop"), sessionId: idSchema, reason: z.string().max(128) }).strict(),
  z.object({ type: z.literal("pause"), sessionId: idSchema, paused: z.boolean(), streamGeneration: revision }).strict(),
  z.object({ type: z.literal("reset"), sessionId: idSchema, streamGeneration: revision }).strict(),
  z.object({ type: z.literal("ack"), sessionId: idSchema, frameSequence: revision, streamGeneration: revision }).strict(),
  z.object({ type: z.literal("lease"), sessionId: idSchema, generation: idSchema, leaseId: token, expiresAt: integer, frameSequence: revision, streamGeneration: revision }).strict(),
  z.object({ type: z.literal("release"), sessionId: idSchema, reason: z.string().max(128) }).strict(),
  screenInputSchema,
]);
export type ScreenServiceCommand = z.infer<typeof screenServiceCommandSchema>;

/** Sent on the same media socket before any binary packet of this generation.
 * Only full-display capture is supported: no inferred crop or letterbox.
 * Sizes above 1920 / 1920×1080 occur only in a `sharp` session (the Hub
 * enforces each session's quality caps), so a viewer that never asked for
 * quality never receives one. */
export const screenStreamSchema = z.object({
  type: z.literal("stream"), streamGeneration: revision, geometryRevision: revision,
  codec: z.enum(["h264", "vp8"]), codecString: z.string().max(64),
  width: z.number().int().min(1).max(SCREEN_STREAM_MAX_EDGE), height: z.number().int().min(1).max(SCREEN_STREAM_MAX_EDGE),
  contentRect: z.object({ x: z.literal(0), y: z.literal(0), width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
}).strict().refine(s => (s.codec === "h264" ? /^avc1\.[0-9a-fA-F]{6}$/.test(s.codecString) : s.codecString === "vp8")
  && s.width * s.height <= SCREEN_STREAM_MAX_AREA && s.contentRect.width === s.width && s.contentRect.height === s.height, "screen_stream_invalid");
export type ScreenStream = z.infer<typeof screenStreamSchema>;
export const screenServiceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), desktop: screenDesktopSchema }).strict(),
  z.object({ type: z.literal("lease-ready"), sessionId: idSchema, leaseId: token }).strict(),
  z.object({ type: z.literal("lease-denied"), sessionId: idSchema, leaseId: token, reason: z.enum(["screen_frame_stale", "screen_lease_invalid", "screen_input_denied", "screen_geometry_changed", "screen_locked", "screen_takeover_unavailable"]) }).strict(),
  z.object({ type: z.literal("frame-confirmed"), sessionId: idSchema, frameSequence: revision, streamGeneration: revision, captureMs: integer }).strict(),
  z.object({ type: z.literal("stop"), sessionId: idSchema.optional(), reason: z.enum(["screen_local_takeover", "screen_capture_failed", "screen_input_failed", "screen_locked", "screen_service_stopped", "screen_congested", "screen_geometry_changed", "screen_capture_stale"]) }).strict(),
]);
export const screenHelloSchema = z.object({ type: z.literal("hello"), ticket: token }).strict();
/** `features` only after the Host advertised SCREEN_CONTROL_QUALITY_CAPABILITY:
 * an older Hub parses this hello strictly. Unknown feature names are ignored. */
export const screenServiceHelloSchema = screenHelloSchema.extend({ desktop: screenDesktopSchema,
  features: z.array(z.string().regex(/^[a-z0-9.-]{1,32}$/)).max(16).optional() }).strict();
export const screenStopSchema = z.object({ sessionId: idSchema.optional() }).strict();
export const screenViewerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attached"), sessionId: idSchema }).strict(),
  z.object({ type: z.literal("state"), session: screenSessionSchema, serverTime: integer, controlPending: z.boolean().optional(), streamGeneration: revision.optional(),
    lease: z.object({ id: token, expiresAt: integer, challenge: token, challengeExpiresAt: integer }).strict().optional() }).strict(),
  z.object({ type: z.literal("frame-ready"), sessionId: idSchema, generation: idSchema, streamGeneration: revision, frameSequence: revision, expiresAt: integer }).strict(),
]);

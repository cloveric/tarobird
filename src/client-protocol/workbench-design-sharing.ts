import { z } from "zod";
import { designFormatSchema, designPath } from "./workbench-design.js";

// Authenticated collaboration on one Baoyu document across this Host's
// devices and conversation members. The source device keeps the document and
// its history; the Host only authenticates, authorizes and relays bounded
// frames over the existing App socket. There is no LAN listener, share link,
// bearer token or public endpoint, and nothing is "synced" while the source
// device is offline: writes then fail instead of queueing.

export const WORKBENCH_DESIGN_SHARE_CAPABILITY = "workbench.design.share.v1"; // Host `ready`
export const DESIGN_SHARE_CLIENT_CAPABILITY = "design.share.v1"; // App `hello`
export const DESIGN_SHARE_LIMITS = {
  /** Raw bytes per transferred chunk; base64 stays far below the 1 MiB socket frame. */
  chunkBytes: 256 * 1024, fileBytes: 8 * 1024 * 1024, commitFiles: 512, callBytes: 256 * 1024,
  resultInlineBytes: 512 * 1024, resultBytes: 64 * 1024 * 1024, resultBufferBytes: 128 * 1024 * 1024,
  sharesPerOwner: 16, membersPerShare: 32, peersPerShare: 16, inflightPerUser: 4,
  stagedBytesPerUser: 48 * 1024 * 1024, stagedBytesTotal: 192 * 1024 * 1024, stageTtlMs: 120_000,
  dispatchTimeoutMs: 25_000, presenceBytes: 4096, presenceFields: 12, presenceIntervalMs: 50, tombstoneMs: 7 * 86_400_000,
} as const;
export type DesignShareLimits = { -readonly [K in keyof typeof DESIGN_SHARE_LIMITS]: number };

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().safe();
const offset = z.number().int().nonnegative().max(DESIGN_SHARE_LIMITS.fileBytes);
export const designShareIdSchema = z.string().regex(/^ds_[a-z0-9]{24}$/);
export const designShareRoleSchema = z.enum(["editor", "commenter", "viewer"]);
export type DesignShareRole = z.infer<typeof designShareRoleSchema>;
export type DesignShareParticipantRole = "owner" | DesignShareRole;
const chunk = z.string().max(Math.ceil(DESIGN_SHARE_LIMITS.chunkBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** A bounded UTF-8 JSON response fragment; only complete, ordered responses are exposed. */
export const designShareResultPartSchema = z.object({
  size: z.number().int().positive().max(DESIGN_SHARE_LIMITS.resultBytes),
  offset: z.number().int().nonnegative().max(DESIGN_SHARE_LIMITS.resultBytes), base64: chunk,
}).strict();
export type DesignShareResultPart = z.infer<typeof designShareResultPartSchema>;
const bounded = (bytes: number) => z.unknown().refine(value => value === undefined || new TextEncoder().encode(JSON.stringify(value)).length <= bytes, "design_share_payload_too_large");
export const designShareCommitEntrySchema = z.union([
  z.object({ sha256: sha, size: z.number().int().nonnegative().max(DESIGN_SHARE_LIMITS.fileBytes), contentType: z.string().min(1).max(128).regex(/^[\w.+-]+\/[\w.+-]+(?:;charset=utf-8)?$/), ifMatch: sha.nullable() }).strict(),
  z.object({ delete: z.literal(true), ifMatch: sha.nullable() }).strict(),
]);
/** Small operations relayed to the source session (same names as DesignSession.request). */
export const designShareCallSchema = z.enum(["session", "list", "comments.snapshot", "comments.create", "comments.status", "comments.delete", "comments.reply", "comments.edit", "comments.sent",
  "db.list", "db.read", "db.write", "history.list", "history.diff", "restore"]);
export type DesignShareCall = z.infer<typeof designShareCallSchema>;
/** `list` returns the full manifest (assets included, no bytes); contents move only by chunked `fetch`. */
export const DESIGN_SHARE_READ_CALLS: readonly DesignShareCall[] = ["session", "list", "comments.snapshot", "db.list", "db.read", "history.list", "history.diff"];
export const DESIGN_SHARE_COMMENT_CALLS: readonly DesignShareCall[] = ["comments.create", "comments.status", "comments.delete", "comments.reply", "comments.edit"];

export const designShareRequestSchema = z.discriminatedUnion("op", [
  // Owner, on the device that holds the document. Requires an explicit user action.
  z.object({ op: z.literal("open"), conversationId: id, designId: id, windowId: id, title: z.string().trim().min(1).max(128), format: designFormatSchema, revision }).strict(),
  z.object({ op: z.literal("attach"), shareId: designShareIdSchema, windowId: id, revision }).strict(),
  /** The source window closed or stopped sharing for now; the share and its grants remain. */
  z.object({ op: z.literal("detach"), shareId: designShareIdSchema, windowId: id }).strict(),
  z.object({ op: z.literal("close"), shareId: designShareIdSchema }).strict(),
  z.object({ op: z.literal("grant"), shareId: designShareIdSchema, userId: id, role: designShareRoleSchema.nullable() }).strict(),
  // Anyone in the conversation: shares visible to them, and the people a grant can name.
  z.object({ op: z.literal("list"), conversationId: id }).strict(),
  z.object({ op: z.literal("members"), conversationId: id }).strict(),
  // Participants (owner's other devices and granted members), one session per App window.
  z.object({ op: z.literal("join"), shareId: designShareIdSchema, windowId: id }).strict(),
  z.object({ op: z.literal("leave"), shareId: designShareIdSchema, windowId: id }).strict(),
  z.object({ op: z.literal("presence"), shareId: designShareIdSchema, windowId: id, patch: z.record(z.string().max(32), z.unknown()) }).strict(),
  z.object({ op: z.literal("stage"), shareId: designShareIdSchema, windowId: id, sha256: sha, size: z.number().int().nonnegative().max(DESIGN_SHARE_LIMITS.fileBytes), offset, base64: chunk }).strict(),
  z.object({ op: z.literal("commit"), shareId: designShareIdSchema, windowId: id, baseRevision: revision, files: z.record(designPath, designShareCommitEntrySchema).refine(files => Object.keys(files).length > 0 && Object.keys(files).length <= DESIGN_SHARE_LIMITS.commitFiles, "design_file_count") }).strict(),
  z.object({ op: z.literal("call"), shareId: designShareIdSchema, windowId: id, call: designShareCallSchema, payload: bounded(DESIGN_SHARE_LIMITS.callBytes) }).strict(),
  z.object({ op: z.literal("fetch"), shareId: designShareIdSchema, windowId: id, sha256: sha, offset }).strict(),
  // Source window only (the exact attached window).
  z.object({ op: z.literal("pull"), shareId: designShareIdSchema, windowId: id, dispatchId: id, sha256: sha, offset }).strict(),
  /** Immediately before the source persists a write: the Host re-checks the requester, membership, role and grant epoch. */
  z.object({ op: z.literal("admit"), shareId: designShareIdSchema, windowId: id, dispatchId: id }).strict(),
  z.object({ op: z.literal("reply"), shareId: designShareIdSchema, windowId: id, dispatchId: id, ok: z.boolean(), result: bounded(DESIGN_SHARE_LIMITS.resultInlineBytes).optional(), part: designShareResultPartSchema.optional(), error: z.string().max(128).optional() }).strict().refine(value => !value.part || value.ok && value.result === undefined && value.error === undefined, "design_share_bad_chunk"),
  z.object({ op: z.literal("changed"), shareId: designShareIdSchema, windowId: id, revision, files: z.record(designPath, sha.nullable()).refine(files => Object.keys(files).length <= DESIGN_SHARE_LIMITS.commitFiles, "design_file_count"),
    by: z.object({ id: z.string().max(200), name: z.string().max(100), agent: z.literal(true).optional() }).strict().optional(), comments: z.literal(true).optional() }).strict(),
]);
export type DesignShareRequest = z.infer<typeof designShareRequestSchema>;
export const designShareRequestFrameSchema = z.object({ v: z.literal(1), type: z.literal("design.share.request"), requestId: id, request: designShareRequestSchema }).strict();
export type DesignShareRequestFrame = z.infer<typeof designShareRequestFrameSchema>;

// Host → App.
export const designShareResultFrameSchema = z.object({ v: z.literal(1), type: z.literal("design.share.result"), requestId: id, ok: z.boolean(), result: z.unknown().optional(), part: designShareResultPartSchema.optional(), error: z.string().max(128).optional() }).strict().refine(value => !value.part || value.ok && value.result === undefined && value.error === undefined, "design_share_bad_chunk");
export type DesignShareResultFrame = z.infer<typeof designShareResultFrameSchema>;
export const designSharePeerSchema = z.object({ peer: id, userId: id, name: z.string().max(100), role: z.enum(["owner", "editor", "commenter", "viewer"]), source: z.boolean(), presence: z.record(z.string(), z.unknown()), updatedAt: z.number() }).strict();
export type DesignSharePeerView = z.infer<typeof designSharePeerSchema>;
export const designShareEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("peers"), peers: z.array(designSharePeerSchema).max(DESIGN_SHARE_LIMITS.peersPerShare + 1) }).strict(),
  z.object({ type: z.literal("source"), online: z.boolean(), revision: revision.optional() }).strict(),
  z.object({ type: z.literal("changed"), revision, files: z.record(z.string(), sha.nullable()), by: z.object({ id: z.string(), name: z.string(), agent: z.literal(true).optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal("comments") }).strict(),
  z.object({ type: z.literal("role"), role: z.enum(["owner", "editor", "commenter", "viewer"]) }).strict(),
  z.object({ type: z.literal("revoked"), reason: z.enum(["removed", "membership", "closed", "device"]) }).strict(),
]);
export type DesignShareEvent = z.infer<typeof designShareEventSchema>;
export const designShareEventFrameSchema = z.object({ v: z.literal(1), type: z.literal("design.share.event"), shareId: designShareIdSchema, generation: z.number().int().positive(), event: designShareEventSchema }).strict();
export type DesignShareEventFrame = z.infer<typeof designShareEventFrameSchema>;
/** Host → source device: one participant's request, already authorized. */
export const designShareDispatchFrameSchema = z.object({
  v: z.literal(1), type: z.literal("design.share.dispatch"), shareId: designShareIdSchema, generation: z.number().int().positive(), dispatchId: id, deadline: z.number().int().positive(),
  from: z.object({ userId: id, name: z.string().max(100), role: z.enum(["owner", "editor", "commenter", "viewer"]), requestId: id }).strict(),
  kind: z.enum(["commit", "call", "fetch"]), payload: z.unknown(),
}).strict();
export type DesignShareDispatchFrame = z.infer<typeof designShareDispatchFrameSchema>;
export const designShareCancelFrameSchema = z.object({ v: z.literal(1), type: z.literal("design.share.cancel"), shareId: designShareIdSchema, dispatchId: id, reason: z.string().max(128) }).strict();
export type DesignShareCancelFrame = z.infer<typeof designShareCancelFrameSchema>;
export type DesignShareServerFrame = DesignShareResultFrame | DesignShareEventFrame | DesignShareDispatchFrame | DesignShareCancelFrame;
/** A content chunk (fetch/pull result). */
export const designShareChunkSchema = z.object({ sha256: sha, size: z.number().int().nonnegative().max(DESIGN_SHARE_LIMITS.fileBytes), offset, base64: chunk, contentType: z.string().max(128).optional(), eof: z.boolean() }).strict();
export type DesignShareChunk = z.infer<typeof designShareChunkSchema>;

const PRESENCE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/, COLOR = /^#[0-9a-fA-F]{6}$/;
function plainJson(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every(item => plainJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= 16 && entries.every(([key, item]) => !["__proto__", "constructor", "prototype"].includes(key) && plainJson(item, depth + 1));
}
/** Presence a page may set: identifier keys, plain JSON, bounded; `who` keeps a color only (the Host names people). `null` deletes. */
export function sanitizeDesignPresence(patch: unknown, current: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return undefined;
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!PRESENCE_KEY.test(key) || key === "constructor" || key === "prototype") return undefined;
    if (value === null || value === undefined) { delete next[key]; continue; }
    if (key === "who") { const color = typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).c : undefined; next.who = typeof color === "string" && COLOR.test(color) ? { c: color } : {}; continue; }
    if (!plainJson(value, 0)) return undefined;
    next[key] = value;
  }
  if (Object.keys(next).length > DESIGN_SHARE_LIMITS.presenceFields || new TextEncoder().encode(JSON.stringify(next)).length > DESIGN_SHARE_LIMITS.presenceBytes) return undefined;
  return next;
}

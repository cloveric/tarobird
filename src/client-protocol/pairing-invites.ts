import { z } from "zod";

// Self-contained on purpose: index.ts may import the capability from here, so
// this module must not import index.ts (an import cycle would leave schemas in
// their temporal dead zone). The device fields mirror `pairingSchema`; a test
// keeps both in step.

export const PAIRING_INVITES_CAPABILITY = "pairing-invites.v1";
/** Owner session: POST issues, GET lists the caller's own invites. */
export const PAIRING_INVITES_PATH = "/api/devices/invites";
/** Owner session: closes one of the caller's own invites to new admissions. */
export const PAIRING_INVITE_REVOKE_PATH = "/api/devices/invites/revoke";
/** Query parameter beside `data` in `tarocub://pair?data=...&invite=...`.
 * The v1 `data` JSON is unchanged, so older Apps can still read routes. */
export const PAIRING_INVITE_LINK_PARAM = "invite";
export const PAIRING_INVITE_TTL_MS = 5 * 60_000;
export const MAX_PAIRING_INVITES_PER_CREATOR = 8;
export const MAX_PAIRING_INVITES = 64;

const base64url43 = /^[A-Za-z0-9_-]{43}$/;
/** 32 random bytes, base64url without padding. Shown once to its creator. */
export const pairingInviteTokenSchema = z.string().regex(base64url43);
/** 16 random bytes, base64url without padding. Not a credential. */
export const pairingInviteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
/** Caller-chosen 32 random bytes (the client's `randomNonce()` format). */
export const pairingRequestIdSchema = z.string().regex(base64url43);

/** A retry with the same `requestId` closes the unclaimed invite that request
 * produced before, so a lost response cannot exhaust the caller's capacity.
 * `replaces` closes one more of the caller's own invites; it never touches
 * another creator's invite. Neither option closes anything if issuance fails. */
export const pairingInviteCreateSchema = z.object({ requestId: pairingRequestIdSchema, replaces: pairingInviteIdSchema.optional() }).strict();
export type PairingInviteCreate = z.infer<typeof pairingInviteCreateSchema>;
export const pairingInviteRevokeSchema = z.object({ id: pairingInviteIdSchema }).strict();
export type PairingInviteRevoke = z.infer<typeof pairingInviteRevokeSchema>;

const time = z.number().int().nonnegative().safe();
/** Issuance response; the only place the raw token ever appears. */
export const pairingInviteIssuedSchema = z.object({ id: pairingInviteIdSchema, invite: pairingInviteTokenSchema, expiresAt: time, serverTime: time }).strict();
export type PairingInviteIssued = z.infer<typeof pairingInviteIssuedSchema>;

/**
 * available: may admit one new device until `expiresAt`.
 * claimed:   bound to one device; this never admits a second device. Its
 *            pending request lives until `requestExpiresAt`; approval is
 *            tracked separately (this label is not proof it is still pending).
 * closed:    revoked or replaced before any admission.
 * expired:   reached `expiresAt` before any admission, or its admitted request
 *            passed `requestExpiresAt` (then `device` is still reported).
 * Closing or expiry never deletes a pending request that was already admitted.
 */
export const pairingInviteStateSchema = z.enum(["available", "claimed", "closed", "expired"]);
export type PairingInviteState = z.infer<typeof pairingInviteStateSchema>;
export const pairingInviteStatusSchema = z.object({
  id: pairingInviteIdSchema, state: pairingInviteStateSchema, createdAt: time, expiresAt: time,
  requestExpiresAt: time.optional(),
  device: z.object({ deviceId: z.string(), name: z.string(), platform: z.string() }).strict().optional(),
}).strict();
export type PairingInviteStatus = z.infer<typeof pairingInviteStatusSchema>;
export const pairingInviteListSchema = z.object({ invites: z.array(pairingInviteStatusSchema).max(256), serverTime: time }).strict();
export type PairingInviteList = z.infer<typeof pairingInviteListSchema>;

/** Body of the public `/api/pair`. `invite` and `requestId` are optional only
 * so the Hub can answer `pairing_invite_required` (403) and
 * `pairing_request_id_required` (400) instead of a generic schema error.
 * The App creates `requestId` once per attempt and persists it with the new
 * identity, retaining the invite only until receipt or definitive rejection.
 * Repeating the identical device fields and requestId returns the same code
 * while the admitted request lives, including token-free receipt recovery. This
 * retrieval never admits a request; a Hub restart forgets it. */
export const pairRequestSchema = z.object({
  deviceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(100),
  platform: z.enum(["web", "macos", "windows", "ios", "android"]),
  publicKey: z.string().min(32).max(256),
  invite: pairingInviteTokenSchema.optional(),
  requestId: pairingRequestIdSchema.optional(),
}).strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;
/** Unchanged response shape. A retry with the identical device fields and
 * requestId returns the identical code and expiry. */
export const pairResponseSchema = z.object({ code: z.string().regex(/^\d{8}$/), expiresAt: time, hubPublicKey: z.string() }).strict();
export type PairResponse = z.infer<typeof pairResponseSchema>;

/** Stable `error` codes of the strict path (HTTP status in brackets).
 * - pairing_invite_required [403]: no invite, and no live request admitted for this exact body.
 * - pairing_request_id_required [400]: invite without requestId.
 * - pairing_invite_invalid [403]: unknown, closed, or its creator lost owner trust.
 * - pairing_invite_expired [403]: the invite, or the admitted request, expired.
 * - pairing_invite_used [409]: bound to another device or a different request body.
 * - pairing_invites_full [429]: issuance would exceed a capacity limit.
 * - pairing_invite_not_found [404]: revoke/replaces of an id the caller did not create.
 * - rate_limited [429]: per-invite attempt limit reached.
 * Existing codes stay: device_already_registered [409] (approved: connect),
 * pairing_already_pending [409], invalid_device_key [400]. */
export const PAIRING_INVITE_ERRORS = ["pairing_invite_required", "pairing_request_id_required", "pairing_invite_invalid", "pairing_invite_expired",
  "pairing_invite_used", "pairing_invites_full", "pairing_invite_not_found"] as const;

/** App Review / demo access, managed only by the host's local CLI (an owner
 * session over loopback; relayed and remote callers are refused). While it
 * is enabled, a device presenting its token is paired and approved at once,
 * up to `maxDevices`, until `expiresAt`. It persists across Hub restarts and
 * is meant for an isolated demo host: anyone holding the token can pair. */
export const REVIEW_ACCESS_CAPABILITY = "review-access.v1";
export const REVIEW_ACCESS_PATH = "/api/devices/review-access";
export const REVIEW_ACCESS_DISABLE_PATH = "/api/devices/review-access/disable";
export const REVIEW_ACCESS_MAX_DAYS = 30;
export const REVIEW_ACCESS_MAX_DEVICES = 20;
export const reviewAccessEnableSchema = z.object({
  days: z.number().int().min(1).max(REVIEW_ACCESS_MAX_DAYS),
  maxDevices: z.number().int().min(1).max(REVIEW_ACCESS_MAX_DEVICES),
}).strict();
export type ReviewAccessEnable = z.infer<typeof reviewAccessEnableSchema>;
export const reviewAccessStatusSchema = z.object({
  enabled: z.boolean(),
  createdAt: time.optional(),
  expiresAt: time.optional(),
  maxDevices: z.number().int().positive().optional(),
  approvedDevices: z.number().int().nonnegative(),
  serverTime: time,
}).strict();
export type ReviewAccessStatus = z.infer<typeof reviewAccessStatusSchema>;
/** Enabling response; the only place the raw token ever appears. */
export const reviewAccessIssuedSchema = z.object({ invite: pairingInviteTokenSchema, status: reviewAccessStatusSchema }).strict();
export type ReviewAccessIssued = z.infer<typeof reviewAccessIssuedSchema>;

import { z } from "zod";
import { idSchema } from "./index.js";

export const deviceActionSchema = z.object({ operation: z.enum(["approve", "revoke", "network", "bot-message-grant", "screen-grant"]), target: z.string() }).strict()
  .refine((value) => value.operation === "approve" ? /^\d{8}$/.test(value.target)
    : (value.operation === "network" || value.operation === "bot-message-grant" || value.operation === "screen-grant") ? value.target.length === 64 && /^[a-f0-9]{64}$/.test(value.target)
    : idSchema.safeParse(value.target).success, { message: "invalid_device_action_target" });
export type DeviceAction = z.infer<typeof deviceActionSchema>;
export const deviceActionStatementSchema = z.object({
  hubPublicKey: z.string().regex(/^[A-Za-z0-9+/]{59}=$/), deviceId: idSchema,
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/), action: deviceActionSchema,
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive().safe(),
}).strict();
export type DeviceActionStatement = z.infer<typeof deviceActionStatementSchema>;
export const deviceActionProofSchema = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
export type DeviceActionProof = z.infer<typeof deviceActionProofSchema>;

/** Distinct from authentication, TLS and revocation-notice signing domains.
 * Rust uses the same ordered JSON array. Every string field is ASCII-only. */
export function deviceActionProofText(statement: DeviceActionStatement): string {
  const s = deviceActionStatementSchema.parse(statement);
  return JSON.stringify(["tarocub/device-action/v1", s.hubPublicKey, s.deviceId, s.sessionHash,
    s.action.operation, s.action.target, s.targetDigest, s.nonce, s.expiresAt]);
}

/** The caller supplies its own intended action and session, never values taken
 * from the challenge. Reject substitutions before asking the device to sign. */
export function boundDeviceActionStatement(raw: unknown, expected: Pick<DeviceActionStatement, "hubPublicKey" | "deviceId" | "sessionHash" | "action">): DeviceActionStatement {
  const s = deviceActionStatementSchema.parse(raw);
  if (s.hubPublicKey !== expected.hubPublicKey || s.deviceId !== expected.deviceId || s.sessionHash !== expected.sessionHash
    || s.action.operation !== expected.action.operation || s.action.target !== expected.action.target) throw new Error("device_action_invalid");
  return s;
}

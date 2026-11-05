import { z } from "zod";
import { idSchema } from "./index.js";

export const AUTH_STATUS_CAPABILITY = "auth-status.v1";
export const authDeniedSchema = z.object({
  v: z.literal(1), type: z.literal("auth.denied"), code: z.literal("device_revoked"),
  deviceId: idSchema, clientNonce: z.string().min(32).max(128),
  publicKey: z.string().min(1).max(1024), signature: z.string().min(1).max(256),
}).strict();
export type AuthDenied = z.infer<typeof authDeniedSchema>;
/** A denial must never share the authentication-challenge signing domain. */
export const authDeniedProof = (deviceId: string, clientNonce: string): string =>
  `tarocub/auth-denied/device-revoked/v1\0${deviceId}\0${clientNonce}`;

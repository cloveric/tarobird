import { z } from "zod";
import { createHash } from "node:crypto";
import { pairingSchema } from "../client-protocol/index.js";
import type { HubDatabase } from "./database.js";

export const desktopControllerMarkerKey = (id: string): string => `desktop-controller:v1:${createHash("sha256").update(id).digest("hex")}`;

/** Caller holds the DB queue. Only an exact, current owner/key binding counts.
 * Name bindings are set by native proof enrollment, never by platform or name. */
export async function localDesktopControllersInTransaction(db: HubDatabase, hostNameOnly = false): Promise<Map<string, string>> {
  const rows = await db.all<{ id: string; public_key: string }>("SELECT d.id,d.public_key FROM devices d JOIN users u ON u.id=d.user_id WHERE u.role='owner' AND d.revoked=0");
  const markers = await db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key>='desktop-controller:v1:' AND key<'desktop-controller:v1;'");
  const byKey = new Map(markers.map(marker => [marker.key, marker.value])), trusted = new Map<string, string>();
  for (const row of rows) {
    try {
      const marker = JSON.parse(byKey.get(desktopControllerMarkerKey(row.id)) ?? "null");
      if (marker?.id === row.id && marker.publicKey === row.public_key && (!hostNameOnly || marker.nameSource === "host")) trusted.set(row.id, row.public_key);
    } catch { /* Invalid local metadata grants neither classification nor naming. */ }
  }
  return trusted;
}

/** Private local-control protocol, never exposed by the HTTP pairing API. */
export const desktopControllerChallengeSchema = z.object({
  v: z.literal(1), hubPublicKey: z.string().min(32).max(256),
  deviceId: pairingSchema.shape.deviceId, publicKey: pairingSchema.shape.publicKey,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type DesktopControllerChallenge = z.infer<typeof desktopControllerChallengeSchema>;
export const desktopControllerProofSchema = z.object({
  challenge: desktopControllerChallengeSchema, signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export const desktopControllerEnrollmentSchema = z.object({ controller: pairingSchema, proof: desktopControllerProofSchema }).strict();
export function desktopControllerProofText(c: DesktopControllerChallenge): string {
  return `tarocub/desktop-controller/v1\0${c.hubPublicKey}\0${c.deviceId}\0${c.publicKey}\0${c.nonce}\0${c.expiresAt}`;
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { relativeDeviceName } from "../client-protocol/device-name.js";
import type { HubDatabase } from "./database.js";
import type { Device } from "./store.js";

const markerKey = (id: string) => `network-device-name:v1:${createHash("sha256").update(id).digest("hex")}`;
const base = { id: z.string(), publicKey: z.string() };
const markerSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("alias") }).strict(),
  z.object({ ...base, kind: z.literal("follow"), networkId: z.string(), memberId: z.string(), lastName: z.string() }).strict(),
]);

/** Caller owns the same transaction as the authenticated explicit rename.
 * An explicit same-value rename is still a choice, not automatic provenance. */
export async function markDeviceNameAlias(db: HubDatabase, device: Pick<Device, "id" | "public_key">): Promise<void> {
  await db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [markerKey(device.id), JSON.stringify({ kind: "alias", id: device.id, publicKey: device.public_key })]);
}

/** Only called after exact imported key/member/network and revocation checks.
 * Names never grant access. Keep explicit aliases, including same-value/ABA
 * choices, and conservatively migrate only known legacy relative defaults. */
export async function syncImportedDeviceName(db: HubDatabase, device: Pick<Device, "id" | "name" | "public_key">, source: { networkId: string; memberId: string; name: string }, fresh = false): Promise<void> {
  const saved = await db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [markerKey(device.id)]);
  if (!fresh && saved) {
    let marker: z.infer<typeof markerSchema>;
    try { marker = markerSchema.parse(JSON.parse(saved.value)); } catch { return; }
    if (marker.id !== device.id || marker.publicKey !== device.public_key || marker.kind === "alias"
      || marker.networkId !== source.networkId || marker.memberId !== source.memberId) return;
    if (device.name !== marker.lastName) { await markDeviceNameAlias(db, device); return; }
  } else if (!fresh && !relativeDeviceName(device.name)) return;
  if (device.name !== source.name) await db.run("UPDATE devices SET name=? WHERE id=? AND public_key=? AND revoked=0", [source.name, device.id, device.public_key]);
  const value = JSON.stringify({ kind: "follow", id: device.id, publicKey: device.public_key, networkId: source.networkId, memberId: source.memberId, lastName: source.name });
  if (saved?.value !== value) await db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [markerKey(device.id), value]);
}

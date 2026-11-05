import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { deviceProof, type AuthSession, type HubAuth } from "../../src/hub/auth.js";
import type { PairingInviteIssued } from "../../src/client-protocol/pairing-invites.js";

export type TestDevice = { deviceId: string; name: string; platform: "web" | "ios" | "android" | "macos" | "windows"; publicKey: string; privateKey: KeyObject };
export function testDevice(deviceId: string, name = deviceId): TestDevice {
  const keys = generateKeyPairSync("ed25519");
  return { deviceId, name, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: keys.privateKey };
}
export const pairingRequestId = (): string => randomBytes(32).toString("base64url");
export const deviceFields = (device: TestDevice) => ({ deviceId: device.deviceId, name: device.name, platform: device.platform, publicKey: device.publicKey });
export const invitedPairing = (device: TestDevice, invite: string, requestId: string) => ({ ...deviceFields(device), invite, requestId });

/** Same handshake an App performs: the bearer token and the session that
 * `authorize` maps it to. */
export async function loginFor(auth: HubAuth, device: TestDevice, source = "127.0.0.1"): Promise<{ token: string; session: AuthSession }> {
  const connection = `test_${randomBytes(8).toString("hex")}`, clientNonce = randomBytes(32).toString("base64url");
  const { nonce } = await auth.challenge(connection, device.deviceId, clientNonce, source);
  const { token } = await auth.authenticate(connection, sign(null, deviceProof(device.deviceId, nonce, clientNonce), device.privateKey).toString("base64"));
  return { token, session: await auth.authorize(token, source) };
}
export async function sessionFor(auth: HubAuth, device: TestDevice, source = "127.0.0.1"): Promise<AuthSession> { return (await loginFor(auth, device, source)).session; }

type DeviceFields = { deviceId: string; name: string; platform: TestDevice["platform"]; publicKey: string };
/** Trusted in-process bootstrap for tests only, typically the first device,
 * when no owner exists yet to issue an invite. `pair` is never reachable from
 * HTTP, and `local-owner` approval is never selected from network input. Does
 * not log in, so it adds no session or `auth.accepted` audit row. */
export async function bootstrapTrusted(auth: HubAuth, fields: DeviceFields, userId = "owner"): Promise<string> {
  const { code } = await auth.pair(fields, "127.0.0.1");
  return auth.approve(code, "local-owner", userId);
}
export async function enrollTrusted(auth: HubAuth, device: TestDevice, userId = "owner"): Promise<AuthSession> {
  await bootstrapTrusted(auth, deviceFields(device), userId);
  return sessionFor(auth, device);
}
/** The public HTTP pairing route, exactly as an App calls it. */
export async function postPairing(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/api/pair`, { method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export function issueInvite(auth: HubAuth, session: AuthSession, options: { requestId?: string; replaces?: string } = {}): Promise<PairingInviteIssued> {
  return auth.issuePairingInvite(session, { requestId: options.requestId ?? pairingRequestId(), ...(options.replaces ? { replaces: options.replaces } : {}) });
}

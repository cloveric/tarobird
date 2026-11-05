import { routeUrlSchema, localRoutesSchema } from "../../src/client-protocol/routes.js";
import { t } from "./i18n.js";
import { type Identity, type Route } from "./storage.js";
import { createNativeIdentity, nativePlatform, signNative, signNativeDeviceAction, verifyEd25519 } from "./native.js";
import { deviceActionProofText, type DeviceActionStatement } from "../../src/client-protocol/device-actions.js";
import { authDeniedProof, authDeniedSchema } from "../../src/client-protocol/auth-status.js";

export function base64(bytes: ArrayBuffer): string { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
export function unbase64(text: string): ArrayBuffer { return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer; }
// The mobile native signers require URL-safe challenges. Keep the 256 bits of
// entropy intact; ordinary padded base64 always fails their input validation.
export function randomNonce(): string { return base64(crypto.getRandomValues(new Uint8Array(32)).buffer).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
export async function createIdentity(name: string, routes: Route[]): Promise<Identity> {
  routes = localRoutesSchema.parse(routes);
  const platform = nativePlatform();
  if (platform !== "web") return { ...await createNativeIdentity(), name, routes, platform };
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const identity: Identity = { deviceId: `device_${crypto.randomUUID().replaceAll("-", "")}`, name, privateKey: pair.privateKey, publicKey: base64(await crypto.subtle.exportKey("spki", pair.publicKey)), routes };
  return identity;
}
export async function verifyHub(identity: Identity, nonce: string, clientNonce: string, signature: string, publicKey: string): Promise<void> {
  if (!identity.hubPublicKey || identity.hubPublicKey !== publicKey) throw new Error(t("Hub 身份不匹配，连接已拒绝"));
  if (!verifyEd25519(publicKey, signature, new TextEncoder().encode(`tarocub/server/v1\0${identity.deviceId}\0${nonce}\0${clientNonce}`))) throw new Error(t("Hub 身份签名无效"));
}
export function verifyRevocation(identity: Identity, clientNonce: string, raw: unknown): void {
  const denied = authDeniedSchema.parse(raw);
  if (!identity.hubPublicKey || denied.publicKey !== identity.hubPublicKey || denied.deviceId !== identity.deviceId || denied.clientNonce !== clientNonce
    || !verifyEd25519(denied.publicKey, denied.signature, new TextEncoder().encode(authDeniedProof(identity.deviceId, clientNonce)))) throw new Error(t("Hub 身份签名无效"));
}
export async function signChallenge(identity: Identity, nonce: string, clientNonce: string): Promise<string> { if (identity.keyRef) return signNative(identity.keyRef, identity.deviceId, nonce, clientNonce); if (!identity.privateKey) throw new Error(t("设备密钥不可用，请重新配对")); return base64(await crypto.subtle.sign("Ed25519", identity.privateKey, new TextEncoder().encode(`tarocub/device/v1\0${identity.deviceId}\0${nonce}\0${clientNonce}`))); }
export async function signDeviceAction(identity: Identity, statement: DeviceActionStatement): Promise<string> {
  if (identity.deviceId !== statement.deviceId || identity.hubPublicKey !== statement.hubPublicKey) throw new Error("device_action_invalid");
  if (identity.keyRef) return signNativeDeviceAction(identity.keyRef, statement);
  if (!identity.privateKey) throw new Error("device_key_unavailable");
  return base64(await crypto.subtle.sign("Ed25519", identity.privateKey, new TextEncoder().encode(deviceActionProofText(statement))));
}
export function validateRoute(value: string): string {
  const result = routeUrlSchema.safeParse(value); if (!result.success) throw new Error(t("请输入有效 Hub HTTPS 地址")); return result.data;
}

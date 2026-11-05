import { beforeEach, expect, it, vi } from "vitest";
import vector from "../../tests/fixtures/device-action-vector.json";
import { deviceActionStatementSchema } from "../../src/client-protocol/device-actions.js";

const sdk = vi.hoisted(() => ({ tauri: false, native: true, invoke: vi.fn(), plugin: { create: vi.fn(), sign: vi.fn(), signAction: vi.fn(), forget: vi.fn() } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => sdk.native, getPlatform: () => "ios" }, registerPlugin: () => sdk.plugin }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => sdk.tauri, invoke: sdk.invoke }));
// Any regression to returning a private seed through the WebView must fail.
vi.mock("@aparajita/capacitor-secure-storage", () => { throw new Error("private_key_export_forbidden"); });
import { createNativeIdentity, deleteNativeIdentity, signNative, signNativeDeviceAction } from "../src/native.js";
import { signDeviceAction } from "../src/identity.js";

const statement = deviceActionStatementSchema.parse(vector.statement);
beforeEach(() => {
  sdk.tauri = false; sdk.native = true; vi.clearAllMocks();
  sdk.plugin.signAction.mockResolvedValue({ signature: vector.signature });
});
it("dispatches mobile action signing without reading a seed into JavaScript", async () => {
  expect(await signNativeDeviceAction(statement.deviceId, statement)).toBe(vector.signature);
  expect(sdk.plugin.signAction).toHaveBeenCalledExactlyOnceWith({ keyRef: statement.deviceId, statement });
  expect(sdk.invoke).not.toHaveBeenCalled();
});
it("dispatches identity creation, authentication and deletion to native code", async () => {
  const identity = { deviceId: statement.deviceId, keyRef: statement.deviceId, publicKey: vector.publicKey };
  sdk.plugin.create.mockResolvedValue(identity); sdk.plugin.sign.mockResolvedValue({ signature: vector.signature });
  expect(await createNativeIdentity()).toEqual(identity);
  expect(await signNative(identity.keyRef, identity.deviceId, "n".repeat(43), "c".repeat(43))).toBe(vector.signature);
  expect(sdk.plugin.sign).toHaveBeenCalledExactlyOnceWith({ keyRef: identity.keyRef, deviceId: identity.deviceId, nonce: "n".repeat(43), clientNonce: "c".repeat(43) });
  await deleteNativeIdentity(identity.keyRef);
  expect(sdk.plugin.forget).toHaveBeenCalledExactlyOnceWith({ keyRef: identity.keyRef });
});
it("dispatches desktop signing to Rust", async () => {
  sdk.tauri = true; sdk.invoke.mockResolvedValue(vector.signature);
  expect(await signNativeDeviceAction(statement.deviceId, statement)).toBe(vector.signature);
  expect(sdk.invoke).toHaveBeenCalledExactlyOnceWith("device_sign_action", { keyRef: statement.deviceId, statement });
  expect(sdk.plugin.signAction).not.toHaveBeenCalled();
});
it("signs the same vector with the browser's non-extractable WebCrypto key", async () => {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(vector.fixtureOnlySeedHex, "hex")]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  expect(privateKey.extractable).toBe(false);
  expect(await signDeviceAction({ deviceId: statement.deviceId, name: "Fixture", publicKey: vector.publicKey,
    hubPublicKey: statement.hubPublicKey, privateKey, routes: [] }, statement)).toBe(vector.signature);
  expect(sdk.plugin.signAction).not.toHaveBeenCalled(); expect(sdk.invoke).not.toHaveBeenCalled();
});
it.each(["web", "wrong-key"])("rejects %s before invoking the native signer", async condition => {
  if (condition === "web") sdk.native = false;
  await expect(signNativeDeviceAction(condition === "wrong-key" ? "device_other" : statement.deviceId, statement)).rejects.toThrow("device_key_unavailable");
  expect(sdk.plugin.signAction).not.toHaveBeenCalled(); expect(sdk.invoke).not.toHaveBeenCalled();
});
it("propagates native storage/signing failure without a JavaScript fallback", async () => {
  sdk.plugin.signAction.mockRejectedValue(new Error("device_key_unavailable"));
  await expect(signNativeDeviceAction(statement.deviceId, statement)).rejects.toThrow("device_key_unavailable");
});

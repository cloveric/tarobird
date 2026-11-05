import { Capacitor, registerPlugin } from "@capacitor/core";
import type { DeviceActionStatement } from "../../src/client-protocol/device-actions.js";

interface DeviceIdentityPlugin {
  create(): Promise<{ deviceId: string; keyRef: string; publicKey: string }>;
  sign(options: { keyRef: string; deviceId: string; nonce: string; clientNonce: string }): Promise<{ signature: string }>;
  signAction(options: { keyRef: string; statement: DeviceActionStatement }): Promise<{ signature: string }>;
  forget(options: { keyRef: string }): Promise<void>;
  getLock(): Promise<{ enabled: boolean }>;
  setLock(options: { enabled: boolean }): Promise<void>;
}
let plugin: DeviceIdentityPlugin | undefined;
/** No import/export-key or arbitrary-message signing method is exposed. */
export function nativeDevice(): DeviceIdentityPlugin {
  if (!Capacitor.isNativePlatform()) throw new Error("device_key_unavailable");
  return plugin ??= registerPlugin<DeviceIdentityPlugin>("TaroCubDeviceIdentity");
}

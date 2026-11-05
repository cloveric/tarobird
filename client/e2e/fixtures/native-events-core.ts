import { bridge } from "./native-events-bridge.js";
export * from "../../node_modules/@capacitor/core/dist/index.js";
export const Capacitor = { isNativePlatform: () => bridge.platform === "ios" || bridge.platform === "android", getPlatform: () => bridge.platform };

import { registerPlugin as originalRegisterPlugin } from "../../node_modules/@capacitor/core/dist/index.js";
export const registerPlugin = <T,>(name: string): T => name === "TaroBotAndroidUpdater" ? {
  status: async () => { bridge.calls.push("android-update-status"); return { phase: "initial", configured: true, authenticated: true }; },
  invoke: async ({ command }: { command: string }) => { bridge.calls.push(`android-update-${command}`); return { phase: "current", configured: true, authenticated: true }; },
  addListener: (_event: string, callback: (value: unknown) => void) => bridge.register("android-update-state", callback),
} as T : name === "TaroCubShareInbox" ? { pushTokenSnapshot: async () => ({ revision: bridge.pushRevision, token: bridge.pushToken, failed: bridge.pushFailed }) } as T : originalRegisterPlugin<T>(name);

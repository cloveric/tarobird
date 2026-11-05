export * from "../../node_modules/@capacitor/core/dist/index.js";
const params = new URLSearchParams(location.search);
export const nativeState = { platform: params.get("platform") ?? "ios", permission: params.get("permission") ?? "denied", calls: [] as string[], channel: "enabled", soundEnabled: true, vibrationEnabled: true, settingsFail: false, appEnabled: true, old: false, token: "a".repeat(64), holdToken: false, revision: 0, listeners: new Map<string, Set<() => void>>(), releases: [] as (() => void)[] };
export const plugins: Record<string, any> = {};
export const Capacitor = { isNativePlatform: () => true, getPlatform: () => nativeState.platform };
export const registerPlugin = <T,>(name: string): T => new Proxy({}, { get: (_target, key) => (...args: unknown[]) => plugins[name]?.[key]?.(...args) ?? Promise.reject({ code: "UNIMPLEMENTED" }) }) as T;

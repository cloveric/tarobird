// Native bridge substitution used only by unifiedpush-native.spec.ts.
export const plugins: Record<string, unknown> = {};
export const Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
// Keep unused dependency exports intact for Vite's dynamic-module scan.
export * from "../../node_modules/@capacitor/core/dist/index.js";
export const registerPlugin = <T,>(name: string): T => new Proxy({}, { get: (_target, key) => (...args: unknown[]) => (plugins[name] as Record<PropertyKey, (...args: unknown[]) => unknown>)[key]!(...args) }) as T;

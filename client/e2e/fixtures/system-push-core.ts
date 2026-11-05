export * from "../../node_modules/@capacitor/core/dist/index.js";
export const plugins: Record<string, any> = {};
export let platform = "ios";
export const setPlatform = (value: string) => { platform = value; };
export const Capacitor = { isNativePlatform: () => true, getPlatform: () => platform };
export const registerPlugin = <T,>(name: string): T => new Proxy({}, { get: (_target, key) => (...args: unknown[]) => plugins[name][key](...args) }) as T;

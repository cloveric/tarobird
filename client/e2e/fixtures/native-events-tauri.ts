import { bridge } from "./native-events-bridge.js";
export * from "../../node_modules/@tauri-apps/api/core.js";
export const isTauri = () => bridge.platform === "tauri";
export const invoke = async (command: string) => { bridge.calls.push(`invoke ${command}`); return command === "update_info" ? { enabled: false, version: "test" } : undefined; };

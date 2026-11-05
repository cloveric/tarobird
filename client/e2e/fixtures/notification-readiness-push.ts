import { nativeState } from "./notification-readiness-core.js";
export const PushNotifications = {
  addListener: async (name: string, callback: () => void) => { const group = nativeState.listeners.get(name) ?? new Set(); group.add(callback); nativeState.listeners.set(name, group); return { remove: async () => { group.delete(callback); } }; },
  register: async () => { nativeState.calls.push("APNs register"); nativeState.revision++; nativeState.listeners.get("registration")?.forEach(f => f()); },
  checkPermissions: async () => { nativeState.calls.push("check"); return { receive: nativeState.permission }; },
  requestPermissions: async () => { nativeState.calls.push("PROMPT"); return { receive: nativeState.permission }; },
};

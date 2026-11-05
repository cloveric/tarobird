import { useSyncExternalStore } from "react";

// Appearance is device-local and shared across the host sidebar, phone home
// and ADHD navigation. Hydrate through the same mirror/DB path as the theme.
let enabled = true;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => enabled;

export function setAvatarMotion(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  for (const listener of listeners) listener();
}

export function useAvatarMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

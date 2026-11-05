import { Capacitor } from "@capacitor/core";
import { isDesktop } from "./desktop-bridge.js";

export const layoutDensities = ["compact", "standard", "comfortable"] as const;
export type LayoutDensity = typeof layoutDensities[number];

export function defaultLayoutDensity(): LayoutDensity {
  if (typeof window === "undefined" || isDesktop()) return "standard";
  // Native phones retain their default in landscape. Desktop windows retain
  // theirs even when narrow; a mobile browser follows the phone layout.
  return Capacitor.isNativePlatform() || window.matchMedia?.("(max-width:760px)").matches
    ? "compact" : "standard";
}

export function normalizeLayoutDensity(value: unknown): LayoutDensity {
  return value === "compact" || value === "standard" || value === "comfortable" ? value : defaultLayoutDensity();
}

// Pass real sizes into Avatar so group collages and image fallbacks resize too.
export const mobileListAvatarSizes: Record<LayoutDensity, number> = {
  compact: Capacitor.getPlatform() === "ios" ? 44 : 40, standard: 48, comfortable: 56,
};

import { DEFAULT_MONO_ACCENT, DEFAULT_PALETTE, DEFAULT_THEME, isColorPalette, isMonoAccent } from "./palettes.js";
import type { Preferences } from "./storage.js";
import { setAvatarMotion } from "./avatar-motion.js";
import { normalizeLayoutDensity } from "./layout-density.js";
import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { Keyboard, KeyboardStyle } from "@capacitor/keyboard";

const key = "tarocub-appearance";
type Appearance = Pick<Preferences, "theme" | "palette" | "monoAccent" | "showModelIcons" | "layoutDensity" | "animations" | "animatedAvatars">;
const nativeAppearance = registerPlugin<{
  setCanvas(options: { color: string; darkIcons: boolean }): Promise<void>;
  setReaderCanvas(options: { color?: string; darkIcons?: boolean }): Promise<void>;
  setImmersive(options: { enabled: boolean }): Promise<void>;
}>("TaroBotAppearance");
/** The image reader surface (message-images.css), painted behind native bars. */
const READER_CANVAS = "#101113";
let darkReaderCount = 0;

/** Full-screen media has its own dark canvas, independently of app theme. */
export function acquireDarkNativeStatusBar(): () => void {
  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") return () => {};
  let held = true;
  if (darkReaderCount++ === 0) syncReader(platform);
  return () => { if (!held) return; held = false; if (--darkReaderCount === 0) syncReader(platform); };
}

function syncReader(platform: string): void {
  // Android bars sit outside the inset WebView, so only native code can paint
  // them. The override is never persisted and yields to the saved theme on release.
  if (platform === "android") void nativeAppearance.setReaderCanvas(darkReaderCount ? { color: READER_CANVAS, darkIcons: false } : {}).catch(() => undefined);
  else syncThemeColor();
}

/** Native phones only. Android lets the WebView fill the hidden bars and cutout. */
export function setImmersiveSystemBars(hidden: boolean): Promise<void> {
  const platform = Capacitor.getPlatform();
  if (platform === "android") return nativeAppearance.setImmersive({ enabled: hidden });
  if (platform === "ios") {
    const animation = "FADE";
    return hidden ? SystemBars.hide({ animation }) : SystemBars.show({ animation });
  }
  return Promise.resolve();
}

export function syncThemeColor(): void {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  // Production CSS shortens #ffffff to #fff. NativeAppearance accepts canonical
  // six-digit hex, so expand shorthand before validating or deriving contrast.
  const canvas = /^#[\da-f]{3}$/i.test(color) ? `#${[...color.slice(1)].map(digit => digit + digit).join("")}` : color;
  if (/^#[\da-f]{6}$/i.test(canvas) && Capacitor.isNativePlatform()) {
    const rgb = [1, 3, 5].map(offset => parseInt(canvas.slice(offset, offset + 2), 16));
    const darkIcons = .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]! > 150;
    if (Capacitor.getPlatform() === "android") void nativeAppearance.setCanvas({ color: canvas, darkIcons }).catch(() => undefined);
    else {
      void SystemBars.setStyle({ style: darkIcons && !darkReaderCount ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => undefined);
      // App appearance can override the OS theme; the native keyboard should
      // use the same light/dark canvas as the composer around it.
      if (Capacitor.getPlatform() === "ios") void Keyboard.setStyle({ style: darkIcons ? KeyboardStyle.Light : KeyboardStyle.Dark }).catch(() => undefined);
    }
  }
}

function setAppearance(value: Appearance): void {
  setAvatarMotion(value.animatedAvatars !== false);
  // CLI is a dark-only skin. Retain the saved preference for other palettes,
  // including when restoring the startup mirror before IndexedDB is ready.
  const palette = isColorPalette(value.palette) ? value.palette : DEFAULT_PALETTE;
  document.documentElement.dataset.theme = palette === "cli" ? "dark" : value.theme;
  document.documentElement.dataset.palette = palette;
  document.documentElement.dataset.monoAccent = isMonoAccent(value.monoAccent) ? value.monoAccent : DEFAULT_MONO_ACCENT;
  document.documentElement.dataset.modelIcons = value.showModelIcons === false ? "hidden" : "visible";
  document.documentElement.dataset.density = normalizeLayoutDensity(value.layoutDensity);
  syncThemeColor();
}

/** A tiny non-sensitive mirror avoids a flash while IndexedDB opens. The DB
 * remains authoritative; missing/blocked localStorage must not block startup. */
export function restoreAppearance(): void {
  document.documentElement.dataset.platform = Capacitor.getPlatform();
  // Establish first-run defaults before React/IndexedDB; a valid mirror below
  // still wins, including an explicitly saved system or dark theme.
  document.documentElement.dataset.theme = DEFAULT_THEME;
  document.documentElement.dataset.palette = DEFAULT_PALETTE;
  document.documentElement.dataset.monoAccent = DEFAULT_MONO_ACCENT;
  document.documentElement.dataset.density = normalizeLayoutDensity(undefined);
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && typeof value === "object" && "theme" in value && ["system", "light", "dark"].includes(String(value.theme))) {
      setAppearance({ animations: true, animatedAvatars: !("animatedAvatars" in value) || value.animatedAvatars !== false, theme: value.theme as Appearance["theme"], palette: "palette" in value && isColorPalette(value.palette) ? value.palette : DEFAULT_PALETTE, monoAccent: "monoAccent" in value && isMonoAccent(value.monoAccent) ? value.monoAccent : DEFAULT_MONO_ACCENT, showModelIcons: !("showModelIcons" in value) || value.showModelIcons !== false, layoutDensity: normalizeLayoutDensity("layoutDensity" in value ? value.layoutDensity : undefined) });
    }
  } catch { /* Private browsing or an invalid mirror: retain first-run defaults. */ }
  syncThemeColor();
}

export function applyAppearance(value: Appearance): void {
  setAppearance(value);
  try { localStorage.setItem(key, JSON.stringify({ animations: true, animatedAvatars: value.animatedAvatars !== false, theme: value.theme, palette: isColorPalette(value.palette) ? value.palette : DEFAULT_PALETTE, monoAccent: value.monoAccent ?? DEFAULT_MONO_ACCENT, showModelIcons: value.showModelIcons !== false, layoutDensity: normalizeLayoutDensity(value.layoutDensity) })); } catch { /* IndexedDB still persists the preference. */ }
}

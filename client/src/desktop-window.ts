import { isElectron, invoke, listen } from "./desktop-bridge.js";
import type { SideWindowFrame } from "./side-window-expansion.js";

export type DesktopWindowState = SideWindowFrame & { focused: boolean; fullscreenTransitioning?: boolean };
export async function getDesktopWindow() {
  if (!isElectron()) return (await import("@tauri-apps/api/window")).getCurrentWindow();
  const read = () => invoke<DesktopWindowState>("desktop_window_read");
  return {
    isFullscreen: async () => (await read()).fullscreen,
    isFocused: async () => (await read()).focused,
    setFullscreen: (enabled: boolean) => invoke<void>("desktop_window_fullscreen", { enabled }),
    onResized: (changed: () => void) => listen("window-state", changed),
  };
}
export async function focusDesktopView(): Promise<void> {
  if (isElectron()) return invoke("desktop_window_focus");
  await (await import("@tauri-apps/api/webview")).getCurrentWebview().setFocus();
}

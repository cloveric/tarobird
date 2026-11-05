import { registerPlugin } from "@capacitor/core";
import { invoke } from "./desktop-bridge.js";
import { nativePlatform } from "./native.js";
import { UnifiedPush } from "./unifiedpush.js";

const iosSettings = registerPlugin<{ open(): Promise<void> }>("TaroBotNotificationSettings");

/** Platforms with a fixed system destination. Android and iOS open TaroBird's
 * settings; Windows opens Notifications. macOS has no documented per-app URL,
 * so it opens the System Settings app and the user chooses Notifications → TaroBird.
 * Browsers own site permissions. */
export function supportsSystemNotificationSettings(): boolean {
  return nativePlatform() !== "web";
}

/** Opens the system notification settings without changing any channel or
 * permission. Rejects when unsupported or when an older native shell lacks the
 * bridge, so callers can show manual instructions instead. */
export async function openSystemNotificationSettings(): Promise<void> {
  const platform = nativePlatform();
  if (platform === "android") return UnifiedPush.openNotificationSettings();
  if (platform === "ios") return iosSettings.open();
  if (platform === "windows" || platform === "macos") return invoke<void>("desktop_notification_settings");
  throw new Error("notification_settings_unavailable");
}

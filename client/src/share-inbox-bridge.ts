import { registerPlugin } from "@capacitor/core";
import type { ShareBridge } from "./share-controller.js";
// Register once even when notifications load before the file-sharing UI.
export const shareInbox = registerPlugin<ShareBridge & {
  pushTokenSnapshot(): Promise<{ revision: number; token?: string; failed?: boolean }>;
}>("TaroCubShareInbox");

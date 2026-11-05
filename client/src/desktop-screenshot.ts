import { decodeBase64 } from "../../src/client-protocol/base64.js";
import { invoke } from "./desktop-bridge.js";
import { t } from "./i18n.js";

/** No paths or clipboard data cross IPC; only the user's completed PNG selection. */
export async function captureDesktopScreenshot(): Promise<File | undefined> {
  const encoded = await invoke<string | null>("capture_screenshot", { english: document.documentElement.lang.startsWith("en") });
  if (encoded === null) return;
  if (typeof encoded !== "string" || encoded.length > Math.ceil(32 * 1024 * 1024 / 3) * 4) throw new Error("screenshot_too_large");
  const data = decodeBase64(encoded);
  if (data.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => data[i] === value)) throw new Error("screenshot_failed");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new File([data], `Screenshot-${stamp}.png`, { type: "image/png" });
}

export function screenshotError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "screenshot_permission_denied") return t("请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 TaroBird 截屏，然后重新打开 TaroBird。也可以先用系统截屏，再粘贴到输入框。");
  if (code === "screenshot_busy") return t("截屏正在进行，请先完成或按 Esc 取消。");
  if (code === "screenshot_too_large") return t("截屏尺寸过大，请缩小截取范围，或用系统截屏后添加图片。");
  return t("截屏未完成，请重试。也可以用系统截屏，再粘贴到输入框。");
}

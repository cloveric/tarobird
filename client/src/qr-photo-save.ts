import { Capacitor, registerPlugin } from "@capacitor/core";
import { exportAttachment, type ExportDelivery } from "./attachment-export.js";
import { t } from "./i18n.js";

/** Saving a connection QR only. Phones write to the photo album through a
 * dedicated, bounded native method; desktop and browsers use the existing file
 * saver and are never described as an album. */
export type QrSaveTarget = "photos" | "file";
export type QrSaveOutcome = { saved: true; delivery: ExportDelivery | "photos"; location?: string } | { saved: false };

// Resolved at call time, like the other native savers.
const photos = () => registerPlugin<{ save(options: { data: string; name: string }): Promise<{ saved?: boolean }> }>("TaroBotQrPhotos");
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_QR_BYTES = 512 * 1024;

export function qrSaveTarget(): QrSaveTarget {
  return Capacitor.isNativePlatform() && ["ios", "android"].includes(Capacitor.getPlatform()) ? "photos" : "file";
}
export function qrSaveLabel(target: QrSaveTarget = qrSaveTarget()): string {
  return target === "photos" ? t("保存到相册") : t("保存二维码图片");
}
/** The same fixed format both native savers validate. */
export function qrImageName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `TaroBot-QR-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}
export function qrPngBase64(dataUrl: string): string {
  const data = PNG_DATA_URL.exec(dataUrl)?.[1];
  if (!data || data.length > Math.ceil(MAX_QR_BYTES / 3) * 4) throw new Error("photos_image_invalid");
  return data;
}

/** Resolves only on an actual platform receipt. A dismissed file dialog
 * resolves `{ saved: false }`; permission denial and failures reject. */
export async function saveQrImage(dataUrl: string, target: QrSaveTarget = qrSaveTarget(), name = qrImageName()): Promise<QrSaveOutcome> {
  const data = qrPngBase64(dataUrl);
  if (target === "photos") {
    const result = await photos().save({ data, name });
    if (result?.saved !== true) throw new Error("photos_save_failed");
    return { saved: true, delivery: "photos" };
  }
  const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
  let delivery: ExportDelivery = "saved", location: string | undefined;
  const accepted = await exportAttachment(new Blob([bytes], { type: "image/png" }), name, { delivered: (value, _path, savedLocation) => { delivery = value; location = savedLocation; } });
  return accepted ? { saved: true, delivery, ...(location ? { location } : {}) } : { saved: false };
}

export function qrSaveError(error: unknown, target: QrSaveTarget = qrSaveTarget()): string {
  const code = error instanceof Error ? error.message : "";
  // The file saver already reports translated, user-facing failures.
  if (target === "file" && code && !code.startsWith("photos_")) return code;
  if (code.includes("photos_permission_denied")) return t("未获得添加照片的权限，二维码没有保存。可在系统设置中允许 TaroBird 添加照片。");
  if (code.includes("photos_image_invalid") || code.includes("photos_name_invalid")) return t("二维码图片无效，没有保存。请重新生成二维码后再试。");
  return t("二维码没有保存，请重试。");
}

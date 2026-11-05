import { attachmentFilename } from "./attachment-export.js";

/** Image captions need not be filenames. Preserve the downloaded format and
 * reserve space for its extension after sanitizing a user/server supplied label. */
export function imageExportFilename(title: string, mime: string): string {
  const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp", "image/svg+xml": "svg", "image/heic": "heic", "image/heif": "heif", "image/tiff": "tif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
  const extension = extensions[mime.split(";")[0]!.trim().toLowerCase()] ?? "img";
  const stem = attachmentFilename(title).replace(/\.(?:png|jpe?g|webp|gif|avif|bmp|svg|heic|heif|tiff?|ico|img)$/i, "");
  let name = "", bytes = 0;
  for (const character of stem) { bytes += new TextEncoder().encode(character).length; if (bytes > 210) break; name += character; }
  return `${name || "image"}.${extension}`;
}

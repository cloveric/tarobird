import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import AdmZip from "adm-zip";

type ArchiveErrorCode = "invalid" | "encrypted" | "name" | "path" | "duplicate" | "limit";
export class ArchiveReadError extends Error {
  constructor(readonly code: ArchiveErrorCode, options?: ErrorOptions) {
    super(`Archive extraction failed: ${code}`, options); this.name = "ArchiveReadError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const gb18030 = new TextDecoder("gb18030", { fatal: true, ignoreBOM: true });
const cp437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
// Preserve raw names until their per-entry encoding/Unicode metadata is known.
// Decoding as UTF-8 inside adm-zip first loses bytes and can invent duplicates.
const losslessNames: AdmZip.ZipTextDecoder = {
  efs: false, encode: text => Buffer.from(text, "latin1"), decode: bytes => Buffer.from(bytes).toString("latin1"),
};

function entryName(entry: AdmZip.IZipEntry): string {
  const raw = entry.rawEntryName;
  if (entry.header.flags & 0x800) {
    try { return utf8.decode(raw); } catch { throw new ArchiveReadError("name"); }
  }
  // Info-ZIP Unicode Path Extra Field: only trust version 1 with a matching
  // CRC of the original name. Ignore stale metadata rather than renaming it.
  const extra = entry.extra;
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at), size = extra.readUInt16LE(at + 2), end = at + 4 + size;
    if (end > extra.length) throw new ArchiveReadError("invalid");
    if (id === 0x7075 && size >= 5 && extra[at + 4] === 1 && extra.readUInt32LE(at + 5) === crc32(raw)) {
      try { return utf8.decode(extra.subarray(at + 9, end)); } catch { throw new ArchiveReadError("name"); }
    }
    at = end;
  }
  // Many tools omit the UTF-8 flag; older Chinese Windows tools use GBK.
  // Without metadata legacy encodings are ambiguous. Prefer valid UTF-8,
  // then a strictly decoded Chinese name, then the ZIP legacy CP437 mapping.
  try { return utf8.decode(raw); } catch { /* legacy name */ }
  try { const name = gb18030.decode(raw); if (/\p{Script=Han}/u.test(name)) return name; } catch { /* CP437 */ }
  return [...raw].map(byte => byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128]).join("");
}

export async function extractZipArchive(archivePath: string, targetDir: string): Promise<void> {
  try {
    const entries = new AdmZip(archivePath, { decoder: losslessNames }).getEntries();
    const root = path.resolve(targetDir), destinations = new Map<string, boolean>();
    let total = 0;
    if (entries.length > 10_000) throw new ArchiveReadError("limit");
    // Validate every decoded path before writing any file. Keep duplicate-name
    // rejection; never "fix" Chinese filenames by allowing silent overwrites.
    const planned = entries.flatMap(entry => {
      if (entry.header.flags & 1) throw new ArchiveReadError("encrypted");
      const name = entryName(entry).replace(/\\/g, "/");
      if (!name || /[\0-\x1f]/.test(name) || path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)
        || name.split("/").some(part => part === ".." || (process.platform === "win32" && (part.includes(":") || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part.replace(/[ .]+$/, "")))))) throw new ArchiveReadError("path");
      const destination = path.resolve(root, name), relative = path.relative(root, destination);
      if (!relative && entry.isDirectory) return []; // ordinary ./ root marker
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ArchiveReadError("path");
      if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new ArchiveReadError("path");
      const key = relative.normalize("NFC").toLowerCase();
      if (destinations.has(key) && !(entry.isDirectory && destinations.get(key))) throw new ArchiveReadError("duplicate");
      destinations.set(key, entry.isDirectory);
      if (!entry.isDirectory) total += entry.header.size;
      if (!Number.isSafeInteger(total) || total > 500 * 1024 * 1024) throw new ArchiveReadError("limit");
      return [{ entry, destination }];
    });
    await mkdir(root, { recursive: true });
    for (const { entry, destination } of planned) {
      if (entry.isDirectory) { await mkdir(destination, { recursive: true }); continue; }
      const bytes = entry.getData();
      if (bytes.length !== entry.header.size) throw new ArchiveReadError("invalid");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
    }
  } catch (error) {
    if (error instanceof ArchiveReadError) throw error;
    const message = error instanceof Error ? error.message : "";
    throw new ArchiveReadError(/Duplicate entry name/.test(message) ? "duplicate" : "invalid", { cause: error });
  }
}

export function archiveReadErrorMessage(error: unknown, locale: "zh" | "en"): string | undefined {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    if (!(error instanceof ArchiveReadError)) continue;
    const messages = {
      encrypted: ["这个 ZIP 需要密码。请先解密，或直接发送里面的文件。", "This ZIP is password-protected. Decrypt it first, or send the files inside it."],
      name: ["这个 ZIP 的文件名编码无效。请使用 UTF-8 文件名重新压缩后发送。", "This ZIP has invalid filename encoding. Recreate it with UTF-8 filenames."],
      path: ["这个 ZIP 包含不安全的文件路径或符号链接，未解压。请重新打包普通文件。", "This ZIP contains an unsafe path or symbolic link. Repackage regular files."],
      duplicate: ["这个 ZIP 中有重名或冲突的文件路径，未覆盖任何文件。请整理文件名后重新压缩。", "This ZIP contains conflicting file paths. No files were overwritten. Rename the conflicting files and recreate it."],
      limit: ["这个 ZIP 解压后超过 500 MiB 或 10,000 个条目，请拆分后发送。", "This ZIP exceeds 500 MiB or 10,000 extracted entries. Split it before sending."],
      invalid: ["无法完整读取这个 ZIP，可能已损坏或使用了不支持的压缩方式。请重新压缩后发送，或直接发送里面的文件。", "This ZIP could not be read completely. It may be damaged or use unsupported compression. Recreate it, or send the files inside it."],
    };
    return messages[error.code][locale === "en" ? 1 : 0];
  }
}

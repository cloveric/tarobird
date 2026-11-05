import { Unzip, UnzipInflate, zipSync } from "fflate";

export const DOCX_MAX_BYTES = 10 * 1024 * 1024;
const EXPANDED_LIMIT = 32 * 1024 * 1024, ENTRY_LIMIT = 16 * 1024 * 1024;
/** Bound actual inflated bytes, not just untrusted ZIP size metadata. Repack
 * validated entries so the converter cannot follow conflicting central headers. */
export function boundedDocxArchive(bytes: Uint8Array): ArrayBuffer {
  return boundedOfficeArchive(bytes, "word/document.xml");
}
/** Excel and Word share the same bounded ZIP boundary. */
export function boundedOfficeArchive(bytes: Uint8Array, requiredEntry: string): ArrayBuffer {
  if (bytes.length > DOCX_MAX_BYTES) throw new Error("large");
  const files: Record<string, Uint8Array> = Object.create(null), names = new Set<string>();
  let expanded = 0, complete = 0;
  const unzip = new Unzip(file => {
    if (names.has(file.name) || ++complete > 2000 || file.name.includes("..") || file.name.includes("\\") || file.name.startsWith("/") || (file.originalSize ?? 0) > ENTRY_LIMIT) throw new Error("large");
    names.add(file.name);
    const chunks: Uint8Array[] = []; let size = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.length; expanded += data.length;
      if (size > ENTRY_LIMIT || expanded > EXPANDED_LIMIT) throw new Error("large");
      chunks.push(data);
      if (final) {
        const content = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
        files[file.name] = content; chunks.length = 0;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small input slices bound each synchronous inflation burst even for bombs.
  for (let at = 0; at < bytes.length; at += 1024) unzip.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length);
  if (Object.keys(files).length !== names.size || !files[requiredEntry] || !files["[Content_Types].xml"]) throw new Error("invalid");
  return zipSync(files, { level: 0 }).buffer as ArrayBuffer;
}

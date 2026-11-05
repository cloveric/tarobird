/** Filename hints for App delivery and generic-type preview recovery. This is
 * not content validation: media elements still decode the original bytes. */
const types: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json",
  ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
};
export function attachmentMime(name: string): string {
  const leaf = name.split(/[\\/]/).at(-1) ?? "", dot = leaf.lastIndexOf(".");
  const extension = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(types, extension) ? types[extension]! : "application/octet-stream";
}

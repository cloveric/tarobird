/** Display hints only. Preview/export still validate the actual downloaded file. */
export type FileKind = "word" | "pdf" | "spreadsheet" | "presentation" | "archive" | "markdown" | "text" | "code" | "image" | "audio" | "video" | "file";
const types: { kind: FileKind; mark: string; extensions: readonly string[]; mimes: readonly string[] }[] = [
  { kind: "word", mark: "W", extensions: ["doc", "docx", "docm", "dot", "dotx", "dotm"], mimes: ["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.template", "application/vnd.ms-word.document.macroenabled.12"] },
  { kind: "pdf", mark: "PDF", extensions: ["pdf"], mimes: ["application/pdf"] },
  { kind: "spreadsheet", mark: "X", extensions: ["xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "csv", "tsv", "ods"], mimes: ["application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.template", "application/vnd.ms-excel.sheet.macroenabled.12", "application/vnd.ms-excel.sheet.binary.macroenabled.12", "text/csv", "text/tab-separated-values", "application/vnd.oasis.opendocument.spreadsheet"] },
  { kind: "presentation", mark: "P", extensions: ["ppt", "pptx", "pptm", "pps", "ppsx", "ppsm", "pot", "potx", "odp"], mimes: ["application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.presentationml.slideshow", "application/vnd.ms-powerpoint.presentation.macroenabled.12", "application/vnd.oasis.opendocument.presentation"] },
  { kind: "archive", mark: "ZIP", extensions: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"], mimes: ["application/zip", "application/x-zip-compressed", "application/x-rar-compressed", "application/vnd.rar", "application/x-7z-compressed", "application/x-tar", "application/gzip"] },
  { kind: "code", mark: "</>", extensions: ["json", "xml", "yaml", "yml", "html", "htm", "css", "js", "jsx", "ts", "tsx", "py", "sh", "sql", "java", "c", "cpp", "h", "go", "rs", "toml"], mimes: ["application/json", "application/xml", "text/xml", "text/html", "text/css", "text/javascript", "application/javascript", "application/yaml", "text/yaml"] },
  { kind: "markdown", mark: "MD", extensions: ["md", "markdown"], mimes: ["text/markdown", "text/x-markdown"] },
  { kind: "text", mark: "TXT", extensions: ["txt", "log", "rtf", "odt"], mimes: ["text/plain", "application/rtf", "text/rtf", "application/vnd.oasis.opendocument.text"] },
  { kind: "image", mark: "IMG", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "avif", "bmp", "tif", "tiff"], mimes: [] },
  { kind: "audio", mark: "♫", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac", "aiff"], mimes: [] },
  { kind: "video", mark: "▶", extensions: ["mp4", "mov", "webm", "mkv", "avi", "m4v"], mimes: [] },
];
export function fileKind(name = "", mime = ""): { kind: FileKind; mark: string; label: string } {
  const filename = name.split(/[\\/]/).at(-1)?.trim() ?? "", dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const mediaType = mime.split(";", 1)[0]!.trim().toLowerCase();
  // Office uploads often arrive as octet-stream or zip. A recognized final
  // extension is the most useful display hint; never infer from an inner suffix.
  const type = types.find(type => type.extensions.includes(extension)) ?? types.find(type => type.mimes.includes(mediaType)) ??
    types.find(type => ["image", "audio", "video", "text"].includes(type.kind) && mediaType.startsWith(`${type.kind}/`));
  const label = /^[a-z0-9]{1,5}$/.test(extension) ? extension.toUpperCase() : type?.kind === "word" ? "Word" : type?.kind === "spreadsheet" ? "Excel" : type?.kind === "presentation" ? "PowerPoint" : type?.mark ?? "FILE";
  return { kind: type?.kind ?? "file", mark: type?.mark ?? "FILE", label };
}

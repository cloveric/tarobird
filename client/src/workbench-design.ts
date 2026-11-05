import { decodeBase64 } from "../../src/client-protocol/base64.js";
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { DESIGN_FILE_BYTES, DESIGN_DOCUMENT_BYTES, DESIGN_FILE_COUNT, designPath, designFormatSchema, type DesignFormat } from "../../src/client-protocol/workbench-design.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const fileSchema = z.object({ base64: z.string().max(Math.ceil(DESIGN_FILE_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0, "design_invalid_base64"), contentType: z.string().min(1).max(128).regex(/^[\w.+-]+\/[\w.+-]+(?:;charset=utf-8)?$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(DESIGN_FILE_BYTES) }).strict();
export const designDocumentSchema = z.object({ schema: z.literal(1), id, revision: z.number().int().nonnegative().safe(),
  // Retain existing design-system source snapshots for canvas/PPT install and
  // sync. They are data sources, never a standalone editor/create/open format.
  format: designFormatSchema.or(z.literal("design-system")).optional(),
  files: z.record(designPath, fileSchema), receipts: z.array(z.object({ id, fingerprint: z.string().max(128), revision: z.number().int().nonnegative() }).strict()).max(128),
}).strict().superRefine((value, context) => {
  if (Object.keys(value.files).length > DESIGN_FILE_COUNT || Object.values(value.files).reduce((size, file) => size + file.size, 0) > DESIGN_DOCUMENT_BYTES) context.addIssue({ code: "custom", message: "design_storage_limit" });
  const format = value.format ?? "canvas";
  if (!["canvas", "slides"].includes(format)) return;
  const index = format === "slides" ? "project/deck.json" : "project/canvas.json";
  if (!value.files[index]) context.addIssue({ code: "custom", message: "design_index_required" });
  if (value.files[value.format === "slides" ? "project/canvas.json" : "project/deck.json"]) context.addIssue({ code: "custom", message: "design_format_mismatch" });
});
export type DesignDocument = z.infer<typeof designDocumentSchema>;
export type DesignFile = DesignDocument["files"][string];
export function encodeDesignFile(bytes: Uint8Array, contentType = "text/plain"): DesignFile {
  if (bytes.length > DESIGN_FILE_BYTES) throw new Error("design_file_too_large");
  let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return fileSchema.parse({ base64: btoa(binary), size: bytes.length, sha256: bytesToHex(sha256(bytes)), contentType });
}
export const designTextFile = (text: string, contentType = "text/plain") => encodeDesignFile(new TextEncoder().encode(text), contentType);
export const decodeDesignFile = (file: { base64: string }) => decodeBase64(file.base64);
export function validateDesignDocument(input: unknown): DesignDocument {
  const document = designDocumentSchema.parse(input);
  for (const [path, file] of Object.entries(document.files)) {
    const bytes = decodeDesignFile(file);
    if (path.startsWith("project/assets/") && path !== `project/assets/${file.sha256.slice(0, 32)}`) throw new Error("design_asset_corrupt");
    if (bytes.length !== file.size || bytesToHex(sha256(bytes)) !== file.sha256) throw new Error("design_file_corrupt");
  }
  for (const [path,file] of Object.entries(document.files)) if (path.startsWith("project/db/")) {
      if (!path.endsWith(".json")) throw new Error("design_invalid_db_path");
      const data = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(decodeDesignFile(file)));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("design_invalid_db_document");
      const check = (v: unknown, depth = 0): void => { if (depth > 48) throw new Error("design_invalid_db_document"); if (v && typeof v === "object") for (const [key,value] of Object.entries(v)) { if (["__proto__","constructor","prototype"].includes(key)) throw new Error("design_invalid_db_document"); check(value, depth+1); } };
      check(data);
  }
  if (document.format === "design-system") {
    if (document.files["project/canvas.json"] || document.files["project/deck.json"]) throw new Error("design_format_mismatch");
    return document;
  }
  const index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeDesignFile(document.files[document.format === "slides" ? "project/deck.json" : "project/canvas.json"])));
  if (document.format === "slides") {
    if (!index || index.v !== 4 || !Array.isArray(index.order) || index.order.length > DESIGN_FILE_COUNT || new Set(index.order).size !== index.order.length) throw new Error("design_invalid_index");
    for (const id of index.order) if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !document.files[`project/slides/${id}.html`]) throw new Error("design_slide_missing");
    return document;
  }
  if (!index || index.v !== 3 || !index.boards || typeof index.boards !== "object" || Array.isArray(index.boards)) throw new Error("design_invalid_index");
  for (const name of Object.keys(index.boards)) if (!designPath.safeParse("project/" + name).success || !name.endsWith(".dc.html") || !document.files["project/" + name]) throw new Error("design_artboard_missing");
  return document;
}
export function emptyDesign(id: string, title = "设计"): DesignDocument {
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const canvas = { v: 3, createdOnFiles: { v: 1, at: new Date().toISOString() }, title, launch: { view: "canvas" }, pages: [], boards: { "Main.dc.html": { x: 0, y: 0, w: 880, h: 560, title } }, order: ["Main.dc.html"], notes: {}, designSystems: [] };
  return { schema: 1, id, revision: 0, receipts: [], files: {
    "project/canvas.json": designTextFile(JSON.stringify(canvas), "application/json"),
    "project/Main.dc.html": designTextFile(`<!doctype html><html><head><meta charset="utf-8"><script src="./support.js"></script></head><body><x-dc><div style="width:880px;height:560px;box-sizing:border-box;padding:56px;display:flex;flex-direction:column;gap:20px;background:#ffffff;color:#292723;font-family:system-ui"><h1 style="font-size:48px;font-weight:600;margin:0">${escaped}</h1><p style="font-size:22px;color:#77736e;margin:0">双击文字即可编辑，也可以让 Bot 帮你设计。</p></div></x-dc><script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":880,"height":560}}'>class Component extends DCLogic {}</script></body></html>`, "text/html"),
  } };
}
export function emptySlides(id: string, title = "PPT"): DesignDocument {
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return { schema: 1, format: "slides", id, revision: 0, receipts: [], files: {
    "project/deck.json": designTextFile(JSON.stringify({ v: 4, createdOnFiles: { v: 1, at: new Date().toISOString() }, lists: "css", title, order: ["cover"], cover: "cover", sections: {}, faces: {}, designSystems: [] }), "application/json"),
    "project/slides/cover.html": designTextFile(`<section id="cover" style="background:#faf9f6;color:#292723;font-family:Arial;padding:128px;display:flex;flex-direction:column;justify-content:center;gap:48px"><h1 style="font-size:96px;font-weight:600">${escaped}</h1><p style="font-size:36px;color:#77736e">双击文字即可编辑，也可以让 Bot 帮你制作幻灯片。</p></section>`, "text/html"),
  } };
}
/** Both editors retain the same atomic, revisioned project store. */
export function emptyDesignDocument(id: string, title: string, format: DesignFormat = "canvas"): DesignDocument {
  if (format === "canvas") return emptyDesign(id,title);
  if (format === "slides") return emptySlides(id,title);
  throw new Error("design_format_unsupported");
}
const wireEntry = z.object({ base64: fileSchema.shape.base64, contentType: fileSchema.shape.contentType, ifMatch: z.string().nullable().optional() }).strict();
const wireDelete = z.object({ delete: z.literal(true), ifMatch: z.string().nullable().optional() }).strict();
const batchSchema = z.record(designPath, z.union([wireEntry, wireDelete, z.null()])).refine(files => Object.keys(files).length <= DESIGN_FILE_COUNT, "design_file_count");
export function designListing(document: DesignDocument) {
  return { ver: `local-${document.revision}`, format: document.format ?? "canvas", files: Object.fromEntries(Object.entries(document.files).filter(([path]) => !path.startsWith("project/assets/")).map(([path, file]) => [path, { sha256: file.sha256, size: file.size, contentType: file.contentType }])) };
}
/** Full-batch validation before persistence. File CAS protects edits from other
 * editor windows; document revision additionally fences Bot writes. */
export function applyDesignFiles(old: DesignDocument, input: unknown): DesignDocument {
  const batch = batchSchema.parse(input), files = { ...old.files };
  for (const [path, entry] of Object.entries(batch)) {
    if (path.startsWith("project/assets/")) throw new Error("design_read_only_path");
    if (entry?.ifMatch !== undefined && entry.ifMatch !== (files[path]?.sha256 ?? null)) throw new Error("design_revision_conflict");
    // An editor may omit ifMatch for new files, never for existing bytes.
    if (files[path] && entry?.ifMatch === undefined) throw new Error("design_revision_required");
    if (!entry || "delete" in entry) delete files[path];
    else files[path] = encodeDesignFile(decodeDesignFile(entry), entry.contentType);
  }
  return validateDesignDocument({ ...old, revision: old.revision + 1, files });
}

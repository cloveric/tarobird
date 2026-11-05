import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { MAX_FILE_BYTES, type Json } from "../client-protocol/index.js";
import { extractDeliveryTagMatches } from "./shared/delivery-tags.js";
import { extractCoreToolTagMatches, parseCoreToolTagPayload } from "./shared/tool-tags.js";
import { isCoreSendToolName, normalizeCoreSendTool } from "./delivery-preflight.js";

export interface AppDeliveryReceipt { path: string; messageId: string; sha256: string }
/** Per-user-turn publication promises shared across automatic repair attempts. */
export type AppDeliveryCache = Map<string, Promise<Json>>;
export const appArtifactKey = (conversationId: string, filePath: string, sha256: string, kind: string, caption?: string) =>
  createHash("sha256").update(JSON.stringify([conversationId, filePath, sha256, kind, caption ?? ""])).digest("hex");

/** Native delivery has already published these file versions. Suppress only duplicate
 * executable directives; preserve quoted examples and any unsent siblings. */
export async function stripAlreadyDeliveredAppArtifacts(text: string, delivered: ReadonlyArray<AppDeliveryReceipt>): Promise<string> {
  if (!delivered.length) return text;
  const versions = new Map<string, Set<string>>();
  for (const receipt of delivered) {
    const hashes = versions.get(receipt.path) ?? new Set<string>();
    hashes.add(receipt.sha256); versions.set(receipt.path, hashes);
  }
  const checked = new Map<string, boolean>();
  const alreadyDelivered = async (value: string): Promise<boolean> => {
    try {
      const canonical = await realpath(value);
      const hashes = versions.get(canonical);
      if (!hashes) return false;
      if (checked.has(canonical)) return checked.get(canonical)!;
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size > MAX_FILE_BYTES) return false;
        const hash = createHash("sha256"); let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) return false;
          hash.update(chunk);
        }
        const after = await file.stat();
        const same = size === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && hashes.has(hash.digest("hex"));
        checked.set(canonical, same);
        return same;
      } finally { await file.close(); }
    } catch { return false; /* Existing preflight owns missing/changed files. */ }
  };
  const edits: Array<{ index: number; length: number; replacement: string }> = [];
  for (const match of extractDeliveryTagMatches(text)) {
    if (await alreadyDelivered(match.path)) edits.push({ index: match.index, length: match.tag.length, replacement: "" });
  }
  for (const match of extractCoreToolTagMatches(text)) {
    try {
      const tool = parseCoreToolTagPayload(match.payload);
      if (!isCoreSendToolName(tool.name)) continue;
      const normalized = normalizeCoreSendTool(tool.name, tool.payload);
      if (!normalized.ok) continue;
      const remaining = [];
      for (const artifact of normalized.artifacts) if (!await alreadyDelivered(artifact.path)) remaining.push(artifact);
      if (remaining.length === normalized.artifacts.length) continue;
      const replacement = [normalized.message, ...remaining.map((file) => '```tool-call\n' + JSON.stringify({ name: `send.${file.kind}`, payload: { path: file.path, ...(file.caption ? { caption: file.caption } : {}) } }) + '\n```')].filter(Boolean).join("\n");
      edits.push({ index: match.index, length: match.tag.length, replacement });
    } catch { /* Existing delivery validation owns malformed directives. */ }
  }
  for (const edit of edits.sort((a, b) => b.index - a.index)) text = text.slice(0, edit.index) + edit.replacement + text.slice(edit.index + edit.length);
  return text.trim();
}

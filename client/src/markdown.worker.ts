import { MarkdownDependencyError, parseMarkdownChunks, type MarkdownDependency } from "./markdown-parser.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
export type MarkdownWorkerRequest = { id: number; text: string; unavailable?: MarkdownDependency[] };
export type MarkdownWorkerChunk = { fingerprint: string; serialized: string };
export type MarkdownWorkerResult = { id: number; chunks: MarkdownWorkerChunk[]; dependencies?: MarkdownDependency[] } | { id: number; error: true; dependency?: MarkdownDependency; skipped?: boolean; dependencies?: MarkdownDependency[] };
async function fingerprint(serialized: string): Promise<string> {
  const bytes = utf8ToBytes(serialized);
  // Native hashing avoids a second long JS scan. The existing pure-JS hash
  // keeps worker rendering available when WebCrypto is absent or restricted.
  if (globalThis.crypto?.subtle) {
    try { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))); } catch { /* platform fallback */ }
  }
  return bytesToHex(sha256(bytes));
}
async function render({ id, text, unavailable }: MarkdownWorkerRequest): Promise<void> {
  let result: MarkdownWorkerResult;
  const used = new Set<MarkdownDependency>();
  try {
    // Fingerprint the cleaned output, not source spans: a reference definition
    // at the end can change a tree near the start. UI can retain the parsed
    // tree and a small key instead of its full JSON transport copy as well.
    const serialized = await parseMarkdownChunks(text, { unavailable, used }), chunks: MarkdownWorkerChunk[] = [];
    // Bound the extra encoding/digest buffers for large documents, rather than
    // submitting every chunk to the native provider simultaneously.
    for (let offset = 0; offset < serialized.length; offset += 8) {
      chunks.push(...await Promise.all(serialized.slice(offset, offset + 8).map(async serialized => ({ fingerprint: await fingerprint(serialized), serialized }))));
    }
    result = { id, chunks, dependencies: [...used] };
  } catch (error) {
    result = { id, error: true, dependencies: [...used], ...(error instanceof MarkdownDependencyError ? { dependency: error.dependency, skipped: error.skipped } : {}) };
  }
  self.postMessage(result);
}
self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  // postMessage can itself fail. Surface an ordinary worker error so the main
  // thread's existing recovery runs, without an unobserved async rejection.
  void render(event.data).catch(() => { setTimeout(() => { throw new Error("markdown_worker_reply_failed"); }, 0); });
};

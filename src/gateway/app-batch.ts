import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppPlatformTools } from "../codex/adapter.js";
import { MAX_FILE_BYTES, MAX_TEXT_BYTES, type Json } from "../client-protocol/index.js";
import { preflightCoreDeliveryPath, resolveCoreDeliveryRoots } from "../core/delivery-preflight.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { buildCoreConversationKey } from "../core/message-normalizer.js";
import { appArtifactKey, type AppDeliveryCache, type AppDeliveryReceipt } from "./app-delivery.js";
import { GatewayArtifactUploadError, type GatewayChannel, type GatewayArtifact } from "./channel.js";
import type { GatewayReceipts } from "./receipts.js";

const artifactArgs = z.object({ path: z.string().min(1).max(4096).refine(path.isAbsolute), kind: z.enum(["file", "image", "audio", "video"]), caption: z.string().max(12_000).optional() }).strict();
const batchArgs = z.object({ artifacts: z.array(artifactArgs).min(1).max(50), caption: z.string().max(12_000).optional() }).strict()
  .refine((batch) => Buffer.byteLength(JSON.stringify([batch.caption ?? "", ...batch.artifacts.map((file) => file.caption ?? "")])) <= MAX_TEXT_BYTES, "Combined encoded captions exceed 200 KiB");
export const batchDefinition: AppPlatformTools["definitions"][number] = {
  name: "app_send_batch", description: "Deliver a titled image gallery and/or mixed attachments in one message to the current App conversation. Up to 50 artifacts and 512 MiB total; optional batch and per-artifact captions. Returns a receipt only after publication. Do not send these artifacts again with other tools or text markers.",
  inputSchema: { type: "object", properties: { artifacts: { type: "array", minItems: 1, maxItems: 50, items: { type: "object", properties: { path: { type: "string", description: "Absolute workspace/output path." }, kind: { type: "string", enum: ["file", "image", "audio", "video"] }, caption: { type: "string", description: "Image title or attachment caption." } }, required: ["path", "kind"], additionalProperties: false } }, caption: { type: "string", description: "Optional text published with the entire batch." } }, required: ["artifacts"], additionalProperties: false },
};
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const result = (value: unknown, isError = false) => ({ text: JSON.stringify(value), ...(isError ? { isError: true } : {}) });
interface SavedFile { path: string; name: string; kind: GatewayArtifact["kind"]; caption?: string; size: number; sha256: string }

export async function deliverAppBatch(input: {
  channel: Pick<GatewayChannel, "sendArtifactBatch">; stateDir: string; conversationId: string; replyTo?: string;
  requestOutputDir?: string; workspaceOverride?: string; signal: AbortSignal; receipts: Pick<GatewayReceipts, "run">;
  publications: AppDeliveryCache; onDelivered?: (file: AppDeliveryReceipt) => void;
  ephemeral?: boolean;
  artifactMime: (name: string) => string;
}, call: Parameters<AppPlatformTools["call"]>[0]) {
  const parsed = batchArgs.safeParse(call.arguments);
  if (!parsed.success) return result({ error: "invalid_batch_arguments", expected: "1-50 artifacts with absolute path, kind and optional caption (12000 characters each, 200 KiB combined); no recipient override" }, true);
  const args = parsed.data, fingerprint = digest(JSON.stringify(args));
  const signal = AbortSignal.any([input.signal, call.abortSignal]);
  const key = `app-batch:${input.conversationId}:${call.sessionId}:${call.callId}`;
  const keysFor = (files: SavedFile[]) => files.map((file) => appArtifactKey(input.conversationId, file.path, file.sha256, file.kind, file.caption));
  const batchKeyFor = (files: SavedFile[]) => `batch:${digest(JSON.stringify([keysFor(files), args.caption ?? ""]))}`;
  const singleResult = (file: SavedFile, messageId: string): Json => ({ delivered: true, path: file.path, name: file.name, size: file.size, sha256: file.sha256, messageId });
  const receipt = await input.receipts.run(key, async (): Promise<Json> => {
    let sending = false;
    try {
      signal.throwIfAborted();
      const roots = await resolveCoreDeliveryRoots(input);
      const checked: Array<{ realPath: string; fileIdentity: string; fileBytes: number; args: z.infer<typeof artifactArgs> }> = [];
      let total = 0;
      for (const [index, artifact] of args.artifacts.entries()) {
        signal.throwIfAborted();
        const safe = await preflightCoreDeliveryPath(artifact.path, roots);
        if (!safe.ok) return { fingerprint, error: safe.reason, index, published: false };
        if (safe.fileBytes === 0) return { fingerprint, error: "empty_file", index, published: false, hint: "The Hub does not accept empty attachments. Write the file contents before sending." };
        total += safe.fileBytes;
        if (total > MAX_FILE_BYTES) return { fingerprint, error: "batch_too_large", maxBytes: MAX_FILE_BYTES, published: false };
        checked.push({ ...safe, args: artifact });
      }
      const artifacts: GatewayArtifact[] = [], files: SavedFile[] = [];
      total = 0;
      for (const [index, safe] of checked.entries()) {
        signal.throwIfAborted();
        const handle = await open(safe.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size !== safe.fileBytes || (before.ino > 0 && safe.fileIdentity !== `inode:${before.dev}:${before.ino}`)) return { fingerprint, error: "file_changed", index, published: false };
          bytes = await handle.readFile();
          const after = await handle.stat();
          total += bytes.length;
          if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || total > MAX_FILE_BYTES) return { fingerprint, error: "file_changed", index, published: false };
        } finally { await handle.close(); }
        const name = path.basename(safe.realPath), mime = input.artifactMime(name);
        if (safe.args.kind === "image" && !mime.startsWith("image/")) return { fingerprint, error: "unsupported_image_type", index, published: false, hint: "Use kind=file for this format." };
        artifacts.push({ bytes, name, mime, kind: safe.args.kind, caption: safe.args.caption });
        files.push({ path: safe.realPath, name, kind: safe.args.kind, ...(safe.args.caption !== undefined ? { caption: safe.args.caption } : {}), size: bytes.length, sha256: digest(bytes) });
      }
      signal.throwIfAborted();
      const batchKey = batchKeyFor(files), keys = keysFor(files);
      if (new Set(keys).size !== keys.length) return { fingerprint, error: "duplicate_batch_artifact", published: false };
      let publication = input.publications.get(batchKey);
      if (!publication) {
        if (keys.some((id) => input.publications.has(id))) return { fingerprint, error: "batch_overlaps_existing_delivery", published: false, hint: "Some identical artifacts have already been sent or are in flight. Verify their receipts; send only the remaining artifacts." };
        publication = (async (): Promise<Json> => {
          const sent = await input.channel.sendArtifactBatch({ conversationId: input.conversationId, messageId: `msg_${digest(key).slice(0, 32)}`, replyTo: input.replyTo, artifacts, caption: args.caption, abortSignal: signal, onActivity: call.onActivity });
          if (!input.ephemeral) for (const file of files) await appendTimelineEventBestEffort(input.stateDir, { type: "file.accepted", channel: "gateway", conversationKey: buildCoreConversationKey(input.conversationId), outcome: "success", metadata: { path: file.path, fileBytes: file.size, kind: file.kind, messageId: sent.messageId, via: "app_send_batch" } });
          return { delivered: true, messageId: sent.messageId, files: z.json().parse(files) };
        })();
        input.publications.set(batchKey, publication);
        // Reserve each member synchronously. Concurrent single-file calls share
        // this publication; overlapping batches cannot produce duplicate members.
        const members = files.map((file, i) => {
          const pending = publication!.then((saved) => singleResult(file, (saved as { messageId: string }).messageId));
          input.publications.set(keys[i]!, pending); void pending.catch(() => undefined);
          return pending;
        });
        void publication.catch((error) => {
          if (!(error instanceof GatewayArtifactUploadError)) return;
          if (input.publications.get(batchKey) === publication) input.publications.delete(batchKey);
          keys.forEach((id, i) => { if (input.publications.get(id) === members[i]) input.publications.delete(id); });
        });
      }
      sending = true;
      return { ...await publication as Record<string, Json>, fingerprint };
    } catch (error) {
      if (sending && !(error instanceof GatewayArtifactUploadError)) throw error;
      return { fingerprint, error: signal.aborted ? "turn_ended" : error instanceof GatewayArtifactUploadError ? error.code : "read-error", published: false, retryable: !signal.aborted,
        hint: "No message was published. Correct the files or connection before retrying with a new call ID.", ...(error instanceof GatewayArtifactUploadError && error.status ? { status: error.status } : {}),
        ...(error instanceof GatewayArtifactUploadError && error.index !== undefined ? { index: error.index } : {}) };
    }
  });
  if (!receipt.ok) return result({ error: signal.aborted ? "turn_ended" : "delivery_uncertain", hint: "Check the conversation before retrying. This call will not publish twice." }, true);
  const saved = z.object({ fingerprint: z.string(), error: z.string().optional(), delivered: z.boolean().optional(), messageId: z.string().optional(), files: z.array(z.object({ path: z.string(), name: z.string(), kind: artifactArgs.shape.kind, caption: z.string().optional(), size: z.number(), sha256: z.string() })).optional() }).passthrough().parse(receipt.result);
  if (saved.fingerprint !== fingerprint) return result({ error: "tool_call_id_reused_with_different_arguments" }, true);
  if (saved.delivered && saved.messageId && saved.files) {
    const { messageId, files } = saved;
    const batchKey = batchKeyFor(files);
    if (!input.publications.has(batchKey)) input.publications.set(batchKey, Promise.resolve(z.json().parse(saved)));
    files.forEach((file) => {
      const id = appArtifactKey(input.conversationId, file.path, file.sha256, file.kind, file.caption);
      if (!input.publications.has(id)) input.publications.set(id, Promise.resolve(singleResult(file, messageId)));
      input.onDelivered?.({ path: file.path, messageId, sha256: file.sha256 });
    });
  }
  const { fingerprint: _private, files, ...publicResult } = saved;
  return result({ ...publicResult, ...(files ? { files: files.map(({ path: _path, ...file }) => file) } : {}) }, !!saved.error);
}

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { idSchema } from "../client-protocol/index.js";
import { attachmentMime } from "../client-protocol/attachment-mime.js";
import { SIDE_ATTACHMENT_COUNT_LIMIT, SIDE_QUESTION_LIMIT, sideAskSchema, sideReplySchema, type SideView } from "../client-protocol/side.js";
import type { LocalHostClient } from "./client.js";
import { upload } from "./groups.js";

export async function runSideCommand(client: Pick<LocalHostClient, "request"> & Partial<Pick<LocalHostClient, "putChunk">>, command: string | undefined, conversation: string | undefined, options: { bot?: string; text?: string; "text-file"?: string; file?: string[]; timeout?: string; "request-id"?: string }, signal?: AbortSignal) {
  if (!["status", "ask"].includes(command ?? "")) throw new Error("用法：tarobot side status|ask CONVERSATION --bot BOT [--text TEXT | --text-file FILE] [--file FILE]...。");
  const conversationId = idSchema.parse(conversation), botId = idSchema.parse(options.bot), route = `/api/conversations/${conversationId}/side`, query = `botId=${botId}`;
  const status = async () => {
    try { return sideReplySchema.parse(await client.request(`${route}?${query}&attachments=1&tools=1&delivery=1`)); }
    catch {
      try { return sideReplySchema.parse(await client.request(`${route}?${query}&attachments=1&tools=1`)); }
      catch { return sideReplySchema.parse(await client.request(`${route}?${query}&attachments=1`)); }
    }
  };
  if (command === "status") {
    if (options.text !== undefined || options["text-file"] || options.file?.length || options.timeout || options["request-id"]) throw new Error("side status 只接受 --bot。");
    return status();
  }
  // Repeated paths are one attachment; the Hub also deduplicates equal uploads.
  const files = [...new Set((options.file ?? []).map(file => path.resolve(file)))];
  if (options.text !== undefined && options["text-file"] !== undefined || !files.length && options.text === undefined && options["text-file"] === undefined) throw new Error(files.length ? "--text 与 --text-file 只能选一个。" : "请选择 --text TEXT 或 --text-file FILE。");
  if (files.length > SIDE_ATTACHMENT_COUNT_LIMIT) throw new Error(`侧边附件最多 ${SIDE_ATTACHMENT_COUNT_LIMIT} 个。`);
  let text = options.text;
  if (options["text-file"]) {
    const file = await open(options["text-file"], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("问题文件必须是普通 UTF-8 文件。");
      const buffer = Buffer.alloc(SIDE_QUESTION_LIMIT * 4 + 1);
      let size = 0;
      while (size < buffer.length) { const result = await file.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
      if (size === buffer.length) throw new Error("问题文件过大。");
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    } finally { await file.close(); }
  }
  const requestId = idSchema.parse(options["request-id"] ?? randomUUID());
  // Validate the whole request before uploading anything.
  sideAskSchema.parse({ botId, requestId, text, ...(files.length ? { attachments: files.map((_, index) => `pending${index}`) } : {}) });
  const seconds = options.timeout === undefined ? 180 : Number(options.timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error("--timeout 须为 1–1800 秒。");
  const until = Date.now() + seconds * 1000;
  const capability = await status();
  const attachments: string[] = [];
  if (files.length) {
    const limits = capability.ok ? capability.capability?.attachments : undefined;
    if (!limits || !client.putChunk) throw new Error("side_attachment_unsupported");
    let total = 0;
    for (const file of files) {
      const size = (await lstat(file)).size, image = /^image\/(png|jpe?g|gif|webp)$/.test(attachmentMime(file));
      if (image && !limits.images) throw new Error("side_attachment_unsupported");
      if (size > (image ? limits.maxImageBytes : limits.maxFileBytes) || (total += size) > limits.maxTotalBytes) throw new Error("side_attachment_too_large");
    }
    // The same resumable upload as the App composer, into this conversation.
    for (const file of files) {
      signal?.throwIfAborted();
      const id = await upload({ request: client.request.bind(client), putChunk: client.putChunk.bind(client) }, conversationId, file, limits.maxFileBytes);
      // Same name and bytes resolve to the same upload ID; send it once.
      if (!attachments.includes(id)) attachments.push(id);
    }
  }
  const ask = sideAskSchema.parse({ botId, requestId, text, ...(attachments.length ? { attachments } : {}) });
  const opened = sideReplySchema.parse(await client.request(route, "POST", { botId, requestId, ...(capability.ok && capability.capability?.tools === "inherited" ? { tools: "inherited" } : {}), ...(capability.ok && capability.capability?.delivery ? { delivery: true } : {}) }));
  if (!opened.ok || !opened.view) throw new Error(`side_${opened.ok ? "failed" : opened.error}`);
  const id = opened.view.id;
  let view: SideView = opened.view, sent = false, answer = "", truncated = false, closeConfirmed = false, partial: string[] = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      if (Date.now() >= until) throw new Error("side_timeout");
      if (view.phase === "error") throw new Error(`side_${view.error ?? "failed"}`);
      if (!sent && view.phase === "idle") {
        const accepted = sideReplySchema.parse(await client.request(`${route}/${id}`, "POST", ask));
        if (!accepted.ok || !accepted.view) throw new Error(`side_${accepted.ok ? "failed" : accepted.error}`);
        view = accepted.view; sent = true;
      }
      const exchange = view.exchanges.find(e => e.id === requestId);
      if (exchange?.status === "complete") { answer = exchange.answer; truncated = exchange.truncated ?? false; partial = exchange.partialAttachments ?? []; break; }
      if (exchange && exchange.status !== "running") throw new Error(`side_${exchange.error ?? "cancelled"}`);
      await delay(500, undefined, { signal });
      const polled = sideReplySchema.parse(await client.request(`${route}/${id}?${query}&revision=${view.revision}`));
      if (!polled.ok) throw new Error(`side_${polled.error}`);
      if (polled.view) view = polled.view;
    }
  } finally {
    const result = await client.request(`${route}/${id}?${query}`, "DELETE").catch(() => null);
    const receipt = sideReplySchema.safeParse(result);
    closeConfirmed = receipt.success && receipt.data.ok;
  }
  return { text: answer, closeConfirmed, ...(view.exchanges.find(e => e.id === requestId)?.deliveries?.length ? { deliveries: view.exchanges.find(e => e.id === requestId)!.deliveries } : {}), ...(attachments.length ? { attachments } : {}), ...(partial.length ? { partialAttachments: partial } : {}), ...(truncated ? { truncated: true } : {}), ...(view.capability.usage === "unavailable" ? { usageAvailable: false } : {}) };
}

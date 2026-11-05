import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { idSchema, MAX_TEXT_BYTES, textSchema } from "../client-protocol/index.js";
import { promptQueueMutationSchema, promptQueueSnapshotSchema, type PromptQueueSnapshot } from "../client-protocol/prompt-queue.js";
import type { LocalHostClient } from "./client.js";

export interface QueueCommandOptions {
  bot?: string;
  message?: string;
  before?: string;
  last?: boolean;
  text?: string;
  "text-file"?: string;
  revision?: string;
  "request-id"?: string;
}

/** Uses the authenticated Hub API, never a second queue or a native CLI session. */
export async function runQueueCommand(
  client: Pick<LocalHostClient, "request">,
  command: string | undefined,
  conversationId: string | undefined,
  options: QueueCommandOptions,
  receipt: (requestId: string) => void = () => {},
): Promise<PromptQueueSnapshot> {
  if (!["list", "move", "edit", "cancel", "pause", "resume"].includes(command ?? "")) throw new Error("用法：tarobot queue list|move|edit|cancel|pause|resume CONVERSATION --bot BOT。");
  const conversation = idSchema.parse(required(conversationId, "缺少对话 ID。"));
  const botId = idSchema.parse(required(options.bot, "缺少 --bot Bot ID。"));
  const route = `/api/conversations/${conversation}/queue`;
  const allowed: Record<string, string[]> = {
    list: ["bot"], move: ["bot", "message", "before", "last", "revision", "request-id"],
    edit: ["bot", "message", "text", "text-file", "revision", "request-id"],
    cancel: ["bot", "message", "revision", "request-id"],
    pause: ["bot", "message", "revision", "request-id"],
    resume: ["bot", "message", "revision", "request-id"],
  };
  for (const [key, value] of Object.entries(options)) if (value !== undefined && !allowed[command!]!.includes(key)) throw new Error(`queue ${command} 不支持 --${key}。`);
  if (command === "list") return promptQueueSnapshotSchema.parse(await client.request(`${route}?botId=${botId}`));
  const messageId = idSchema.parse(required(options.message, "缺少 --message 排队消息 ID。"));
  const revision = required(options.revision, "请先 queue list，再用 --revision 提交刚查看的队列版本。");
  let action;
  if (command === "move") {
    if (!!options.before === !!options.last) throw new Error("请选择 --before MESSAGE 或 --last，两者不能同时使用。");
    action = { type: "move" as const, messageId, beforeId: options.last ? null : idSchema.parse(options.before) };
  } else if (command === "edit") {
    if ((options.text !== undefined) === (options["text-file"] !== undefined)) throw new Error("请选择 --text TEXT 或 --text-file FILE，两者不能同时使用。");
    const text = options["text-file"] === undefined ? options.text! : await readQueueText(options["text-file"]);
    action = { type: "edit" as const, messageId, text: textSchema.parse(text) };
  } else action = { type: command, messageId };
  const requestId = idSchema.parse(options["request-id"] ?? randomUUID());
  const request = promptQueueMutationSchema.parse({ botId, requestId, revision, action });
  // Print before sending, so a lost response can be checked with the exact ID,
  // revision and payload. Never fetch a newer revision and silently overwrite it.
  receipt(requestId);
  return promptQueueSnapshotSchema.parse(await client.request(route, "POST", request));
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

async function readQueueText(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_TEXT_BYTES) throw new Error("文字文件须为不超过 200 KiB 的普通 UTF-8 文件。");
    const bytes = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length > MAX_TEXT_BYTES || before.size !== length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("读取期间文字文件发生变化，请重新检查。");
    if (length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) throw new Error("文字文件是 UTF-16，请另存为 UTF-8 后重试。");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw new Error("文字文件不是有效的 UTF-8，请另存为 UTF-8 后重试。"); }
  } finally { await handle.close(); }
}

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CHUNK_BYTES, conversationSchema, idSchema } from "../client-protocol/index.js";
import { attachmentMime } from "../client-protocol/attachment-mime.js";
import { groupSettingsSchema } from "../client-protocol/groups.js";
import {
  GROUP_DISCUSSION_CAPABILITY, GROUP_DISCUSSION_COMPOSER_CAPABILITY, GROUP_DISCUSSION_RECOVERY_CAPABILITY, GROUP_PARALLEL_CAPABILITY, GROUP_DISCUSSION_TEXT_LIMIT, groupDiscussionActionSchema, groupDiscussionControlSchema, groupDiscussionStartSchema, groupDiscussionNoteSchema,
  groupDiscussionViewSchema, groupSettingsSnapshotSchema,
} from "../client-protocol/group-discussion.js";
import type { LocalHostClient } from "./client.js";

export interface GroupsCommandOptions {
  from?: string;
  revision?: string;
  "text-file"?: string;
  file?: string[];
  run?: string;
  "request-id"?: string;
  "reply-to"?: string;
  participants?: string;
  supersedes?: string;
  then?: string;
  "if-running"?: boolean;
}
type Client = Pick<LocalHostClient, "request" | "putChunk"> & { ready: Pick<LocalHostClient["ready"], "serverCapabilities"> };
const MAX_FILES = 16;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Same Hub APIs as the App group settings and discussion strip. One-shot:
 * never starts a Hub, never retries an uncertain start or control. */
export async function runGroupsCommand(client: Client, command: string | undefined, id: string | undefined, options: GroupsCommandOptions, receipt: (requestId: string) => void = () => {}): Promise<unknown> {
  const allowed: Record<string, string[]> = {
    show: [], update: ["from"], status: [], start: ["text-file", "file", "revision", "request-id", "reply-to", "participants", "supersedes"], note: ["run", "text-file", "file", "request-id", "reply-to", "then", "revision", "if-running"],
    pause: ["run", "revision", "request-id"], resume: ["run", "revision", "request-id"], end: ["run", "revision", "request-id"], retry: ["run", "revision", "request-id"],
  };
  if (!command || !Object.hasOwn(allowed, command)) throw new Error("用法：tarobot groups show|update|status|start|note|pause|resume|end|retry；请执行 tarobot --help。");
  for (const [key, value] of Object.entries(options)) if (value !== undefined && !allowed[command]!.includes(key)) throw new Error(`groups ${command} 不支持 --${key}。`);
  if (!client.ready.serverCapabilities.includes(GROUP_DISCUSSION_CAPABILITY)) throw new Error("主机尚不支持群讨论模式，请先更新主机。");
  const target = idSchema.parse(required(id, command === "show" || command === "update" ? "缺少群 ID。" : "缺少群或话题对话 ID。"));
  if (command === "show") return groupSettingsSnapshotSchema.parse(await client.request(`/api/groups/${target}/settings`));
  if (command === "update") {
    // A complete settings document: the Hub compares title/members and, when
    // present, the policy revision. Never fetch-and-overwrite a newer edit.
    const input = groupSettingsSchema.parse(JSON.parse(await readText(required(options.from, "缺少 --from 设置 JSON 文件；可先 groups show 取得当前值和 revision。"), 64 * 1024)));
    if (input.policy?.mode === "parallel" && !client.ready.serverCapabilities.includes(GROUP_PARALLEL_CAPABILITY)) throw new Error("主机尚不支持并行回复，请先更新主机。");
    const conversations = z.array(conversationSchema).parse(await client.request(`/api/groups/${target}/settings`, "PUT", input));
    return { conversations, settings: groupSettingsSnapshotSchema.parse(await client.request(`/api/groups/${target}/settings`)) };
  }
  if (command === "status") return groupDiscussionViewSchema.parse(await client.request(`/api/conversations/${target}/discussion`));
  const requestId = idSchema.parse(options["request-id"] ?? randomUUID());
  const replyTo = options["reply-to"] ? idSchema.parse(options["reply-to"]) : undefined;
  const recovery = client.ready.serverCapabilities.includes(GROUP_DISCUSSION_RECOVERY_CAPABILITY);
  if (!recovery && (options.participants !== undefined || options.supersedes !== undefined || options.then !== undefined || options["if-running"])) throw new Error("更新主机后可选择发言 Bot、替换已暂停的讨论或补充并继续。");
  if (replyTo && !client.ready.serverCapabilities.includes(GROUP_DISCUSSION_COMPOSER_CAPABILITY)) throw new Error("更新主机后可引用消息发起讨论。");
  if (command === "note") {
    if (!client.ready.serverCapabilities.includes(GROUP_DISCUSSION_COMPOSER_CAPABILITY)) throw new Error("更新主机后可补充讨论。");
    const runId = idSchema.parse(required(options.run, "缺少 --run 讨论 ID；请先 groups status。"));
    const text = options["text-file"] ? await readText(options["text-file"], GROUP_DISCUSSION_TEXT_LIMIT * 4) : "";
    const files = options.file ?? [];
    groupDiscussionNoteSchema.shape.text.parse(text);
    if (!text.trim() && !files.length) throw new Error("补充讨论需要 --text-file 或至少一个 --file。");
    if (files.length > MAX_FILES) throw new Error(`附件最多 ${MAX_FILES} 个。`);
    if (options.then !== undefined && options.then !== "resume" && options.then !== "retry") throw new Error("--then 只能是 resume 或 retry。");
    const then = options.then as "resume" | "retry" | undefined;
    if (!then !== !options.revision) throw new Error("--then 需同时提供讨论 --revision（来自 groups status）；单纯补充不需要 --revision。");
    if (then && options["if-running"]) throw new Error("--then 与 --if-running 不能同时使用。");
    // Status/control may resolve a topic from its root group, but notes, quoted
    // messages and uploads remain bound to the exact conversation. Diagnose a
    // known mismatch before uploading; never redirect or pick another run.
    const current = groupDiscussionViewSchema.parse(await client.request(`/api/conversations/${target}/discussion`));
    if (current.run?.id === runId && current.run.conversationId !== target) {
      throw new Error(`这轮讨论在话题 ${current.run.conversationId} 中。请使用 groups note ${current.run.conversationId} --run ${runId}；附件和引用也须属于该话题。`);
    }
    const attachments: string[] = [];
    for (const file of files) attachments.push(await upload(client, target, file));
    const input = groupDiscussionNoteSchema.parse({ requestId, text, attachments, ...(replyTo ? { replyTo } : {}), ...(then ? { then, revision: options.revision } : {}), ...(options["if-running"] ? { ifRunning: true } : {}) });
    receipt(requestId);
    return groupDiscussionViewSchema.parse(await client.request(`/api/conversations/${target}/discussion/${runId}/notes`, "POST", input));
  }
  if (command === "start") {
    const revision = required(options.revision, "缺少 --revision；请先 groups show 群 ID 取得设置 revision。");
    const participants = options.participants === undefined ? undefined : options.participants.split(",").map(id => id.trim()).filter(Boolean);
    const supersedes = options.supersedes === undefined ? undefined : { runId: idSchema.parse(options.supersedes) };
    const text = await readText(required(options["text-file"], "缺少 --text-file UTF-8 课题文件。"), GROUP_DISCUSSION_TEXT_LIMIT * 4);
    const files = options.file ?? [];
    if (files.length > MAX_FILES) throw new Error(`附件最多 ${MAX_FILES} 个。`);
    // Validate the request before uploading anything.
    groupDiscussionStartSchema.parse({ requestId, revision, text, attachments: [], ...(participants ? { participants } : {}), ...(supersedes ? { supersedes } : {}) });
    const attachments: string[] = [];
    for (const file of files) attachments.push(await upload(client, target, file));
    const input = groupDiscussionStartSchema.parse({ requestId, revision, text, ...(attachments.length ? { attachments } : {}), ...(replyTo ? { replyTo } : {}), ...(participants ? { participants } : {}), ...(supersedes ? { supersedes } : {}) });
    // Print first so a lost response can be checked with the same ID/payload.
    receipt(requestId);
    return groupDiscussionViewSchema.parse(await client.request(`/api/conversations/${target}/discussion`, "POST", input));
  }
  const runId = idSchema.parse(required(options.run, "缺少 --run 讨论 ID；请先 groups status。"));
  // End and pause bind to the exact run on recovery Hosts; a missing revision
  // is read once from status (never a retry). Resume/retry keep the explicit CAS.
  const lenient = recovery && (command === "end" || command === "pause");
  let revision = options.revision;
  if (!revision && lenient) {
    const current = groupDiscussionViewSchema.parse(await client.request(`/api/conversations/${target}/discussion`));
    revision = current.run?.id === runId ? current.run.revision : "r0";
  }
  revision = required(revision, "缺少 --revision；请先 groups status 取得讨论 revision。");
  const input = groupDiscussionControlSchema.parse({ requestId, revision, action: groupDiscussionActionSchema.parse(command) });
  receipt(requestId);
  return groupDiscussionViewSchema.parse(await client.request(`/api/conversations/${target}/discussion/${runId}/control`, "POST", input));
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

async function readFile(file: string, maximum: number): Promise<Buffer> {
  if (!file.trim() || file.includes("\0")) throw new Error("输入文件路径无效。");
  const checked = await lstat(file);
  if (!checked.isFile() || checked.size === 0 || checked.size > maximum) throw new Error("输入须为大小受限、非空的普通文件，不能使用符号链接或设备文件。");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== checked.dev || before.ino !== checked.ino || before.size !== checked.size || before.mtimeMs !== checked.mtimeMs) throw new Error("读取前输入文件发生变化，请重新检查。");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("读取期间输入文件发生变化，请重新检查。");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function readText(file: string, maximum: number): Promise<string> {
  const bytes = await readFile(file, maximum);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("输入文件不是有效的 UTF-8，请另存为 UTF-8 后重试。"); }
}
/** The ordinary resumable upload API, bound to the target conversation. */
export async function upload(client: Pick<LocalHostClient, "request" | "putChunk">, conversationId: string, file: string, maximum = MAX_FILE_BYTES): Promise<string> {
  const bytes = await readFile(file, maximum), name = path.basename(file);
  const created = z.object({ id: idSchema }).parse(await client.request("/api/uploads", "POST", { conversationId, name, size: bytes.length, mime: attachmentMime(name), sha256: createHash("sha256").update(bytes).digest("hex") }));
  const status = z.object({ complete: z.boolean(), chunks: z.array(z.number()) }).parse(await client.request(`/api/uploads/${created.id}`));
  if (!status.complete) {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) if (!status.chunks.includes(offset / CHUNK_BYTES)) await client.putChunk(`/api/uploads/${created.id}/${offset / CHUNK_BYTES}`, bytes.subarray(offset, offset + CHUNK_BYTES));
    await client.request(`/api/uploads/${created.id}/complete`, "POST");
  }
  return created.id;
}

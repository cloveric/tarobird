import { networkCanonical } from "../client-protocol/private-network.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CHUNK_BYTES, MAX_FILE_BYTES, MAX_TEXT_BYTES, idSchema, uploadSchema } from "../client-protocol/index.js";
import { BOT_LOCAL_REQUEST_TIMEOUT_MS, botMessageTargetSchema, parseBotDestination, type BotLocalRequest } from "../client-protocol/bot-messages.js";
import { LocalHostClient, HostCliError } from "./client.js";
import { inspectHubService } from "../hub/service.js";
import { isLoopback } from "../hub/network.js";
import { preflightCoreDeliveryPath, resolveCoreDeliveryRoots } from "../core/delivery-preflight.js";
import { withChannelProfile } from "../core/channel-profile.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../state/instance-config.js";

export type BotMessageOptions = { host?: string; bot?: string; to?: string; "source-bot"?: string; "text-file"?: string; file?: string[];
  "new-conversation"?: string; message?: string; timeout?: string; out?: string; "request-id"?: string; "context-message"?: string; from?: string };
type Call = (body: BotLocalRequest) => Promise<any>;
const replyFileSchema = uploadSchema.omit({ conversationId: true }).extend({ id: idSchema, size: uploadSchema.shape.size.max(MAX_FILE_BYTES) });

async function connect(directory: string): Promise<{ call: Call; grant: (data: unknown) => Promise<unknown>; close: () => void }> {
  const botId = process.env.TAROBOT_ACTIVE_INSTANCE ?? process.env.TAROBOT_INSTANCE;
  if (!botId) {
    let client = await LocalHostClient.connect(directory);
    const current = async () => {
      // A long wait/upload can outlive the owner's 15-minute HTTP lease.
      // Refresh before the next operation; never retry a transmitted request.
      if (Date.now() + BOT_LOCAL_REQUEST_TIMEOUT_MS + 30_000 >= client.ready.expiresAt) { client.close(); client = await LocalHostClient.connect(directory); }
      return client;
    };
    return { call: async input => (await current()).request("/api/bot-messages/local", "POST", input), grant: async input => {
      const owner = await current();
      return owner.request("/api/bot-messages/grant", "POST", { command: input, proof: await owner.deviceAction({ operation: "bot-message-grant", target: createHash("sha256").update(networkCanonical(input)).digest("hex") }) });
    }, close: () => client.close() };
  }
  const instance = await instanceEndpoint(directory, botId);
  return { close: () => undefined, grant: async () => { throw new Error("bot_message_grant_requires_owner_controller"); },
    call: input => instance.post("/api/instance/bot-messages", { ...input, sourceBot: botId, ...(process.env.TAROBOT_MESSAGE_ID ? { contextMessage: process.env.TAROBOT_MESSAGE_ID } : {}) }) };
}
/** A Bot-run CLI: the active instance's key and its loopback Hub endpoint. */
export async function instanceEndpoint(directory: string, botId: string): Promise<{ post: (route: string, body: unknown) => Promise<any> }> {
  const state = process.env.TAROBOT_ACTIVE_STATE_DIR ?? process.env.TAROBOT_STATE_DIR;
  if (!state || await realpath(state) !== await realpath(path.join(directory, "bots", botId))) throw new Error("bot_message_source_directory_mismatch");
  const keyPath = path.join(state, "gateway.key"), info = await lstat(keyPath);
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("bot_message_key_permissions");
  const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let secret: string;
  try { secret = (await handle.readFile("utf8")).trim(); } finally { await handle.close(); }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("bot_message_key_invalid");
  const service = await inspectHubService(directory);
  if (!service.running || !service.instanceUrl) throw new Error("hub_not_running");
  const base = new URL(service.instanceUrl);
  if (base.protocol !== "http:" || !isLoopback(base.hostname)) throw new Error("local_instance_endpoint_required");
  return { post: (route, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request(new URL(route, base), { method: "POST", agent: false,
        headers: { Authorization: `Instance ${botId}:${secret}`, "Content-Type": "application/json", "Content-Length": bytes.length } }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (c: Buffer) => { size += c.length; if (size > 8 * 1024 * 1024) res.destroy(new Error("reply_too_large")); else chunks.push(c); });
        res.on("error", reject); res.on("aborted", () => reject(new Error("bot_message_response_interrupted")));
        res.on("end", () => { try { const result = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (res.statusCode !== 200) throw new HostCliError(result.error ?? "bot_message_rejected", res.statusCode ?? 502); resolve(result); } catch (e) { reject(e); } });
      });
      const timer = setTimeout(() => req.destroy(new Error("bot_message_transport_timeout_no_retry")), BOT_LOCAL_REQUEST_TIMEOUT_MS); timer.unref();
      req.once("close", () => clearTimeout(timer)); req.once("error", reject); req.end(bytes);
    });
  } };
}
async function fileHandle(file: string, maximum: number) {
  const stateDir = process.env.TAROBOT_ACTIVE_STATE_DIR ?? process.env.TAROBOT_STATE_DIR;
  const config = stateDir ? await loadInstanceConfig(stateDir) : undefined;
  const roots = await withChannelProfile("gateway", () => resolveCoreDeliveryRoots({ stateDir, workspaceOverride: config ? resolveInstanceWorkspacePath(config) : undefined }));
  if (!stateDir) roots.allowAnyAbsolutePath = true; // Explicit local operator; credentials are still forbidden.
  const checked = await preflightCoreDeliveryPath(path.resolve(file), roots);
  if (!checked.ok) throw new Error(`bot_message_file_${checked.reason}`);
  const handle = await open(checked.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const before = await handle.stat();
  if (!before.isFile() || before.size <= 0 || before.size > maximum) { await handle.close(); throw new Error("bot_message_file_size"); }
  const unchanged = async () => { const after = await handle.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("bot_message_file_changed"); };
  return { handle, before, unchanged };
}
const required = (value: string | undefined, name: string) => { if (!value) throw new Error(`missing_${name}`); return value; };

function replyFilename(id: string, value: string): string {
  idSchema.parse(id);
  const name = path.basename(value).replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/[. ]+$/g, "");
  const suffix = /\.[A-Za-z0-9]{1,16}$/.exec(name)?.[0] ?? "";
  const prefix = `${id}-`, stem = suffix ? name.slice(0, -suffix.length) : name;
  const budget = 240 - Buffer.byteLength(prefix + suffix);
  let shortened = "", bytes = 0;
  for (const character of stem) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget || shortened.length + character.length > 120 - suffix.length) break;
    shortened += character; bytes += size;
  }
  return `${prefix}${shortened || "attachment"}${suffix}`;
}

export async function runBotMessagesCommand(directory: string, command: string, options: BotMessageOptions, signal: AbortSignal = new AbortController().signal) {
  const allow: Record<string, string[]> = {
    list: ["host", "bot", "source-bot"], send: ["to", "source-bot", "text-file", "file", "new-conversation", "request-id", "context-message"],
    wait: ["to", "source-bot", "message", "timeout", "out"], allow: ["from", "bot"], revoke: ["from", "bot"], grants: [],
  };
  if (!allow[command]) throw new Error("unknown_bot_message_command");
  for (const [key, value] of Object.entries(options)) if (value !== undefined && !allow[command]!.includes(key)) throw new Error(`unsupported_option_${key}`);
  if (command === "grants") {
    if (process.env.TAROBOT_INSTANCE || process.env.TAROBOT_ACTIVE_INSTANCE) throw new Error("bot_message_grant_requires_owner_controller");
    const owner = await LocalHostClient.connect(directory);
    try { return await owner.request("/api/bot-messages/grants"); } finally { owner.close(); }
  }
  const sourceBot = options["source-bot"];
  if (!process.env.TAROBOT_INSTANCE && !process.env.TAROBOT_ACTIVE_INSTANCE && !sourceBot && !["allow", "revoke"].includes(command)) throw new Error("operator_requires_source_bot");
  const client = await connect(directory);
  try {
    if (command === "allow" || command === "revoke") {
      const source = parseBotDestination(required(options.from, "from"));
      if (source.conversation) throw new Error("grant_requires_host_and_source_bot_id");
      return await client.grant({ sourceHost: source.host, sourceBot: source.bot, targetBot: required(options.bot, "bot"), revoke: command === "revoke" });
    }
    const destination = command === "list" ? { host: required(options.host, "host"), bot: required(options.bot, "bot") } : parseBotDestination(required(options.to, "to"));
    const requestId = options["request-id"] ?? randomUUID();
    if (command === "send") console.error(`请求编号：${requestId}。连接断开或超时不会重发；保留编号核对，勿换新编号重复发送。`);
    const invoke = (operation: BotLocalRequest["operation"], data: Record<string, unknown> = {}, target = destination): Promise<any> => {
      signal.throwIfAborted(); return client.call({ operation, ...target, sourceBot, requestId, contextMessage: options["context-message"], data });
    };
    if (command === "list") return await invoke("list");
    if (options["new-conversation"] && destination.conversation) throw new Error("new_conversation_requires_host_bot_only");
    if (command === "wait" && !destination.conversation) throw new Error("wait_requires_resolved_conversation_id");
    const target = botMessageTargetSchema.parse(await invoke("resolve", options["new-conversation"] ? { newConversation: options["new-conversation"] } : {}));
    const ids = { host: target.hostId, bot: target.botId, conversation: target.conversationId };
    const call = (operation: BotLocalRequest["operation"], data: Record<string, unknown>) => invoke(operation, data, ids);
    if (command === "send") {
      const source = await fileHandle(required(options["text-file"], "text_file"), MAX_TEXT_BYTES);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(await source.handle.readFile()); await source.unchanged(); } finally { await source.handle.close(); }
      const attachments: string[] = [];
      if ((options.file?.length ?? 0) > 50) throw new Error("too_many_files");
      for (const file of options.file ?? []) {
        const source = await fileHandle(file, MAX_FILE_BYTES);
        try {
          const sha = createHash("sha256");
          const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, source.before.size));
          for (let offset = 0; offset < source.before.size;) {
            const read = await source.handle.read(buffer, 0, Math.min(buffer.length, source.before.size - offset), offset);
            if (!read.bytesRead) throw new Error("bot_message_file_changed");
            sha.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
          }
          await source.unchanged();
          const upload = await call("upload", { name: path.basename(file), mime: "application/octet-stream", size: source.before.size, sha256: sha.digest("hex") });
          for (let offset = 0, index = 0; offset < source.before.size; offset += CHUNK_BYTES, index++) {
            const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, source.before.size - offset));
            const read = await source.handle.read(chunk, 0, chunk.length, offset);
            if (read.bytesRead !== chunk.length) throw new Error("bot_message_file_changed");
            await call("chunk", { uploadId: upload.id, index, bytes: chunk.toString("base64") });
          }
          await source.unchanged(); await call("complete", { uploadId: upload.id }); attachments.push(upload.id);
        } finally { await source.handle.close(); }
      }
      return await call("send", { text, attachments });
    }
    const messageId = idSchema.parse(required(options.message, "message")), timeout = Number(options.timeout ?? "120");
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600) throw new Error("timeout_must_be_0_to_3600_seconds");
    const deadline = Date.now() + timeout * 1000;
    let result;
    for (;;) {
      result = await call("wait", { messageId });
      if (result.status !== "pending") break;
      if (Date.now() >= deadline) return { ...result, status: "timeout", deliveryStatus: "pending" };
      await delay(Math.min(1500, deadline - Date.now()), undefined, { signal });
    }
    const output = path.resolve(options.out ?? path.join("output", "bot-replies", target.hostId, target.botId, messageId));
    const files = [];
    // Peer signatures authenticate the sender, not the safety of file metadata.
    // Validate the whole batch before opening any output path.
    const replyFiles = replyFileSchema.array().parse(result.files);
    for (const file of replyFiles) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      const out = path.join(output, replyFilename(file.id, String(file.name)));
      const existing = await open(out, constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (existing) {
        try {
          const stat = await existing.stat(); if (!stat.isFile() || stat.size !== file.size) throw new Error("reply_file_exists_conflict");
          const hash = createHash("sha256"), buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size));
          for (let offset = 0; offset < stat.size;) { const read = await existing.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset); if (!read.bytesRead) throw new Error("reply_file_exists_conflict"); hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead; }
          if (hash.digest("hex") !== file.sha256) throw new Error("reply_file_exists_conflict");
          files.push({ ...file, path: out }); continue;
        } finally { await existing.close(); }
      }
      const handle = await open(out, "wx", 0o600), hash = createHash("sha256"); let verified = false;
      try {
        for (let offset = 0; offset < file.size;) {
          const chunk = await call("download", { messageId, attachmentId: file.id, offset });
          const bytes = Buffer.from(chunk.bytes, "base64");
          if (!bytes.length || chunk.offset !== offset || offset + bytes.length > file.size) throw new Error("reply_file_invalid");
          await handle.writeFile(bytes); hash.update(bytes); offset += bytes.length;
        }
        if (hash.digest("hex") !== file.sha256) throw new Error("reply_file_hash_mismatch");
        await handle.sync(); verified = true; files.push({ ...file, path: out });
      } finally { await handle.close(); if (!verified) await unlink(out); }
    }
    return { ...result, files };
  } finally { client.close(); }
}

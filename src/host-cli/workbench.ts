import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY, isSlidesRequest, designOperationCapability } from "../client-protocol/workbench-design.js";
import { createHash } from "node:crypto";
import { readWorkbenchImage } from "../runtime/workbench-image.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../state/instance-config.js";
import { withChannelProfile } from "../core/channel-profile.js";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { idSchema, messageSchema, CHUNK_BYTES } from "../client-protocol/index.js";
import { workbenchRequestSchema, workbenchPublishedSource, WORKBENCH_MAX_BYTES, WORKBENCH_MARKDOWN_CAPABILITY, type WorkbenchRequest } from "../client-protocol/workbench.js";
import { MAX_WIDGET_BYTES, type WidgetInput } from "../client-protocol/widget.js";
import { validateWidget } from "../runtime/widget.js";
import { inspectHubService } from "../hub/service.js";
import { isLoopback } from "../hub/network.js";
import { LocalHostClient, HostCliError } from "./client.js";
import { appCapabilityInstructions } from "../gateway/agent-instructions.js";

/** Standalone and engine CLI share the exact Host command contract. Bot mode
 * never enrolls or borrows the owner's local controller credentials. */
export async function runWorkbenchCommand(directory: string, command: string | undefined, conversationId: string | undefined,
  options: { from?: string; requestId?: string; contextMessageId?: string; file?: string[] }) {
  if (command === "guide") {
    if (conversationId !== "widgets" && conversationId !== "browser") throw new Error("workbench_guide_topic_required: widgets|browser");
    if (options.from || options.requestId || options.contextMessageId || options.file) throw new Error("workbench_guide_does_not_accept_request");
    // Static contracts are safe to read without a running Host, identity or
    // credentials. They are documentation, not a grant or policy override.
    return { topic: conversationId, instructions: [
      "Static workbench contract; Host policy and the current user turn still control authorization. If app_workbench/app_capability is unavailable, use tarobot workbench context CONVERSATION --context-message MESSAGE --json for that turn's full frozen context, then tarobot workbench run CONVERSATION --from REQUEST.json --request-id ID --context-message MESSAGE --json. The file uses the same request JSON as app_workbench; local imagePath instead uses --file IMAGE. A null context means this message had no frozen target; it never means reuse a previous turn. workbench_context_unavailable/forbidden/turn_ended means stop workbench operations for this source. Do not alter Bot credential/state environment or use owner-only commands.",
      appCapabilityInstructions(conversationId, { widgetsEnabled: true }),
    ].join("\n\n"), staticGuide: true };
  }
  if (!["targets", "run", "context", "publish"].includes(command ?? "")) throw new Error("用法：tarobot workbench guide widgets|browser | context CONVERSATION --context-message ID | targets CONVERSATION | run|publish CONVERSATION --from REQUEST.json --request-id ID [--context-message ID] --json");
  const conversation = idSchema.parse(conversationId);
  const contextMessageId = options.contextMessageId ?? process.env.TAROBOT_MESSAGE_ID;
  if (contextMessageId) idSchema.parse(contextMessageId);
  if (command !== "run" && command !== "publish" && (options.from || options.requestId || options.file)) throw new Error(`workbench_${command}_does_not_accept_request`);
  if (command === "context" && !contextMessageId) throw new Error("workbench_current_context_required");
  let request: WorkbenchRequest | undefined;
  let widget: WidgetInput | undefined;
  if (command === "publish") {
    if (!options.from || !options.requestId) throw new Error("workbench_request_file_and_id_required");
    idSchema.parse(options.requestId);
    if ((await stat(options.from)).size > MAX_WIDGET_BYTES) throw new Error("widget_file_too_large");
    widget = validateWidget(JSON.parse(await readFile(options.from, "utf8")));
  }
  if (command === "run") {
    if (!options.from || !options.requestId) throw new Error("workbench_request_file_and_id_required");
    if ((await stat(options.from)).size > WORKBENCH_MAX_BYTES) throw new Error("workbench_request_too_large");
    const raw: unknown = JSON.parse(await readFile(options.from, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_workbench_request");
    if ("requestId" in raw && raw.requestId !== options.requestId) throw new Error("request_id_conflict");
    if ("contextMessageId" in raw && raw.contextMessageId !== contextMessageId) throw new Error("workbench_context_mismatch");
    request = workbenchRequestSchema.parse({ ...raw, requestId: options.requestId, ...(contextMessageId ? { contextMessageId } : {}) });
  }
  if (options.file && (options.file.length !== 1 || request?.operation !== "image.insert")) throw new Error("workbench_single_image_insert_required");
  const botId = process.env.TAROBOT_ACTIVE_INSTANCE ?? process.env.TAROBOT_INSTANCE;
  const attachImage = async (call: (route: string, method?: string, body?: unknown) => Promise<any>, chunk: (route: string, bytes: Buffer) => Promise<unknown>) => {
    if (!options.file?.[0] || !request) return;
    const stateDir = process.env.TAROBOT_ACTIVE_STATE_DIR ?? process.env.TAROBOT_STATE_DIR;
    const config = stateDir ? await loadInstanceConfig(stateDir) : undefined;
    const image = await withChannelProfile("gateway", () => readWorkbenchImage(path.resolve(options.file![0]!), { stateDir, workspaceOverride: config ? resolveInstanceWorkspacePath(config) : undefined }, !botId));
    const created = await call(botId ? "/workbench/uploads" : "/uploads", "POST", {conversationId:conversation, ...(botId ? {contextMessageId} : {}), name:image.name, mime:image.mime, size:image.bytes.length, sha256:createHash("sha256").update(image.bytes).digest("hex")});
    const status=await call(`/uploads/${created.id}`);
    if(!status.complete) { for(let offset=0;offset<image.bytes.length;offset+=CHUNK_BYTES) if(!status.chunks.includes(offset/CHUNK_BYTES)) await chunk(`/uploads/${created.id}/${offset/CHUNK_BYTES}`,image.bytes.subarray(offset,offset+CHUNK_BYTES));await call(`/uploads/${created.id}/complete`,"POST"); }
    const payload=request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
    if(payload.attachmentId && payload.attachmentId!==created.id) throw new Error("workbench_attachment_mismatch");
    request.payload={...payload,attachmentId:created.id};
  };
  if (!botId) {
    const client = await LocalHostClient.connect(directory);
    try {
      const feature = request && designOperationCapability(request.operation); if(feature && !client.supports(feature)) throw new Error("workbench_design_suite_host_update_required");
      if (request && isSlidesRequest(request) && !client.supports(WORKBENCH_SLIDES_CAPABILITY)) throw new Error("workbench_slides_host_update_required");
      if (request?.operation.startsWith("design.") && !client.supports(WORKBENCH_DESIGN_CAPABILITY)) throw new Error("workbench_design_host_update_required");
      if (request?.operation === "design.open" && !client.supports(WORKBENCH_DESIGN_OPEN_CAPABILITY)) throw new Error("workbench_design_open_host_update_required");
      // The owner names the exact opener from targets; there is no implicit fallback.
      if (request?.operation === "design.open" && !request.target) throw new Error("workbench_open_target_required");
      if (request?.operation.startsWith("markdown.") && !client.supports(WORKBENCH_MARKDOWN_CAPABILITY)) throw new Error("workbench_markdown_host_update_required");
      if (command === "context") return await client.request(`/api/conversations/${conversation}/workbench/context`, "POST", { contextMessageId });
      if (command === "publish") {
        const message = messageSchema.parse(await client.request(`/api/conversations/${conversation}/widgets`, "POST", { ...widget, requestId: options.requestId }));
        return { delivered: true, messageId: message.id, conversationId: message.conversationId, authorType: message.authorType, source: workbenchPublishedSource(message) };
      }
      await attachImage((route,method,body)=>client.request(`/api${route}`,method,body), (route,bytes)=>client.putChunk(`/api${route}`,bytes));
      return command === "targets" ? await client.request(`/api/conversations/${conversation}/workbench/targets`) : await client.request(`/api/conversations/${conversation}/workbench/commands`, "POST", request);
    }
    finally { client.close(); }
  }
  if (!contextMessageId) throw new Error("workbench_current_context_required");
  idSchema.parse(botId);
  const state = process.env.TAROBOT_ACTIVE_STATE_DIR ?? process.env.TAROBOT_STATE_DIR;
  if (!state || await realpath(state) !== await realpath(path.join(directory, "bots", botId))) throw new Error("workbench_source_directory_mismatch");
  const keyPath = path.join(state, "gateway.key"), info = await lstat(keyPath);
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("workbench_key_permissions");
  const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let secret: string; try { secret = (await handle.readFile("utf8")).trim(); } finally { await handle.close(); }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("workbench_key_invalid");
  const service = await inspectHubService(directory);
  if (!service.running || !service.instanceUrl) throw new Error("hub_not_running");
  const base = new URL(service.instanceUrl);
  if (base.protocol !== "http:" || !isLoopback(base.hostname)) throw new Error("local_instance_endpoint_required");
  const call = async (route: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(new URL(`/api/instance${route}`, base), { method, signal: AbortSignal.timeout(35_000),
      headers: { Authorization: `Instance ${botId}:${secret}`, "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" },
      ...(body === undefined ? {} : {body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body)}) });
    const text = await response.text(); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("workbench_reply_too_large");
    const result = JSON.parse(text); if (!response.ok) throw new HostCliError(result.error ?? "workbench_rejected", response.status);
    return result;
  };
  if (command === "publish") return call("/workbench/publish", "POST", { conversationId: conversation, contextMessageId, requestId: options.requestId, widget });
  await attachImage(call, (route,bytes)=>call(route,"PUT",bytes));
  return call("/workbench", "POST", {method: command === "targets" ? "workbench.targets" : command === "context" ? "workbench.context" : "workbench.command", params:{conversationId:conversation, contextMessageId,...(request?{request}:{})}});
}

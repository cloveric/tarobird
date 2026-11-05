import { readWorkbenchImage } from "../runtime/workbench-image.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { workbenchRequestSchema, workbenchOperations, workbenchRequestShapeError } from "../client-protocol/workbench.js";
import { widgetsEnabled } from "../runtime/widget-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppPlatformTools } from "../codex/adapter.js";
import { MAX_FILE_BYTES, type Json } from "../client-protocol/index.js";
import { attachmentMime as artifactMime } from "../client-protocol/attachment-mime.js";
import { localAsrAgentInstruction, cloudAsrAgentInstruction } from "../core/agent-instructions.js";
import { withChannelProfile } from "./platform-profile.js";
import { preflightCoreDeliveryPath, resolveCoreDeliveryRoots } from "../core/delivery-preflight.js";
import { JsonStore } from "../state/json-store.js";
import { APP_CAPABILITIES, appAgentInstructions, appCapabilityInstructions, appTurnInstructions, type AppInstructionOptions } from "./agent-instructions.js";
import { GatewayArtifactUploadError, type GatewayChannel } from "./channel.js";
import { GatewayReceipts } from "./receipts.js";
import { appArtifactKey, type AppDeliveryReceipt, type AppDeliveryCache } from "./app-delivery.js";
import { widgetDefinition, reportWidgetDefinition, htmlWidgetDefinition, deliverAppWidget } from "./app-widget.js";
import { batchDefinition, deliverAppBatch } from "./app-batch.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { buildCoreConversationKey } from "../core/message-normalizer.js";

const fileArgs = z.object({ path: z.string().min(1).max(4096).refine(path.isAbsolute), kind: z.enum(["file", "image", "audio", "video"]), caption: z.string().max(12_000).optional() }).strict();
const capabilityArgs = z.object({ topic: z.enum(APP_CAPABILITIES) }).strict();
// Frozen v1 definitions: native threads persist this exact tool set. Keep its
// digest stable when extending the contract for newly created threads.
const legacyDefinitions: AppPlatformTools["definitions"] = [
  { name: "app_send_file", description: "Deliver a verified local artifact and optional caption to the current App conversation. Returns a delivery receipt. Never send the same artifact again using text markers.", inputSchema: {
    type: "object", properties: { path: { type: "string", description: "Absolute path inside this Bot's workspace or current output directory." }, kind: { type: "string", enum: ["file", "image", "audio", "video"] }, caption: { type: "string", description: "Optional text published together with the attachment." } }, required: ["path", "kind"], additionalProperties: false,
  } },
  { name: "app_capability", description: "Read App procedures on demand: files, Google documents, speech/transcription, browsers, schedules or native questions. This tool provides guidance and performs no action.", inputSchema: {
    type: "object", properties: { topic: { type: "string", enum: ["files", "documents", "media", "browser", "schedules", "questions"] } }, required: ["topic"], additionalProperties: false,
  } },
];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const batchDefinitions = [...legacyDefinitions, batchDefinition];
// New threads get the permission-aware description. Persisted v1/v2 schemas
// remain byte-for-byte compatible; updating policy never resets a native thread.
const permissionDefinitions = structuredClone(batchDefinitions);
const fileProperties = permissionDefinitions[0]!.inputSchema.properties as Record<string, { description?: string }>;
fileProperties.path!.description = "Absolute readable artifact path. Full-access Bots allow external paths by default; other modes require an allowed workspace/output path.";
const batchProperties = permissionDefinitions[2]!.inputSchema.properties as { artifacts: { items: { properties: Record<string, { description?: string }> } } };
batchProperties.artifacts.items.properties.path!.description = fileProperties.path!.description;
const widgetDefinitions = structuredClone([...permissionDefinitions, widgetDefinition]);
(widgetDefinitions[1]!.inputSchema.properties as { topic: { enum: string[] } }).topic.enum = [...APP_CAPABILITIES];
const definitions = [...widgetDefinitions.slice(0, -1), reportWidgetDefinition];
const widgetToolVersion = hash(JSON.stringify(widgetDefinitions));
const permissionToolVersion = hash(JSON.stringify(permissionDefinitions));
// Frozen v6 contract: native threads persist the exact digest. Its operation
// enum predates markdown notes; extend only through a new version.
const WORKBENCH_V6_OPERATIONS = ["tabs.list", "whiteboard.create", "whiteboard.read", "whiteboard.patch", "whiteboard.undo", "whiteboard.redo", "chart.open", "chart.update", "image.insert", "browser"];
const workbenchDefinitionFor = (description: string, operations: readonly string[]): AppPlatformTools["definitions"][number] => ({
  name: "app_workbench", description,
  inputSchema: { type: "object", properties: { imagePath: {type: "string", description: "Only for image.insert: absolute generated image path, securely uploaded to this conversation before execution. Does not publish a chat attachment."}, requestId: { type: "string" }, operation: { type: "string", enum: [...operations] }, target: { type: "object", properties: { deviceId: { type: "string" }, windowId: { type: "string" }, tabId: { type: "string" } }, required: ["deviceId", "windowId"], additionalProperties: false }, expectedRevision: { type: "integer", minimum: 0 }, payload: { type: "object" } }, required: ["requestId", "operation"], additionalProperties: false }
});
const workbenchDefinition = workbenchDefinitionFor("Operate the current user's trusted App workbench (whiteboard, chart or browser). Requires a live App; a successful receipt is actual App execution. Read before patching and pass expectedRevision; preserve requestId on uncertain results and never automatically replay. Browser payload has action, never arbitrary JavaScript. Does not grant authority beyond the user's task.", WORKBENCH_V6_OPERATIONS);
const workbenchDefinitionV7 = workbenchDefinitionFor("Operate the current user's trusted App workbench (whiteboard, markdown note, chart or browser). Requires a live App; a successful receipt is actual App execution. Read before changing and pass expectedRevision; preserve requestId on uncertain results and never automatically replay. Markdown notes are App workbench objects, not local files. Browser payload has action, never arbitrary JavaScript. Does not grant authority beyond the user's task.", workbenchOperations.filter(operation => !operation.startsWith("design.")));
const workbenchDefinitions = [...definitions, workbenchDefinition];
const minimalWorkbenchDefinitions = [...permissionDefinitions, workbenchDefinition];
const minimalWorkbenchToolVersion = hash(JSON.stringify(minimalWorkbenchDefinitions));
const workbenchDefinitionsV7 = [...definitions, workbenchDefinitionV7];
const minimalWorkbenchDefinitionsV7 = [...permissionDefinitions, workbenchDefinitionV7];
const toolVersionV7 = hash(JSON.stringify(workbenchDefinitionsV7)), minimalToolVersionV7 = hash(JSON.stringify(minimalWorkbenchDefinitionsV7));
// v8 changes only the default-format advice. Persisted v1-v7 contracts remain exact.
const workbenchDefinitionsV8 = [...widgetDefinitions.slice(0, -1), htmlWidgetDefinition, workbenchDefinitionV7];
const toolVersionV8 = hash(JSON.stringify(workbenchDefinitionsV8));
// Frozen v9 contract: its operation enum predates design.open.
const WORKBENCH_V9_OPERATIONS = ["tabs.list", "whiteboard.create", "whiteboard.read", "whiteboard.patch", "whiteboard.undo", "whiteboard.redo", "chart.open", "chart.update", "image.insert", "browser",
  "markdown.create", "markdown.read", "markdown.replace", "markdown.patch", "markdown.undo", "markdown.redo", "design.create", "design.read", "design.publish"];
const workbenchDefinitionV9 = workbenchDefinitionFor("Operate the current user's App workbench: design canvases, whiteboards, Markdown notes, charts and browser. Read app_capability before use. Design files are local App objects, never Host paths. Read the exact target and revision before changing, preserve requestId on uncertainty. Only applied with saved:true confirms a saved change.", WORKBENCH_V9_OPERATIONS);
const workbenchDefinitionsV9 = [...widgetDefinitions.slice(0, -1), htmlWidgetDefinition, workbenchDefinitionV9];
const minimalWorkbenchDefinitionsV9 = [...permissionDefinitions, workbenchDefinitionV9];
const toolVersionV9 = hash(JSON.stringify(workbenchDefinitionsV9)), minimalToolVersionV9 = hash(JSON.stringify(minimalWorkbenchDefinitionsV9));
const WORKBENCH_V10_OPERATIONS = [...WORKBENCH_V9_OPERATIONS, "design.open"];
// v10 adds design.open: open this turn's Workbench on the sending App device.
const workbenchDefinitionV10 = workbenchDefinitionFor("Operate the current user's App workbench: design canvases, whiteboards, Markdown notes, charts and browser. Read app_capability before use. design.open opens this turn's Workbench on the sending App only when the user asks to use Design. Design files are local App objects, never Host paths. Read the exact target and revision before changing, preserve requestId on uncertainty. Only applied with saved:true confirms a saved change.", WORKBENCH_V10_OPERATIONS);
const workbenchDefinitionsV10 = [...widgetDefinitions.slice(0, -1), htmlWidgetDefinition, workbenchDefinitionV10];
const minimalWorkbenchDefinitionsV10 = [...permissionDefinitions, workbenchDefinitionV10];
const toolVersionV10 = hash(JSON.stringify(workbenchDefinitionsV10)), minimalToolVersionV10 = hash(JSON.stringify(minimalWorkbenchDefinitionsV10));
// v11 names the optional Baoyu routes; persisted v1-v10 contracts stay exact.
const workbenchDefinitionV11 = workbenchDefinitionFor("Operate the current user's App workbench: Baoyu Design canvases, Baoyu PPT slide decks, whiteboards, Markdown notes, charts and browser. Read app_capability before use. Use Baoyu only when requested or continuing the explicitly selected Baoyu project; ordinary PPT/design requests keep the engine's usual skills. design.open/create payload.format selects canvas (default) or slides. Read exact target and revision before changing; preserve requestId on uncertainty. Only applied with saved:true confirms persistence, not rendered output.", WORKBENCH_V10_OPERATIONS);
const workbenchDefinitionsV11 = [...widgetDefinitions.slice(0, -1), htmlWidgetDefinition, workbenchDefinitionV11];
const minimalWorkbenchDefinitionsV11 = [...permissionDefinitions, workbenchDefinitionV11];
const toolVersionV11 = hash(JSON.stringify(workbenchDefinitionsV11)), minimalToolVersionV11 = hash(JSON.stringify(minimalWorkbenchDefinitionsV11));
// v12 exposes the five explicitly selected Baoyu formats; older tools stay frozen.
const workbenchDefinitionV12 = workbenchDefinitionFor("Operate the current user's App workbench. Explicit Baoyu requests select design.open/create payload.format: canvas or slides. Ordinary presentation/design tasks retain the engine's native skills. Read app_capability first; use exact target and revision. Only applied with saved:true confirms persistence; verify actual rendering separately. ADHD never auto-opens.", workbenchOperations);
const workbenchDefinitionsV12 = [...widgetDefinitions.slice(0, -1), htmlWidgetDefinition, workbenchDefinitionV12];
const minimalWorkbenchDefinitionsV12 = [...permissionDefinitions, workbenchDefinitionV12];
const toolVersionV12 = hash(JSON.stringify(workbenchDefinitionsV12)), minimalToolVersionV12 = hash(JSON.stringify(minimalWorkbenchDefinitionsV12));
// v13 separates the editor destination from the authoring skill. Old contracts stay frozen.
const workbenchDefinitionV13 = workbenchDefinitionFor("Operate the current user's App workbench: canvases, PPT slide decks, whiteboards, Markdown notes, charts and browser. Workbench is a destination, independent of the authoring skill. PPT requests use the engine's native presentation skill unless the user explicitly selects another. An explicit request to put a PPT in Workbench can use design.open/create payload.format: slides. Read app_capability first, use exact target and revision, and preserve requestId on uncertainty. Only applied with saved:true confirms persistence; verify rendering separately. ADHD never auto-opens.", workbenchOperations);
const workbenchDefinitionsV13 = [...widgetDefinitions.slice(0, -1), htmlWidgetDefinition, workbenchDefinitionV13];
const minimalWorkbenchDefinitionsV13 = [...permissionDefinitions, workbenchDefinitionV13];
const toolVersionV13 = hash(JSON.stringify(workbenchDefinitionsV13)), minimalToolVersionV13 = hash(JSON.stringify(minimalWorkbenchDefinitionsV13));
const reportToolVersion = hash(JSON.stringify(definitions));
const toolVersion = hash(JSON.stringify(workbenchDefinitions)), batchToolVersion = hash(JSON.stringify(batchDefinitions)), legacyToolVersion = hash(JSON.stringify(legacyDefinitions));
const result = (value: unknown, isError = false) => ({ text: JSON.stringify(value), ...(isError ? { isError: true } : {}) });

export function createAppPlatformTools(input: {
  channel: Pick<GatewayChannel, "sendArtifact" | "sendArtifactBatch"> & Partial<Pick<GatewayChannel, "sendWidget" | "workbench" | "workbenchScreenshot" | "workbenchImage" | "workbenchContext" | "workbenchContextOmitted">>;
  stateDir: string;
  conversationId: string;
  replyTo?: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  options?: AppInstructionOptions;
  turnInstructions?: string;
  executionInstructions?: string;
  turnText?: string;
  onDelivered?: (file: AppDeliveryReceipt) => void;
  suppressDelivery?: boolean;
  /** Temporary side outputs have no main-chat audit records or durable transcript. */
  ephemeral?: boolean;
  deliveryCache?: AppDeliveryCache;
  receipts: Pick<GatewayReceipts, "run">;
  signal: AbortSignal;
}): AppPlatformTools {
  // A persistent CLI's stdio reader may still run in the first turn's async
  // context. Capture this request once, including all restored schema versions.
  const inTurn = AsyncLocalStorage.snapshot();
  const enabled = input.options?.widgetsEnabled ?? widgetsEnabled();
  const publications = input.deliveryCache ?? new Map<string, Promise<Json>>();
  const registration = (id: string) => new JsonStore(path.join(input.stateDir, "app-tool-threads", `${hash(id)}.json`),
    (value) => z.object({ toolVersion: z.string() }).nullable().parse(value));
  const versionFor = async (id: string) => (await registration(id).read(null).catch(() => null))?.toolVersion;
  const makeTools = (version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13, minimal = false): AppPlatformTools => {
    const batch = version !== 1;
    const options = { ...input.options, nativeDelivery: true, nativeBatchDelivery: batch, nativeWidgets: version >= 4 && !minimal, nativeReports: version >= 5 && !minimal, widgetsEnabled: enabled };
    return {
      definitions: version === 13 ? minimal ? minimalWorkbenchDefinitionsV13 : workbenchDefinitionsV13 : version === 12 ? minimal ? minimalWorkbenchDefinitionsV12 : workbenchDefinitionsV12 : version === 11 ? minimal ? minimalWorkbenchDefinitionsV11 : workbenchDefinitionsV11 : version === 10 ? minimal ? minimalWorkbenchDefinitionsV10 : workbenchDefinitionsV10 : version === 9 ? minimal ? minimalWorkbenchDefinitionsV9 : workbenchDefinitionsV9 : version === 8 ? workbenchDefinitionsV8 : version === 7 ? minimal ? minimalWorkbenchDefinitionsV7 : workbenchDefinitionsV7 : version === 6 ? minimal ? minimalWorkbenchDefinitions : workbenchDefinitions : version === 5 ? definitions : version === 4 ? widgetDefinitions : version === 3 ? permissionDefinitions : batch ? batchDefinitions : legacyDefinitions,
      instructions: [appAgentInstructions(options), input.suppressDelivery ? "This scheduled run is muted: keep artifacts locally; do not publish attachments or emit delivery directives." : undefined].filter(Boolean).join("\n"),
      turnInstructions: [input.turnInstructions, input.turnText ? appTurnInstructions(input.turnText, options) : undefined].filter(Boolean).join("\n\n") || undefined,
      executionInstructions: input.executionInstructions,
      // Codex persists dynamic tools with NEW threads. /resume of an older thread
      // must keep the compatible contract; never reset history to install tools.
      isRegistered: async (id) => [toolVersionV13, minimalToolVersionV13, toolVersionV12, minimalToolVersionV12, toolVersionV11, minimalToolVersionV11, toolVersionV10, minimalToolVersionV10, toolVersionV9, minimalToolVersionV9, toolVersionV8, toolVersionV7, minimalToolVersionV7, toolVersion, minimalWorkbenchToolVersion, reportToolVersion, widgetToolVersion, permissionToolVersion, batchToolVersion, legacyToolVersion].includes(await versionFor(id) ?? ""),
      forSession: async (id) => {
        const version = await versionFor(id);
        return version === toolVersionV13 ? makeTools(13) : version === minimalToolVersionV13 ? makeTools(13, true) : version === toolVersionV12 ? makeTools(12) : version === minimalToolVersionV12 ? makeTools(12, true) : version === toolVersionV11 ? makeTools(11) : version === minimalToolVersionV11 ? makeTools(11, true) : version === toolVersionV10 ? makeTools(10) : version === minimalToolVersionV10 ? makeTools(10, true) : version === toolVersionV9 ? makeTools(9) : version === minimalToolVersionV9 ? makeTools(9, true) : version === toolVersionV8 ? makeTools(8) : version === minimalToolVersionV7 ? makeTools(7, true) : version === toolVersionV7 ? makeTools(7) : version === minimalWorkbenchToolVersion ? makeTools(6, true) : version === toolVersion ? makeTools(6) : version === reportToolVersion ? makeTools(5) : version === widgetToolVersion ? makeTools(4) : version === permissionToolVersion ? makeTools(3) : version === batchToolVersion ? makeTools(2) : version === legacyToolVersion ? makeTools(1) : undefined;
      },
      register: async (id) => registration(id).write({ toolVersion: version === 13 ? minimal ? minimalToolVersionV13 : toolVersionV13 : version === 12 ? minimal ? minimalToolVersionV12 : toolVersionV12 : version === 11 ? minimal ? minimalToolVersionV11 : toolVersionV11 : version === 10 ? minimal ? minimalToolVersionV10 : toolVersionV10 : version === 9 ? minimal ? minimalToolVersionV9 : toolVersionV9 : version === 8 ? toolVersionV8 : version === 7 ? minimal ? minimalToolVersionV7 : toolVersionV7 : version === 6 ? minimal ? minimalWorkbenchToolVersion : toolVersion : version === 5 ? reportToolVersion : version === 4 ? widgetToolVersion : version === 3 ? permissionToolVersion : batch ? batchToolVersion : legacyToolVersion }),
      call: async (call) => inTurn(() => withChannelProfile("gateway", async () => {
        const signal = AbortSignal.any([input.signal, call.abortSignal]);
        if (signal.aborted) return result({ error: "turn_ended" }, true);
        if (version >= 6 && call.name === "app_workbench") {
          if (input.suppressDelivery || input.ephemeral) return result({ error: "workbench_user_turn_required" }, true);
          if (!input.channel.workbench) return result({ error: "workbench_unavailable" }, true);
          const parsed = workbenchRequestSchema.omit({ contextMessageId: true }).extend({imagePath: z.string().max(4096).optional()}).safeParse(call.arguments);
          if (!parsed.success) return result({ error: "invalid_workbench_request" }, true);
          const shapeError = workbenchRequestShapeError(parsed.data);
          if (shapeError) return result({requestId:parsed.data.requestId,status:"not_executed",error:shapeError,hint:shapeError === "invalid_workbench_source"
            ? "Unwrap the publication receipt and use its source:{messageId,blockIndex,version}; chart.update also needs previousSource. Read app_capability topic=widgets. No command or file upload was dispatched."
            : parsed.data.operation.startsWith("design.") ? "Design requests use the exact payload in app_capability topic=browser; design.publish needs expectedRevision from the latest design.read. Nothing was dispatched." : "Markdown requests use the exact payload in app_capability topic=browser; replace/patch/undo/redo need expectedRevision from the latest markdown.read. Nothing was dispatched."}, true);
          let dispatched = false;
          try {
            const {imagePath, ...request} = parsed.data;
            if (imagePath) {
              if (request.operation !== "image.insert" || !input.channel.workbenchImage) return result({error: "workbench_image_insert_required"}, true);
              const image = await readWorkbenchImage(imagePath, input);
              const attachmentId = await input.channel.workbenchImage(image, signal);
              const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
              if (payload.attachmentId && payload.attachmentId !== attachmentId) return result({error: "workbench_attachment_mismatch"}, true);
              request.payload = {...payload, attachmentId};
            }
            dispatched = true;
            const receipt = await input.channel.workbench(request, signal);
            const shot = receipt.result && typeof receipt.result === "object" && !Array.isArray(receipt.result) ? receipt.result.screenshot : undefined;
            let screenshot: { path: string; delivered: false } | undefined;
            if (shot && typeof shot === "object" && !Array.isArray(shot) && typeof shot.attachmentId === "string" && input.channel.workbenchScreenshot && input.requestOutputDir) {
              const bytes = await input.channel.workbenchScreenshot(parsed.data.requestId, shot.attachmentId, signal);
              await mkdir(input.requestOutputDir, { recursive: true });
              const output = path.join(input.requestOutputDir, `workbench-${randomUUID()}.${shot.mime === "image/jpeg" ? "jpg" : "png"}`);
              await writeFile(output, bytes, { mode: 0o600, flag: "wx" }); screenshot = { path: output, delivered: false };
            }
            return result({ ...receipt, ...(screenshot ? { screenshot } : {}) }, !["success", "applied"].includes(receipt.status));
          } catch (error) {
            const code = error instanceof Error ? error.message : "workbench_failed";
            const contextUnavailable = code === "workbench_context_unavailable", markdownUnsupported = code === "workbench_slides_host_update_required" || code === "workbench_markdown_host_update_required" || code === "workbench_design_host_update_required" || code === "workbench_design_open_host_update_required" || code === "workbench_design_suite_host_update_required", targetRequired = code === "workbench_target_required";
            // design.open has exactly one possible target: this turn's sending App.
            const openUnroutable = ["workbench_open_target_required", "workbench_open_target_mismatch", "workbench_open_target_unavailable"].includes(code), inputPending = code === "workbench_input_pending";
            // The Host throws these only before it records or dispatches anything.
            const busy = code === "workbench_busy", unroutable = ["workbench_target_closed", "workbench_app_unavailable", "workbench_target_ambiguous", "workbench_capability_unsupported"].includes(code);
            // Channel capability/context failures and these Host rejections cannot
            // have dispatched an App command. Transport failures can, and so can
            // turn/Bot validation, which also runs after an App receipt.
            const sent = dispatched && !contextUnavailable && !markdownUnsupported && !targetRequired && !busy && !unroutable && !openUnroutable && !inputPending;
            // A read's durable receipt keeps only a summary, so replaying its ID
            // cannot return content. Reads have no side effects: fresh content
            // needs a new ID. Writes keep their ID and are only reconciled.
            const readOnly = ["design.read", "design.comments.read", "design.history.list", "design.history.diff", "markdown.read", "whiteboard.read", "tabs.list"].includes(parsed.data.operation);
            return result({ requestId: parsed.data.requestId, status: sent ? "unknown" : "not_executed", error: code, hint: contextUnavailable ? "This turn has no saved workbench context. Do not reuse a previous target or retry this turn; continue ordinary chat." : inputPending ? "Nothing was dispatched: a newer user input reached this turn but is not yet proven read by you, so its App is unknown. Retry shortly with the same requestId and identical arguments; never pass an explicit opener target." : openUnroutable ? "Nothing was dispatched. design.open can only open the Workbench of the App chat that sent the latest adopted input of THIS turn (always omit target). That App did not freeze an opener, has left this chat or closed the panel since. Never open another device or window; ask the user to open Design in the App or resend from it." : markdownUnsupported ? "This Host is too old for Bot access to this workbench content. Nothing was dispatched; tell the user to update the Host. The user can still edit locally; whiteboard, chart and browser operations are unaffected." : targetRequired ? "No App command was dispatched. List this conversation's targets, choose the intended tab, and retry with its exact target (deviceId/windowId/tabId)." : busy ? "Nothing was dispatched: the Host's Workbench command capacity is currently full. Retry later with the same requestId and identical arguments." : unroutable ? "Nothing was dispatched: the requested App target is closed, unavailable, ambiguous or lacks this capability. Never switch to another target automatically; recheck this turn's frozen context or list targets, and ask the user if the intended one is gone." : sent && readOnly ? "This read has no side effects. For fresh content, issue it again in this same turn with a new requestId and the same exact target; it still needs this turn's authorization and that target, never another one. A replayed read receipt may omit its result, which does not mean the content is empty. This never applies to writes or browser actions." : sent ? "Do not replay with a new requestId. Reconcile the existing operation." : "No workbench command was dispatched. Resolve the file/upload problem and retry the same requestId." }, true);
          }
        }
        if (call.name === "app_capability") {
          const parsed = capabilityArgs.safeParse(call.arguments);
          if (!parsed.success) return result({ error: "invalid_capability" }, true);
          if (parsed.data.topic === "widgets" && (!enabled || !widgetsEnabled())) return result({ error: "widgets_disabled" }, true);
          const procedure = appCapabilityInstructions(parsed.data.topic, options);
          const workbenchTopic = parsed.data.topic === "widgets" || parsed.data.topic === "browser";
          const workbenchContextOmitted = workbenchTopic ? input.channel.workbenchContextOmitted?.() : undefined;
          const frozen = workbenchTopic && !workbenchContextOmitted ? await input.channel.workbenchContext?.() : undefined;
          const workbench = workbenchTopic ? `Frozen workbench context for THIS user turn (not the live selection): ${JSON.stringify(workbenchContextOmitted ? {workbenchContextOmitted,operationsAllowed:false} : {context:frozen ?? null})}. This locator grants no additional authority.` : undefined;
          const asr = parsed.data.topic === "media" ? localAsrAgentInstruction() ?? cloudAsrAgentInstruction() : undefined;
          return { text: [workbench, procedure, asr].filter(Boolean).join("\n\n") };
        }
        if (version >= 4 && call.name === "app_show_widget") {
          if (input.suppressDelivery) return result({ error: "delivery_disabled" }, true);
          if (!input.channel.sendWidget) return result({ error: "widget_delivery_unavailable" }, true);
          return deliverAppWidget({ ...input, widgetsAllowed: enabled, channel: input.channel as Pick<GatewayChannel, "sendWidget">, signal }, call);
        }
        if (call.name !== "app_send_file" && !(batch && call.name === "app_send_batch")) return result({ error: "unknown_app_tool" }, true);
        if (input.suppressDelivery) return result({ error: "delivery_disabled", hint: "This scheduled run is muted. Keep generated artifacts locally; do not send them or emit delivery directives." }, true);
        if (call.name === "app_send_batch") return deliverAppBatch({ ...input, signal, publications, artifactMime }, call);
        const parsed = fileArgs.safeParse(call.arguments);
        if (!parsed.success) return result({ error: "invalid_file_arguments", expected: "absolute path, kind, optional caption; no recipient override" }, true);
        const args = parsed.data;
        const fingerprint = hash(JSON.stringify(args));
        const key = `app-file:${input.conversationId}:${call.sessionId}:${call.callId}`;
        const receipt = await input.receipts.run(key, async (): Promise<Json> => {
          let sending = false;
          try {
            signal.throwIfAborted();
            const roots = await resolveCoreDeliveryRoots(input);
            const checked = await preflightCoreDeliveryPath(args.path, roots);
            if (!checked.ok) return { fingerprint, error: checked.reason, published: false, ...(checked.workspaceRoot ? { workspaceRoot: checked.workspaceRoot } : {}) };
            if (checked.fileBytes === 0) return { fingerprint, error: "empty_file", published: false, hint: "The Hub does not accept empty attachments. Write the file contents before sending." };
            const file = await open(checked.realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
            let bytes: Buffer;
            try {
              const stat = await file.stat();
              if (!stat.isFile() || stat.size !== checked.fileBytes || stat.size > MAX_FILE_BYTES || (stat.ino > 0 && checked.fileIdentity !== `inode:${stat.dev}:${stat.ino}`)) return { fingerprint, error: "file_changed", published: false };
              signal.throwIfAborted();
              bytes = await file.readFile();
              const after = await file.stat();
              if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytes.length > MAX_FILE_BYTES) return { fingerprint, error: "file_changed", published: false };
            } finally { await file.close(); }
            signal.throwIfAborted();
            const name = path.basename(checked.realPath);
            const mime = artifactMime(name);
            if (args.kind === "image" && !mime.startsWith("image/")) return { fingerprint, error: "unsupported_image_type", hint: "Use kind=file for this format." };
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const artifactKey = appArtifactKey(input.conversationId, checked.realPath, sha256, args.kind, args.caption);
            sending = true;
            let publication = publications.get(artifactKey);
            if (!publication) {
              publication = (async () => {
                const sent = await input.channel.sendArtifact({ conversationId: input.conversationId, messageId: `msg_${hash(key).slice(0, 32)}`, replyTo: input.replyTo, bytes, name, mime, kind: args.kind, caption: args.caption, abortSignal: signal, onActivity: call.onActivity });
                if (!input.ephemeral) await appendTimelineEventBestEffort(input.stateDir, { type: "file.accepted", channel: "gateway", conversationKey: buildCoreConversationKey(input.conversationId), outcome: "success", metadata: { path: checked.realPath, fileBytes: bytes.length, kind: args.kind, messageId: sent.messageId, via: "app_send_file" } });
                return { delivered: true, path: checked.realPath, messageId: sent.messageId, name, size: bytes.length, sha256 };
              })();
              publications.set(artifactKey, publication);
              // Definite upload failures may be repaired. Uncertain publishes
              // stay cached so a fresh call ID cannot duplicate the side effect.
              void publication.catch((error) => { if (error instanceof GatewayArtifactUploadError && publications.get(artifactKey) === publication) publications.delete(artifactKey); });
            }
            return { ...await publication as Record<string, Json>, fingerprint };
          } catch (error) {
            if (sending && !(error instanceof GatewayArtifactUploadError)) throw error;
            const code = signal.aborted ? "turn_ended" : error instanceof GatewayArtifactUploadError ? error.code : "read-error";
            return { fingerprint, error: code, published: false, retryable: !signal.aborted,
              hint: code === "too-large" ? "The Hub rejected the file size. Reduce it or check the Hub upload limit, then use a new call ID." : "No message was published. Correct the file or connection and retry with a new call ID.",
              ...(error instanceof GatewayArtifactUploadError && error.status ? { status: error.status } : {}) };
          }
        });
        if (!receipt.ok) return result({ error: signal.aborted ? "turn_ended" : "delivery_uncertain", hint: "Check the conversation before retrying with a new call. This call will not publish twice." }, true);
        const saved = z.object({ fingerprint: z.string(), error: z.string().optional() }).passthrough().parse(receipt.result);
        if (saved.fingerprint !== fingerprint) return result({ error: "tool_call_id_reused_with_different_arguments" }, true);
        const { fingerprint: _private, path: _path, ...publicResult } = saved;
        if (saved.delivered === true && typeof saved.messageId === "string" && typeof saved.sha256 === "string") {
          const deliveredPath = typeof saved.path === "string" ? saved.path : args.path;
          const artifactKey = appArtifactKey(input.conversationId, deliveredPath, saved.sha256, args.kind, args.caption);
          // A durable call replay also seeds the current turn's content cache.
          if (!publications.has(artifactKey)) publications.set(artifactKey, Promise.resolve(z.json().parse({ ...saved, path: deliveredPath })));
          input.onDelivered?.({ path: deliveredPath, messageId: saved.messageId, sha256: saved.sha256 });
        }
        return result(publicResult, !!saved.error);
      })),
    };
  };
  return makeTools(13, !enabled);
}

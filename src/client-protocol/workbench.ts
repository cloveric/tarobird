import { designFormatSchema } from "./workbench-design.js";
import { workbenchDesignError } from "./workbench-design.js";
import { z } from "zod";
import type { Message } from "./index.js";
import { readWidget, readReport } from "./widget.js";

export const WORKBENCH_CAPABILITY = "workbench.v1";
// Hosts before markdown notes reject unknown registration kinds/capabilities;
// clients and gateways send markdown only when the Host advertises this.
export const WORKBENCH_MARKDOWN_CAPABILITY = "workbench.markdown.v1";
export const workbenchContextOmittedSchema = z.literal("history_limit");
export type WorkbenchContextOmitted = z.infer<typeof workbenchContextOmittedSchema>;
export const WORKBENCH_MAX_BYTES = 256 * 1024;
export const WORKBENCH_RESULT_BYTES = 512 * 1024;
/** Markdown notes are local workbench objects (not Host files). Content is
 * bounded in UTF-8 bytes; reads page by JavaScript UTF-16 code units. */
export const WORKBENCH_MARKDOWN_BYTES = 128 * 1024;
export const WORKBENCH_MARKDOWN_READ_LIMIT = 16_000;
export const WORKBENCH_MARKDOWN_READ_MAX = 32_000;
export const WORKBENCH_MARKDOWN_EDITS = 64;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const revision = z.number().int().nonnegative().safe();
const boundedJson = (limit: number) => z.json().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= limit, "workbench_payload_too_large");
export const workbenchSourceSchema = z.object({ messageId: id, blockIndex: z.number().int().nonnegative().max(255), version: revision }).strict();
export const workbenchTargetSchema = z.object({ deviceId: id, windowId: id, tabId: id.optional() }).strict();
/** The sending device's design.open opener window; never a tab. When the panel
 * was closed, target is this same window and authorizes nothing else. */
export const workbenchOpenTargetSchema = z.object({ deviceId: id, windowId: id }).strict();
export const workbenchContextSchema = z.object({
  target: workbenchTargetSchema, openTarget: workbenchOpenTargetSchema.optional(),
  kind: z.enum(["whiteboard", "chart", "browser", "markdown", "design"]).optional(),
  title: z.string().max(256).optional(), revision: revision.optional(),
  selection: z.array(id).max(256).optional(), source: workbenchSourceSchema.optional(),
  imageEdit: z.object({ requestId: id, boardId: id, baseRevision: revision, originalElementId: id, originalAttachmentId: id.optional(), referenceAttachmentIds: z.array(id).max(16).optional(), attachmentIds: z.array(id).max(16) }).strict().optional(),
}).strict();
export const workbenchTabSchema = z.object({ id, kind: z.enum(["whiteboard", "chart", "browser", "markdown", "design"]), title: z.string().max(256), revision: revision.optional(), source: workbenchSourceSchema.optional(), readOnly: z.boolean().optional(), designFormat: designFormatSchema.optional() }).strict();
export const workbenchRegistrationSchema = z.object({
  windowId: id, conversationId: id, generation: id,
  capabilities: z.array(z.enum(["whiteboard.v1", "charts.v1", "browser.v1", "markdown.v1", "design.v1", "design.open.v1", "design.slides.v1", "design.comments.v1", "design.history.v1"])).max(10),
  tabs: z.array(workbenchTabSchema).max(64), activeTabId: id.optional(), visible: z.boolean(),
}).strict().refine(value => new Set(value.tabs.map(tab => tab.id)).size === value.tabs.length, "duplicate_tab")
  // An opener is a separate lightweight window: no content, tabs or editors.
  .refine(value => !value.capabilities.includes("design.open.v1") || value.capabilities.every(cap => cap === "design.open.v1" || cap === "design.slides.v1") && !value.tabs.length && !value.activeTabId, "invalid_workbench_opener");
export const workbenchOperations = ["tabs.list", "whiteboard.create", "whiteboard.read", "whiteboard.patch", "whiteboard.undo", "whiteboard.redo", "chart.open", "chart.update", "image.insert", "browser",
  "markdown.create", "markdown.read", "markdown.replace", "markdown.patch", "markdown.undo", "markdown.redo", "design.create", "design.read", "design.publish", "design.open", "design.comments.read", "design.comments.reply", "design.comments.resolve", "design.history.list", "design.history.diff", "design.restore"] as const;
const markdownText = z.string().refine(value => new TextEncoder().encode(value).length <= WORKBENCH_MARKDOWN_BYTES, "markdown_too_large");
export const markdownCreateSchema = z.object({ title: z.string().min(1).max(128).optional(), content: markdownText.optional() }).strict();
export const markdownReadSchema = z.object({ offset: z.number().int().min(0).max(WORKBENCH_MARKDOWN_BYTES).optional(), limit: z.number().int().min(1).max(WORKBENCH_MARKDOWN_READ_MAX).optional() }).strict();
export const markdownReplaceSchema = z.object({ content: markdownText }).strict();
/** Edits apply in order; each oldText must occur exactly once in the text at
 * that point (overlapping occurrences count). Any miss rejects the batch. */
export const markdownPatchSchema = z.object({ edits: z.array(z.object({ oldText: markdownText.refine(value => value.length > 0, "markdown_old_text_required"), newText: markdownText }).strict()).min(1).max(WORKBENCH_MARKDOWN_EDITS) }).strict();
const markdownPayloads = { "markdown.create": markdownCreateSchema, "markdown.read": markdownReadSchema, "markdown.replace": markdownReplaceSchema, "markdown.patch": markdownPatchSchema,
  "markdown.undo": z.object({}).strict(), "markdown.redo": z.object({}).strict() } as const;
export const markdownMutations: readonly string[] = ["markdown.replace", "markdown.patch", "markdown.undo", "markdown.redo"];
export type WorkbenchContentKind = "whiteboard" | "chart" | "browser" | "markdown" | "design";
/** The tab kind an operation acts on; tabs.list has none. */
export function workbenchOperationKind(operation: (typeof workbenchOperations)[number]): WorkbenchContentKind | undefined {
  if (operation === "tabs.list") return undefined;
  if (operation === "browser") return "browser";
  if (operation === "image.insert") return "whiteboard";
  return operation.slice(0, operation.indexOf(".")) as WorkbenchContentKind;
}
export const workbenchRequestSchema = z.object({
  requestId: id, operation: z.enum(workbenchOperations), target: workbenchTargetSchema.optional(),
  expectedRevision: revision.optional(), payload: boundedJson(WORKBENCH_MAX_BYTES).optional(),
  contextMessageId: id.optional(),
}).strict();
/** Shape validation shared by the local tool and Host. Authorization still
 * happens in the Host; missing references must never reach an older renderer. */
export function workbenchChartSourceError(request: Pick<WorkbenchRequest, "operation" | "payload">): "invalid_workbench_source" | undefined {
  if (request.operation !== "chart.open" && request.operation !== "chart.update") return undefined;
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : undefined;
  if (!workbenchSourceSchema.safeParse(payload?.source).success || request.operation === "chart.update" && !workbenchSourceSchema.safeParse(payload?.previousSource).success) return "invalid_workbench_source";
  return undefined;
}
/** Markdown shape and revision rules, shared by the local tool and Host. */
export function workbenchMarkdownError(request: Pick<WorkbenchRequest, "operation" | "payload" | "expectedRevision">): "invalid_markdown_payload" | "workbench_revision_required" | undefined {
  if (!request.operation.startsWith("markdown.")) return undefined;
  if (!markdownPayloads[request.operation as keyof typeof markdownPayloads].safeParse(request.payload ?? {}).success) return "invalid_markdown_payload";
  if (markdownMutations.includes(request.operation) && request.expectedRevision === undefined) return "workbench_revision_required";
  return undefined;
}
export function workbenchRequestShapeError(request: Pick<WorkbenchRequest, "operation" | "payload" | "expectedRevision">) {
  return workbenchChartSourceError(request) ?? workbenchMarkdownError(request) ?? workbenchDesignError(request);
}
export const workbenchReceiptSchema = z.object({
  requestId: id, status: z.enum(["success", "applied", "applied_not_saved", "conflict", "not_executed", "failed", "unknown", "cancelled"]),
  target: workbenchTargetSchema, revision: revision.optional(), saved: z.boolean().optional(),
  result: boundedJson(WORKBENCH_RESULT_BYTES).optional(), error: z.string().max(256).optional(),
}).strict().refine(value => value.status !== "applied" || value.saved === true, "workbench_save_receipt_required");
export const workbenchRegisterFrameSchema = z.object({ v: z.literal(1), type: z.literal("workbench.register"), registration: workbenchRegistrationSchema }).strict();
export const workbenchUnregisterFrameSchema = z.object({ v: z.literal(1), type: z.literal("workbench.unregister"), windowId: id }).strict();
export const workbenchReceiptFrameSchema = z.object({ v: z.literal(1), type: z.literal("workbench.receipt"), dispatchId: id, receipt: workbenchReceiptSchema });
export const workbenchCommandFrameSchema = z.object({
  v: z.literal(1), type: z.literal("workbench.command"), dispatchId: id, deadline: z.number().int().positive(),
  actor: z.object({kind:z.enum(["bot","user"]),id,name:z.string().max(128)}).strict().optional(),
  userId: id, conversationId: id, generation: id, request: workbenchRequestSchema, target: workbenchTargetSchema,
}).strict();
export const workbenchCancelFrameSchema = z.object({ v: z.literal(1), type: z.literal("workbench.cancel"), dispatchId: id, reason: z.string().max(128) }).strict();
export type WorkbenchSource = z.infer<typeof workbenchSourceSchema>;
export type WorkbenchTarget = z.infer<typeof workbenchTargetSchema>;
export type WorkbenchOpenTarget = z.infer<typeof workbenchOpenTargetSchema>;
export type WorkbenchContext = z.infer<typeof workbenchContextSchema>;
export type WorkbenchRegistration = z.infer<typeof workbenchRegistrationSchema>;
/** A design.open receipt names the real controller tab the App registered first. */
export const workbenchDesignOpenResultSchema = z.object({ target: workbenchTargetSchema.required({ tabId: true }), created: z.boolean() }).strict();
export const isWorkbenchOpener = (registration: Pick<WorkbenchRegistration, "capabilities">) => registration.capabilities.includes("design.open.v1");
/** Same window, no tab: the turn was sent with the Workbench panel closed. */
export const workbenchOpenerOnly = (context: WorkbenchContext | undefined) => !!context?.openTarget && !context.target.tabId && context.target.deviceId === context.openTarget.deviceId && context.target.windowId === context.openTarget.windowId;
export type WorkbenchRequest = z.infer<typeof workbenchRequestSchema>;
export type WorkbenchReceipt = z.infer<typeof workbenchReceiptSchema>;
export type WorkbenchCommandFrame = z.infer<typeof workbenchCommandFrameSchema>;
export type WorkbenchCancelFrame = z.infer<typeof workbenchCancelFrameSchema>;

/** Reference only the actual published widget block; do not guess version or
 * index from a request, since the Hub can return an existing idempotent row. */
export function workbenchPublishedSource(message: Message): WorkbenchSource | undefined {
  if (message.status === "deleted") return undefined;
  const blockIndex = message.blocks.findIndex(block => !!readWidget(block) || !!readReport(block));
  if (blockIndex < 0 || blockIndex > 255) return undefined;
  return workbenchSourceSchema.parse({messageId:message.id,blockIndex,version:message.version});
}

import { z } from "zod";

export const WORKBENCH_DESIGN_CAPABILITY = "workbench.design.v1";
/** design.open: a Bot opens this conversation's Workbench on the device that
 * sent the turn. Clients send openTarget and register an opener window only
 * when the Host advertises it; gateways only when the Host's ready lists it. */
export const WORKBENCH_DESIGN_OPEN_CAPABILITY = "workbench.design.open.v1";
export const WORKBENCH_SLIDES_CAPABILITY = "workbench.design.slides.v1";
export const WORKBENCH_DESIGN_COMMENTS_CAPABILITY = "workbench.design.comments.v1";
export const WORKBENCH_DESIGN_HISTORY_CAPABILITY = "workbench.design.history.v1";
export const designOperationCapability = (operation:string) => operation.startsWith("design.comments.") ? WORKBENCH_DESIGN_COMMENTS_CAPABILITY : operation.startsWith("design.history.") || operation === "design.restore" ? WORKBENCH_DESIGN_HISTORY_CAPABILITY : undefined;
export const designReadOperations: readonly string[] = ["design.read","design.comments.read","design.history.list","design.history.diff"];
export const designMutationOperations: readonly string[] = ["design.publish","design.restore","design.comments.reply","design.comments.resolve"];
export const designFormatSchema = z.enum(["canvas", "slides"]);
export const designFormatTitle = (format: DesignFormat = "canvas") => ({ canvas: "画布", slides: "PPT" })[format];
export type DesignFormat = z.infer<typeof designFormatSchema>;
export const isSlidesRequest = (request: { operation: string; payload?: unknown }) =>
  ["design.create", "design.open"].includes(request.operation) && !!request.payload && typeof request.payload === "object" && "format" in request.payload && request.payload.format === "slides";
export const DESIGN_FILE_BYTES = 8 * 1024 * 1024;
export const DESIGN_DOCUMENT_BYTES = 32 * 1024 * 1024;
export const DESIGN_FILE_COUNT = 512;
export const designPath = z.string().max(512).refine(value => value.startsWith("project/") && value.split("/").every(part => /^[\p{L}\p{N}_][\p{L}\p{N}\p{M} _().+-]*$/u.test(part) && part.trim() === part) && !value.split("/").some(part => ["__proto__", "constructor", "prototype"].includes(part)), "design_invalid_path");
const text = z.string().refine(value => new TextEncoder().encode(value).length <= 128 * 1024, "design_file_too_large");
export const designCreateSchema = z.object({ title: z.string().trim().min(1).max(128).optional(), format: designFormatSchema.optional() }).strict();
export const designReadSchema = z.object({ path: designPath.optional(), offset: z.number().int().min(0).max(DESIGN_FILE_BYTES).optional(), limit: z.number().int().min(1).max(32_000).optional() }).strict();
export const designOpenSchema = z.object({ format: designFormatSchema.optional() }).strict();
export const designPublishSchema = z.object({ files: z.record(designPath, z.object({ content: text, contentType: z.enum(["text/html", "text/css", "text/javascript", "application/json", "text/plain", "image/svg+xml"]).optional() }).strict().nullable()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 64, "design_file_count") }).strict();
const commentId = z.string().regex(/^c_[a-f0-9]{10,32}$/);
const commentRead = z.object({
  status: z.enum(["open", "all"]).optional(), threadId: commentId.optional(),
  offset: z.number().int().min(0).max(500).optional(), limit: z.number().int().min(1).max(50).optional(),
  messageOffset: z.number().int().min(0).max(200).optional(), messageLimit: z.number().int().min(1).max(200).optional(),
}).strict();
const commentReply = z.object({threadId:commentId,text:z.string().trim().min(1).max(10_000),resolve:z.boolean().optional()}).strict();
const commentResolve = z.object({threadId:commentId,status:z.enum(["open","resolved"])}).strict();
const historyList = z.object({limit:z.number().int().min(1).max(50).optional(),before:z.number().int().positive().optional()}).strict();
const historyDiff = z.object({version:z.number().int().positive().safe(),path:designPath}).strict();
const restore = z.object({version:z.number().int().positive().safe(),paths:z.array(designPath).min(1).max(512).optional()}).strict();
const designPayloads:Record<string,z.ZodTypeAny> = {"design.create":designCreateSchema,"design.read":designReadSchema,"design.open":designOpenSchema,"design.publish":designPublishSchema,
 "design.comments.read":commentRead,"design.comments.reply":commentReply,"design.comments.resolve":commentResolve,"design.history.list":historyList,"design.history.diff":historyDiff,"design.restore":restore};
export function workbenchDesignError(request: { operation: string; payload?: unknown; expectedRevision?: number }): string | undefined {
  if (!request.operation.startsWith("design.")) return;
  const schema = designPayloads[request.operation];
  if (!schema?.safeParse(request.payload ?? {}).success) return "invalid_design_payload";
  if (["design.publish","design.restore"].includes(request.operation) && request.expectedRevision === undefined) return "workbench_revision_required";
}

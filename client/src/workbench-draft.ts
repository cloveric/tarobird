import { z } from "zod";
import { workbenchContextSchema, type WorkbenchContext, type WorkbenchTarget, type WorkbenchRegistration } from "../../src/client-protocol/workbench.js";
import type { BoardAnnotation } from "./workbench-board.js";
import { designCommentVersionsSchema } from "./design-comment-delivery.js";

const stamp = z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().max(512),type:z.string().max(256),size:z.number().int().nonnegative()}).strict();
export const workbenchDraftSchema = z.object({context:workbenchContextSchema,files:z.array(stamp).max(16),designComments:z.array(z.string().min(1).max(128)).max(200).optional(),designCommentVersions:designCommentVersionsSchema.optional()}).strict().superRefine((draft,ctx)=>{
  const design=draft.context.kind === "design" && !!draft.context.target.tabId && draft.context.revision!==undefined && !draft.context.imageEdit && draft.files.length===0;
  if(!design && (draft.context.kind!=="whiteboard" || !draft.context.imageEdit || draft.files.length<2 || draft.designComments!==undefined || draft.designCommentVersions!==undefined))ctx.addIssue({code:"custom",message:"invalid_workbench_draft"});
  if(draft.designCommentVersions && Object.keys(draft.designCommentVersions).some(id=>!draft.designComments?.includes(id)))ctx.addIssue({code:"custom",message:"invalid_workbench_comment_versions"});
});
export type WorkbenchDraft = z.infer<typeof workbenchDraftSchema>;
/** Reload creates a new App lease, but never a new board or base revision.
 * Rebind only the original board in this same device/conversation; focus is irrelevant. */
export function bindWorkbenchDraft(raw: WorkbenchDraft, deviceId: string, conversationId: string, registration?: WorkbenchRegistration): WorkbenchDraft {
  const draft = workbenchDraftSchema.parse(raw), original = draft.context;
  if (original.kind === "design") {
    if(original.target.deviceId!==deviceId || !registration?.visible || registration.conversationId!==conversationId || !registration.tabs.some(tab=>tab.id===original.target.tabId && tab.kind==="design"))throw new Error("workbench_original_design_unavailable");
    return {...draft,context:{...original,target:{...original.target,windowId:registration.windowId}}};
  }
  if (!original.imageEdit || original.target.deviceId !== deviceId || !registration?.visible
    || registration.conversationId !== conversationId || original.target.tabId !== original.imageEdit.boardId
    || !registration.tabs.some(tab => tab.id === original.imageEdit!.boardId && tab.kind === "whiteboard")) throw new Error("workbench_original_board_unavailable");
  return { ...draft, context: { ...original, target: { ...original.target, windowId: registration.windowId } } };
}
async function fileStamp(file: File): Promise<z.infer<typeof stamp>> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return {name:file.name,type:file.type,size:file.size,sha256:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("")};
}
export async function annotationDraft(target: WorkbenchTarget, annotation: BoardAnnotation): Promise<{files:File[];workbench:WorkbenchDraft}> {
  const files = [annotation.original.file,annotation.preview,...annotation.references.map(value=>value.file)];
  const context: WorkbenchContext = {target:{...target,tabId:annotation.boardId},kind:"whiteboard",revision:annotation.baseRevision,imageEdit:{requestId:crypto.randomUUID(),boardId:annotation.boardId,baseRevision:annotation.baseRevision,originalElementId:annotation.originalElementId,attachmentIds:[]}};
  return {files,workbench:workbenchDraftSchema.parse({context,files:await Promise.all(files.map(fileStamp))})};
}
/** Match exact bytes after draft reload or file reordering. Removed/replaced originals never silently retarget an edit. */
export async function resolveWorkbenchDraft(raw: WorkbenchDraft, files: File[], attachmentIds: string[]): Promise<WorkbenchContext> {
  const draft = workbenchDraftSchema.parse(raw), context = structuredClone(draft.context);
  if(context.kind === "design")return workbenchContextSchema.parse(context);
  const candidates = await Promise.all(files.map(fileStamp)), used = new Set<number>();
  const ids = draft.files.map(expected => {
    const index = candidates.findIndex((candidate,index) => !used.has(index) && candidate.sha256===expected.sha256 && candidate.size===expected.size && candidate.type===expected.type);
    if (index < 0 || !attachmentIds[index]) throw new Error("workbench_image_draft_changed");
    used.add(index); return attachmentIds[index]!;
  });
  if (!context.imageEdit) throw new Error("workbench_image_context_missing");
  context.imageEdit.attachmentIds=ids;context.imageEdit.originalAttachmentId=ids[0];context.imageEdit.referenceAttachmentIds=ids.slice(2);
  return workbenchContextSchema.parse(context);
}

/** A conversation draft may refer to only one design. A reopened window is a
 * new lease for the same device/tab, not permission to replace the document.
 * Keep the oldest base revision: adding a current comment cannot silently
 * advertise older draft context as having been reviewed at the new revision. */
export function mergeDesignCommentDraft(previous: WorkbenchDraft | undefined, incoming: WorkbenchDraft): WorkbenchDraft {
  const next = workbenchDraftSchema.parse(incoming);
  if (next.context.kind !== "design") throw new Error("invalid_design_comment_draft");
  const current = previous === undefined ? undefined : workbenchDraftSchema.parse(previous);
  if (current && (current.context.kind !== "design"
    || current.context.target.deviceId !== next.context.target.deviceId
    || current.context.target.tabId !== next.context.target.tabId)) throw new Error("workbench_design_draft_target_changed");
  return workbenchDraftSchema.parse({
    ...(current ?? next),
    context: current ? { ...current.context, target: { ...current.context.target, windowId: next.context.target.windowId },
      revision: Math.min(current.context.revision!, next.context.revision!) } : next.context,
    designComments: [...new Set([...(current?.designComments ?? []), ...(next.designComments ?? [])])],
    // Each newly appended thread includes its complete current text. Its latest
    // snapshot is therefore present in the resulting composer, even on repeat.
    ...((current?.designCommentVersions || next.designCommentVersions) ? {designCommentVersions:{...current?.designCommentVersions,...next.designCommentVersions}} : {}),
  });
}

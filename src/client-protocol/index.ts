import { designShareRequestFrameSchema, WORKBENCH_DESIGN_SHARE_CAPABILITY, DESIGN_SHARE_CLIENT_CAPABILITY } from "./workbench-design-sharing.js";
import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_DESIGN_COMMENTS_CAPABILITY, WORKBENCH_DESIGN_HISTORY_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY } from "./workbench-design.js";
import { WORKBENCH_CAPABILITY, WORKBENCH_MARKDOWN_CAPABILITY, workbenchContextSchema, workbenchRegisterFrameSchema, workbenchUnregisterFrameSchema, workbenchReceiptFrameSchema } from "./workbench.js";
export * from "./workbench.js";
import { nativeInputProgressSchema } from "./native-input.js";
import { steeringApplicationSchema } from "./steering-outcome.js";
import { botSourceSchema } from "./bot-messages.js";
import { DISPATCH_CAPABILITY, conversationTicketSchema } from "./dispatch.js";
import { linkUrlSchema, linkPreviewSchema, linkPreviewStyleSchema } from "./links.js";
import { z } from "zod";
import { PAIRING_INVITES_CAPABILITY } from "./pairing-invites.js";
import { ATTACHMENT_ADMIN_CAPABILITY } from "./attachment-admin.js";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;
export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
// MAX_FILE_BYTES is the default policy, not a wire-format ceiling. The Hub
// advertises its configured limit after authentication; chunks remain 8 MiB.
export const fileSizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const uploadLimitsSchema = z.object({ maxFileBytes: fileSizeSchema, chunkBytes: z.literal(CHUNK_BYTES) });
export const CAPABILITIES = [ATTACHMENT_ADMIN_CAPABILITY, WORKBENCH_DESIGN_SHARE_CAPABILITY, DESIGN_SHARE_CLIENT_CAPABILITY,"desktop.screen.v1", "desktop.screen.quality.v1", DISPATCH_CAPABILITY,WORKBENCH_CAPABILITY, WORKBENCH_MARKDOWN_CAPABILITY, WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_DESIGN_COMMENTS_CAPABILITY, WORKBENCH_DESIGN_HISTORY_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY, PAIRING_INVITES_CAPABILITY, "markdown", "katex", "cards.v1", "runs.v1", "runs.scopes.v1", "runs.tail.v1", "runs.scope-groups.v1", "forms.v1", "streaming.v1", "streaming.card-extra.v1", "snapshot.v1", "snapshot.delta.v1", "sync.conversations.v1", "sync.lineage.v1", "fragments.v1", "auth-status.v1", "conversation-folders.reorder.v1", "conversation-folders.pin.v1", "conversations.batch.v1", "conversations.restore.v1", "conversation-avatars.v1", "bots.delete.v1", "messages.delete.v1", "messages.clear.v1", "prompt-queue.v1", "workspace.diff.v1", "runs.changes.v1", "integrations.asr.v1", "integrations.voice.v2", "widgets.settings.v1", "engines.settings.v1", "backups.settings.v1", "bot-messages.v1", "groups.discussion.v1", "groups.discussion.composer.v1", "groups.discussion.recovery.v1", "groups.reply-guard.v1", "groups.parallel.v1", "conversations.side.v1", "conversations.tasks.v1", "claude.native-input.v1", "private-network.v2", "host-routes.v1", "voice", "push.apns", "push.fcm", "push.webpush", "push.unifiedpush"] as const;
export const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const textSchema = z.string().refine((s) => new TextEncoder().encode(s).length <= MAX_TEXT_BYTES, "Text exceeds 200 KiB");
export const jsonSchema = z.json();
export type Json = z.infer<typeof jsonSchema>;
export const extraSchema = z.record(z.string(), jsonSchema);

// Protocol names are deliberately independent of Feishu. Unrecognized source
// properties survive in extra, so a newer renderer can recover their meaning.
export const cardElementSchema: z.ZodType<CardElement> = z.lazy(() => z.object({
  type: z.enum(["markdown", "button", "buttonGroup", "select", "input", "form", "collapsible", "divider", "columns", "column", "icon", "image"]),
  id: z.string().optional(), text: z.string().optional(), children: z.array(cardElementSchema).optional(),
  actionId: z.string().optional(), value: jsonSchema.optional(), name: z.string().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  multiple: z.boolean().optional(), min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional(),
  required: z.boolean().optional(), disabled: z.boolean().optional(), open: z.boolean().optional(),
  style: z.enum(["primary", "default", "danger"]).optional(),
  confirm: z.object({ title: z.string(), text: z.string() }).optional(),
  attachmentId: idSchema.optional(), url: z.string().optional(),
  layout: extraSchema.optional(), extra: extraSchema.optional(),
}).strict());
export interface CardElement {
  type: "markdown" | "button" | "buttonGroup" | "select" | "input" | "form" | "collapsible" | "divider" | "columns" | "column" | "icon" | "image";
  id?: string; text?: string; children?: CardElement[]; actionId?: string; value?: Json; name?: string;
  options?: { label: string; value: string }[]; multiple?: boolean; min?: number; max?: number;
  required?: boolean; disabled?: boolean; open?: boolean; style?: "primary" | "default" | "danger";
  confirm?: { title: string; text: string }; attachmentId?: string; url?: string;
  layout?: Record<string, Json>; extra?: Record<string, Json>;
}
export const blockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), attachmentId: idSchema, title: z.string().optional(), groupId: idSchema.optional() }),
  z.object({ type: z.literal("file"), attachmentId: idSchema, name: z.string(), size: z.number().nonnegative(), mime: z.string() }),
  z.object({ type: z.literal("audio"), attachmentId: idSchema, name: z.string().optional() }),
  z.object({ type: z.literal("card"), title: z.string().optional(), summary: z.string().optional(), template: z.string().optional(), elements: z.array(cardElementSchema), layout: extraSchema.optional(), extra: extraSchema.optional() }),
  z.object({ type: z.literal("run"), phase: z.string(), elapsedMs: z.number().nonnegative(), thinking: z.string().optional(), tools: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), detail: z.string().optional() })), todos: z.array(z.object({ text: z.string(), done: z.boolean() })) }),
  z.object({ type: z.literal("steering"), botId: idSchema, targetId: idSchema, outcome: z.enum(["pending", "accepted", "rejected", "unknown"]), reason: z.string().optional(), application: steeringApplicationSchema.optional(), mode: z.literal("message").optional(), nativeInput: nativeInputProgressSchema.optional() }),
  z.object({ type: z.literal("usage"), model: z.string().optional(), effort: z.string().optional(), contextPercent: z.number().optional(), inputTokens: z.number().optional(), outputTokens: z.number().optional() }),
]);
export type Block = z.infer<typeof blockSchema>;
export const forwardingSchema = z.object({ messageId: idSchema, conversationId: idSchema, conversationTitle: z.string().max(515), authorName: z.string().max(256), createdAt: z.number().int() });
/** Hub-owned marker of a group-discussion topic or scheduler input. Written only
 * by the Hub's discussion scheduler; client and Bot writes cannot set it. */
export const groupDiscussionMessageSchema = z.object({
  runId: idSchema, role: z.enum(["topic", "input"]), mode: z.enum(["sequential", "independent"]),
  turnId: idSchema.optional(), botId: idSchema.optional(), round: z.number().int().positive().optional(), maxRounds: z.number().int().positive().optional(),
  position: z.number().int().nonnegative().optional(), participants: z.number().int().positive().optional(), attempt: z.number().int().positive().optional(), blind: z.boolean().optional(),
}).strict();
export const messageSchema = z.object({ groupDiscussion: groupDiscussionMessageSchema.optional(), botSource: botSourceSchema.optional(), id: idSchema, conversationId: idSchema, authorId: idSchema, authorType: z.enum(["user", "bot", "system"]), mentions: z.array(idSchema).max(64).optional(), blocks: z.array(blockSchema), status: z.enum(["pending", "streaming", "complete", "error", "deleted"]), version: z.number().int().nonnegative(), clientMsgId: idSchema.optional(), replyTo: idSchema.optional(), forwardedFrom: forwardingSchema.optional(), previewUrl: linkUrlSchema.nullable().optional(), previewStyle: linkPreviewStyleSchema.optional(), linkPreview: linkPreviewSchema.optional(), createdAt: z.number().int() });
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({ id: idSchema, type: z.enum(["direct", "group"]), title: z.string().max(256), ownerId: idSchema, parentId: idSchema.optional(), botIds: z.array(idSchema), archived: z.boolean(), sessionId: z.string().optional(), bindingId: idSchema.optional(), createdAt: z.number().int(),
  /** dispatch.v1: a dispatcher ticket's worker conversation, kept out of lists. */
  hidden: z.literal(true).optional(), ticket: conversationTicketSchema.optional() });
export type Conversation = z.infer<typeof conversationSchema>;
export const eventSchema = z.object({ v: z.literal(1), type: z.literal("event"), conversationId: idSchema, seq: z.number().int().positive(), kind: z.enum(["message.created", "message.updated", "message.deleted", "message.stream", "turn.state", "reaction", "read"]), payload: jsonSchema, at: z.number().int() });
export type HubEvent = z.infer<typeof eventSchema>;
const envelope = { v: z.literal(1) };
/** `sequential`/`independent` (groups.discussion.recovery.v1): one directed
 * reply to exactly one mentioned Bot while no discussion is active. */
export const groupReplyGuardSchema = z.object({ mode: z.enum(["mentions", "parallel", "sequential", "independent"]), revision: z.string().min(1).max(128) }).strict();
export type GroupReplyGuard = z.infer<typeof groupReplyGuardSchema>;
export const clientFrameSchema = z.discriminatedUnion("type", [
  designShareRequestFrameSchema, workbenchRegisterFrameSchema, workbenchUnregisterFrameSchema, workbenchReceiptFrameSchema,
  z.object({ ...envelope, type: z.literal("hello"), deviceId: idSchema, protocolVersions: z.array(z.number().int()).min(1).max(16), capabilities: z.array(z.string().max(64)).max(64), cursors: z.record(idSchema, z.number().int().nonnegative()), syncLineages: z.record(idSchema, z.string().uuid()).optional(), preferredConversationId: idSchema.optional(), nonce: z.string().min(32).max(128) }),
  z.object({ ...envelope, type: z.literal("auth"), signature: z.string().max(256) }),
  z.object({ ...envelope, type: z.literal("snapshot.ack"), id: idSchema, count: z.number().int().nonnegative().safe() }),
  z.object({ ...envelope, type: z.literal("message.send"), workbench: workbenchContextSchema.optional(), groupReplyGuard: groupReplyGuardSchema.optional(), clientMsgId: idSchema, conversationId: idSchema, text: textSchema, previewUrl: linkUrlSchema.nullable().optional(), previewStyle: linkPreviewStyleSchema.optional(), attachments: z.array(idSchema).max(64).default([]), replyTo: idSchema.optional(), mentions: z.array(idSchema).max(64).optional() }),
  z.object({ ...envelope, type: z.literal("message.forward"), clientMsgId: idSchema, conversationId: idSchema, sourceMessageId: idSchema, mentions: z.array(idSchema).max(64).optional() }),
  z.object({ ...envelope, type: z.literal("interaction.submit"), conversationId: idSchema, messageId: idSchema, actionId: z.string().min(1).max(256), values: extraSchema, clientActionId: idSchema }),
  z.object({ ...envelope, type: z.literal("turn.stop"), conversationId: idSchema, botId: idSchema.optional() }),
  z.object({ ...envelope, type: z.literal("read.mark"), conversationId: idSchema, seq: z.number().int().nonnegative() }),
  z.object({ ...envelope, type: z.literal("typing"), conversationId: idSchema }),
  z.object({ ...envelope, type: z.literal("conversation.create"), clientActionId: idSchema, botIds: z.array(idSchema).min(1).max(32), title: z.string().min(1).max(256), conversationType: z.enum(["direct", "group"]).optional() }),
  z.object({ ...envelope, type: z.literal("topic.create"), clientActionId: idSchema, groupId: idSchema, title: z.string().trim().min(1).max(256) }),
  z.object({ ...envelope, type: z.literal("conversation.rename"), conversationId: idSchema, title: z.string().min(1).max(256) }),
  z.object({ ...envelope, type: z.literal("conversation.archive"), conversationId: idSchema, archived: z.boolean() }),
  z.object({ ...envelope, type: z.literal("conversation.bind"), conversationId: idSchema, sessionId: z.string().min(1).max(256).nullable(), expectedBindingId: idSchema.nullable().optional() }),
  z.object({ ...envelope, type: z.literal("command.complete"), botId: idSchema, query: z.string().max(256) }),
  z.object({ ...envelope, type: z.literal("presence"), foreground: z.boolean() }),
  z.object({ ...envelope, type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;
const knownTypes = new Set(clientFrameSchema.options.map((s) => s.shape.type.value));
export function parseClientFrame(raw: string): { frame: ClientFrame } | { ignored: string } {
  if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) throw new Error("frame_too_large");
  const value: unknown = JSON.parse(raw);
  const head = z.object({ v: z.literal(1), type: z.string().min(1).max(128) }).parse(value);
  if (!knownTypes.has(head.type as ClientFrame["type"])) return { ignored: head.type };
  return { frame: clientFrameSchema.parse(value) };
}
export const pairingSchema = z.object({ deviceId: idSchema, name: z.string().min(1).max(100), platform: z.enum(["web", "macos", "windows", "ios", "android"]), publicKey: z.string().min(32).max(256) }).strict();
export const uploadSchema = z.object({ conversationId: idSchema, name: z.string().min(1).max(255).refine((s) => !/[\\/\x00-\x1f]/.test(s) && s !== "." && s !== "..", "Invalid filename"), size: fileSizeSchema, mime: z.string().max(128).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Upload = z.infer<typeof uploadSchema>;

export function blocksText(blocks: Block[]): string {
  const elementText = (e: CardElement): string => [e.text, ...(e.options?.map((o, i) => `${i + 1}. ${o.label}`) ?? []), ...(e.children?.map(elementText) ?? [])].filter(Boolean).join("\n");
  // Delivery status is not part of the user's prompt. Keep the legacy card
  // fallback in history without adding it to copy, search or quoted text.
  return blocks.filter((b) => b.type !== "steering" && !(b.type === "card" && b.extra?.promptQueue)).map((b) => b.type === "text" ? b.text : b.type === "card" ? [b.title, ...b.elements.map(elementText)].filter(Boolean).join("\n") : b.type === "file" ? b.name : b.type === "image" ? b.title ?? "[image]" : "").join("\n");
}

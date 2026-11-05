import { z } from "zod";
import { blockSchema, cardElementSchema, idSchema, jsonSchema, messageSchema, type Block, type CardElement, type Message } from "./index.js";

export const CARD_EXTRA_STREAM_CAPABILITY = "streaming.card-extra.v1";

const index = z.number().int().nonnegative();
const elementPath = z.array(index).min(1).max(32);
export const streamOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("appendText"), block: index, path: elementPath.optional(), text: z.string() }).strict(),
  z.object({ op: z.literal("replaceCardExtra"), block: index, value: z.record(z.string(), jsonSchema).nullable() }).strict(),
  z.object({ op: z.literal("replaceBlock"), block: index, value: blockSchema }).strict(),
  z.object({ op: z.literal("replaceElement"), block: index, path: elementPath, value: cardElementSchema }).strict(),
]);
export const messageStreamSchema = z.object({
  messageId: idSchema, baseVersion: index, version: z.number().int().positive(),
  ops: z.array(streamOperationSchema).max(256),
}).strict().refine((value) => value.version > value.baseVersion, "Stream version must advance");
export type MessageStream = z.infer<typeof messageStreamSchema>;
type Operation = z.infer<typeof streamOperationSchema>;
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Derive transport deltas from durable snapshots; terminal updates stay full. */
export function messageDelta(previous: Message, next: Message, options: { cardExtra?: boolean } = {}): MessageStream | undefined {
  const { blocks: before, version: baseVersion, ...beforeMeta } = previous;
  const { blocks: after, version, ...afterMeta } = next;
  if (previous.status !== "streaming" || next.status !== "streaming" || version <= baseVersion || before.length !== after.length || !equal(beforeMeta, afterMeta)) return;
  const ops: Operation[] = [];
  function element(old: CardElement, value: CardElement, block: number, path: number[]): void {
    if (equal(old, value)) return;
    const { text: oldText, children: oldChildren, ...oldMeta } = old;
    const { text, children, ...meta } = value;
    if (path.length > 32 || !equal(oldMeta, meta) || oldChildren?.length !== children?.length || (text !== oldText && (typeof text !== "string" || typeof oldText !== "string" || !text.startsWith(oldText)))) {
      ops.push({ op: "replaceElement", block, path, value }); return;
    }
    if (text !== oldText) ops.push({ op: "appendText", block, path, text: text!.slice(oldText!.length) });
    children?.forEach((child, i) => element(oldChildren![i]!, child, block, [...path, i]));
  }
  after.forEach((value, block) => {
    const old = before[block]!;
    if (equal(old, value)) return;
    if (old.type === "text" && value.type === "text" && value.text.startsWith(old.text)) {
      ops.push({ op: "appendText", block, text: value.text.slice(old.text.length) });
    } else if (old.type === "card" && value.type === "card") {
      const { elements: beforeElements, extra: oldExtra, ...oldMeta } = old, { elements, extra, ...meta } = value;
      if (beforeElements.length === elements.length && equal(oldMeta, meta) && (options.cardExtra || equal(oldExtra, extra))) {
        if (!equal(oldExtra, extra)) ops.push({ op: "replaceCardExtra", block, value: extra ?? null });
        elements.forEach((child, i) => element(beforeElements[i]!, child, block, [i]));
      }
      else ops.push({ op: "replaceBlock", block, value });
    } else ops.push({ op: "replaceBlock", block, value });
  });
  const candidate = messageStreamSchema.safeParse({ messageId: next.id, baseVersion, version, ops });
  if (!candidate.success || JSON.stringify(candidate.data).length >= JSON.stringify(next).length) return;
  return candidate.data;
}

/** Index-only paths cannot address arbitrary properties or change message identity. */
export function applyMessageDelta(previous: Message, raw: unknown): Message {
  const delta = messageStreamSchema.parse(raw);
  if (previous.id !== delta.messageId) throw new Error("stream_message_mismatch");
  if (delta.version <= previous.version) return previous;
  if (previous.version !== delta.baseVersion || previous.status !== "streaming") throw new Error("stream_base_mismatch");
  const blocks: Block[] = structuredClone(previous.blocks);
  for (const op of delta.ops) {
    const block = blocks[op.block];
    if (!block) throw new Error("stream_block_missing");
    if (op.op === "replaceBlock") { blocks[op.block] = op.value; continue; }
    if (op.op === "replaceCardExtra") {
      if (block.type !== "card") throw new Error("stream_card_required");
      if (op.value === null) delete block.extra; else block.extra = op.value;
      continue;
    }
    if (op.op === "appendText" && !op.path) {
      if (block.type !== "text") throw new Error("stream_text_required");
      block.text += op.text; continue;
    }
    if (block.type !== "card" || !op.path) throw new Error("stream_card_required");
    let elements = block.elements;
    for (const part of op.path.slice(0, -1)) {
      const children = elements[part]?.children;
      if (!children) throw new Error("stream_element_missing");
      elements = children;
    }
    const last = op.path[op.path.length - 1]!, target = elements[last];
    if (!target) throw new Error("stream_element_missing");
    if (op.op === "replaceElement") elements[last] = op.value;
    else { if (typeof target.text !== "string") throw new Error("stream_text_required"); target.text += op.text; }
  }
  return messageSchema.parse({ ...previous, blocks, version: delta.version });
}

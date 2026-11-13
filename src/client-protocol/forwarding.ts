import type { Block, CardElement } from "./index.js";

export function messageAttachmentIds(blocks: Block[]): Set<string> {
  const ids = new Set<string>();
  const walk = (elements: CardElement[]) => { for (const e of elements) { if (e.attachmentId) ids.add(e.attachmentId); walk(e.children ?? []); } };
  for (const b of blocks) { if ("attachmentId" in b) ids.add(b.attachmentId); if (b.type === "card") walk(b.elements); }
  return ids;
}

/** A forward is a readable snapshot, never another executable approval. */
export function forwardedBlocks(blocks: Block[], attachments: ReadonlyMap<string, string>): Block[] {
  const element = (e: CardElement): CardElement => {
    const { actionId, value, confirm, ...snapshot } = e;
    return { ...snapshot,
    ...(["button", "input", "select"].includes(e.type) ? { disabled: true } : {}),
    ...(e.attachmentId ? { attachmentId: attachments.get(e.attachmentId)! } : {}),
    ...(e.children ? { children: e.children.map(element) } : {}) };
  };
  // Queue receipts describe the source delivery only. Forwarding creates a new
  // input, so carrying “cancelled / not sent” into it would misreport its state.
  return blocks.filter(b => !(b.type === "card" && b.extra?.promptQueue)).map((b) => {
    if (b.type === "card") {
      const { nativeRun: _run, nativeRunThinking: _thinking, goalTurnEnded: _goalTurnEnded, scopedRun: _scopedRun, scopedJournal: _scopedJournal, backgroundTask: _background, backgroundTaskGroup: _group, answerFollowup: _answerFollowup, appQueue: _queue, ...extra } = b.extra ?? {};
      return { ...b, ...(_run || _thinking || _goalTurnEnded || _scopedRun || _scopedJournal || _background || _group || _answerFollowup || _queue ? { extra } : {}),
        elements: b.elements.filter(e => !_background || e.id !== "background_context").map(element) };
    }
    if ("attachmentId" in b) return { ...b, attachmentId: attachments.get(b.attachmentId)! };
    if (b.type === "run") return { type: "text", text: [b.phase, b.thinking, ...b.tools.map((tool) => `${tool.name}: ${tool.status}${tool.detail ? ` — ${tool.detail}` : ""}`), ...b.todos.map((todo) => `${todo.done ? "[x]" : "[ ]"} ${todo.text}`)].filter(Boolean).join("\n") };
    return b;
  });
}

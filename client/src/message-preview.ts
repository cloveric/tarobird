import type { CardElement, Message } from "../../src/client-protocol/index.js";

export type PreviewAttachment = { id: string; type: "image" | "file" | "audio"; name?: string; mime?: string; size?: number };

// A thumbnail is a bounded, read-only view. Keep authored Markdown intact,
// without promoting card actions or folded process details into the preview.
export function messagePreview(message: Message) {
  const parts: string[] = [], attachments: PreviewAttachment[] = [];
  const ids = new Set<string>();
  let remaining = 16_000, visited = 0, truncated = false;
  const append = (text?: string) => {
    if (!text) return;
    const value = text.slice(0, remaining);
    if (value) parts.push(value);
    remaining -= value.length;
    if (value.length < text.length) truncated = true;
  };
  const label = (text?: string) => text && append(text.replace(/([\\`*_{}\[\]<>#+.!|~-])/g, "\\$1"));
  const attachment = (item: PreviewAttachment) => {
    if (ids.has(item.id)) return;
    ids.add(item.id);
    if (attachments.length < 64) attachments.push(item); else truncated = true;
  };
  const walk = (elements: CardElement[], hidden = false, depth = 0) => {
    for (const e of elements) {
      if (++visited > 256 || depth > 12) { truncated = true; return; }
      if (e.type === "image" && e.attachmentId) attachment({ id: e.attachmentId, type: "image", name: e.text });
      if (!hidden) {
        if (e.type === "markdown") append(e.text);
        else if (e.type === "divider") append("---");
        else if (e.type !== "image") label(e.text);
      }
      walk(e.children ?? [], hidden || e.type === "collapsible" && !e.open, depth + 1);
    }
  };
  for (const block of message.blocks) {
    if (++visited > 256) { truncated = true; break; }
    if (block.type === "text") append(block.text);
    else if (block.type === "card") { label(block.title); walk(block.elements); }
    else if (block.type === "file") attachment({ id: block.attachmentId, type: "file", name: block.name, mime: block.mime, size: block.size });
    else if (block.type === "image") attachment({ id: block.attachmentId, type: "image", name: block.title });
    else if (block.type === "audio") attachment({ id: block.attachmentId, type: "audio", name: block.name });
  }
  return { text: parts.join("\n\n"), attachments, truncated };
}

import type { ElementContent, Nodes, Root } from "hast";
import { t } from "./i18n.js";
export type NamedBot = { id: string; name: string; engine?: string; model?: string; deletedAt?: number; defaultAvatar?: string; role?: string };
export function botLabels(bots: readonly NamedBot[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>(), suffixCounts = new Map<string, Map<string, number>>();
  const group = (bot: NamedBot) => `${bot.deletedAt ? "deleted" : "active"}:${bot.name}`;
  for (const bot of bots) {
    counts.set(group(bot), (counts.get(group(bot)) ?? 0) + 1);
    let suffixes = suffixCounts.get(group(bot)); if (!suffixes) { suffixes = new Map(); suffixCounts.set(group(bot), suffixes); }
    const suffix = bot.id.slice(-6); suffixes.set(suffix, (suffixes.get(suffix) ?? 0) + 1);
  }
  return new Map(bots.map((bot) => {
    const duplicate = (counts.get(group(bot)) ?? 0) > 1, suffix = bot.id.slice(-6);
    const collision = (suffixCounts.get(group(bot))?.get(suffix) ?? 0) > 1;
    const name = bot.deletedAt ? t("{0}（已删除）", bot.name) : bot.name;
    return [bot.id, duplicate ? `${name} · ${collision ? bot.id : suffix}` : name];
  }));
}
/** Opaque managed IDs are references, ordinary words such as a legacy 'alpha'
 * instance name are not. Never rewrite an ID embedded in a path or identifier. */
export function referenceParts(text: string, labels: ReadonlyMap<string, string>): { text: string; botId?: string; label?: string }[] {
  const result: { text: string; botId?: string; label?: string }[] = []; let at = 0;
  for (const match of text.matchAll(/client_[a-f0-9]{24}/g)) {
    const id = match[0], start = match.index, end = start + id.length, label = labels.get(id);
    const before = text[start - 1] ?? "", after = text[end] ?? "";
    if (!label || /[\p{L}\p{N}_./:@\\-]/u.test(before) || /[\p{L}\p{N}_/:@\\-]/u.test(after) || after === "." && text[end + 1] !== "." && /[\p{L}\p{N}_]/u.test(text[end + 1] ?? "")) continue;
    if (start > at) result.push({ text: text.slice(at, start) });
    result.push({ text: id, botId: id, label }); at = end;
  }
  if (at < text.length || !result.length) result.push({ text: text.slice(at) });
  return result;
}
export function readableBotReferences(text: string, labels: ReadonlyMap<string, string>): string { return referenceParts(text, labels).map((part) => part.label ?? part.text).join(""); }
/** Short, possibly truncated navigation excerpts cannot safely parse code
 * spans. Leave code-bearing excerpts intact, but an ordinary tilde in prose
 * is not a code fence. URL query strings must also remain literal. */
export function readablePreviewBotReferences(text: string, labels: ReadonlyMap<string, string>): string {
  if (/`|~{3,}/.test(text)) return text;
  return text.split(/(https?:\/\/\S+)/g).map((part, index) => {
    if (index % 2) return part;
    // The Hub bounds the excerpt before names are resolved. A result header
    // or progress line can therefore end mid-ID. Mark that tail as an excerpt;
    // never guess which Bot it was or rewrite URL/code/literal path contents.
    const preview = part.replace(/(^|[^\p{L}\p{N}_./:@\\\[-])(\[?client_[a-f0-9]{0,23})$/u, (match, before: string, partial: string) =>
      [...labels.keys()].some(id => id.startsWith(partial.replace(/^\[/, ""))) ? `${before}…` : match);
    return readableBotReferences(preview, labels);
  }).join("");
}
/** Presentation-only tree. Source messages, copy/export, URLs and code stay exact.
 * Worker-produced trees are shared between revisions, so never mutate them. */
export function annotateBotReferences(tree: Root, labels: ReadonlyMap<string, string>): Root {
  if (!labels.size) return tree;
  function children(node: Nodes): Nodes {
    if (node.type === "element" && (["a", "code", "pre", "math", "svg", "script", "style"].includes(node.tagName) || String(node.properties.className ?? "").includes("katex"))) return node;
    if (!("children" in node)) return node;
    let changed = false;
    const next = node.children.flatMap((child) => {
      if (child.type === "text") {
        const parts = referenceParts(child.value, labels);
        if (!parts.some((part) => part.botId)) return [child];
        changed = true;
        return parts.map((part): ElementContent => part.botId ? { type: "element", tagName: "span", properties: { className: ["bot-reference"], title: `${part.label} · ${part.botId}`, dataBotId: part.botId }, children: [{ type: "text", value: part.label! }] } : { type: "text", value: part.text });
      }
      const next = children(child); if (next !== child) changed = true; return [next];
    });
    return changed ? { ...node, children: next } as Nodes : node;
  }
  return children(tree) as Root;
}

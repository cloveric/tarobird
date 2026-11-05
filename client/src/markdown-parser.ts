import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import type { Nodes, Root } from "hast";
import { markdownImageUrl } from "./markdown-image.js";
import { remarkMathBoundaries } from "./markdown-math-boundaries.js";
import { remarkCjkStrong } from "./markdown-cjk-strong.js";

// Parse the entire document, preserving reference links, nested lists, fenced
// blocks and footnotes across updates. Chunk only the resulting display tree.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkMathBoundaries).use(remarkCjkStrong)
  .use(remarkRehype);
// Most chat messages use neither formula layout nor syntax highlighting. Load
// those engines only after parsing proves they are needed, inside the Worker.
// A failed module fetch can poison a WebKit module map. Report which optional
// engine failed so its bounded recovery does not block unrelated plain messages.
export type MarkdownDependency = "math" | "highlight";
type Options = { unavailable?: readonly MarkdownDependency[]; used?: Set<MarkdownDependency> };
export class MarkdownDependencyError extends Error {
  constructor(readonly dependency: MarkdownDependency, readonly skipped = false) { super("markdown_dependency_unavailable"); }
}
async function dependency<T>(kind: MarkdownDependency, options: Options, load: () => Promise<T>): Promise<T> {
  if (options.unavailable?.includes(kind)) throw new MarkdownDependencyError(kind, true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MarkdownDependencyError(kind)), 5_000); });
    const result = await Promise.race([load(), timeout]); options.used?.add(kind); return result;
  }
  catch { throw new MarkdownDependencyError(kind); }
  finally { clearTimeout(timer); }
}
function needsMath(node: Nodes): boolean {
  if (node.type === "element" && Array.isArray(node.properties.className)
    && node.properties.className.some(value => value === "language-math" || value === "math-display" || value === "math-inline")) return true;
  return "children" in node && node.children.some(needsMath);
}
function needsHighlight(node: Nodes): boolean {
  if (node.type === "element" && node.tagName === "pre" && node.children.some(child => {
    if (child.type !== "element" || child.tagName !== "code" || !Array.isArray(child.properties.className)) return false;
    // rehype-highlight's default detect=false skips untyped/indented code.
    // Preserve its explicit skip classes, language aliases and unknown-language
    // behavior; language-no-highlight is a language, not a skip class.
    let language: string | undefined;
    for (const item of child.properties.className) {
      const value = String(item);
      if (value === "no-highlight" || value === "nohighlight") return false;
      if (!language && value.startsWith("lang-")) language = value.slice(5);
      if (!language && value.startsWith("language-")) language = value.slice(9);
    }
    return !!language;
  })) return true;
  return "children" in node && node.children.some(needsHighlight);
}
function safeUrl(value: string): string {
  const colon = value.indexOf(":");
  const boundary = value.search(/[/?#]/);
  return colon < 0 || boundary >= 0 && boundary < colon || /^(?:https?|ircs?|mailto|xmpp)$/i.test(value.slice(0, colon)) ? value : "";
}
function clean(node: Nodes, linked = false): void {
  delete node.position;
  if (node.type === "element") {
    if (node.tagName === "img") {
      const href = markdownImageUrl(node.properties.src);
      const alt = typeof node.properties.alt === "string" ? node.properties.alt : "";
      // Preserve a surrounding Markdown link's destination and avoid nested
      // anchors. Attachments use the authorized image component separately.
      node.tagName = linked ? "span" : "a";
      node.properties = linked ? {} : { href: href ?? "", className: ["markdown-image-link"] };
      node.children = [{ type: "text", value: alt || (linked ? (href ? new URL(href).hostname : "▧") : "") }];
    }
    // Raw HTML is never enabled. Generated links/images use an explicit
    // protocol allowlist for messages of every length.
    for (const key of ["href", "src", "xLinkHref", "action", "formAction", "poster"]) {
      if (typeof node.properties[key] === "string") node.properties[key] = safeUrl(String(node.properties[key]));
    }
  }
  if ("children" in node) node.children.forEach(child => clean(child, linked || node.type === "element" && node.tagName === "a"));
}
export async function parseMarkdownChunks(text: string, options: Options = {}): Promise<string[]> {
  if (text.length > 1024 * 1024) throw new Error("markdown_too_large");
  let tree = processor.runSync(processor.parse(text)) as Root;
  if (needsMath(tree)) tree = (await dependency("math", options, () => import("./markdown-math.js"))).renderMath(tree);
  // Math fences become formula spans first, preserving the previous transform
  // order and avoiding a highlighter import for a formula-only document.
  if (needsHighlight(tree)) tree = (await dependency("highlight", options, () => import("./markdown-highlight.js"))).highlightCode(tree);
  clean(tree);
  const chunks: string[] = [];
  // Ten formula/table roots can contain far more DOM than 100 plain roots.
  // Bound grouping cost without splitting semantic blocks or discarding nodes.
  const weight = (node: Nodes, budget = 250): number => {
    let count = 1;
    if (budget <= 1) return count;
    if ("children" in node) for (const child of node.children) {
      count += weight(child, budget - count);
      if (count >= budget) break;
    }
    return count;
  };
  let children: Root["children"] = [], nodes = 0;
  const flush = () => { if (children.length) chunks.push(JSON.stringify({ type: "root", children })); children = []; nodes = 0; };
  for (const child of tree.children) {
    const cost = weight(child);
    if (children.length >= 100 || nodes + cost > 250) flush();
    children.push(child); nodes += cost;
  }
  flush();
  return chunks;
}

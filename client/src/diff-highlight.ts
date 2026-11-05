import type { Root, RootContent } from "hast";
import type { DisplayDiff } from "./diff-view-rows.js";
export type DiffToken = { text: string; classes: string[] };
/** Preserve span ancestry across newlines without inserting raw HTML. */
export function highlightLines(nodes: RootContent[]): DiffToken[][] {
  const lines: DiffToken[][] = [[]];
  const walk = (node: RootContent, classes: string[]) => {
    if (node.type === "text") node.value.split("\n").forEach((text, index) => { if (index) lines.push([]); if (text) lines[lines.length - 1]!.push({ text, classes }); });
    else if (node.type === "element") {
      const own = node.tagName === "span" && Array.isArray(node.properties.className) ? node.properties.className.filter((value): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value)) : [];
      node.children.forEach(child => walk(child, [...classes, ...own]));
    }
  };
  nodes.forEach(node => walk(node, [])); return lines;
}
export async function highlightDiff(file: DisplayDiff): Promise<Map<string, DiffToken[]>> {
  const all = file.hunks.flatMap(h => h.lines), result = new Map<string, DiffToken[]>();
  if (all.length > 200 || new TextEncoder().encode(all.map(line => line.text).join("\n")).length > 32 * 1024 || all.some(line => line.clipped)) return result;
  const extension = file.file.path.split(".").pop()?.toLowerCase();
  const language = ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", py: "python", css: "css", sh: "bash", rs: "rust", go: "go", html: "xml", md: "markdown", yml: "yaml", yaml: "yaml" } as Record<string, string>)[extension ?? ""];
  if (!language) return result;
  const { highlightCode } = await import("./markdown-highlight.js");
  for (const [hi, hunk] of file.hunks.entries()) for (const side of ["old", "new"] as const) {
    const lines = hunk.lines.filter(line => (side === "old" ? line.oldLine : line.newLine) !== null);
    // A fragment beginning in the middle of a file has unknown lexical state
    // (for example an already-open block comment). Fall back to plain text.
    if (!lines.length || (side === "old" ? lines[0]!.oldLine : lines[0]!.newLine) !== 1) continue;
    const tree: Root = { type: "root", children: [{ type: "element", tagName: "pre", properties: {}, children: [{ type: "element", tagName: "code", properties: { className: [`language-${language}`] }, children: [{ type: "text", value: lines.map(line => line.text).join("\n") }] }] }] };
    const output = highlightLines(highlightCode(tree).children);
    lines.forEach((line, index) => result.set(`${hi}:${side}:${side === "old" ? line.oldLine : line.newLine}`, output[index] ?? []));
  }
  return result;
}

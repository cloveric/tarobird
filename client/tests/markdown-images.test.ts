import { expect, it } from "vitest";
import { parseMarkdownChunks } from "../src/markdown-parser.js";
import type { Nodes } from "hast";

async function elements(text: string) {
  const result: Extract<Nodes, { type: "element" }>[] = [];
  function walk(node: Nodes) { if (node.type === "element") result.push(node); if ("children" in node) node.children.forEach(walk); }
  (await parseMarkdownChunks(text)).forEach(chunk => walk(JSON.parse(chunk))); return result;
}
it("renders remote and reference images as explicit links without image fetch elements", async () => {
  const nodes = await elements('![A chart](https://images.example.test/chart.png "Title")\n\n![Reference][image]\n\n[image]: //images.example.test/reference.png');
  expect(nodes.some(n => n.tagName === "img")).toBe(false);
  expect(nodes.filter(n => n.tagName === "a").map(n => n.properties.href)).toEqual(["https://images.example.test/chart.png", "https://images.example.test/reference.png"]);
});
it.each(["javascript:alert%281%29", "data:image/svg+xml,unsafe", "blob:opaque", "/api/private", "https://user:secret@images.example.test/a.png"])("does not turn %s into a passive request or actionable image link", async value => {
  const nodes = await elements(`![Image description](${value})`);
  expect(nodes.some(n => n.tagName === "img")).toBe(false);
  expect(nodes.some(n => n.properties.src)).toBe(false);
  expect(nodes.filter(n => n.tagName === "a").every(n => !n.properties.href)).toBe(true);
  expect(JSON.stringify(nodes)).toContain("Image description");
});
it("preserves a linked image's destination without creating nested anchors", async () => {
  const nodes = await elements("[![Diagram](https://images.example.test/a.png)](https://example.test/article)");
  expect(nodes.filter(n => n.tagName === "a")).toHaveLength(1);
  expect(nodes.find(n => n.tagName === "a")?.properties.href).toBe("https://example.test/article");
  expect(nodes.some(n => n.tagName === "img")).toBe(false);
});

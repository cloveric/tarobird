import { expect, it } from "vitest";
import type { Nodes } from "hast";
import { parseMarkdownChunks } from "../src/markdown-parser.js";

const example = "- **k6**：落线后 $10 刻度亮起，出「≈ $10」。「差了好几十倍」时，$0.2 到 $10 之间画出带箭头的标尺，写「相差几十倍」。";
async function rendered(text: string) {
  const nodes: Nodes[] = [];
  function walk(node: Nodes) { nodes.push(node); if ("children" in node) node.children.forEach(walk); }
  const used = new Set<"math" | "highlight">();
  for (const chunk of await parseMarkdownChunks(text, { used })) walk(JSON.parse(chunk));
  return { text: nodes.filter(n => n.type === "text").map(n => n.value).join(""),
    math: nodes.filter(n => n.type === "element" && Array.isArray(n.properties.className) && n.properties.className.includes("katex")).length, used };
}

it("keeps the reported dollar amounts and surrounding Chinese as prose without loading math", async () => {
  const result = await rendered(example);
  expect(result.math).toBe(0); expect(result.used.has("math")).toBe(false);
  expect(result.text.trim()).toBe(example.slice(2).replaceAll("**", ""));
});

it.each(["$0.2 到 $10，相差几十倍。", "$20,000 and $30,000", "$5 / $10 / $15", "价格 $10，另一个价格 $20。", "价格 $10\n以及 $20", "\\$10 与 \\$20", "`$10 与 $20`", "```text\n$10 and $20\n```", "| 金额 |\n|---|\n| $10 与 $20 |"])("preserves currency in prose and Markdown containers: %s", async text => {
  const result = await rendered(text);
  expect(result.math).toBe(0); expect(result.text).toContain("$"); expect(result.used.has("math")).toBe(false);
});

it.each(["$E=mc^2$", "$2+2=4$", "$10$", "$\\frac{1}{2}$", "$$ x + y $$", "$$\nx^2+y^2=z^2\n$$", "```math\nx^2\n```"])("retains actual formulas: %s", async text => {
  expect((await rendered(text)).math).toBe(1);
});

it.each(["$ x$", "$x $", "$x$2"])("requires unambiguous single-dollar boundaries: %s", async text => {
  const result = await rendered(text);
  expect(result.math).toBe(0); expect(result.text).toBe(text);
});

it("does not let prices consume a later formula or the next streaming revision", async () => {
  for (const text of ["$10", "$10 到 $", "$10 到 $20", "$10 到 $20。公式 $x^2$，之后 $30 到 $40。"]) {
    const result = await rendered(text);
    expect(result.math).toBe(text.includes("x^2") ? 1 : 0);
    expect(result.text).toContain("$10");
    if (text.includes("$20")) expect(result.text).toContain("$20");
    if (text.includes("$30")) expect(result.text).toContain("$30 到 $40");
  }
});

import { expect, it } from "vitest";
import { evaluateCanvasNode } from "../client/src/canvas-node-evaluator.js";

it("runs single-file and default-export nodes in separate QuickJS instances", async () => {
  const input = { title: "Note", text: "hello world" };
  expect(await evaluateCanvasNode('export default node => ({text: node.title + ": " + node.text.toUpperCase(), color:"#336699"})', input))
    .toEqual({ text: "Note: HELLO WORLD", color: "#336699" });
  const counter = 'function render(node) { globalThis.count = (globalThis.count || 0) + 1; return {text: node.text + count}; }';
  expect(await evaluateCanvasNode(counter, input)).toEqual({ text: "hello world1" });
  expect(await evaluateCanvasNode(counter, input)).toEqual({ text: "hello world1" });
});

it("exposes only the selected node strings and no ambient host capabilities", async () => {
  const module = `export default node => ({text: JSON.stringify([
    Object.keys(node).sort(), typeof window, typeof document, typeof fetch, typeof process,
    typeof localStorage, typeof indexedDB, typeof postMessage, typeof WebSocket, typeof navigator,
  ])})`;
  const output = await evaluateCanvasNode(module, { title: "Sample", text: "note" });
  expect(JSON.parse(output.text)).toEqual([["text", "title"], ...Array(9).fill("undefined")]);
});

it("rejects unsupported dependencies, malformed results and CPU-bound transforms", async () => {
  for (const source of [
    'import dependency from "a-node-dependency"; export default dependency;',
    'export default () => ({ text: 1 })',
    'export default () => ({ text: "value", color: "invalid" })',
    'export default () => { let v=0; for(let i=0;i<1000000000;i++) v+=i; return {text:String(v)}; }',
  ]) await expect(evaluateCanvasNode(source, { text: "" })).rejects.toThrow(/canvas_node_/);
});

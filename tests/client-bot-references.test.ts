import { describe, expect, it } from "vitest";
import { annotateBotReferences, botLabels, readableBotReferences, readablePreviewBotReferences } from "../client/src/bot-references.js";
type Root = Parameters<typeof annotateBotReferences>[0];
const id = `client_${"a".repeat(24)}`, other = `client_${"b".repeat(24)}`;
const labels = botLabels([{ id, name: "Research [Bot]" }, { id: "alpha", name: "Legacy" }]);
describe("readable Bot references preserve native identities", () => {
  it("omits a clipped known Bot header in navigation without guessing its identity or altering literal code", () => {
    expect(readablePreviewBotReferences(`[${id}] answer --- [client_`, labels)).toBe("[Research [Bot]] answer --- …");
    expect(readablePreviewBotReferences(`[client_aaaa`, labels)).toBe("…");
    for (const text of ["[client_cccc", "[client_not_hex", "notes/client_aaaa", "https://example.org/[client_aaaa", "`[client_aaaa"]) {
      expect(readablePreviewBotReferences(text, labels)).toBe(text);
    }
  });
  it("handles truncated references across Ask, Chain, Verify and progress previews", () => {
    for (const prefix of ["[来自 ", "[链路阶段 3: ", "正在转发给 ", "正在执行第 3/3 步：", ""]) {
      expect(readablePreviewBotReferences(`${prefix}client_aaaa`, labels)).toBe(`${prefix}…`);
    }
    for (const text of ["[client_cccc", "notes/client_aaaa", "notes/[client_aaaa", "prefix_client_aaaa", "C:\\client_aaaa", "xclient_aaaa", "https://example.org/client_aaaa", "`client_aaaa", "~~~client_aaaa"]) {
      expect(readablePreviewBotReferences(text, labels)).toBe(text);
    }
  });
  it("resolves tilde prose while preserving truncated code and complete URLs in navigation previews", () => {
    const url = `https://example.org/?bot=${id}&range=3~5`;
    expect(readablePreviewBotReferences(`约 3~5 分钟，由 ${id} 完成 ${url}`, labels)).toBe(`约 3~5 分钟，由 Research [Bot] 完成 ${url}`);
    for (const text of [`\`${id}\``, `~~~\n${id}`, `请看 \`${id}`, `~/${id}/file`]) expect(readablePreviewBotReferences(text, labels)).toBe(text);
    expect(readablePreviewBotReferences(other, labels)).toBe(other);
  });
  it("resolves only exact known opaque references, including native progress and result headers", () => {
    expect(readableBotReferences(`/ask ${id} task\n正在转发给 ${id}...\n[来自 ${id}]\n[${other}] alpha`, labels)).toBe(`/ask Research [Bot] task\n正在转发给 Research [Bot]...\n[来自 Research [Bot]]\n[${other}] alpha`);
    for (const text of [`/${id}`, `${id}.json`, `prefix_${id}`, `${id}extra`, `x${id}`, `https://example.org/${id}`, `${id}/config.json`]) expect(readableBotReferences(text, labels)).toBe(text);
  });
  it("retired names do not rename a replacement Bot or collide with its historical author", () => {
    const values = botLabels([{ id, name: "Codex", deletedAt: 1 }, { id: other, name: "Codex" }]);
    expect(values.get(other)).toBe("Codex");
    expect(values.get(id)).toContain("已删除");
    expect(values.get(id)).not.toBe(values.get(other));
  });
  it("distinguishes duplicate names, including colliding short suffixes", () => {
    const ids = [`client_${"a".repeat(18)}123456`, `client_${"b".repeat(18)}123456`];
    const values = botLabels(ids.map((id) => ({ id, name: "同名助手" })));
    expect(new Set(values.values()).size).toBe(2); expect(values.get(ids[0]!)).toContain(ids[0]);
    expect(botLabels([{ id, name: "same" }, { id: other, name: "same" }]).get(id)).toBe("same · aaaaaa");
  });
  it("annotates prose without mutating trees, interpreting names as markup or changing code, URLs and math", () => {
    const protectedNodes = ["pre", "code", "a", "math", "svg"].map((tagName) => ({ type: "element" as const, tagName, properties: { href: `https://example.org/${id}` }, children: [{ type: "text" as const, value: id }] }));
    const tree: Root = { type: "root", children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: `[${id}]` }] }, ...protectedNodes, { type: "element", tagName: "span", properties: { className: ["katex"] }, children: [{ type: "text", value: id }] }] };
    const before = JSON.stringify(tree), result = annotateBotReferences(tree, labels);
    expect(JSON.stringify(tree)).toBe(before); expect(result.children.slice(1)).toEqual(tree.children.slice(1));
    expect(result.children[0]).toMatchObject({ children: [{ value: "[" }, { tagName: "span", properties: { dataBotId: id }, children: [{ type: "text", value: "Research [Bot]" }] }, { value: "]" }] });
    expect(annotateBotReferences(tree, new Map())).toBe(tree);
  });
});

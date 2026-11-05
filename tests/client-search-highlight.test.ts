import { describe, expect, it } from "vitest";
import { searchExcerptParts, searchTextParts } from "../client/src/search-highlight.js";

const matches = (text: string, query: string) => searchTextParts(text, query).filter(part => part.match).map(part => part.text);
describe("literal history result highlighting", () => {
  it("marks repeated Chinese and ASCII matches without changing source text", () => {
    for (const [text, query, expected] of [
      ["好的，好的。", "好的", ["好的", "好的"]],
      ["AbC abc ABC", "abc", ["AbC", "abc", "ABC"]],
      ["📎好的🙂 好的", "好的", ["好的", "好的"]],
      ["📎附件📎", "📎", ["📎", "📎"]],
      ["İABC CAFÉ café", "abc", ["ABC"]],
      ["CAFÉ café", "café", ["café"]],
      [" first  next\nlast ", "  ", ["  "]],
    ] as const) {
      expect(matches(text, query)).toEqual(expected);
      expect(searchTextParts(text, query).map(part => part.text).join("")).toBe(text);
    }
  });
  it("treats regex, HTML and SQL punctuation as ordinary text", () => {
    for (const query of ["a+b.*[x](?)", "<img onerror=alert(1)>", "abc%def", "abc_def", "\\file", "$&"]) {
      expect(matches(`before ${query} after ${query}`, query)).toEqual([query, query]);
    }
    expect(matches("anything", "")).toEqual([]);
    expect(matches("ABC", "absent")).toEqual([]);
  });
  it("keeps readable previews but preserves matches hidden by cosmetic cleanup", () => {
    const labels = new Map([["client_0123456789abcdef01234567", "助手"]]);
    const plain = searchExcerptParts("## 标题：**好的**，好的", "好的", labels);
    expect(plain.map(part => part.text).join("")).toBe("标题：好的，好的");
    expect(plain.filter(part => part.match).map(part => part.text)).toEqual(["好的", "好的"]);
    for (const [text, query] of [
      ["[资料](https://example.com/needle) needle", "needle"],
      ["## 标题", "##"], ["a  b", "a  b"],
      ["引用 client_0123456789abcdef01234567", "0123456789"],
    ]) {
      const parts = searchExcerptParts(text!, query!, labels);
      expect(parts.map(part => part.text).join("")).toBe(text);
      expect(parts.some(part => part.match)).toBe(true);
    }
    expect(searchExcerptParts("引用 client_0123456789abcdef01234567", "引用", labels).map(part => part.text).join("")).toBe("引用 助手");
  });
});

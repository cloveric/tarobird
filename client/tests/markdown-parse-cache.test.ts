import { expect, it } from "vitest";
import { cachedMarkdown, rememberMarkdown } from "../src/markdown-parse-cache.js";

const chunks = (label: string) => [{ fingerprint: label, tree: { type: "root" as const, children: [] } }];

it("returns a finished parse for the exact same text and nothing for other text", () => {
  const value = chunks("a");
  rememberMarkdown("**cached** text", value);
  expect(cachedMarkdown("**cached** text")).toBe(value);
  expect(cachedMarkdown("**cached** text!")).toBeUndefined();
});

it("ignores empty parses and oversized texts, and evicts least recently used entries by size", () => {
  rememberMarkdown("empty", []);
  expect(cachedMarkdown("empty")).toBeUndefined();
  const huge = "x".repeat(100_001);
  rememberMarkdown(huge, chunks("huge"));
  expect(cachedMarkdown(huge)).toBeUndefined();
  const keep = "k".repeat(90_000), evict = "e".repeat(90_000);
  rememberMarkdown(evict, chunks("evict")); rememberMarkdown(keep, chunks("keep"));
  expect(cachedMarkdown(evict)).toBeDefined(); // touching makes it recent again
  for (let i = 0; i < 9; i++) rememberMarkdown(`${i}`.repeat(90_000), chunks(`fill-${i}`));
  // 800k character budget: the oldest untouched entries go first.
  expect(cachedMarkdown(keep)).toBeUndefined();
  expect(cachedMarkdown("8".repeat(90_000))).toBeDefined();
});

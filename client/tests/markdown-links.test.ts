import { expect, it } from "vitest";
import type { Nodes } from "hast";
import { parseMarkdownChunks } from "../src/markdown-parser.js";

async function render(source: string) {
  const links: { href: unknown; text: string }[] = [];
  const text = (node: Nodes): string => node.type === "text" ? node.value : "children" in node ? node.children.map(text).join("") : "";
  function walk(node: Nodes) {
    if (node.type === "element" && node.tagName === "a") links.push({ href: node.properties.href, text: text(node) });
    if ("children" in node) node.children.forEach(walk);
  }
  const roots: Nodes[] = (await parseMarkdownChunks(source)).map(chunk => JSON.parse(chunk));
  roots.forEach(walk);
  return { links, text: roots.map(text).join("") };
}

it("keeps the authorization instructions after a Chinese comma outside the link", async () => {
  const source = "请再打开 https://github.com/login/device，输入新代码 `DEMO-CODE` 并完成授权。";
  const result = await render(source);
  expect(result.links).toEqual([{ href: "https://github.com/login/device", text: "https://github.com/login/device" }]);
  expect(result.text).toBe(source.replaceAll("`", ""));
});

it.each([..."，。；：！？、（）【】《》「」『』“”‘’"])("ends bare links at %s without losing the following prose", async mark => {
  const source = `打开 https://example.test/path${mark}继续操作`;
  expect(await render(source)).toEqual({ links: [{ href: "https://example.test/path", text: "https://example.test/path" }], text: source });
});

it.each([
  ["www.example.test/path，继续", "http://www.example.test/path", "www.example.test/path"],
  ["https://example.test/文档?q=中文#标题，继续", "https://example.test/%E6%96%87%E6%A1%A3?q=%E4%B8%AD%E6%96%87#%E6%A0%87%E9%A2%98", "https://example.test/文档?q=中文#标题"],
  ["https://例子.test/中文，继续", "https://%E4%BE%8B%E5%AD%90.test/%E4%B8%AD%E6%96%87", "https://例子.test/中文"],
  ["https://example.test/a%EF%BC%8Cb，继续", "https://example.test/a%EF%BC%8Cb", "https://example.test/a%EF%BC%8Cb"],
  ["https://example.test/a_(b)?x=1&y=2#part，继续", "https://example.test/a_(b)?x=1&y=2#part", "https://example.test/a_(b)?x=1&y=2#part"],
])("preserves the URL parts in %s", async (source, href, text) => {
  expect(await render(source)).toEqual({ links: [{ href, text }], text: source });
});

it.each([
  "[https://example.test/a，b](https://example.test/a，b)",
  "<https://example.test/a，b>",
  "[https://example.test/a，b][source]\n\n[source]: https://example.test/a，b",
])("preserves explicitly delimited URLs in %s", async source => {
  expect((await render(source)).links).toEqual([{ href: "https://example.test/a%EF%BC%8Cb", text: "https://example.test/a，b" }]);
});

it("keeps code literal and existing English links and email addresses intact", async () => {
  expect((await render("`https://example.test/a，原样`\n\n```text\nhttps://example.test/b，原样\n```" )).links).toEqual([]);
  expect((await render("Visit https://example.test/path, then contact support@example.test." )).links).toEqual([
    { href: "https://example.test/path", text: "https://example.test/path" },
    { href: "mailto:support@example.test", text: "support@example.test" },
  ]);
});

it.each([
  ["https://example.test/path.，继续", "https://example.test/path"],
  ["https://example.test/path)，继续", "https://example.test/path"],
  ["https://example.test/a_(b))，继续", "https://example.test/a_(b)"],
  ["https://example.test/path…继续", "https://example.test/path"],
  ["https://example.test/path——继续", "https://example.test/path"],
  ["https://example.test/path～继续", "https://example.test/path"],
])("reapplies GFM endpoint punctuation after splitting %s", async (source, url) => {
  expect(await render(source)).toEqual({ links: [{ href: url, text: url }], text: source });
});

it("keeps each adjacent bare web link clickable without interpreting the detached prose", async () => {
  const source = "https://one.example.test/a，https://two.example.test/b)。www.three.example.test/c，javascript:alert(1)";
  expect(await render(source)).toEqual({ links: [
    { href: "https://one.example.test/a", text: "https://one.example.test/a" },
    { href: "https://two.example.test/b", text: "https://two.example.test/b" },
    { href: "http://www.three.example.test/c", text: "www.three.example.test/c" },
  ], text: source });
});

it("keeps disambiguated punctuation, literal markup and ordinary Unicode URL parts intact", async () => {
  const source = "https://example.test/文档—详情~more?q=x&n=2#part，继续";
  expect((await render(source)).links).toEqual([{ href: "https://example.test/%E6%96%87%E6%A1%A3%E2%80%94%E8%AF%A6%E6%83%85~more?q=x&n=2#part", text: "https://example.test/文档—详情~more?q=x&n=2#part" }]);
  for (const mark of ["…", "——", "～"]) {
    const url = "https://example.test/a" + mark + "b";
    expect((await render(`[${url}](${url})`)).links).toEqual([{ href: encodeURI(url), text: url }]);
    expect((await render(`<${url}>`)).links).toEqual([{ href: encodeURI(url), text: url }]);
    expect((await render(encodeURI(url) + "，继续")).links).toEqual([{ href: encodeURI(url), text: encodeURI(url) }]);
  }
  const literal = "https://example.test/a，**literal**";
  expect((await render(literal)).text).toBe(literal);
});

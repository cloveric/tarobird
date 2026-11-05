import type { Link, Nodes, Root, Text } from "mdast";
import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const proseBoundary = /——|[，。；：！？、（）【】《》「」『』“”‘’…～]/u;
const separators = new RegExp(`(${proseBoundary.source})`, "gu");
const webPrefix = /(?:https?:\/\/|www\.)/i;
const literalParser = unified().use(remarkParse).use(remarkGfm);

function literalWebLink(node: Nodes): node is Link & { children: [Text] } {
  if (node.type !== "link" || node.children.length !== 1 || node.children[0]!.type !== "text") return false;
  const label = node.children[0]!;
  // [label](url) and <url> begin before their label. GFM's fallback text
  // transform can create positionless literal links.
  return (!node.position || node.position.start.offset === label.position?.start.offset)
    && /^(?:https?:\/\/|www\.)/i.test(label.value)
    && (node.url === label.value || node.url === `http://${label.value}`);
}

/** Reuse GFM's URL matching and endpoint punctuation rules for each separated
 * segment. Only copy literal web links; never reinterpret detached prose as
 * Markdown/HTML, decode entities, or introduce other link protocols. */
function splitLiteral(value: string): (Link | Text)[] {
  const result: (Link | Text)[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = result.at(-1);
    if (last?.type === "text") last.value += value;
    else result.push({ type: "text", value });
  };
  for (const segment of value.split(separators)) {
    if (!webPrefix.test(segment)) { text(segment); continue; }
    let offset = 0;
    for (const block of literalParser.parse(segment).children) {
      if (block.type !== "paragraph") continue;
      for (const node of block.children) {
        if (!literalWebLink(node)) continue;
        const start = node.position?.start.offset, end = node.position?.end.offset;
        // Preserve the original characters, including text represented as
        // escapes/entities by a second parse. Ambiguous matches stay text.
        if (start === undefined || end === undefined || start < offset || segment.slice(start, end) !== node.children[0].value) continue;
        text(segment.slice(offset, start));
        result.push({ type: "link", url: node.url, children: [{ type: "text", value: node.children[0].value }] });
        offset = end;
      }
    }
    text(segment.slice(offset));
  }
  return result;
}

/** GFM treats CJK punctuation and the following sentence as part of a bare
 * URL. Split only literal web links, before rehype percent-encodes the URL.
 * Keep Unicode URL letters, encoded punctuation and explicit Markdown targets.
 * No source rewrite: stored messages, code and copyable prose stay unchanged. */
export const remarkLinkBoundaries: Plugin<[], Root> = function () {
  return tree => {
    function walk(parent: Nodes): void {
      if (!("children" in parent) || parent.type === "link" || parent.type === "linkReference") return;
      for (let i = 0; i < parent.children.length; i++) {
        const node = parent.children[i]!;
        if (literalWebLink(node) && node.children[0].value.search(proseBoundary) > 0) {
          const replacement = splitLiteral(node.children[0].value);
          parent.children.splice(i, 1, ...replacement);
          i += replacement.length - 1;
        } else walk(node);
      }
    }
    walk(tree);
  };
};

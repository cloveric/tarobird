import type { Nodes, Root } from "mdast";
import type { Plugin } from "unified";

const proseBoundary = /[，。；：！？、（）【】《》「」『』“”‘’]/u;

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
        if (node.type === "link" && node.children.length === 1 && node.children[0]!.type === "text") {
          const label = node.children[0]!;
          // Literal links start at the label. [label](url) and <url> start
          // before it. GFM's fallback text transform creates positionless links.
          const literal = !node.position || node.position.start.offset === label.position?.start.offset;
          const prefix = node.url === label.value ? "" : node.url === `http://${label.value}` ? "http://" : undefined;
          const boundary = label.value.search(proseBoundary);
          if (literal && prefix !== undefined && /^(?:https?:\/\/|www\.)/i.test(label.value) && boundary > 0) {
            const suffix = label.value.slice(boundary);
            label.value = label.value.slice(0, boundary);
            node.url = prefix + label.value;
            parent.children.splice(++i, 0, { type: "text", value: suffix });
          }
        }
        walk(node);
      }
    }
    walk(tree);
  };
};

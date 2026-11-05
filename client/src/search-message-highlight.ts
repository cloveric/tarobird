import { useEffect, useRef, type RefObject } from "react";
import { searchTextParts } from "./search-highlight.js";

const name = "conversation-search-match";

function textRanges(target: Element, query: string): Range[] {
  // Syntax highlighting and inline Markdown split visible words across text
  // nodes. Join consecutive nodes within a prose block, never across paragraphs.
  const groups: { block: Element; nodes: Text[] }[] = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest('label, select, textarea, input, svg, script, style, [hidden], [aria-hidden="true"], .message-reference, .bot-reply-source') || !target.matches(".background-task-name") && parent.closest("button")) continue;
    const block = parent.closest("p, li, pre, td, th, h1, h2, h3, h4, h5, h6") ?? parent.closest("div, section") ?? target;
    if (groups.at(-1)?.block !== block) groups.push({ block, nodes: [] });
    groups.at(-1)!.nodes.push(node as Text);
  }
  const ranges: Range[] = [];
  for (const { nodes } of groups) {
    let offset = 0, index = 0, nodeOffset = 0;
    for (const part of searchTextParts(nodes.map(node => node.data).join(""), query)) {
      if (part.match) {
        while (index < nodes.length - 1 && nodeOffset + nodes[index]!.length <= offset) nodeOffset += nodes[index++]!.length;
        const range = document.createRange(); range.setStart(nodes[index]!, offset - nodeOffset);
        const end = offset + part.text.length;
        while (index < nodes.length - 1 && nodeOffset + nodes[index]!.length < end) nodeOffset += nodes[index++]!.length;
        range.setEnd(nodes[index]!, end - nodeOffset); ranges.push(range);
      }
      offset += part.text.length;
    }
  }
  return ranges;
}

/** Paint only the located message. No DOM replacement, selection change or
 * copied-text mutation; each pane removes only the ranges it owns. */
export function useSearchMessageHighlight(root: RefObject<HTMLElement | null>, messageId: string | undefined, query: string | undefined, locate: (range: Range) => void) {
  const locateLatest = useRef(locate); locateLatest.current = locate;
  useEffect(() => {
    const node = root.current;
    if (!node || !messageId || !query || !globalThis.CSS?.highlights || typeof Highlight === "undefined") return;
    const registry = CSS.highlights;
    const highlight = registry.get(name) ?? new Highlight();
    registry.set(name, highlight);
    let ranges: Range[] = [], frame = 0, revealFrame = 0, revealed = false;
    const clear = () => { for (const range of ranges) highlight.delete(range); ranges = []; };
    const paint = () => {
      frame = 0; clear();
      const id = CSS.escape(messageId);
      const target = node.querySelector(`[data-message-id="${id}"] .message-blocks, [data-background-message-id="${id}"] .background-task-name`);
      if (!target) return;
      ranges = textRanges(target, query);
      for (const range of ranges) highlight.add(range);
      if (ranges.length && !revealed && !revealFrame) {
        // Let virtual row measurement/positioning commit before refining the
        // location to the actual word (a long reply may be taller than a pane).
        revealFrame = requestAnimationFrame(() => {
          revealFrame = requestAnimationFrame(() => {
            revealFrame = 0;
            const first = ranges[0];
            if (first?.getClientRects().length) { revealed = true; locateLatest.current(first); }
          });
        });
      }
    };
    // Virtual rows and asynchronous Markdown can mount after the location
    // request. Observe only this pane, and coalesce mutations into one paint.
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(paint); });
    observer.observe(node, { childList: true, subtree: true, characterData: true });
    paint();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(revealFrame); clear();
      // Keep the single empty registry entry: another pane may own this same
      // Highlight while its target is temporarily outside the virtual window.
    };
  }, [root, messageId, query]);
}

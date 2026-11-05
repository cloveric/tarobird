import { unified } from "unified";
import rehypeHighlight from "rehype-highlight";
import type { Root } from "hast";

const processor = unified().use(rehypeHighlight);
export function highlightCode(tree: Root): Root { return processor.runSync(tree) as Root; }

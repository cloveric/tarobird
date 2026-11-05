import { unified } from "unified";
import rehypeKatex from "rehype-katex";
import type { Root } from "hast";

const processor = unified().use(rehypeKatex, { trust: false });
export function renderMath(tree: Root): Root { return processor.runSync(tree) as Root; }

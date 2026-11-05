/** A clipboard-only projection. Never insert marker text into the live message
 * DOM or change the selection; streaming, double-click and native editing keep
 * their existing owners. Ordinary/partial selections keep native copying. */
export type MessageSelectionCopy = { text: string; html?: string };
const excluded = "button,[role=button],summary,input,textarea,select,[contenteditable]:not([contenteditable=false]),svg,script,style,.message-avatar,.message-meta,.native-run-heading,.native-run-actions,.usage-footer,.run-status,.markdown-table-tools,.code-language,.code-copy-status";
const blocks = new Set(["P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "UL", "OL", "LI"]);
const allowed = new Set(["p", "div", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del", "sup", "sub", "a", "span", "table", "thead", "tbody", "tr", "td", "th", "br", "hr"]);
type Part = { text: string; node: Node; block: boolean; list?: boolean };

function ordinal(li: HTMLLIElement, cache: Map<Element, Map<Element, number>>): number {
  const list = li.parentElement as HTMLOListElement;
  const existing = cache.get(list); if (existing) return existing.get(li)!;
  const items = [...list.children].filter(el => el.tagName === "LI") as HTMLLIElement[];
  const values = new Map<Element, number>(); cache.set(list, values);
  let value = list.hasAttribute("start") ? list.start : list.reversed ? items.length : 1;
  for (const item of items) {
    if (item.hasAttribute("value")) value = item.value;
    values.set(item, value);
    value += list.reversed ? -1 : 1;
  }
  return values.get(li)!;
}

export function messageSelectionCopy(selection: Selection | null): MessageSelectionCopy | undefined {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0), document = range.startContainer.ownerDocument!;
  const ancestor = range.commonAncestorContainer;
  const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
  // This includes cross-message ranges in one viewport, but never readers in
  // portals, settings, an editor, or selection spanning unrelated App panes.
  const root = element?.closest(".message-blocks,.message-scroll");
  if (!root) return;
  const visibleCache = new Map<Element, boolean>();
  const visible = (el: Element): boolean => {
    const cached = visibleCache.get(el); if (cached !== undefined) return cached;
    const style = document.defaultView!.getComputedStyle(el);
    const result = !el.matches(excluded) && style.display !== "none" && style.visibility !== "hidden"
      && style.userSelect !== "none" && style.webkitUserSelect !== "none"
      && (!el.parentElement || el === root || visible(el.parentElement));
    visibleCache.set(el, result); return result;
  };
  const selectedText = (node: Text): string => {
    if (!range.intersectsNode(node)) return "";
    return node.data.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : node.length);
  };
  const full = new Set<Element>();
  for (const li of root.querySelectorAll(".markdown li")) {
    if (!range.intersectsNode(li) || !visible(li)) continue;
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    let found = false, complete = true;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.parentElement?.closest("li") !== li || !visible(node.parentElement!) || !node.data.trim()) continue;
      found = true;
      const start = node.data.search(/\S/), end = node.data.trimEnd().length;
      if (range.comparePoint(node, start) !== 0 || range.comparePoint(node, end) !== 0) { complete = false; break; }
    }
    if (found && complete) full.add(li);
  }
  if (!full.size) return;
  // KaTeX has parallel visual/accessibility trees. Copy its author-provided
  // notation once, not both trees. Partial formula selections stay native.
  const formulas = new Map<Element, string>();
  for (const math of root.querySelectorAll(".katex")) {
    if (!range.intersectsNode(math)) continue;
    const source = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!source || range.comparePoint(math, 0) !== 0 || range.comparePoint(math, math.childNodes.length) !== 0) return;
    formulas.set(math, source);
  }
  // A long selected list should scan its counters once, not once per item.
  const ordinals = new Map<Element, Map<Element, number>>();

  const join = (parts: Part[]) => parts.reduce((text, part, index) => {
    const previous = parts[index - 1];
    const gap = previous && (previous.block || part.block) ? previous.list || part.list ? "\n" : "\n\n" : "";
    return text + gap + part.text;
  }, "");
  const render = (node: Node): Part | undefined => {
    if (!range.intersectsNode(node)) return;
    if (node instanceof Text) {
      if (!node.parentElement || !visible(node.parentElement)) return;
      const text = selectedText(node);
      // Parser indentation between blocks is not an authored paragraph/space.
      if (!text || !text.trim() && [...node.parentElement.children].some(el => blocks.has(el.tagName))) return;
      return { text, node: document.createTextNode(text), block: false };
    }
    if (!(node instanceof Element) || !visible(node)) return;
    const formula = formulas.get(node);
    if (formula !== undefined) return { text: formula, node: document.createTextNode(formula), block: false };
    if (node.tagName === "BR") return { text: "\n", node: document.createElement("br"), block: false };
    const parts = [...node.childNodes].flatMap(child => { const part = render(child); return part ? [part] : []; });
    if (!parts.length) return;
    if (node.tagName === "OL" || node.tagName === "UL") {
      const container = document.createElement("div");
      let list: HTMLElement | undefined;
      for (const part of parts) {
        if (part.node instanceof Element && part.node.tagName === "LI") {
          if (!list) {
            list = document.createElement(node.tagName.toLowerCase());
            if (node.tagName === "OL") list.setAttribute("start", part.node.getAttribute("value")!);
            if (node.hasAttribute("reversed")) list.setAttribute("reversed", "");
            container.append(list);
          }
          list.append(part.node);
        } else { list = undefined; container.append(part.node); }
      }
      return { text: parts.map(part => part.text).join("\n"), node: container, block: true, list: true };
    }
    let text = join(parts);
    const tag = node.tagName.toLowerCase();
    const copy = document.createElement(tag === "li" ? full.has(node) ? "li" : "div" : allowed.has(tag) ? tag : "div");
    if (tag === "li" && full.has(node)) {
      const ordered = node.parentElement?.tagName === "OL", value = ordered ? ordinal(node as HTMLLIElement, ordinals) : undefined;
      if (value !== undefined) copy.setAttribute("value", String(value));
      const checkbox = node.querySelector<HTMLInputElement>(":scope > input[type=checkbox]:disabled, :scope > p > input[type=checkbox]:disabled");
      const task = checkbox ? `[${checkbox.checked ? "x" : " "}] ` : "";
      const prefix = (ordered ? `${value}. ` : "• ") + task;
      if (task) copy.append(document.createTextNode(task));
      text = prefix + text.split("\n").join(`\n${" ".repeat(prefix.length)}`);
    }
    if (tag === "tr") text = parts.map(part => part.text).join("\t");
    if (["table", "tbody", "thead", "tfoot"].includes(tag)) text = parts.map(part => part.text).join("\n");
    // Copy semantic markup only, never App IDs, event handlers, remote images
    // or layout/control styles. The rendered link policy is retained.
    if (tag === "a") { const href = node.getAttribute("href"); if (href && /^(?:https?:\/\/|mailto:|ircs?:|xmpp:)/i.test(href)) copy.setAttribute("href", href); }
    if (["p", "pre", "code"].includes(tag)) copy.style.whiteSpace = "pre-wrap";
    copy.append(...parts.map(part => part.node));
    return { text, node: copy, block: blocks.has(node.tagName) || tag === "tr", list: tag === "li" };
  };
  const result = render(root); if (!result?.text) return;
  const holder = document.createElement("div"); holder.append(result.node);
  return { text: result.text, html: holder.innerHTML };
}

/** Native keyboard/edit-menu and phone selection Copy. No selectionchange or
 * key interception: only a supported list selection owns this copy event. */
export function installMessageSelectionCopy(): () => void {
  const copy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !event.clipboardData || event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])")) return;
    const value = messageSelectionCopy(document.getSelection());
    if (!value?.html) return;
    event.clipboardData.setData("text/plain", value.text);
    event.clipboardData.setData("text/html", value.html);
    event.preventDefault();
  };
  document.addEventListener("copy", copy);
  return () => document.removeEventListener("copy", copy);
}

export async function writeMessageSelection(text: string, html?: string): Promise<void> {
  if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
      return;
    } catch { /* Text-only platforms may still support the existing copy API. */ }
  }
  await navigator.clipboard.writeText(text);
}

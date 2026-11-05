import { expect, type Locator } from "@playwright/test";

// Worker output and ResizeObserver-driven virtual measurements commit in
// different frames. Capture a reading baseline only once both have settled.
export async function settleReadingLayout(scroller: Locator, parsed = true) {
  if (parsed) await expect(scroller.locator(".markdown-pending")).toHaveCount(0);
  await scroller.evaluate(async (node, requireParsed) => {
    let previous = "", stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const value = JSON.stringify([node.scrollTop, node.scrollHeight, ...[...node.querySelectorAll<HTMLElement>("[data-message-id]")].map(row => [row.dataset.messageId, row.getBoundingClientRect().top, row.getBoundingClientRect().height, row.style.transform])]);
      stable = value === previous && (!requireParsed || !node.querySelector(".markdown-pending")) ? stable + 1 : 0; previous = value;
      if (stable >= 4) return;
    }
    throw new Error("Reading layout did not settle");
  }, parsed);
}

export async function readingAnchor(scroller: Locator) {
  return scroller.evaluate(node => {
    const viewport = node.getBoundingClientRect();
    const rows = [...node.querySelectorAll<HTMLElement>("[data-message-id]")];
    const row = rows.find(item => item.getBoundingClientRect().top >= viewport.top && item.getBoundingClientRect().top < viewport.bottom);
    if (!row) throw new Error("No visible message anchor");
    return { id: row.dataset.messageId!, top: row.getBoundingClientRect().top - viewport.top, scrollTop: node.scrollTop };
  });
}

export async function anchorTop(scroller: Locator, id: string) {
  return scroller.evaluate((node, messageId) => {
    const row = [...node.querySelectorAll<HTMLElement>("[data-message-id]")].find(item => item.dataset.messageId === messageId);
    if (!row) throw new Error("Reading anchor was unmounted");
    return row.getBoundingClientRect().top - node.getBoundingClientRect().top;
  }, id);
}

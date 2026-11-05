import { expect, type Locator } from "@playwright/test";

/** Assert the rendered page, independent of its CSS/container implementation. */
export async function expectSettingsPage(page: Locator, width: number, height: number) {
  await expect.poll(() => page.evaluate(node => {
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), radius: getComputedStyle(node).borderTopLeftRadius };
  })).toEqual({ x: 0, y: 0, width, height, radius: "0px" });
  // Category slide transitions temporarily extend the scrollable bounds.
  await expect.poll(() => page.evaluate(node => {
    if (node.scrollWidth <= node.clientWidth + 1) return { overflow: 0, children: [] };
    const box = node.getBoundingClientRect();
    return { overflow: node.scrollWidth - node.clientWidth, children: [...node.querySelectorAll<HTMLElement>("*")].filter(child => child.getClientRects().length && child.getBoundingClientRect().right > box.right + 1).slice(0, 8).map(child => ({ tag: child.tagName, class: child.className, right: Math.round(child.getBoundingClientRect().right), width: child.clientWidth, scrollWidth: child.scrollWidth })) };
  })).toEqual({ overflow: 0, children: [] });
}

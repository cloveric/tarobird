import { expect, type Locator } from "@playwright/test";

/** Count painted disclosure indicators, not DOM buttons alone. An SVG plus a
 * CSS pseudo-element/native marker is visually duplicated despite one summary. */
export async function expectOneDisclosure(summary: Locator) {
  const count = await summary.evaluate(node => {
    const rendered = (content: string) => !["none", "normal", '""', "''"].includes(content);
    const style = getComputedStyle(node), marker = getComputedStyle(node, "::marker");
    const native = style.display.includes("list-item") && style.listStyleType !== "none"
      && !['""', "''", "none"].includes(marker.content);
    return node.querySelectorAll(":scope > .lucide-chevron-right,:scope > .lucide-chevron-down").length
      + Number(rendered(getComputedStyle(node, "::before").content))
      + Number(rendered(getComputedStyle(node, "::after").content)) + Number(native);
  });
  expect(count).toBe(1);
}

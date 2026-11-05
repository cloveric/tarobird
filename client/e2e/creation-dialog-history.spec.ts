import { expect, test } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

test("nested modal undo preserves parent and background drafts; close restores normal editing", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/dialog-history.html");
    const background = page.getByLabel("Background", { exact: true }), parent = page.getByLabel("Parent draft"), child = page.getByLabel("Child draft");
    await background.fill("keep background");
    await page.getByRole("button", { name: "Open parent", exact: true }).click();
    await parent.fill("keep parent");
    for (const init of [{ key: "Escape", isComposing: true }, { key: "Escape", keyCode: 229 }]) {
      expect(await parent.evaluate((node, init) => !node.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true })), init)).toBe(true);
      await expect(parent).toBeVisible();
    }
    await page.getByRole("button", { name: "Open child", exact: true }).click();
    await child.focus(); await child.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 5));
    await child.press("Enter"); await expect(child).toHaveValue("hello\n");
    await child.press("ControlOrMeta+z"); await expect(child).toHaveValue("hello");
    await expect(parent).toHaveValue("keep parent"); await expect(background).toHaveValue("keep background");
    await child.press("ControlOrMeta+Shift+z"); await expect(child).toHaveValue("hello\n");
    await expect(parent).toHaveValue("keep parent"); await expect(background).toHaveValue("keep background");
    await page.getByRole("button", { name: "Close child", exact: true }).click();
    await parent.fill("parent remains editable");
    await page.getByRole("button", { name: "Close parent", exact: true }).click();
    await background.fill("new draft"); await background.press("ControlOrMeta+z");
    await expect(background).toHaveValue("keep background");
  } finally { await page.close(); await server.close(); }
});

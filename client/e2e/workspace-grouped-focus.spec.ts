import { test, expect } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

test("a single grouped Workspace file paints a visible keyboard focus ring", async ({ page }) => {
  const folder = resolve("dist/assets");
  const css = (await readdir(folder)).filter(name => name.endsWith(".css"));
  await page.setContent('<main style="margin:30px;width:290px"><div class="workspace-list"><div class="workspace-file-grid"><button class="workspace-file-tile">Example.txt</button></div></div></main>');
  for (const file of css) await page.addStyleTag({ content: await readFile(resolve(folder, file), "utf8") });
  await page.addStyleTag({ content: "* { animation: none !important; transition: none !important; }" });
  const clip = { x: 15, y: 15, width: 330, height: 90 };
  await page.mouse.move(600, 450);
  const before = await page.screenshot({ clip });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Example.txt" })).toBeFocused();
  const after = await page.screenshot({ clip });
  const difference = await page.evaluate(async ([a, b]) => {
    const pixels = async (data: string) => {
      const image = new Image();
      image.src = "data:image/png;base64," + data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const [previous, current] = await Promise.all([pixels(a!), pixels(b!)]);
    let changed = 0;
    for (let i = 0; i < previous.length; i += 4) {
      if ([0, 1, 2].some(channel => Math.abs(previous[i + channel]! - current[i + channel]!) > 3)) changed++;
    }
    return changed;
  }, [before.toString("base64"), after.toString("base64")]);
  expect(difference).toBeGreaterThan(100);
});

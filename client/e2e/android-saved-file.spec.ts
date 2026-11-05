import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

// Actual renderer with a Capacitor bridge double. Native URI grants and the
// Android installer are checked separately by instrumentation.
test.use({ viewport: { width: 390, height: 844 } });
for (const name of ["update.apk", "notes.txt"]) test(`Android saved ${name} opens the existing copy without downloading again`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html?name=" + name);
    const save = page.getByRole("button", { name: `保存到手机 ${name}`, exact: true });
    const open = page.getByRole("button", { name: name.endsWith(".apk") ? "安装 APK" : "打开文件", exact: true });
    await expect(open).toHaveCount(0);
    await save.click(); await expect(open).toBeVisible();
    if (name.endsWith(".apk")) await page.screenshot({ path: test.info().outputPath("apk-saved.png") });
    await expect(page.getByRole("button", { name: "打开文件位置", exact: true })).toHaveCount(0);
    await page.evaluate(() => { (window as any).savedFixture.fail = "attachment_install_permission_required"; });
    await open.click(); await expect(page.getByRole("alert")).toContainText("允许 TaroBird 安装未知应用");
    await expect(page.getByRole("status")).toHaveText("已保存到手机");
    await page.evaluate(() => { (window as any).savedFixture.fail = ""; });
    await open.click(); await expect(page.getByRole("button", { name: "正在打开…", exact: true })).toBeDisabled();
    await expect(save).toBeDisabled(); await save.dispatchEvent("click"); // Serialized with the open operation.
    await page.evaluate(() => (window as any).savedFixture.release());
    await expect(open).toBeEnabled();
    expect(await page.evaluate(() => { const s = (window as any).savedFixture; return { downloads: s.downloads, saves: s.saves, opened: s.opened }; })).toEqual({ downloads: 1, saves: 1, opened: ["content://media/external/downloads/123", "content://media/external/downloads/123"] });
    await page.evaluate(() => { (window as any).savedFixture.cancel = true; });
    await save.click(); await expect(page.getByRole("status")).toHaveText("已取消保存"); await expect(open).toBeVisible();
    await page.evaluate(() => { const s = (window as any).savedFixture; s.cancel = false; s.legacy = true; });
    await save.click(); await expect(page.getByRole("status")).toContainText("已保存到手机"); await expect(open).toBeVisible();
  } finally { await page.close(); await server.close(); }
});

for (const name of ["update.apk", "notes.txt"]) test(`Android saved ${name} survives remount/reload and remains isolated to its host and device`, async ({ page }, info) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html?name=" + name);
    const open = page.getByRole("button", { name: name.endsWith(".apk") ? "安装 APK" : "打开文件", exact: true });
    await page.getByRole("button", { name: `保存到手机 ${name}`, exact: true }).click();
    await expect(open).toBeVisible();
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.locator(".file-status").evaluate(node => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${width}-saved.png`) });
    }
    await page.evaluate(() => (window as any).savedFixture.hide()); await expect(open).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.show()); await expect(open).toBeVisible();
    await page.reload(); await expect(open).toBeVisible();
    await open.click(); await expect(page.getByRole("button", { name: "正在打开…", exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.release()); await expect(open).toBeEnabled();
    expect(await page.evaluate(() => { const s = (window as any).savedFixture; return [s.downloads, s.saves, s.opened]; })).toEqual([1, 1, ["content://media/external/downloads/123"]]);
    await page.evaluate(() => (window as any).savedFixture.host("host-b")); await expect(open).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.host("host-a")); await expect(open).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.device("device-b")); await expect(open).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.device("device-a")); await expect(open).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.removeLocal()); await expect(open).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).savedFixture.downloads)).toBe(1);
  } finally { await page.close(); await server.close(); }
});

test("a delayed old receipt check cannot clear a newly saved Android copy", async ({ page }) => {
  const server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/android-saved-file.html");
    await expect(page.locator(".file-card")).toBeVisible();
    await page.evaluate(() => { const s = (window as any).savedFixture; s.delayRestore = true; s.hide(); });
    await expect(page.locator(".file-card")).toHaveCount(0);
    await page.evaluate(() => (window as any).savedFixture.show());
    await page.waitForFunction(() => !!(window as any).savedFixture.releaseRestore);
    await page.getByRole("button", { name: "保存到手机 update.apk", exact: true }).click();
    const open = page.getByRole("button", { name: "安装 APK", exact: true }); await expect(open).toBeVisible();
    await page.evaluate(() => (window as any).savedFixture.releaseRestore());
    await expect(open).toBeVisible(); await open.click();
    await expect.poll(() => page.evaluate(() => (window as any).savedFixture.opened)).toEqual(["content://media/external/downloads/123"]);
  } finally { await page.close(); await server.close(); }
});

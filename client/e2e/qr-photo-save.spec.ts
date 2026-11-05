import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { desktopTls } from "../../src/hub/desktop-tls.js";
import type { HostSpec } from "./fixtures/device-invite.js";
import { createServer } from "./fixtures/vite.js";

// The QR save is bound to one live invitation. A mocked native Photos plugin
// records each write; nothing reaches a real photo library or host.
type Photos = { mode(mode: "grant" | "deny" | "fail" | "hold"): void; calls(): { data: string; name: string }[]; release(): void };
declare global { interface Window { inviteFixture: { configure(ca: string): void; add(label: string, spec: HostSpec): void; show(label: string, localHost?: boolean): void; photos: Photos } } }

const key = `MCowBQYDK2VwAyEA${"a".repeat(44)}`, lan = "https://192.168.10.20:8788";
let server: ViteDevServer, directory: string, ca: string;
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "qr-photo-save-"));
  ({ certificateAuthority: ca } = await desktopTls(directory, ["192.168.10.20"]));
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen();
});
test.afterAll(async () => { await server?.close(); await rm(directory, { recursive: true, force: true }); });

async function open(page: Page, platform?: "ios" | "android", clock = false) {
  if (clock) await page.clock.install();
  await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/device-invite.html${platform ? `?platform=${platform}` : ""}`);
  await page.waitForFunction(() => !!window.inviteFixture);
  await page.evaluate(value => window.inviteFixture.configure(value), ca);
  await page.evaluate(([value, url]) => { window.inviteFixture.add("A", { key: value, view: { routes: [{ source: "managed", route: { name: "Direct", url } }] } }); window.inviteFixture.show("A"); }, [key, lan] as const);
  await expect(qr(page)).toBeVisible();
}
const qr = (page: Page) => page.getByRole("img", { name: "连接二维码", exact: true });
const menu = (page: Page) => page.getByRole("menu", { name: "二维码操作", exact: true });
const calls = (page: Page) => page.evaluate(() => window.inviteFixture.photos.calls());
/** A touch press on the QR; optionally moves or scrolls before the hold time. */
async function press(page: Page, { move = 0, scroll = 0, hold = 650 } = {}) {
  await page.evaluate(([dx, dy]) => {
    const image = document.querySelector<HTMLImageElement>(".pair-qr")!, rect = image.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, bubbles: true };
    image.dispatchEvent(new PointerEvent("pointerdown", at));
    if (dx) image.dispatchEvent(new PointerEvent("pointermove", { ...at, clientX: at.clientX + dx }));
    if (dy) window.scrollBy(0, dy);
  }, [move, scroll] as const);
  await page.waitForTimeout(hold);
  await page.evaluate(() => document.querySelector(".pair-qr")?.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true })));
}

test("long press opens the QR menu and saves exactly the shown invitation to Photos once", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page, "android");
  await expect(page.getByRole("button", { name: "保存到相册", exact: true })).toBeVisible();
  // WebKit honors this; it keeps the system image callout from bypassing the bound save.
  expect(await qr(page).evaluate(image => getComputedStyle(image).userSelect)).toBe("none");
  await press(page);
  await expect(menu(page)).toBeVisible();
  // The menu opens at the finger and stays inside a 320px screen.
  const box = (await menu(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
  await menu(page).getByRole("menuitem", { name: "保存到相册", exact: true }).click();
  await expect(page.getByText("已保存到相册", { exact: true })).toBeVisible();
  const [saved, ...rest] = await calls(page);
  expect(rest).toEqual([]);
  expect(saved!.name).toMatch(/^TaroBird-QR-\d{8}-\d{6}\.png$/);
  expect(`data:image/png;base64,${saved!.data}`).toBe(await qr(page).getAttribute("src"));
});

test("movement or scrolling during the press never opens the menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await open(page, "ios");
  await press(page, { move: 24 });
  await expect(menu(page)).toHaveCount(0);
  await press(page, { scroll: 60 });
  await expect(menu(page)).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
});

test("denied Photos access and native failure are reported without success", async ({ page }) => {
  await open(page, "ios");
  await page.evaluate(() => window.inviteFixture.photos.mode("deny"));
  await page.getByRole("button", { name: "保存到相册", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("未获得添加照片的权限");
  await page.evaluate(() => window.inviteFixture.photos.mode("fail"));
  await page.getByRole("button", { name: "保存到相册", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("二维码没有保存，请重试。");
  await expect(page.getByText("已保存到相册", { exact: true })).toHaveCount(0);
});

test("a second trigger during a write is ignored, and a regenerated QR never inherits the old receipt", async ({ page }) => {
  await open(page, "android");
  await page.evaluate(() => window.inviteFixture.photos.mode("hold"));
  const save = page.getByRole("button", { name: "保存到相册", exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await press(page);
  await expect(menu(page).getByRole("menuitem", { name: "保存到相册", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect(await calls(page)).toHaveLength(1);
  const old = await qr(page).getAttribute("src");
  await page.getByRole("button", { name: "重新生成二维码", exact: true }).click();
  await expect.poll(async () => qr(page).getAttribute("src")).not.toBe(old);
  await page.evaluate(() => window.inviteFixture.photos.release());
  await page.waitForTimeout(200);
  await expect(page.getByText("已保存到相册", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存到相册", exact: true })).toBeEnabled();
  expect(await calls(page)).toHaveLength(1);
});

test("an expired QR offers no save action", async ({ page }) => {
  await open(page, "android", true);
  await expect(page.getByRole("button", { name: "保存到相册", exact: true })).toBeVisible();
  await page.clock.fastForward(300_001);
  await expect(qr(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("二维码已过期或失效，请重新生成。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存到相册", exact: true })).toHaveCount(0);
  expect(await calls(page)).toEqual([]);
});

test("desktop offers the file saver by right click and a visible action, never the album wording", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "保存二维码图片", exact: true })).toBeVisible();
  await qr(page).click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "保存二维码图片", exact: true })).toBeVisible();
  await expect(page.getByText("保存到相册")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

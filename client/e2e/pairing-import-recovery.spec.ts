import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import en from "../src/locales/en.json" with { type: "json" };
import { pairingLink } from "../src/pairing-link.js";

let server: Awaited<ReturnType<typeof createServer>>, base: string;
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  base = server.resolvedUrls!.local[0] + "e2e/fixtures/pairing-design.html";
});
test.afterAll(async () => { await server?.close(); });
for (const os of ["ios", "android"]) for (const width of [320, 390]) for (const locale of ["zh", "en"]) test(`imported connection presents the next step on ${os} ${width} ${locale}`, async ({ page }, info) => {
  const label = (key: keyof typeof en) => locale === "en" ? en[key] : key;
  const admissions: string[] = [];
  page.on("request", request => { if (/\/(?:health|api\/pair)$/.test(new URL(request.url()).pathname)) admissions.push(request.url()); });
  await page.setViewportSize({ width, height: 720 });
  await page.goto(`${base}?view=phone&os=${os}&lang=${locale}`);
  await page.getByRole("button", { name: label("粘贴连接信息"), exact: true }).click();
  await page.getByLabel(label("配对信息"), { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: "k".repeat(44), routes: [{ name: "Direct", url: "https://192.168.1.100:8788" }], invite: "a".repeat(43) }));
  await page.getByRole("button", { name: label("使用配对信息"), exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: label("配对此设备"), exact: true })).toBeInViewport();
  await expect(page.getByText(label("已读取主机信息"), { exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: label("配对此设备"), exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath("imported.png") });
  await page.getByLabel(label("设备名称"), { exact: true }).fill("My phone");
  const change = page.getByRole("button", { name: label("更换连接信息"), exact: true });
  await change.click();
  await page.getByLabel(label("配对信息"), { exact: true }).fill("not a pairing code");
  await page.getByRole("button", { name: label("使用配对信息"), exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: label("关闭"), exact: true }).click();
  await expect(change).toBeFocused();
  await expect(page.getByLabel(label("设备名称"), { exact: true })).toHaveValue("My phone");
  expect(admissions).toEqual([]);
});

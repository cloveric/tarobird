import { test, expect, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import { pairingLink } from "../src/pairing-link.js";
import en from "../src/locales/en.json" with { type: "json" };

let server: Awaited<ReturnType<typeof createServer>>, base: string;
test.use({ hasTouch: true });
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  base = server.resolvedUrls!.local[0] + "e2e/fixtures/pairing-design.html";
});
test.afterAll(async () => { await server?.close(); });
const importedLink = (address = "https://192.168.1.100:8788") => pairingLink({ v: 1, kind: "connect", hubPublicKey: "k".repeat(44), routes: [{ name: "Direct", url: address }], invite: "a".repeat(43) });
const labelFor = (lang: string) => (key: keyof typeof en) => lang === "en" ? en[key] : key;
async function importConnection(page: Page, lang: string) {
  const label = labelFor(lang);
  await page.getByRole("button", { name: label("粘贴连接信息"), exact: true }).click();
  await page.getByLabel(label("配对信息"), { exact: true }).fill(importedLink());
  await page.getByRole("button", { name: label("使用配对信息"), exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
const layouts = [
  { os: "ios", width: 320, height: 568 },
  { os: "ios", width: 390, height: 844 },
  { os: "ios", width: 673, height: 841 },
  { os: "ios", width: 820, height: 1180 },
  { os: "android", width: 360, height: 800 },
  { os: "android", width: 673, height: 841 },
];
for (const layout of layouts) for (const lang of ["zh", "en"]) test(`mobile import clearly offers the next step ${layout.os} ${layout.width} ${lang}`, async ({ page }, info) => {
  const label = labelFor(lang), admissions: string[] = [], errors: string[] = [];
  page.on("request", request => { if (/\/(?:health|api\/pair)$/.test(new URL(request.url()).pathname)) admissions.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize(layout);
  await page.goto(`${base}?view=phone&os=${layout.os}&lang=${lang}`);
  await importConnection(page, lang);
  const next = page.getByRole("button", { name: lang === "en" ? /Next/ : /下一步/ });
  await expect(next).toBeInViewport();
  await expect(next).toBeFocused();
  const nextBox = (await next.boundingBox())!;
  expect(nextBox.height).toBeGreaterThanOrEqual(44);
  expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(layout.height + 1);
  const changeBox = (await page.getByRole("button", { name: label("更换连接信息"), exact: true }).boundingBox())!;
  expect(changeBox.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByText(label("已读取主机信息"), { exact: true })).toBeInViewport();
  await expect(page.getByText("192.168.1.100", { exact: true })).toBeInViewport();
  expect((await page.getByText(label("已读取主机信息"), { exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await expect(page.getByText(label("尚未连接，请继续完成下方配对。"), { exact: true })).toBeInViewport();
  await expect(next).toHaveAccessibleDescription(label("之后会显示 8 位配对码，需在已连接的手机或电脑上确认，才会完成连接。"));
  // On common portrait phones, the concise English caveat and footer should
  // fit too; smaller screens may scroll while keeping the primary action clear.
  if (lang === "en" && layout.width <= 390 && layout.height >= 800) {
    const footer = (await page.locator(".pairing-card>footer").boundingBox())!;
    expect(footer.y + footer.height).toBeLessThanOrEqual(layout.height);
  }
  // Import is a review step, not a connection. Leave enrollment to the user.
  await expect(page.locator(".pairing-import-actions")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".pairing-card").getByRole("alert")).toHaveCount(0);
  expect(admissions).toEqual([]); expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath(`import-${layout.os}-${layout.width}-${lang}.png`) });
});

for (const os of ["ios", "android"]) test(`QR image, cancelled replacement and rejected pairing retain the review step on ${os}`, async ({ page }) => {
  const { default: QRCode } = await import("qrcode");
  const admissions: string[] = [];
  page.on("request", request => { if (/\/(?:health|api\/pair)$/.test(new URL(request.url()).pathname)) admissions.push(request.url()); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?view=phone&os=${os}&theme=dark`);
  await page.getByRole("button", { name: "导入二维码图片", exact: true }).click();
  await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "connection.png", mimeType: "image/png", buffer: await QRCode.toBuffer(importedLink()) });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const next = page.getByRole("button", { name: /下一步/ });
  await expect(next).toBeInViewport();
  await page.getByLabel("设备名称", { exact: true }).fill("我的手机");
  const change = page.getByRole("button", { name: "更换连接信息", exact: true });
  await change.click();
  await page.getByLabel("配对信息", { exact: true }).fill("not a pairing code");
  await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(change).toBeFocused();
  await expect(page.getByText("192.168.1.100", { exact: true })).toBeVisible();
  await expect(page.getByLabel("设备名称", { exact: true })).toHaveValue("我的手机");
  expect(admissions).toEqual([]);
  await change.click();
  await page.getByLabel("配对信息", { exact: true }).fill(importedLink("https://192.168.1.101:8788"));
  await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(next).toBeFocused();
  await expect(page.getByText("192.168.1.101", { exact: true })).toBeVisible();
  await expect(page.getByLabel("设备名称", { exact: true })).toHaveValue("我的手机");
  expect(admissions).toEqual([]);
  // The synthetic key is deliberately not an Ed25519 SPKI identity. The
  // native pairing guard rejects it before any probe or enrollment request.
  await page.setViewportSize({ width: 320, height: 568 });
  await next.click();
  const refusal = page.locator(".pairing-card").getByRole("alert");
  await expect(refusal).toHaveText("主机身份公钥格式不正确，请重新从主机或已信任设备复制。");
  await expect(refusal).toBeInViewport({ ratio: 1 });
  await expect(next).toBeFocused();
  // A second identical synchronous rejection must reveal the error again,
  // even if the user scrolled back up after the first attempt.
  await next.evaluate(element => {
    const scroller = element.closest(".pairing-page")!;
    scroller.scrollTop += element.getBoundingClientRect().bottom - (innerHeight - 16);
  });
  await expect(refusal).not.toBeInViewport({ ratio: 1 });
  await next.click();
  await expect(refusal).toBeInViewport({ ratio: 1 });
  await expect(next).toBeFocused();
  await expect(next).toBeEnabled();
  await expect(page.getByText("已读取主机信息", { exact: true })).toBeVisible();
  await expect(page.getByLabel("配对码", { exact: true })).toHaveCount(0);
  expect(admissions).toEqual([]);
});

for (const os of ["ios", "android"]) test(`imported step preserves the device name through rotation and enlarged English text on ${os}`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?view=phone&os=${os}&lang=en&theme=dark`);
  await importConnection(page, "en");
  const name = page.getByLabel("Device name", { exact: true }), next = page.getByRole("button", { name: /Next/ });
  await name.fill("My travel phone");
  for (const viewport of [{ width: 844, height: 390 }, { width: 673, height: 841 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await expect(name).toHaveValue("My travel phone");
    await next.scrollIntoViewIfNeeded(); await expect(next).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => {
    const sizes = [...document.querySelectorAll<HTMLElement>(".pairing-card *")].map(node => ({ node, font: parseFloat(getComputedStyle(node).fontSize), line: parseFloat(getComputedStyle(node).lineHeight) }));
    for (const { node, font, line } of sizes) { node.style.fontSize = `${font * 2}px`; if (Number.isFinite(line)) node.style.lineHeight = `${line * 2}px`; }
  });
  await next.scrollIntoViewIfNeeded(); await expect(next).toBeInViewport();
  expect(await next.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(name).toHaveValue("My travel phone");
});

for (const os of ["ios", "android"]) test(`editing an imported address keeps the review page mounted on ${os}`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?view=phone&os=${os}`);
  await importConnection(page, "zh");
  await page.getByText("手动连接与高级选项", { exact: true }).click();
  const address = page.getByLabel("Hub 地址", { exact: true });
  await address.fill("https://");
  await expect(page.getByText("已读取主机信息", { exact: true })).toBeVisible();
  await expect(address).toHaveValue("https://");
  await address.fill("https://192.168.1.102:8788");
  await expect(page.getByText("192.168.1.102", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

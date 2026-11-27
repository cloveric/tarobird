import { test, expect, type Browser, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import en from "../src/locales/en.json" with { type: "json" };
// Landscape phone viewer: real RemoteScreenPanel over the native plugin double
// (fixtures/screen-mobile.tsx) with the App's theme stack. Synthetic pixels only.
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });

type Insets = { top: number; right: number; bottom: number; left: number };
type Phone = { name: string; width: number; height: number; platform: "ios" | "android"; insets: Insets; english?: boolean };
const none: Insets = { top: 0, right: 0, bottom: 0, left: 0 }, iphone: Insets = { top: 0, right: 59, bottom: 21, left: 59 };
// iOS reports both side insets in landscape; the one-sided cases prove each side is honoured on its own.
const phones: Phone[] = [
  { name: "905x382 android", width: 905, height: 382, platform: "android", insets: none },
  { name: "852x393 ios", width: 852, height: 393, platform: "ios", insets: iphone },
  { name: "852x393 ios notch left", width: 852, height: 393, platform: "ios", insets: { ...iphone, right: 0 } },
  { name: "852x393 ios notch right", width: 852, height: 393, platform: "ios", insets: { ...iphone, left: 0 } },
  { name: "740x360 android", width: 740, height: 360, platform: "android", insets: none },
  { name: "667x375 ios", width: 667, height: 375, platform: "ios", insets: none },
  { name: "667x375 ios en", width: 667, height: 375, platform: "ios", insets: none, english: true },
  { name: "932x430 ios", width: 932, height: 430, platform: "ios", insets: iphone },
];
const resolutions = [[1280, 720], [1440, 900], [2560, 1080], [1080, 1920]] as const;
const log = (page: Page) => page.evaluate(() => (window as any).screenMobileFixture);
const say = (english: boolean | undefined) => (key: string) => english ? (en as Record<string, string>)[key] ?? key : key;

async function open(browser: Browser, phone: Phone, query = "") {
  const context = await browser.newContext({ viewport: { width: phone.width, height: phone.height }, locale: phone.english ? "en-US" : "zh-CN", hasTouch: true, isMobile: true });
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const { top, right, bottom, left } = phone.insets, cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top, topMax: top, right, rightMax: right, bottom, bottomMax: bottom, left, leftMax: left } });
  await page.goto(server.resolvedUrls!.local[0] + `e2e/fixtures/screen-mobile.html?platform=${phone.platform}&theme=app&host=macmini${query}`);
  await expect(page.locator(".remote-screen-panel.screen-landscape")).toBeVisible();
  return { page, errors, close: () => context.close() };
}
async function connect(page: Page, text: (key: string) => string) {
  await page.getByRole("button", { name: text("连接屏幕"), exact: true }).click();
  await expect(page.getByRole("button", { name: text("开始控制"), exact: true })).toBeEnabled();
}

/** Every layout rule of the landscape design, measured in the page. Returns the broken ones. */
function layout(page: Page, insets: Insets, image?: readonly [number, number], picture = true) {
  return page.evaluate(({ insets, image, picture }) => {
    const problems: string[] = [], near = (a: number, b: number, d = .6) => Math.abs(a - b) <= d;
    const panel = document.querySelector<HTMLElement>(".remote-screen-panel")!, box = (node: Element) => node.getBoundingClientRect();
    const visible = (node: Element) => { const r = box(node), s = getComputedStyle(node); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const say = (name: string, r: DOMRect) => `${name}(${[r.left, r.top, r.right, r.bottom].map(n => Math.round(n * 10) / 10).join(",")})`;
    const p = box(panel); if (!near(p.left, 0) || !near(p.top, 0) || !near(p.width, innerWidth) || !near(p.height, innerHeight)) problems.push(say("panel", p));
    const safe = { left: insets.left, top: insets.top, right: innerWidth - insets.right, bottom: innerHeight - insets.bottom };
    const rail = box(panel.querySelector(".screen-rail")!), view = box(panel.querySelector(".screen-viewport")!), tray = panel.querySelector(".screen-mobile-keyboard");
    if (!near(rail.right, safe.right) || !near(rail.width, 56) || !near(rail.top, safe.top) || !near(rail.bottom, safe.bottom)) problems.push(say("rail", rail));
    const viewBottom = tray ? box(tray).top : safe.bottom;
    if (!near(view.left, safe.left) || !near(view.top, safe.top) || !near(view.right, rail.left) || !near(view.bottom, viewBottom)) problems.push(say("view", view));
    if (tray) { const t = box(tray); if (!near(t.left, safe.left) || !near(t.right, rail.left) || !near(t.height, 44) || !near(t.bottom, safe.bottom)) problems.push(say("tray", t)); }
    // Interactive targets are at least 44 × 44 CSS px.
    for (const node of panel.querySelectorAll("button,select,textarea,input,summary")) if (visible(node)) { const r = box(node); if (r.width < 43.99 || r.height < 43.99) problems.push(say(`small ${node.getAttribute("aria-label") ?? node.textContent?.trim()}`, r)); }
    // Nothing leaves the safe panel area; scrolled strips and sheets clip their own content.
    const scrolled = (node: Element) => !!node.parentElement?.closest(".screen-mobile-keys,.screen-tools-popover");
    for (const node of panel.querySelectorAll("*")) if (visible(node) && !scrolled(node) && node.tagName !== "CANVAS") { const r = box(node); if (r.left < safe.left - .6 || r.top < safe.top - .6 || r.right > safe.right + .6 || r.bottom > safe.bottom + .6) problems.push(say(`outside ${node.className || node.tagName}`, r)); }
    // Rail captions and controls are whole: no wrapping or clipping.
    for (const node of panel.querySelectorAll<HTMLElement>(".screen-rail-label,.screen-text>button,.screen-status-actions button")) if (node.scrollWidth > node.clientWidth + .5 || (node.matches(".screen-rail-label") && node.getBoundingClientRect().height > 13)) problems.push(`clipped ${node.textContent}`);
    for (const node of panel.querySelectorAll(".screen-rail button")) { const r = box(node); if (r.left < rail.left - .6 || r.right > rail.right + .6) problems.push(say("rail button outside", r)); }
    // The status label: top-left of the picture area, one 26 px line, at most 70 % wide, never taking touches.
    const label = panel.querySelector<HTMLElement>(".screen-status-label")!, l = box(label), ls = getComputedStyle(label);
    if (label.getAttribute("role") !== "status" || !near(l.left, view.left + 10) || !near(l.top, view.top + 10) || l.width > view.width * .7 + .6 || ls.pointerEvents !== "none") problems.push(say("label", l));
    if (!label.hasAttribute("data-alert") && (!near(l.height, 26) || ls.borderRadius !== "13px" || ls.fontSize !== "12px" || ls.whiteSpace !== "nowrap")) problems.push(say(`label line ${ls.borderRadius} ${ls.fontSize}`, l));
    if (picture && image) {
      // The picture is the largest image of its ratio that fits the picture area, centred.
      const canvas = box(panel.querySelector("canvas")!), k = Math.min(view.width / image[0], view.height / image[1]);
      if (!near(canvas.width, image[0] * k, 1) || !near(canvas.height, image[1] * k, 1) || !near(canvas.left + canvas.width / 2, view.left + view.width / 2, 1) || !near(canvas.top + canvas.height / 2, view.top + view.height / 2, 1)) problems.push(say(`picture≠${Math.round(image[0] * k)}x${Math.round(image[1] * k)}`, canvas));
      // Only the status label is drawn over the picture, and it lets touches through.
      const shown = { left: Math.max(canvas.left, view.left), top: Math.max(canvas.top, view.top), right: Math.min(canvas.right, view.right), bottom: Math.min(canvas.bottom, view.bottom) };
      for (const node of panel.querySelectorAll("*")) {
        if (!visible(node) || node.tagName === "CANVAS" || node.closest(".screen-status-label") || node.contains(panel.querySelector("canvas"))) continue;
        const r = box(node), w = Math.min(r.right, shown.right) - Math.max(r.left, shown.left), h = Math.min(r.bottom, shown.bottom) - Math.max(r.top, shown.top);
        if (w > .6 && h > .6) problems.push(say(`over picture ${node.className || node.tagName}`, r));
      }
      for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
        const x = shown.left + 2 + (shown.right - shown.left - 4) * i / 5, y = shown.top + 2 + (shown.bottom - shown.top - 4) * j / 3, hit = document.elementFromPoint(x, y);
        if (hit?.tagName !== "CANVAS") problems.push(`touch at ${Math.round(x)},${Math.round(y)} hits ${hit?.className || hit?.tagName}`);
      }
    }
    return problems;
  }, { insets, image, picture });
}

for (const phone of phones) test(`landscape layout ${phone.name}`, async ({ browser }) => {
  const text = say(phone.english);
  for (const res of resolutions) {
    const { page, errors, close } = await open(browser, phone, `&res=${res[0]}x${res[1]}`);
    try {
      await connect(page, text);
      await expect.poll(() => layout(page, phone.insets, res), { message: `${phone.name} ${res.join("x")} viewing` }).toEqual([]);
      if (res[0] !== 1280) continue;
      // Start control and open the keyboard row.
      await page.getByRole("button", { name: text("开始控制"), exact: true }).click();
      await expect(page.getByRole("button", { name: text("停止控制"), exact: true })).toBeVisible();
      await page.getByRole("button", { name: text("键盘与快捷键"), exact: true }).click();
      const editor = page.getByLabel(text("发送到远端的文本"));
      await expect(editor).toBeVisible();
      await expect.poll(() => layout(page, phone.insets, res), { message: `${phone.name} keyboard row` }).toEqual([]);
      const row = await page.locator(".screen-mobile-keyboard").evaluate(tray => {
        const tops = [...tray.querySelectorAll(".screen-mobile-keys>button,textarea,.screen-text>button")].filter(n => n.getBoundingClientRect().width > 0).map(n => Math.round(n.getBoundingClientRect().top));
        const key = tray.querySelector(".screen-mobile-keys>button")!, drawn = getComputedStyle(key, "::before");
        return { rows: new Set(tops).size, keyInset: [drawn.top, drawn.bottom, drawn.borderRadius], field: getComputedStyle(tray.querySelector("textarea")!).fontSize, hint: getComputedStyle(tray.querySelector("small")!).display, send: tray.querySelector(".screen-text>button")!.getAttribute("aria-label") };
      });
      expect(row).toEqual({ rows: 1, keyInset: ["6px", "6px", "6px"], field: "16px", hint: "none", send: text("发送到远端") });
      // ≥ 640 pt beside the rail: all eight keys whole and still, the field takes the rest.
      // Narrower: the keys scroll. Enter is drawn as a return arrow but keeps its name.
      const keys = await page.locator(".screen-mobile-keyboard").evaluate(tray => {
        const panel = tray.closest<HTMLElement>(".remote-screen-panel")!, style = getComputedStyle(panel), available = panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 56;
        const strip = tray.querySelector<HTMLElement>(".screen-mobile-keys")!, s = strip.getBoundingClientRect(), buttons = [...strip.querySelectorAll("button")];
        const field = tray.querySelector("textarea")!.getBoundingClientRect(), send = tray.querySelector(".screen-text>button")!.getBoundingClientRect(), t = tray.getBoundingClientRect();
        return { wide: available >= 640, whole: buttons.slice(0, 8).every(b => { const r = b.getBoundingClientRect(); return r.width >= 44 && r.left >= s.left - .5 && r.right <= s.right + .5; }),
          scrolls: strip.scrollWidth > strip.clientWidth + .5, combos: buttons.slice(8).some(b => b.getBoundingClientRect().width > 0),
          field: field.width - 12 >= 159.5, fills: Math.abs(field.left - s.right) <= 8 && Math.abs(send.right - (t.right - 8)) <= .6, enter: [buttons[2]!.getAttribute("aria-label"), !!buttons[2]!.querySelector("svg"), buttons[2]!.textContent] };
      });
      expect(keys).toEqual(keys.wide ? { wide: true, whole: true, scrolls: false, combos: false, field: true, fills: true, enter: ["Enter", true, ""] }
        : { wide: false, whole: keys.whole, scrolls: true, combos: true, field: keys.field, fills: keys.fills, enter: ["Enter", true, ""] });
      // "More" is a full-height sheet against the rail and carries the keyboard note.
      await page.getByRole("button", { name: text("屏幕更多操作"), exact: true }).click();
      const sheet = page.getByRole("region", { name: text("屏幕更多操作") }); await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(text("仅在开始控制后，点击发送才会提交文本。"));
      const geometry = await sheet.evaluate((node, insets) => { const r = node.getBoundingClientRect(), rail = document.querySelector(".screen-rail")!.getBoundingClientRect();
        return { top: Math.round(r.top - insets.top), bottom: Math.round(innerHeight - insets.bottom - r.bottom), againstRail: Math.round(rail.left - r.right), width: Math.round(r.width), expected: Math.round(Math.min(340, innerWidth * .6)), overflow: getComputedStyle(node).overflowY, wide: node.scrollWidth > node.clientWidth };
      }, phone.insets);
      expect(geometry).toMatchObject({ top: 0, bottom: 0, againstRail: 0, width: geometry.expected, overflow: "auto", wide: false });
      await page.getByRole("button", { name: text("屏幕更多操作"), exact: true }).click(); await expect(sheet).toBeHidden();
      expect(errors).toEqual([]);
    } finally { await close(); }
  }
  // A reason stays readable and its action remains reachable.
  const blocked = await open(browser, phone, "&blocked=screen_service_offline&settings=1");
  try {
    const action = blocked.page.getByRole("button", { name: text("屏幕控制设置"), exact: true }); await expect(action).toBeVisible();
    await expect.poll(() => layout(blocked.page, phone.insets, undefined, false)).toEqual([]);
    await expect(blocked.page.locator(".screen-status-label")).toContainText(text("主机在线，但桌面服务未运行。请在目标电脑打开 TaroBird。"));
    await action.click(); expect((await log(blocked.page)).settingsOpened).toBe(1);
  } finally { await blocked.close(); }
});

test("status label fades only in a calm view and returns for changes and rail taps", async ({ browser }) => {
  const phone = phones[0]!, text = say(false), { page, close } = await open(browser, phone);
  const label = page.locator(".screen-status-label");
  const faded = () => label.evaluate(node => [node.hasAttribute("data-faded"), getComputedStyle(node).opacity, node.getAttribute("role"), node.isConnected]);
  const persists = async () => { await page.waitForTimeout(5000); expect(await faded()).toEqual([false, "1", "status", true]); };
  try {
    // Not connected: stays.
    await expect(label).toHaveText("macmini · " + text("尚未连接")); await persists();
    await connect(page, text);
    await expect(label).toContainText(text("查看中 · 点击开始控制后操作")); expect(await faded()).toEqual([false, "1", "status", true]);
    await expect.poll(faded, { timeout: 7000 }).toEqual([true, "0", "status", true]);
    await expect(label).toContainText("1280 × 720");
    // A rail tap shows it again for a while.
    await page.getByRole("button", { name: text("屏幕更多操作"), exact: true }).click();
    expect((await faded())[0]).toBe(false);
    await page.getByRole("button", { name: text("屏幕更多操作"), exact: true }).click();
    await expect.poll(faded, { timeout: 7000 }).toEqual([true, "0", "status", true]);
    // A status change shows it again.
    await page.getByRole("button", { name: text("开始控制"), exact: true }).click();
    await expect(label).toContainText(text("正在控制 · 可随时停止控制")); expect((await faded())[0]).toBe(false);
    await expect.poll(faded, { timeout: 7000 }).toEqual([true, "0", "status", true]);
    // While a word is being composed the label explains why Send waits.
    await page.getByRole("button", { name: text("键盘与快捷键"), exact: true }).click();
    const editor = page.getByLabel(text("发送到远端的文本")); await editor.fill("候选"); await editor.dispatchEvent("compositionstart");
    await expect(label).toContainText(text("请先在键盘上确认候选词，再发送。")); await persists();
    await editor.dispatchEvent("compositionend"); await page.getByRole("button", { name: text("键盘与快捷键"), exact: true }).click();
    // A stalled picture stays announced.
    await page.evaluate(() => { (window as any).screenMobileFixture.pauseFrames = true; });
    await expect(label).toContainText(text("画面暂未更新，控制已停止，请等待新画面。"), { timeout: 5000 }); await persists();
    // While waiting for a fresh frame after asking for control, the control caption says so.
    await page.evaluate(() => { (window as any).screenMobileFixture.pauseFrames = false; });
    await expect(page.getByRole("button", { name: text("开始控制"), exact: true })).toBeEnabled();
    // Closed with a reason: stays, and so does connecting.
    await page.evaluate(() => (window as any).screenMobileHostClose("screen_host_stopped"));
    await expect(page.getByRole("button", { name: text("连接屏幕"), exact: true })).toBeVisible(); await persists();
    await page.evaluate(() => { (window as any).screenMobileFixture.holdHubOpen = true; });
    await page.getByRole("button", { name: text("连接屏幕"), exact: true }).click();
    await expect(label).toContainText(text("正在连接屏幕…")); await persists();
    // Reduced motion drops the transition; the element still only changes opacity.
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await label.evaluate(node => getComputedStyle(node).transitionDuration)).toBe("0s");
  } finally { await close(); }
});

test("rail control waits for a fresh frame and the quality fallback stays reachable", async ({ browser }) => {
  const text = say(false), { page, close } = await open(browser, phones[1]!);
  try {
    await page.evaluate(() => { (window as any).screenMobileFixture.rejectQuality = true; });
    await page.getByRole("button", { name: text("连接屏幕"), exact: true }).click();
    const fallback = page.getByRole("button", { name: text("以默认画质连接"), exact: true }); await expect(fallback).toBeVisible();
    const hit = await fallback.evaluate(node => { const r = node.getBoundingClientRect(); return [document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === node, r.width >= 44 && r.height >= 44]; });
    expect(hit).toEqual([true, true]);
    await fallback.click(); await expect(page.getByRole("button", { name: text("开始控制"), exact: true })).toBeEnabled();
    expect((await log(page)).opens).toBe(1);
    // Asking for control: the rail button is disabled and captioned "等待" until the new stream's frame.
    await page.evaluate(() => { (window as any).screenMobileFixture.pauseFrames = true; });
    await page.getByRole("button", { name: text("开始控制"), exact: true }).click();
    const waiting = page.getByRole("button", { name: text("等待新画面…"), exact: true });
    await expect(waiting).toBeDisabled(); await expect(waiting.locator(".screen-rail-label")).toHaveText("等待");
    await page.evaluate(() => { (window as any).screenMobileFixture.pauseFrames = false; });
    const stop = page.getByRole("button", { name: text("停止控制"), exact: true }); await expect(stop).toBeEnabled();
    await expect(stop.locator(".screen-rail-label")).toHaveText("停止");
    await page.getByRole("button", { name: text("断开"), exact: true }).click();
    await expect(page.getByRole("button", { name: text("连接屏幕"), exact: true }).locator(".screen-rail-label")).toHaveText("连接");
  } finally { await close(); }
});

for (const [phone, keyboard] of [[phones[1]!, 180], [phones[0]!, 180], [phones[4]!, 200]] as const) test(`${phone.name} system keyboard (${keyboard} pt) keeps the row above it and the picture's scale and place`, async ({ browser }) => {
  const text = say(false), { page, close } = await open(browser, phone, "&viewport=native");
  try {
    await connect(page, text); await page.getByRole("button", { name: text("开始控制"), exact: true }).click();
    await page.getByRole("button", { name: text("键盘与快捷键"), exact: true }).click();
    const editor = page.getByLabel(text("发送到远端的文本")); await editor.tap(); await expect(editor).toBeFocused();
    const picture = () => page.locator("canvas").evaluate(node => { const r = node.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(n => Math.round(n)); });
    await expect.poll(() => layout(page, phone.insets, [1280, 720])).toEqual([]);
    const before = await picture();
    const rail = () => page.locator(".screen-rail").evaluate(node => { const r = node.getBoundingClientRect();
      return { shown: [...node.querySelectorAll("button")].filter(b => b.getBoundingClientRect().height > 0).map(b => { const box = b.getBoundingClientRect(); return `${b.getAttribute("aria-label")}${box.top >= r.top - .5 && box.bottom <= r.bottom + .5 && box.height >= 44 ? "" : " cut"}`; }), overflow: node.scrollHeight > node.clientHeight };
    });
    const full = await rail();
    await page.evaluate(height => window.dispatchEvent(new CustomEvent("tarobot-keyboard", { detail: { height } })), keyboard);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.keyboardOpen)).toBe("true");
    const above = await page.evaluate(() => { const panel = document.querySelector(".remote-screen-panel")!.getBoundingClientRect(), tray = document.querySelector(".screen-mobile-keyboard")!.getBoundingClientRect(), field = document.querySelector("textarea")!.getBoundingClientRect();
      return { panel: Math.round(panel.bottom), tray: Math.round(tray.bottom), height: Math.round(tray.height), field: document.elementFromPoint(field.left + field.width / 2, field.top + field.height / 2)?.tagName, rail: Math.round(document.querySelector(".screen-rail")!.getBoundingClientRect().bottom) };
    });
    expect(above).toEqual({ panel: phone.height - keyboard, tray: phone.height - keyboard, height: 44, field: "TEXTAREA", rail: phone.height - keyboard });
    await expect.poll(picture).toEqual(before);
    // Only what typing needs stays in the rail, whole and without scrolling.
    expect(await rail()).toEqual({ shown: [text("键盘与快捷键"), text("断开"), text("停止控制")], overflow: false });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("tarobot-keyboard", { detail: { height: 0 } })));
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.keyboardOpen)).toBe("false");
    await expect.poll(picture).toEqual(before);
    expect(await rail()).toEqual(full);
    await expect.poll(() => layout(page, phone.insets, [1280, 720])).toEqual([]);
  } finally { await close(); }
});

test("rotation keeps the session and control, refits, and the panel follows the visible height", async ({ browser }) => {
  const text = say(false), context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", hasTouch: true, isMobile: true }), page = await context.newPage();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/screen-mobile.html?platform=android&theme=app&host=macmini&viewport=native");
    await connect(page, text); await page.getByRole("button", { name: text("开始控制"), exact: true }).click();
    await expect(page.getByRole("button", { name: text("停止控制"), exact: true })).toBeVisible();
    const sizes = () => page.evaluate(() => { const panel = document.querySelector<HTMLElement>(".remote-screen-panel")!, view = panel.querySelector(".screen-viewport")!.getBoundingClientRect(), canvas = panel.querySelector("canvas")!.getBoundingClientRect(), k = Math.min(view.width / 1280, view.height / 720);
      return { landscape: panel.classList.contains("screen-landscape"), panel: Math.round(panel.getBoundingClientRect().height) === innerHeight, shell: getComputedStyle(document.documentElement).getPropertyValue("--shell-height").trim() === `${innerHeight}px`, fit: Math.abs(canvas.width - 1280 * k) <= 1 && Math.abs(canvas.height - 720 * k) <= 1 };
    });
    const commands = async () => (await log(page)).commands.filter((value: any) => ["release", "control"].includes(value.type)).length;
    const before = await commands();
    await expect.poll(sizes).toEqual({ landscape: false, panel: true, shell: true, fit: true });
    for (const [width, height, landscape] of [[844, 390, true], [390, 844, false], [905, 382, true]] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(sizes, { message: `${width}x${height}` }).toEqual({ landscape, panel: true, shell: true, fit: true });
      await expect(page.getByRole("button", { name: text("停止控制"), exact: true })).toBeVisible();
    }
    expect((await log(page)).opens).toBe(1); expect((await log(page)).stops).toBe(0); expect(await commands()).toBe(before);
  } finally { await context.close(); }
});

test("controlling fill is the theme accent with 4.5:1 ink and 3:1 against the rail in every palette and scheme", async ({ browser }, info) => {
  const { page, close } = await open(browser, phones[0]!);
  try {
    await connect(page, say(false)); await page.getByRole("button", { name: "开始控制", exact: true }).click();
    await expect(page.locator(".screen-rail-control[data-active]")).toBeVisible();
    const accents = ["graphite", "warm-gray", "mist", "sage", "rose", "oat", "mauve", "none"];
    const variants = [...accents.flatMap(accent => ["light", "dark", "system"].map(theme => ({ palette: "mono", accent, theme }))),
      ...["white-blue", "white-green", "white-violet", "white-rose", "white-orange", "sage", "ocean"].flatMap(palette => ["light", "dark"].map(theme => ({ palette, accent: "warm-gray", theme }))),
      { palette: "cli", accent: "warm-gray", theme: "dark" }];
    await page.emulateMedia({ colorScheme: "dark" }); // "system" resolves to dark here
    const rows = await page.evaluate(variants => {
      const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      const rgb = (color: string) => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "#000"; canvas.fillStyle = color; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
      const luminance = (c: number[]) => c.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
      const ratio = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return Math.round((x! + .05) / (y! + .05) * 100) / 100; };
      const hex = (c: number[]) => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
      const icon = document.querySelector(".screen-rail-control[data-active] .screen-rail-icon")!, rail = document.querySelector(".screen-rail")!, root = document.documentElement;
      return variants.map(({ palette, accent, theme }) => {
        Object.assign(root.dataset, { palette, monoAccent: accent, theme });
        const fill = rgb(getComputedStyle(icon).backgroundColor), ink = rgb(getComputedStyle(icon).color), back = rgb(getComputedStyle(rail).backgroundColor);
        const mark = getComputedStyle(root).getPropertyValue("--mono-mark").trim(), accentColor = rgb(getComputedStyle(root).getPropertyValue("--accent"));
        return { palette, accent: palette === "mono" ? accent : "", theme, fill: hex(fill), ink: hex(ink), rail: hex(back), ink_fill: ratio(ink, fill), fill_rail: ratio(fill, back), source: palette === "mono" && mark ? (hex(fill) === hex(rgb(mark)) ? "mark" : "mark deepened") : hex(fill) === hex(accentColor) ? "accent" : "other" };
      });
    }, variants);
    await info.attach("controlling-fill-contrast", { body: JSON.stringify(rows, null, 1), contentType: "application/json" });
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      const name = `${row.palette} ${row.accent} ${row.theme}`;
      expect.soft(row.ink_fill, `${name} ink on fill`).toBeGreaterThanOrEqual(4.5);
      expect.soft(row.fill_rail, `${name} fill on rail`).toBeGreaterThanOrEqual(3);
      expect.soft(["#000000", "#111111", "#171717"], `${name} is not black`).not.toContain(row.fill);
      // The fill comes from the accent: the mark itself in dark mono, deepened in light mono, --accent elsewhere; "none" keeps its deep grey.
      const expected = row.palette !== "mono" ? "accent" : row.accent === "none" ? "other" : row.theme === "light" ? "mark deepened" : "mark";
      expect.soft(row.source, `${name} source`).toBe(expected);
    }
  } finally { await close(); }
});

test("portrait phones and tablets keep the stacked viewer", async ({ browser }) => {
  for (const [width, height] of [[390, 844], [360, 780], [1024, 768]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", hasTouch: true, isMobile: true }), page = await context.newPage();
    try {
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/screen-mobile.html?platform=ios&theme=app");
      await expect(page.locator(".screen-heading")).toBeVisible();
      expect(await page.locator(".screen-landscape,.screen-rail,.screen-status-label").count()).toBe(0);
    } finally { await context.close(); }
  }
});

test("landscape performance overlay clears the status pill, stays above the keyboard row, and meets 44px touch targets", async ({ browser }) => {
  const phone = phones[1]!, text = say(false), { page, errors, close } = await open(browser, phone);
  try {
    await connect(page, text);
    await page.getByRole("button", { name: text("屏幕更多操作"), exact: true }).click();
    const toggleRow = page.locator(".screen-metrics-toggle"), checkbox = toggleRow.locator('input[type="checkbox"]');
    const sizes = await toggleRow.evaluate(node => {
      const r = node.getBoundingClientRect(), input = node.querySelector("input")!.getBoundingClientRect();
      return { rowH: r.height, inputW: input.width, inputH: input.height };
    });
    expect(sizes.rowH).toBeGreaterThanOrEqual(43.99);
    expect(sizes.inputW).toBeGreaterThanOrEqual(43.99);
    expect(sizes.inputH).toBeGreaterThanOrEqual(43.99);
    await checkbox.click();
    await page.getByRole("button", { name: text("屏幕更多操作"), exact: true }).click();
    // Open keyboard row too so both status pill (top) and keyboard tray (bottom) are active simultaneously.
    await page.getByRole("button", { name: text("键盘与快捷键"), exact: true }).click();
    const overlay = page.getByRole("region", { name: text("屏幕性能数据"), exact: true });
    await expect(overlay).toBeVisible();
    const check = await page.evaluate(() => {
      const o = document.querySelector(".screen-metrics-overlay")!.getBoundingClientRect();
      const l = document.querySelector(".screen-status-label")!.getBoundingClientRect();
      const v = document.querySelector(".screen-viewport")!.getBoundingClientRect();
      const k = document.querySelector(".screen-mobile-keyboard")!.getBoundingClientRect();
      return {
        pointerEvents: getComputedStyle(document.querySelector(".screen-metrics-overlay")!).pointerEvents,
        belowStatusLabel: o.top >= l.bottom - 0.5,
        aboveKeyboard: o.bottom <= k.top + 0.5,
        insideViewport: o.left >= v.left - 0.5 && o.right <= v.right + 0.5 && o.top >= v.top - 0.5 && o.bottom <= v.bottom + 0.5,
      };
    });
    expect(check).toEqual({ pointerEvents: "none", belowStatusLabel: true, aboveKeyboard: true, insideViewport: true });
    expect(errors).toEqual([]);
  } finally { await close(); }
});

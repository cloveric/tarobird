import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, mobileHome, openMobileHome, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { colorPalettes, DEFAULT_PALETTE } from "../src/palettes.js";
import { openSettings, closeSettings, selectPaletteForCoverage } from "./fixtures/settings.js";
import { microphone } from "./fixtures/microphone.js";

// Rendered colours, including nested syntax and cards, rather than token equality.
// Porcelain shows attachments beside the caption, so the caption carries the bubble colour.
const bubbleColor = (el: Element) => { const own = getComputedStyle(el).backgroundColor, caption = el.querySelector(":scope > .markdown"); return own === "rgba(0, 0, 0, 0)" && caption ? getComputedStyle(caption).backgroundColor : own; };

async function contrast(page: Page, targets?: string[]) {
  return page.evaluate((targets) => {
    // color-mix() is serialized as color(srgb 0..1), not rgb(0..255).
    // Let the browser resolve either form into comparable sRGB bytes.
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, alpha! / 255];
    };
    const luminance = (c: number[]) => c.slice(0, 3).map((v) => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((s, n, i) => s + n * [.2126, .7152, .0722][i]!, 0);
    const background = (el: Element): number[] => {
      const c = rgb(getComputedStyle(el).backgroundColor), alpha = c[3] ?? 1;
      const underneath = el.parentElement ? background(el.parentElement) : [255, 255, 255];
      return c.slice(0, 3).map((v, i) => v * alpha + underneath[i]! * (1 - alpha));
    };
    const selectors = targets ?? [".message.user .markdown", ".message.user .markdown a", ".message.user .hljs-keyword", ".message.user .hljs-string", ".message.user .hljs-title", ".message.user .code-copy", ".message.user blockquote", ".message.user .file-card", ".message.user .file-card small", ".message.user .link-preview-description", ".message.bot .markdown", ".message.bot .hljs-keyword", ".message.bot .hljs-string", ".message.bot .hljs-title", ".wordmark-text"];
    return selectors.map((selector) => {
      const el = document.querySelector(selector); if (!el) throw new Error(`Missing contrast target: ${selector}`);
      const fg = luminance(rgb(getComputedStyle(el).color)), bg = luminance(background(el));
      return { selector, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) };
    });
  }, targets);
}

test("palettes keep rich messages readable and persist through reload, dark mode and mobile settings", async ({ page }, info) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "palette-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "本周阅读清单", "palette");
    hub.linkPreviews.read = async (url) => ({ url, status: "ready", title: "让讨论和资料，在同一个地方", siteName: "TaroCub", description: "消息、附件和链接一起发送，电脑与手机同步查看。" });
    // Fresh installs stay monochrome/light even when the OS prefers dark.
    await page.emulateMedia({ colorScheme: "dark" });
    const html = await (await page.request.get(hub.url)).text();
    expect(html).toContain('data-theme="light"'); expect(html).toContain('data-palette="mono"');
    await page.goto(hub.url);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
    await page.evaluate(() => localStorage.setItem("tarocub-appearance", "invalid"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page);
    // Migrate a pre-palette preference record without resetting any existing choice.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("tarocub-v1"); r.onsuccess = () => resolve(r.result); });
      await new Promise<void>((resolve) => { const tx = db.transaction("settings", "readwrite"); tx.objectStore("settings").put({ theme: "light", locale: "zh", fontSize: 16, quietStart: "22:00", quietEnd: "08:00" }, "preferences"); tx.oncomplete = () => resolve(); }); db.close();
      // Simulate an old installation whose global host preferences have not
      // been imported yet. Existing global preferences correctly take priority.
      const registry = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); });
      await new Promise<void>((resolve) => { const tx = registry.transaction("meta", "readwrite"); tx.objectStore("meta").delete("preferences"); tx.oncomplete = () => resolve(); }); registry.close();
    });
    await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-palette", DEFAULT_PALETTE);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // The legacy migration deliberately clears the global opt-in above.
    await showDisconnectedBots(page);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill('文件与说明一起发送。\n\n```js\n// 准备资料\nconst status = "ready";\nfunction verify() { return status; }\n```\n\n> 本周要点，随时回来接着讨论。\n\n[产品参考](https://example.org/design)');
    await page.locator('input[type="file"]').first().setInputFiles({ name: "产品阅读清单.txt", mimeType: "text/plain", buffer: Buffer.from("主题、文件与链接统一呈现。") });
    await expect(page.locator(".link-preview-draft .link-preview-card")).toBeVisible();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.user .file-card")).toBeVisible();
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: '收到。我会把资料分成三个主题，保留原文链接。\n\n```js\nconst topic = "design";\nfunction read() { return topic; }\n```' }], status: "complete" });
    // Reconnect replays the persisted Hub message; no fake assistant UI is injected.
    await page.reload(); await expect(page.locator(".message.bot .markdown")).toBeVisible();
    await page.evaluate(() => document.documentElement.removeAttribute("data-palette"));
    expect(await page.locator(".message.user .message-blocks").evaluate(bubbleColor)).toBe("rgb(234, 234, 234)");
    await page.evaluate(() => document.documentElement.dataset.palette = "mono");
    const bubbles = new Set<string>();
    for (const palette of colorPalettes) {
      await openSettings(page);
      await expect(page.locator(".palette-family").filter({ has: page.getByRole("heading", { name: "特色主题", exact: true }) }).locator('input[name="color-palette"]')).toHaveCount(1);
      await selectPaletteForCoverage(page, palette.id);
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-palette", palette.id);
      // The synchronous palette mirror is ready before host/cache hydration.
      await waitForClientOnline(page);
      await expect(page.locator(".message.user .hljs-string")).toBeVisible();
      bubbles.add(await page.locator(".message.user .message-blocks").evaluate(bubbleColor));
      for (const mode of ["light", "dark"] as const) {
        await openSettings(page); if (palette.id !== "cli") await page.getByLabel("主题", { exact: true }).selectOption(mode);
        await page.getByRole("button", { name: "关闭设置", exact: true }).click();
        await expect(async () => { for (const row of await contrast(page)) expect(row.ratio, `${palette.id}/${mode} ${row.selector}`).toBeGreaterThanOrEqual(4.5); }).toPass({ timeout: 2000, intervals: [150] });
        expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toBe(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--bg").trim()));
        if (palette.family === "white" && mode === "light") {
          // Check the rendered page surfaces, not just a white swatch in settings.
          for (const selector of [".sidebar", ".conversation-main", ".composer"]) {
            await expect(page.locator(selector)).toHaveCSS("background-color", "rgb(255, 255, 255)");
          }
          await page.setViewportSize({ width: 390, height: 844 });
          await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeInViewport();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ animations: "disabled", path: info.outputPath(`${palette.id}-phone.png`) });
          await page.setViewportSize({ width: 1360, height: 900 });
        }
        if (palette.family === "expressive") {
          await expect(page.locator(".message.user .message-blocks")).toHaveCSS("border-top-left-radius", "0px");
          await expect(page.locator(".message.user .file-card")).toHaveCSS("border-top-left-radius", "0px");
        }
        await page.screenshot({ animations: "disabled", path: info.outputPath(`${palette.id}-${mode}.png`) });
      }
      await openSettings(page); if (palette.id !== "cli") await page.getByLabel("主题", { exact: true }).selectOption("system");
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await page.emulateMedia({ colorScheme: "light" });
      const light = await page.locator(".message.user .message-blocks").evaluate(bubbleColor);
      await page.emulateMedia({ colorScheme: "dark" });
      const current = await page.locator(".message.user .message-blocks").evaluate(bubbleColor);
      if (palette.id === "cli") expect(current).toBe(light); else expect(current).not.toBe(light);
      await expect.poll(() => page.locator('meta[name="theme-color"]').getAttribute("content")).toBe(await page.locator("html").evaluate((el) => getComputedStyle(el).getPropertyValue("--bg").trim()));
      await page.emulateMedia({ colorScheme: "light" });
    }
    expect(bubbles.size).toBe(colorPalettes.length);
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole("button", { name: "打开会话列表", exact: true }).click(); await openSettings(page);
    await expect(page.getByLabel("字号", { exact: true })).toHaveValue("16");
    await expect(page.locator('input[name="color-palette"]')).toHaveCount(colorPalettes.length);
    await expect(page.locator(".palette-family").filter({ has: page.getByRole("heading", { name: "特色主题", exact: true }) }).locator('input[name="color-palette"]')).toHaveValue("cli");
    await page.locator('input[name="color-palette"]').first().focus();
    await page.keyboard.press("ArrowRight"); await expect(page.locator('input[name="color-palette"]').nth(1)).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: info.outputPath("palette-settings-phone.png") });
    await page.getByLabel("语言", { exact: true }).selectOption("en");
    await expect(page.getByRole("group", { name: "Color palette", exact: true })).toBeVisible();
    for (const name of await page.locator(".palette-name").allTextContents()) expect(name).not.toMatch(/[\u4e00-\u9fff]/);
    const radio = page.locator('input[name="color-palette"]').nth(1);
    expect((await radio.boundingBox())!.height).toBe(15);
    await page.screenshot({ animations: "disabled", path: info.outputPath("palette-settings-phone-en.png") });
    await page.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.screenshot({ animations: "disabled", path: info.outputPath("palette-settings-phone-dark-en.png") });
    await closeSettings(page, true);
    // Hold asynchronous preference reads while inspecting the first rendered
    // loading screen. The synchronous mirror must already restore the saved palette.
    await page.addInitScript(() => {
      const original = IDBObjectStore.prototype.get, pending: (() => void)[] = [];
      let released = false;
      IDBObjectStore.prototype.get = function (key) {
        const request = original.call(this, key);
        if ((this.name === "settings" || this.name === "meta") && key === "preferences") {
          const add = request.addEventListener.bind(request);
          request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            add(type, type === "success" ? (event: Event) => { const resume = () => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event); if (released) resume(); else pending.push(resume); } : listener, options);
          }) as typeof request.addEventListener;
        }
        return request;
      };
      Object.assign(window, { releaseAppearanceReads() { released = true; IDBObjectStore.prototype.get = original; pending.splice(0).forEach((resume) => resume()); } });
    });
    await page.reload(); await expect(page.locator(".loading-screen")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-palette", colorPalettes[1].id);
    await page.evaluate(() => (window as unknown as { releaseAppearanceReads(): void }).releaseAppearanceReads());
    await mobileHome(page).locator(".mh-row").filter({has:page.getByText(chat.title,{exact:true})}).click();
    await expect(page.locator(".message.user .file-card")).toBeVisible();

  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("phone monochrome keeps neutral bubbles, reply cards and held recording readable in both modes", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const root = await mkdtemp(path.join(os.tmpdir(), "mono-phone-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "今天的阅读计划", "mono");
    await microphone(page); await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("帮我安排一个轻松的阅读计划。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.user")).toBeVisible();
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "card", title: "今天，留一点时间给阅读", elements: [{ type: "markdown", text: "不必赶进度，从你感兴趣的内容开始。\n\n- **读 20 分钟**：选一篇喜欢的文章。\n- **记一个想法**：留下最有启发的一句话。\n- **聊聊收获**：随时回来，我们接着讨论。" }] }], status: "complete" });
    for (const mode of ["light", "dark"] as const) {
      await openSettings(page);
      await page.locator('input[name="color-palette"][value="mono"]').check();
      await page.getByLabel("主题", { exact: true }).selectOption(mode);
      await page.locator('input[value="mono"]').scrollIntoViewIfNeeded();
      await page.screenshot({ animations: "disabled", path: info.outputPath(`mono-settings-${mode}.png`) });
      await closeSettings(page); await page.reload(); await waitForClientOnline(page);
      await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
      await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
      await selectConversation(page, chat.title);
      await expect(page.locator(".message.bot .rich-card")).toBeVisible();
      const draft = page.getByRole("textbox", { name: "消息", exact: true }); await draft.fill("好，就从今天开始。");
      const targets = [".message.user .markdown", ".message.bot .card-header", ".message.bot .markdown", ".send-button"];
      await expect(async () => { for (const row of await contrast(page, targets)) expect(row.ratio, `${mode} ${row.selector}`).toBeGreaterThanOrEqual(4.5); }).toPass();
      await expect(page.locator(".message.user .message-blocks")).toHaveCSS("background-color", mode === "light" ? "rgb(234, 234, 234)" : "rgb(238, 238, 238)");
      await expect(page.locator(".message.bot .rich-card")).toHaveCSS("background-color", mode === "light" ? "rgb(255, 255, 255)" : "rgb(37, 37, 37)");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await draft.blur(); await page.screenshot({ animations: "disabled", path: info.outputPath(`mono-chat-${mode}.png`) });
      await page.getByRole("button", { name: "录制语音", exact: true }).click();
      const hold = page.getByRole("button", { name: "按住说话", exact: true }), box = (await hold.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await expect(page.locator(".hold-voice")).toHaveClass(/is-recording/);
      await expect.poll(() => page.getByRole("img", { name: "实时录音波形" }).getAttribute("data-level").then(Number)).toBeGreaterThan(0.05);
      for (const row of await contrast(page, [".hold-voice-button", ".hold-voice-panel time", ".hold-voice-panel p"])) expect(row.ratio, `${mode} ${row.selector}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`mono-recording-${mode}.png`) });
      await hold.dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true }); await page.mouse.up();
      await expect(page.locator(".hold-voice-panel")).toHaveCount(0);
      await page.getByRole("button", { name: "切换到键盘", exact: true }).click();
      await expect(draft).toHaveValue("好，就从今天开始。");
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("CLI styles keep drafts, readable content and usable phone controls across modes", async ({ page, browserName }, info) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "expressive-themes-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','灵感助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "把想法变成作品", "expressive");
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page);
    const draft = page.getByRole("textbox", { name: "消息", exact: true });
    await draft.fill("做一个轻巧的灵感收集工具，帮我理一理第一步。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message.user")).toBeVisible();
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "complete", blocks: [{ type: "card", title: "从一个小想法开始", elements: [{ type: "markdown", text: "先做三件事，让想法有地方落下。\n\n- **随手记**：文字、图片和链接一起收集。\n- **慢慢理**：按主题归档，再补充细节。\n- **开始做**：选一个最有意思的点。\n\n| 步骤 | 今天的计划 |\n| --- | --- |\n| 01 | 做一个能随时记录想法的入口 |\n| 02 | 把相关资料放在同一个话题里 |\n\n```js\nconst idea = \"start small\";\n```" }] }] });
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator(".message.bot .rich-card")).toBeVisible();
    await draft.fill("记住这个想法，明天继续。");
    for (const palette of ["cli"] as const) {
      for (const mode of ["light", "dark"] as const) {
        await openSettings(page);
        await selectPaletteForCoverage(page, "mono");
        await page.getByLabel("主题", { exact: true }).selectOption(mode);
        await selectPaletteForCoverage(page, palette);
        await expect(page.locator("html")).toHaveAttribute("data-theme", palette === "cli" ? "dark" : mode);
        if (mode === "light") await page.screenshot({ animations: "disabled", path: info.outputPath(`${palette}-settings.png`) });
        await closeSettings(page);
        await expect(draft).toHaveValue("记住这个想法，明天继续。");
        await page.reload(); await waitForClientOnline(page);
        await expect(page.locator("html")).toHaveAttribute("data-palette", palette);
        await expect(draft).toHaveValue("记住这个想法，明天继续。");
        await expect(page.locator(".composer")).toHaveCSS("border-top-left-radius", "2px");
        if (palette === "cli") {
          await expect(page.locator(".message-meta").first()).toHaveCSS("font-family", /ui-monospace/);
          await expect(draft).toHaveCSS("font-family", /ui-monospace/);
          await expect(page.locator(".message.user .message-body")).toHaveCSS("align-items", "flex-start");
          // Prompt decoration must not become message or draft content.
          await expect(page.locator(".message.user .markdown")).toHaveText("做一个轻巧的灵感收集工具，帮我理一理第一步。");
        }
        await expect(async () => { for (const row of await contrast(page, [".message.user .markdown", ".message.bot .card-header", ".message.bot .markdown", ".message.bot .hljs-string", ".send-button"])) expect(row.ratio, `${palette}/${mode} ${row.selector}`).toBeGreaterThanOrEqual(4.5); }).toPass();
        await draft.blur();
        await page.screenshot({ animations: "disabled", path: info.outputPath(`${palette}-${mode}-desktop.png`) });
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await expect(draft).toBeInViewport();
          // Measure after the conversation slide-in: a fractional translate skews boxes by float rounding.
          await expect.poll(() => page.locator(".conversation-main").evaluate(el => el.getAnimations().length)).toBe(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          for (const label of ["添加附件", "发送消息", "录制语音"]) {
            const target = page.getByRole("button", { name: label, exact: true }).filter({ visible: true });
            const box = (await target.boundingBox())!;
            expect(box.width, label).toBeGreaterThanOrEqual(44);
            expect(box.height, label).toBeGreaterThanOrEqual(44);
          }
          if (palette === "cli") {
            const copy = page.locator(".message.bot .code-copy");
            const box = (await copy.boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
          }
          await page.screenshot({ animations: "disabled", path: info.outputPath(`${palette}-${mode}-phone-${width}.png`) });
          if (width === 390) {
            await page.evaluate(() => {
              document.documentElement.style.setProperty("--safe-area-inset-top", "36px");
              document.documentElement.style.setProperty("--safe-area-inset-bottom", "24px");
            });
            await expect.poll(() => page.getByRole("heading", { name: chat.title, exact: true }).evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(36);
            await expect.poll(() => page.getByRole("button", { name: "发送消息", exact: true }).evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(820);
            await page.evaluate(() => {
              document.documentElement.style.removeProperty("--safe-area-inset-top");
              document.documentElement.style.removeProperty("--safe-area-inset-bottom");
            });
          }
          await openMobileHome(page);
          await expect(mobileHome(page).locator(".mh-row").first()).toBeInViewport();
          if (width === 390) await page.screenshot({ animations: "disabled", path: info.outputPath(`${palette}-${mode}-inbox.png`) });
          await selectConversation(page, chat.title);
          await expect(draft).toHaveValue("记住这个想法，明天继续。");
        }
        await page.setViewportSize({ width: 1360, height: 900 });
      }
      await openSettings(page); if (palette !== "cli") await page.getByLabel("主题", { exact: true }).selectOption("system");
      await closeSettings(page);
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", palette === "cli" ? "dark" : "system");
      await expect.poll(() => page.locator('meta[name="theme-color"]').getAttribute("content")).toBe(await page.locator("html").evaluate(el => getComputedStyle(el).getPropertyValue("--bg").trim()));
      await page.emulateMedia({ colorScheme: "light" });
      if (browserName === "chromium") {
        await page.emulateMedia({ forcedColors: "active" });
        await draft.focus();
        await expect(draft).toBeFocused();
        const frame = await page.locator(".composer").evaluate(el => {
          const style = getComputedStyle(el);
          return { color: style.borderTopColor, width: parseFloat(style.borderTopWidth), style: style.borderTopStyle };
        });
        expect(frame.width).toBeGreaterThanOrEqual(1);
        expect(frame.style).toBe("solid");
        expect(frame.color).not.toBe("rgba(0, 0, 0, 0)");
        await page.emulateMedia({ forcedColors: "none" });
      }
    }
    await openSettings(page);
    await page.locator('input[name="color-palette"][value="white-blue"]').check();
    await closeSettings(page);
    await expect(draft).toHaveValue("记住这个想法，明天继续。");
    await expect(page.locator(".composer")).toHaveCSS("border-top-left-radius", "18px");
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

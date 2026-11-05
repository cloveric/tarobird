import { monoAccents, colorPalettes } from "../src/palettes.js";
import { microphone } from "./fixtures/microphone.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { openDesktopListOptions, showDisconnectedBots, selectConversation, waitForClientOnline, openMobileHome, mobileHome } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";
import { openWorkspacePage } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page, run: (hub: HubServer, conversationId: string) => Promise<void>, botName = "研究助手") {
  const root = await mkdtemp(path.join(os.tmpdir(), "porcelain-details-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha',?,'fixture')", [botName]);
    const other = await hub.store.createConversation("owner", ["alpha"], "稍后阅读", "other");
    await hub.store.publishBotMessage("alpha", { conversationId: other.id, status: "complete", blocks: [{ type: "text", text: "保留这条未读提醒" }] });
    const chat = await hub.store.createConversation("owner", ["alpha"], "界面回归", "current");
    const bytes = Buffer.from("文件操作仍然可用。\n"), name = "阅读清单.txt";
    const attachmentId = await hub.attachments.importForBot("alpha", { conversationId: chat.id, name, mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: "查看文件，再继续讨论。" }, { type: "file", attachmentId, name, mime: "text/plain", size: bytes.length }] });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    await run(hub, chat.id);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}

test("the personal avatar restores focus without a ring in chat and ADHD", async ({ page, browserName }, info) => {
  const next = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  const previous = browserName === "webkit" && process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab";
  await fixture(page, async () => {
    for (const layout of ["chat", "adhd"]) {
      if (layout === "adhd") await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      const avatar = page.locator('.sidebar-footer [data-settings-entry="profile"]').filter({ visible: true });
      const paint = () => avatar.evaluate(node => { const style = getComputedStyle(node); return { outline: style.outlineStyle, shadow: style.boxShadow, background: style.backgroundColor }; });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => Object.assign(document.documentElement.dataset, { palette: "mono", theme }), theme);
        await avatar.click(); await expect(page.getByRole("button", { name: "关闭设置", exact: true })).toBeVisible();
        await page.keyboard.press("Escape"); await expect(avatar).toBeFocused();
        await page.mouse.move(1200, 30);
        // Move through the real tab order, rather than setting the focus-intent attribute.
        await page.keyboard.press(next); await expect(page.locator('.workspace-trigger').filter({ visible: true })).toBeFocused();
        await page.keyboard.press(previous); await expect(avatar).toBeFocused();
        await page.screenshot({ path: info.outputPath(`avatar-${layout}-${theme}.png`) });
        await expect.poll(paint).toMatchObject({ outline: "none", shadow: "none" });
        await expect.poll(async () => (await paint()).background).not.toBe("rgba(0, 0, 0, 0)");
        const keyboardBackground = (await paint()).background;
        await page.keyboard.press("Enter"); await expect(page.getByRole("button", { name: "关闭设置", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "关闭设置", exact: true }).click();
        await expect(avatar).toBeFocused(); await expect.poll(paint).toMatchObject({ outline: "none", shadow: "none" });
        await expect.poll(async () => (await paint()).background).not.toBe(keyboardBackground);
      }
    }
  });
});

test("Tab marks sidebar modes quietly without changing the selected mode", async ({ page, browserName }, info) => {
  const next = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  const previous = browserName === "webkit" && process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab";
  await fixture(page, async () => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => Object.assign(document.documentElement.dataset, { palette: "mono", theme }), theme);
      const group = page.getByRole("group", { name: "列表排列方式", exact: true }).filter({ visible: true });
      const bot = group.getByRole("button", { name: "按 Bot", exact: true });
      const chat = group.getByRole("button", { name: "按对话", exact: true });
      const adhd = group.getByRole("button", { name: "打开 ADHD 模式", exact: true });
      await chat.click(); await chat.focus(); await page.mouse.move(1200, 30); await page.keyboard.press(previous);
      await expect(bot).toBeFocused(); await expect(bot).toHaveAttribute("aria-pressed", "false"); await expect(chat).toHaveAttribute("aria-pressed", "true");
      await expect(bot).toHaveCSS("outline-style", "none"); await expect(bot).toHaveCSS("text-decoration-line", "underline");
      await group.screenshot({ path: info.outputPath(`mode-focus-${theme}.png`) });
      await page.keyboard.press("Enter"); await expect(bot).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press(next); await expect(chat).toBeFocused(); await expect(chat).toHaveCSS("outline-style", "none");
      await page.keyboard.press(next); await expect(adhd).toBeFocused(); await expect(adhd).toHaveCSS("outline-style", "none");
      await expect(adhd).toHaveCSS("text-decoration-line", "underline"); await page.keyboard.press("Enter");
      await expect(page.locator(".adhd-shell")).toBeVisible();
      const boardGroup = page.locator(".adhd-shell .sidebar-layout-switch");
      await expect(boardGroup.getByRole("button", { name: "打开 ADHD 模式", exact: true })).toHaveAttribute("aria-pressed", "true");
      await boardGroup.getByRole("button", { name: "按对话", exact: true }).click();
      await expect(page.locator(".adhd-shell")).toHaveCount(0);
      await expect(chat).toHaveAttribute("aria-pressed", "true"); await expect(chat).toHaveCSS("outline-style", "none");
      await expect(chat).toHaveCSS("text-decoration-line", "none");
    }
  });
});

test("the sidebar edge is one line that the conversation header rule meets", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await fixture(page, async () => {
    for (const palette of ["white-violet", "white-orange", "mono"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(settings => Object.assign(document.documentElement.dataset, settings), { palette, theme });
      const edge = await page.locator(".host-workspace:not([hidden]) .app-shell").evaluate(shell => {
        const main = shell.querySelector(":scope>.conversation-main")!, header = main.querySelector(".conversation-header")!, handle = shell.querySelector(":scope>.sidebar>.sidebar-resize-handle")!;
        const transparent = (colour: string) => colour === "transparent" || colour === "rgba(0, 0, 0, 0)";
        return { mainEdge: !transparent(getComputedStyle(main).borderLeftColor) && getComputedStyle(main).borderLeftWidth === "1px", splitterLine: !transparent(getComputedStyle(handle, "::before").backgroundColor), headerRule: !transparent(getComputedStyle(header).borderBottomColor), meets: Math.abs(header.getBoundingClientRect().left - (main.getBoundingClientRect().left + 1)) < 0.5 };
      });
      expect(edge, palette).toEqual({ mainEdge: true, splitterLine: false, headerRule: true, meets: true });
      const handle = page.locator(".host-workspace:not([hidden]) .sidebar-resize-handle");
      await handle.hover();
      await expect.poll(() => handle.evaluate(node => getComputedStyle(node, "::after").opacity)).toBe("1");
      await page.mouse.move(0, 0);
    }
  });
});

test("Porcelain dark pressed rows remain readable and system-dark controls match explicit dark", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await fixture(page, async () => {
    const row = page.locator('.host-workspace:not([hidden]) .sidebar .conversation-row').filter({ hasText: "稍后阅读" });
    for (const palette of ["white-violet", "white-green", "mono"]) {
      await page.evaluate(palette => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = "dark"; }, palette);
      const box = (await row.boundingBox())!; await page.mouse.move(box.x + 40, box.y + box.height / 2); await page.mouse.down();
      const colors = await row.evaluate(node => {
        const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
        const lum = (s: string) => rgb(s).slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
        const color = getComputedStyle(node.querySelector("strong")!).color, background = getComputedStyle(node).backgroundColor;
        const a = lum(color), b = lum(background);
        return { color, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
      await info.attach(`${palette}-pressed-colors`, { body: JSON.stringify(colors), contentType: "application/json" });
      expect.soft(colors.ratio, `${palette} pressed row`).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0); await page.mouse.up();
    }
    await page.evaluate(() => { document.documentElement.dataset.palette = "white-violet"; });
    const badge = row.locator(".unread-badge"); await expect(badge).toBeVisible();
    const badgeColors = () => badge.evaluate(node => ({ fg: getComputedStyle(node).color, bg: getComputedStyle(node).backgroundColor }));
    const explicitBadge = await badgeColors();
    await openSettings(page);
    await page.locator('input[name="color-palette"][value="white-violet"]').check();
    const select = page.getByLabel("主题", { exact: true });
    await select.selectOption("dark");
    const explicitArrow = await select.evaluate(node => getComputedStyle(node).backgroundImage);
    await select.selectOption("system");
    expect.soft(await select.evaluate(node => getComputedStyle(node).backgroundImage)).toBe(explicitArrow);
    await page.screenshot({ path: info.outputPath("settings-system-dark.png"), animations: "disabled" });
    await closeSettings(page);
    expect.soft(await badgeColors()).toEqual(explicitBadge);
    await page.screenshot({ path: info.outputPath("chat-system-dark.png"), animations: "disabled" });
  });
});

test("the composer stop is one outlined square in the plus colour, not a ring inside the round button", async ({ browser }) => {
  for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, hasTouch: viewport.width < 761, serviceWorkers: "block", reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      await fixture(page, async (hub, conversationId) => {
        await hub.store.publishBotMessage("alpha", { conversationId, status: "streaming", blocks: [{ type: "run", phase: "running", elapsedMs: 1000, tools: [], todos: [] }] });
        const stop = page.locator(".host-workspace:not([hidden]) .composer-stop.is-live").first();
        await expect(stop).toBeVisible();
        for (const palette of ["white-violet", "mono"]) for (const theme of ["light", "dark"]) {
          await page.evaluate(settings => Object.assign(document.documentElement.dataset, settings), { palette, theme });
          const readIcon = () => stop.evaluate(node => {
            const svg = node.querySelector("svg")!, rect = svg.querySelector("rect")!, probe = document.createElement("i");
            probe.style.color = "var(--grey)"; node.append(probe); const plus = getComputedStyle(probe).color;
            probe.style.color = "var(--text)"; const text = getComputedStyle(probe).color; probe.remove();
            return { ring: getComputedStyle(svg.querySelector("circle")!).display, fill: getComputedStyle(rect).fill, colour: getComputedStyle(node).color, plus, text, side: rect.getBoundingClientRect().width };
          });
          const icon = await readIcon();
          await expect.poll(readIcon, `${viewport.width}/${palette}`).toMatchObject({ ring: "none", fill: "none", colour: icon.plus });
          expect(icon.side).toBeGreaterThan(8);
          if (viewport.width > 760) {
            await stop.hover(); await expect(stop).toHaveCSS("color", icon.text);
            await page.mouse.move(0, 0);
          }
        }
      });
    } finally { await context.close(); }
  }
});

test("Porcelain touch file actions preserve their targets and composer focus stays quiet", async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await fixture(page, async () => {
      for (const platform of ["android", "ios"]) {
        await page.evaluate(platform => { document.documentElement.dataset.platform = platform; }, platform);
        for (const width of platform === "ios" ? [390, 1024] : [390]) {
          await page.setViewportSize({ width, height: 844 });
          const file = page.getByRole("region", { name: "阅读清单.txt", exact: true }); await file.scrollIntoViewIfNeeded();
          for (const action of await file.locator("button:visible").all()) {
            const box = (await action.boundingBox())!;
            expect.soft(box.height, `${platform}/${width} ${await action.getAttribute("aria-label")}`).toBeGreaterThanOrEqual(44);
          }
          const composer = page.getByRole("textbox", { name: "消息", exact: true }); await composer.focus();
          expect.soft(await composer.locator("..").evaluate(node => getComputedStyle(node).boxShadow), `${platform}/${width} composer focus`).toBe("none");
          await page.screenshot({ path: info.outputPath(`touch-${platform}-${width}.png`), animations: "disabled" });
          if (width > 760) {
            await openSettings(page);
            expect.soft((await page.getByLabel("主题", { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
            await closeSettings(page);
          }
        }
      }
    });
  } finally { await context.close(); }
});

test("narrow phones draw the Bot tab plus as a small soft disc inside its 44px target", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await fixture(page, async () => {
      await openMobileHome(page);
      await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Bot", exact: true }).click();
      const plus = mobileHome(page).getByRole("button", { name: "与 研究助手 新建对话", exact: true });
      const paint = () => plus.evaluate(node => { const style = getComputedStyle(node); return { ring: style.boxShadow, clip: style.backgroundClip, padding: style.paddingTop }; });
      for (const palette of ["white-violet", "mono"]) {
        await page.evaluate(palette => { document.documentElement.dataset.palette = palette; }, palette);
        const box = (await plus.boundingBox())!;
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
        expect(await paint()).toEqual({ ring: "none", clip: "content-box", padding: "6px" });
      }
      // Wider phones keep the ringed "+ 新对话" pill.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => (await paint()).ring).not.toBe("none");
    });
  } finally { await context.close(); }
});

test("forced colors keep checked controls visibly distinct", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "WebKit does not emulate forced colors");
  await fixture(page, async () => {
    await page.emulateMedia({ forcedColors: "active" });
    const checkbox = (await openDesktopListOptions(page)).getByRole("checkbox", { name: "显示未连接 Bot", exact: true });
    await expect(checkbox).toBeChecked();
    const paint = await checkbox.locator(".sidebar-list-toggle-mark").evaluate(node => ({ background: getComputedStyle(node).backgroundColor, check: getComputedStyle(node).color }));
    await info.attach("checkbox-paint", { body: JSON.stringify(paint), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("forced-colors-checked.png"), animations: "disabled" });
    // Either native platform painting, or a custom mark distinguishable from
    // its fill. Forced-colors must not turn both into the same Canvas colour.
    expect(paint.check).not.toBe(paint.background);
  });
});

test("phone 运行状态 lists the Hub entries, keeps each instance in one card and keeps 44px touch targets", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await fixture(page, async () => {
      await page.evaluate(() => { document.documentElement.dataset.palette = "mono"; });
      await openWorkspacePage(page, "运行状态");
      const card = page.locator(".operation-bot").first();
      await expect(card.getByRole("button", { name: "详细概览", exact: true })).toBeVisible();
      const layout = await card.evaluate(node => {
        const rect = (selector: string) => node.querySelector(selector)!.getBoundingClientRect();
        const avatar = rect(".avatar-setting>.profile-avatar"), header = rect("header"), actions = rect(".quick-actions");
        const tiles = [...node.querySelectorAll(".quick-actions>button")].map(button => button.getBoundingClientRect());
        return { avatarBesideName: avatar.right <= header.left && Math.abs(avatar.top + avatar.height / 2 - (header.top + header.height / 2)) < 8, twoColumns: Math.abs(tiles[0].top - tiles[1].top) < 1 && tiles[1].left > tiles[0].right, restartFullWidth: Math.abs(tiles[tiles.length - 1].width - actions.width) < 1, shortestTile: Math.min(...tiles.map(tile => tile.height)), repeatedLabel: getComputedStyle(node.querySelector(".avatar-setting strong")!).display };
      });
      expect(layout).toMatchObject({ avatarBesideName: true, twoColumns: true, restartFullWidth: true, repeatedLabel: "none" });
      expect(layout.shortestTile).toBeGreaterThanOrEqual(44);
      // The two Hub entries are one full-width list.
      const entries = page.locator(".operations-body>.operation-metrics~button");
      await expect(entries).toHaveCount(2);
      const [logs, audit] = [(await entries.nth(0).boundingBox())!, (await entries.nth(1).boundingBox())!];
      expect(Math.abs(logs.y + logs.height - audit.y)).toBeLessThan(1); expect(Math.abs(logs.width - audit.width)).toBeLessThan(1);
      // Compact pills keep a 44px target through their hit area.
      for (const pill of [page.getByRole("button", { name: "刷新状态", exact: true }), card.getByRole("button", { name: /^设置.*头像$/ })]) {
        expect(await pill.evaluate(node => { const after = getComputedStyle(node, "::after"); return node.getBoundingClientRect().height - parseFloat(after.top) - parseFloat(after.bottom); })).toBeGreaterThanOrEqual(44);
      }
    });
  } finally { await context.close(); }
});

test("three-image galleries keep every image inside the wide lead and square trailing tiles", async ({ page }, info) => {
  await fixture(page, async (hub, conversationId) => {
    const images = [];
    for (const [width, height] of [[600, 900], [960, 540], [900, 600]]) {
      const bytes = Buffer.from(await page.evaluate(([width, height]) => {
        const canvas = document.createElement("canvas"); canvas.width = width!; canvas.height = height!;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#ede9f8"; ctx.fillRect(0, 0, width!, height!);
        ctx.strokeStyle = "#6c528b"; ctx.lineWidth = 16; ctx.strokeRect(8, 8, width! - 16, height! - 16);
        ctx.fillStyle = "#362343"; ctx.font = "32px sans-serif";
        ctx.fillText(`${width} × ${height}`, 24, 56); ctx.fillText("Full image", 24, height! - 24);
        return canvas.toDataURL("image/png").split(",")[1]!;
      }, [width!, height!]), "base64");
      const attachmentId = await hub.attachments.importForBot("alpha", { conversationId, name: `${width}x${height}.png`, mime: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
      images.push({ type: "image" as const, attachmentId, title: `${width} × ${height}` });
    }
    const message = await hub.store.publishBotMessage("alpha", { conversationId, status: "complete", blocks: images });
    const gallery = page.locator(`[data-message-id="${message.id}"] .image-grid`);
    await expect(gallery.locator(".image-thumbnail img")).toHaveCount(3);
    for (const width of [390, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      for (const img of await gallery.locator("img").all()) {
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
        const tile = (await img.locator("..").boundingBox())!, box = (await img.boundingBox())!;
        const ratio = await img.evaluate((node: HTMLImageElement) => node.naturalWidth / node.naturalHeight);
        expect(box.width / box.height).toBeCloseTo(ratio, 2);
        expect(box.x).toBeGreaterThanOrEqual(tile.x - 1); expect(box.y).toBeGreaterThanOrEqual(tile.y - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(tile.x + tile.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(tile.y + tile.height + 1);
      }
      const tiles = gallery.locator(".image-thumbnail"), lead = (await tiles.nth(0).boundingBox())!, second = (await tiles.nth(1).boundingBox())!;
      expect(lead.width).toBeGreaterThan(second.width * 1.9);
      expect(lead.width / lead.height).toBeCloseTo(2, 1);
      expect(second.width / second.height).toBeCloseTo(1, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await gallery.screenshot({ path: info.outputPath(`three-images-${width}.png`) });
    }
  });
});

test("unknown stored Monochrome accents fall back without losing existing appearance choices", async ({ page }) => {
  await fixture(page, async () => {
    await openSettings(page);
    await page.getByLabel("主题", { exact: true }).selectOption("dark");
    await closeSettings(page);
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("tarocub-hosts-v1");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta");
          const request = store.get("preferences");
          request.onsuccess = () => store.put(JSON.stringify({ ...JSON.parse(request.result), monoAccent: "future-accent" }), "preferences");
          tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
      const mirror = JSON.parse(localStorage.getItem("tarocub-appearance")!);
      localStorage.setItem("tarocub-appearance", JSON.stringify({ ...mirror, monoAccent: "future-accent" }));
    });
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator("html")).toHaveAttribute("data-palette", "mono");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("data-mono-accent", "warm-gray");
    await openSettings(page);
    await expect(page.getByRole("radiogroup", { name: "黑白点缀色", exact: true }).getByRole("radio", { name: "浅暖灰", exact: true })).toBeChecked();
  });
});

test("Monochrome defaults to Warm Gray, preserves a saved opt-out, and tints Bot reply marks once chosen", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page, async (hub, conversationId) => {
    await hub.store.publishBotMessage("alpha", { conversationId, status: "complete", blocks: [{ type: "text", text: "要点：\n\n- 第一项\n- 第二项" }] });
    const composer = page.locator('.host-workspace:not([hidden]) .composer');
    const send = composer.locator('.send-button');
    const fill = () => send.evaluate(async el => {
      // Flush style before collecting transitions, then sample their final
      // colour. OS reduced-motion no longer disables the App's transitions.
      getComputedStyle(el).backgroundColor;
      await Promise.all(el.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
      return getComputedStyle(el).backgroundColor;
    });
    const disabledFill = await fill();
    await composer.locator('textarea').fill('保持这份草稿，不发送');
    await expect(send).toBeEnabled();
    const neutral = () => composer.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopColor, text: getComputedStyle(el.querySelector('textarea')!).color, plus: getComputedStyle(el.querySelector('.composer-toolbar .icon-button')!).color }));
    const marker = () => page.locator(".message.bot .markdown li").first().evaluate(node => ({ marker: getComputedStyle(node, "::marker").color, text: getComputedStyle(node).color }));
    await openSettings(page);
    await expect.poll(() => composer.evaluate(el => el.getAnimations().length)).toBe(0);
    const originalNeutral = await neutral();
    // New preferences use Warm Gray; an explicit opt-out remains authoritative.
    await expect(page.getByRole("radiogroup", { name: "黑白点缀色", exact: true })).toBeVisible();
    await page.locator('input[name="color-palette"][value="mono"]').check();
    const accents = page.getByRole("radiogroup", { name: "黑白点缀色", exact: true });
    await expect(accents).toBeVisible();
    await expect(accents.getByRole("radio", { name: "浅暖灰", exact: true })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-mono-accent", "warm-gray");
    await expect.poll(fill).toBe("rgb(231, 226, 220)");
    await accents.getByRole("radio", { name: "不使用", exact: true }).check();
    await closeSettings(page);
    await page.reload(); await waitForClientOnline(page);
    await selectConversation(page, "界面回归");
    await expect(page.locator("html")).toHaveAttribute("data-mono-accent", "none");
    await composer.locator('textarea').fill('保持这份草稿，不发送');
    const originalFill = await fill();
    // Explicitly disabling the accent keeps the marks in the text colour.
    await expect.poll(async () => { const value = await marker(); return value.marker === value.text; }).toBe(true);
    await openSettings(page);
    await expect(accents.getByRole("radio", { name: "不使用", exact: true })).toBeChecked();
    await page.getByRole("radiogroup", { name: "黑白点缀色", exact: true }).getByRole("radio", { name: "雾蓝", exact: true }).check();
    const modelIcons = page.getByRole('switch', { name: '显示模型图标', exact: true });
    await modelIcons.click(); await expect(modelIcons).not.toBeChecked();
    // App motion is always on: wait for the switch transition before retaining
    // its off colour as the reference for later toggle cycles.
    const offFill = await modelIcons.locator('.model-brand-toggle-track').evaluate(async el => {
      await Promise.all(el.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
      return getComputedStyle(el).backgroundColor;
    });
    await modelIcons.click(); await expect(modelIcons).toBeChecked();
    for (const { name } of monoAccents.filter(accent => accent.id !== 'none')) {
      await accents.getByRole('radio', { name, exact: true }).check();
      await expect.poll(fill).not.toBe(originalFill);
      expect(await neutral()).toEqual(originalNeutral);
      await expect.poll(async () => await modelIcons.locator('.model-brand-toggle-track').evaluate(el => getComputedStyle(el).backgroundColor) === await fill()).toBe(true);
      await modelIcons.click(); await expect(modelIcons).not.toBeChecked();
      await expect.poll(() => modelIcons.locator('.model-brand-toggle-track').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(offFill);
      await modelIcons.click(); await expect(modelIcons).toBeChecked();
      const contrast = await send.evaluate(el => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
        const lum = (color: string) => { ctx.fillStyle = color; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i]!,0); };
        const css = getComputedStyle(el), a = lum(css.color), b = lum(css.backgroundColor);
        return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      });
      expect(contrast, name).toBeGreaterThanOrEqual(4.5);
    }
    await accents.getByRole('radio', { name: '雾蓝', exact: true }).check();
    const selectedFill = await fill();
    await page.getByLabel('主题', { exact: true }).selectOption('dark');
    const darkFill = await fill();
    await accents.getByRole('radio', { name: '不使用', exact: true }).check();
    expect(await fill()).toBe(darkFill);
    await accents.getByRole('radio', { name: '雾蓝', exact: true }).check();
    await page.getByLabel('主题', { exact: true }).selectOption('system');
    await page.emulateMedia({ colorScheme: 'dark' }); await expect.poll(fill).toBe(darkFill);
    await page.emulateMedia({ colorScheme: 'light' }); await expect.poll(fill).toBe(selectedFill);
    await page.getByLabel('主题', { exact: true }).selectOption('light');
    await modelIcons.locator('..').screenshot({ path: info.outputPath('accent-switch-desktop.png'), animations: 'disabled' });
    await page.locator('.font-size-row').screenshot({ path: info.outputPath('accent-slider-desktop.png'), animations: 'disabled' });
    await closeSettings(page);
    await composer.screenshot({ path: info.outputPath('accent-send-desktop.png'), animations: 'disabled' });
    await page.locator('.host-workspace:not([hidden]) .conversation-header').screenshot({ path: info.outputPath('accent-connection-desktop.png'), animations: 'disabled' });
    await composer.locator('textarea').fill('');
    await expect(send).toBeDisabled(); expect(await fill()).toBe(disabledFill);
    await composer.locator('textarea').fill('保持这份草稿，不发送');
    await page.setViewportSize({ width: 390, height: 844 });
    await selectConversation(page, '界面回归');
    expect(await fill()).toBe(selectedFill);
    await composer.screenshot({ path: info.outputPath('accent-send-phone.png'), animations: 'disabled' });
    await page.locator('.host-workspace:not([hidden]) .conversation-header').screenshot({ path: info.outputPath('accent-connection-phone.png'), animations: 'disabled' });
    await openSettings(page);
    await modelIcons.locator('..').screenshot({ path: info.outputPath('accent-switch-phone.png'), animations: 'disabled' });
    await page.locator('.font-size-row').screenshot({ path: info.outputPath('accent-slider-phone.png'), animations: 'disabled' });
    await accents.getByRole('radio', { name: '浅暖灰', exact: true }).check();
    await expect(accents.locator('.mono-accent-swatch[data-accent=warm-gray]')).toHaveCSS('background-color', 'rgb(231, 226, 220)');
    for (const theme of ['light', 'dark', 'system']) for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByLabel('主题', { exact: true }).selectOption(theme);
      await expect(send).toHaveCSS('background-color', 'rgb(231, 226, 220)');
      await expect(send).toHaveCSS('color', 'rgb(81, 76, 69)');
      await expect(modelIcons.locator('.model-brand-toggle-track')).toHaveCSS('background-color', 'rgb(231, 226, 220)');
    }
    await page.getByLabel('主题', { exact: true }).selectOption('light');
    await accents.screenshot({ path: info.outputPath('warm-gray-settings-phone.png'), animations: 'disabled' });
    await closeSettings(page);
    await selectConversation(page, '界面回归');
    await composer.screenshot({ path: info.outputPath('light-warm-gray-composer-phone.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1360, height: 900 });
    await composer.screenshot({ path: info.outputPath('light-warm-gray-composer-desktop.png'), animations: 'disabled' });
    await expect(page.locator("html")).toHaveAttribute("data-mono-accent", "warm-gray");
    await expect.poll(async () => (await marker()).marker).toBe("rgb(163, 155, 145)");
    await page.reload(); await waitForClientOnline(page);
    await expect(page.locator("html")).toHaveAttribute("data-mono-accent", "warm-gray");
    await expect.poll(async () => (await marker()).marker).toBe("rgb(163, 155, 145)");
    // Other palettes neither show the choice nor inherit the tint.
    await openSettings(page);
    await expect(accents.getByRole('radio', { name: '浅暖灰', exact: true })).toBeChecked();
    await accents.screenshot({ path: info.outputPath('warm-gray-settings-desktop.png'), animations: 'disabled' });
    await page.locator('input[name="color-palette"][value="white-violet"]').check();
    await expect(page.getByRole("radiogroup", { name: "黑白点缀色", exact: true })).toHaveCount(0);
    await closeSettings(page);
    await expect.poll(async () => (await marker()).marker).not.toBe("rgb(163, 155, 145)");
  });
});

test("a chosen Monochrome accent also tints the reply status, typing dots, run spinner and active filter", async ({ page }) => {
  await fixture(page, async (hub, conversationId) => {
    await hub.store.publishBotMessage("alpha", { conversationId, status: "streaming", blocks: [{ type: "run", phase: "running", elapsedMs: 48000, tools: [], todos: [] }] });
    await expect(page.locator(".conversation-header .header-activity")).toContainText("正在回复");
    const signals = () => page.evaluate(() => {
      const style = (selector: string, pseudo?: string) => { const node = document.querySelector(selector); return node ? getComputedStyle(node, pseudo) : undefined; };
      return { status: style(".conversation-header .header-activity")?.color, dot: style(".conversation-header .activity-dot")?.backgroundColor, typing: style(".message-avatar.bot.is-working", "::before")?.color, spinner: style(".run-status .spin")?.color };
    });
    const mist = "rgb(125, 142, 163)";
    await page.evaluate(() => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.monoAccent = "none"; });
    // Without an accent every signal keeps the Monochrome primary.
    const plain = await signals();
    expect(Object.values(plain).every(Boolean)).toBe(true);
    expect([plain.dot, plain.typing, plain.spinner]).not.toContain(mist);
    await page.evaluate(() => { document.documentElement.dataset.monoAccent = "mist"; });
    await expect.poll(async () => (await signals()).dot).not.toBe(plain.dot);
    const accentSignal = (await signals()).dot!;
    expect(await signals()).toMatchObject({ dot: accentSignal, typing: accentSignal, spinner: accentSignal });
    expect((await signals()).status).not.toBe(plain.status);
    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    const underline = () => mobileHome(page).locator(".mh-chip[aria-pressed='true']").first().evaluate(node => getComputedStyle(node, "::after").backgroundColor);
    await expect.poll(underline).toBe(accentSignal);
    await page.evaluate(() => { document.documentElement.dataset.monoAccent = "none"; });
    await expect.poll(underline).not.toBe(accentSignal);
  });
});

for (const width of [320, 390, 1024]) test(`integrated card actions retain full touch targets (${width})`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  try { await fixture(page, async (hub, conversationId) => {
    await page.evaluate(() => { document.documentElement.dataset.platform = 'ios'; });
    const msg = await hub.store.publishBotMessage('alpha', { conversationId, status: 'complete', blocks: [{ type: 'card', title: '操作选项', elements: [
      { type: 'button', text: '稍后处理', actionId: 'later' },
      { type: 'select', text: '选择操作', actionId: 'pick', options: [{ label: '保留', value: 'keep' }] },
    ] }] });
    const row = page.locator(`[data-message-id="${msg.id}"]`);
    await expect(row.locator('.card-button')).toBeVisible();
    for (const palette of ['mono','white-violet','white-orange']) for (const theme of ['light','dark']) {
      await page.evaluate(({palette,theme}) => { document.documentElement.dataset.palette=palette; document.documentElement.dataset.theme=theme; }, {palette,theme});
      for (const control of await row.locator('button.card-button, .card-field select').all()) {
        expect.soft((await control.boundingBox())!.height, `${palette}/${theme}`).toBeGreaterThanOrEqual(44);
      }
    }
    await page.screenshot({path:info.outputPath(`cards-touch-${width}.png`),animations:'disabled'});
  }); } finally { await context.close(); }
});

for (const width of [320,390,1024]) test(`integrated operations long names fit beside actionable avatar controls (${width})`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport:{width,height:844},hasTouch:true,reducedMotion:'reduce',serviceWorkers:'block' });
  const page = await context.newPage();
  try { await fixture(page, async (hub) => {
    await openWorkspacePage(page,'运行状态');
    const card=page.locator('.operation-bot').first();
    await expect(card.locator('header')).toContainText('LongUnbrokenBotName');
    for (const theme of ['light','dark']) {
      await page.evaluate(theme=>{ document.documentElement.dataset.theme=theme; },theme);
      const geometry=await card.evaluate(node=>{
        const box=node.getBoundingClientRect(), head=node.querySelector('header')!.getBoundingClientRect(), text=node.querySelector('header strong')!.getBoundingClientRect(), button=node.querySelector('.avatar-setting>button')!.getBoundingClientRect();
        return {fits:node.scrollWidth<=node.clientWidth,headerContained:head.right<=button.left,textContained:text.right<=button.left,buttonContained:button.right<=box.right};
      });
      expect.soft(geometry).toEqual({fits:true,headerContained:true,textContained:true,buttonContained:true});
      await page.screenshot({path:info.outputPath(`ops-${width}-${theme}.png`),animations:'disabled'});
    }
    await card.getByRole('button',{name:/^设置.*头像$/}).click();
    const editor=page.locator('dialog[open]'); await expect(editor).toBeVisible();
    await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0);
    await expect(card.getByRole('button',{name:/^设置.*头像$/})).toBeFocused();
  }, 'LongUnbrokenBotName'.repeat(4)); } finally { await context.close(); }
});

// Numbered list markers and links carry meaning, so swatch colours must remain
// readable as text on both canvases, rather than being reused unadjusted.
test('Monochrome accent text remains readable and forced-colors exposes selected swatches', async ({ page, browserName }, info) => {
  await fixture(page, async (hub, conversationId) => {
    await hub.store.publishBotMessage('alpha', { conversationId, status:'complete', blocks:[{type:'text',text:'1. 第一项\n2. [查看说明](https://example.com)'}] });
    const item=page.locator('.message.bot .markdown ol>li').first(); await expect(item).toBeVisible();
    await hub.store.publishBotMessage('alpha', { conversationId, status:'streaming', blocks:[{type:'run',phase:'running',elapsedMs:1000,tools:[],todos:[]}] });
    await expect(page.locator('.header-activity')).toContainText('正在回复');
    const values=[];
    for (const theme of ['light','dark']) for (const { id: accent } of monoAccents.filter(accent => accent.id !== 'none')) {
      await page.evaluate(({theme,accent})=>{document.documentElement.dataset.palette='mono'; document.documentElement.dataset.theme=theme;document.documentElement.dataset.monoAccent=accent;},{theme,accent});
      const ratio=await item.evaluate(node=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d')!;
        const lum=(color:string)=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i]!,0);};
        const ratio = (el: Element, pseudo?: string, property = 'color') => {
          let bgElement: Element | null = el;
          while(bgElement && getComputedStyle(bgElement).backgroundColor === 'rgba(0, 0, 0, 0)') bgElement=bgElement.parentElement;
          const bg=lum(bgElement ? getComputedStyle(bgElement).backgroundColor : '#fff'), fg=lum(getComputedStyle(el,pseudo).getPropertyValue(property));
          return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);
        };
        return {marker:ratio(node,'::marker'),link:ratio(document.querySelector('.message.bot .markdown a')!),status:ratio(document.querySelector('.header-activity')!),spinner:ratio(document.querySelector('.run-status .spin')!)};
      });values.push({theme,accent,ratio});
      for(const key of ['marker','link','status'] as const) expect.soft(ratio[key],`${theme}/${accent} ${key}`).toBeGreaterThanOrEqual(4.5);
      expect.soft(ratio.spinner,`${theme}/${accent} spinner`).toBeGreaterThanOrEqual(3);
    }
    await info.attach('accent-contrast',{body:JSON.stringify(values),contentType:'application/json'});
    if(browserName==='chromium') {
      await openSettings(page);await page.getByRole('radiogroup',{name:'黑白点缀色',exact:true}).getByRole('radio',{name:'雾蓝',exact:true}).check();
      await page.emulateMedia({forcedColors:'active'});
      const radio=page.getByRole('radio',{name:'雾蓝',exact:true});
      const state=await radio.evaluate(el=>({opacity:getComputedStyle(el).opacity,appearance:getComputedStyle(el).appearance}));
      expect.soft(state).toEqual({opacity:'1',appearance:'auto'});
    }
  });
});

// Canvas resolves both rgb() and color(srgb ...) from CSS color-mix; parsing
// numeric substrings as byte RGB would silently mismeasure mixed accent colours.
async function signalPaint(page: Page, selector: string) {
  return page.locator(selector).filter({ visible: true }).first().evaluate(node => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const rgba = (value: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const background = (el: Element): number[] => {
      const c = rgba(getComputedStyle(el).backgroundColor), a = c[3]! / 255;
      const under = el.parentElement ? background(el.parentElement) : [255, 255, 255];
      return c.slice(0, 3).map((v, i) => v * a + under[i]! * (1 - a));
    };
    const luminance = (c: number[]) => c.slice(0, 3).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i]!, 0);
    const foreground = rgba(getComputedStyle(node).color).slice(0, 3), bg = background(node);
    const f = luminance(foreground), b = luminance(bg);
    return { foreground, background: bg, ratio: (Math.max(f, b) + .05) / (Math.min(f, b) + .05) };
  });
}

test('phone unread avatars stay red while the aggregate follows the optional accent', async ({ page, browserName }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, async (hub, chat) => {
    const head = await hub.store.db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM events');
    await hub.store.markRead('owner', chat, head!.seq);
    await openMobileHome(page);
    const avatar = '.mobile-home .mh-avatar > .mh-badge', total = '.mobile-home .mh-tab-badge';
    await expect(page.locator(avatar).filter({ visible: true })).toHaveText('1');
    for (const platform of ['android', 'ios']) for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      for (const { id: monoAccent } of monoAccents) {
        await page.evaluate(values => Object.assign(document.documentElement.dataset, values), { platform, palette: 'mono', theme, monoAccent });
        const badge = await signalPaint(page, avatar), summary = await signalPaint(page, total);
        expect(badge.background).toEqual([209, 62, 66]); expect(badge.foreground).toEqual([255, 255, 255]);
        expect(badge.ratio).toBeGreaterThanOrEqual(4.5); expect(summary.ratio).toBeGreaterThanOrEqual(4.5);
        if (monoAccent === 'none') expect(summary.background).toEqual([115, 115, 115]);
        else if (monoAccent === 'warm-gray') { expect(summary.background).toEqual([231, 226, 220]); expect(summary.foreground).toEqual([81, 76, 69]); }
        else expect(summary.background).not.toEqual([115, 115, 115]);
        await expect(page.locator(total).filter({ visible: true })).toHaveText('1');
        if (monoAccent === 'mist' && theme !== 'system') await page.screenshot({ path: info.outputPath(`unread-${platform}-${theme}.png`), animations: 'disabled' });
      }
    }
    // Other palettes must not override the phone's red with their neutral style.
    for (const palette of ['white-violet', 'white-orange', 'cli', 'pixel', 'tty', 'paper', 'agent']) {
      await page.evaluate(palette => Object.assign(document.documentElement.dataset, { palette, theme: 'light' }), palette);
      expect((await signalPaint(page, avatar)).background).toEqual([209, 62, 66]);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    // Desktop uses a dot but keeps the real count available to assistive tools.
    const desktopBadge = page.locator('.sidebar .unread-badge').filter({ visible: true });
    for (const palette of ['mono', 'white-violet', 'white-orange', 'cli']) for (const theme of ['light', 'dark', 'system']) {
      await page.evaluate(values => Object.assign(document.documentElement.dataset, values), { palette, theme, monoAccent: 'warm-gray', platform: 'web' });
      const badge = await signalPaint(page, '.sidebar .unread-badge');
      expect(badge.background).toEqual([209, 62, 66]); expect(badge.foreground).toEqual([255, 255, 255]);
      expect(badge.ratio).toBeGreaterThanOrEqual(4.5);
      await expect(desktopBadge).toHaveText('1');
      await expect(desktopBadge).toHaveAccessibleName('1 条新消息');
      await expect(desktopBadge).toHaveCSS('width', '8px');
      await expect(desktopBadge).toHaveCSS('height', '8px');
      await expect(desktopBadge).toHaveCSS('font-size', '0px');
      if (palette === 'mono' && theme !== 'system') await page.screenshot({ path: info.outputPath(`unread-desktop-${theme}.png`), animations: 'disabled' });
    }
    await page.getByRole('button', { name: '按对话', exact: true }).click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => Object.assign(document.documentElement.dataset, { palette: 'mono', theme, monoAccent: 'none' }), theme);
      await expect(desktopBadge).toHaveCSS('width', '8px');
      await expect(desktopBadge).toHaveAccessibleName('1 条新消息');
      await page.mouse.move(1200, 600);
      await page.screenshot({ path: info.outputPath(`unread-conversations-${theme}.png`), animations: 'disabled' });
    }
    await page.getByRole('button', { name: '打开 ADHD 模式', exact: true }).click();
    await expect(desktopBadge).toHaveCSS('height', '8px');
    await expect(desktopBadge).toHaveAccessibleName('1 条新消息');
    await page.getByRole('button', { name: '按对话', exact: true }).click();
    if (browserName === 'chromium') {
      await page.emulateMedia({ forcedColors: 'active' });
      const visibleDot = await desktopBadge.evaluate(node => getComputedStyle(node).backgroundColor !== getComputedStyle(node.closest('.sidebar')!).backgroundColor);
      expect(visibleDot).toBe(true);
      await page.emulateMedia({ forcedColors: 'none' });
    }
    // Opening and reading the actual conversation clears its indicator.
    await selectConversation(page, '稍后阅读');
    await expect(desktopBadge).toHaveCount(0);
  });
});

for (const width of [390, 1360]) test(`recording waveform and timer follow accents without changing cancellation at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await microphone(page);
  await fixture(page, async (hub, chat) => {
    const before = (await hub.store.snapshot('owner', chat)).messages.length;
    await page.getByRole('button', { name: '录制语音', exact: true }).click();
    let point: { x: number; y: number } | undefined;
    if (width === 390) {
      const box = (await page.getByRole('button', { name: '按住说话', exact: true }).boundingBox())!;
      point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(point.x, point.y); await page.mouse.down();
    }
    await expect(page.getByText('正在录音', { exact: true })).toBeVisible();
    await expect(page.getByLabel('录音时长', { exact: true })).not.toHaveText('00:00');
    const panel = width === 390 ? '.hold-voice-panel' : '.voice-recording';
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      const colors: string[] = [];
      for (const { id: monoAccent } of monoAccents) {
        await page.evaluate(values => Object.assign(document.documentElement.dataset, values), { palette: 'mono', theme, monoAccent });
        const time = await signalPaint(page, `${panel} time`), wave = await signalPaint(page, `${panel} .voice-waveform`);
        expect(time.foreground).toEqual(wave.foreground); expect(time.ratio).toBeGreaterThanOrEqual(4.5);
        colors.push(time.foreground.join(','));
        if (monoAccent === 'mist' && theme !== 'system') await page.screenshot({ path: info.outputPath(`recording-${width}-${theme}.png`), animations: 'disabled' });
      }
      expect(new Set(colors).size).toBe(monoAccents.length);
    }
    // Non-monochrome palettes use their accent too, on a different recording
    // surface. Exercise the real recorder UI, not just injected token samples.
    for (const { id: palette } of colorPalettes.filter(value => value.id !== 'mono')) for (const theme of palette === 'cli' ? ['dark'] : ['light', 'dark']) {
      await page.evaluate(values => Object.assign(document.documentElement.dataset, values), { palette, theme });
      const time = await signalPaint(page, `${panel} time`), wave = await signalPaint(page, `${panel} .voice-waveform`);
      expect(time.foreground).toEqual(wave.foreground);
      expect(time.ratio, `${width}/${palette}/${theme}`).toBeGreaterThanOrEqual(4.5);
    }
    if (point) {
      const normal = await signalPaint(page, `${panel} time`);
      await page.mouse.move(point.x, point.y - 100);
      await expect(page.locator('.hold-voice')).toHaveClass(/is-cancelling/);
      const cancelled = await signalPaint(page, `${panel} time`), wave = await signalPaint(page, `${panel} .voice-waveform`);
      expect(cancelled.foreground).toEqual(wave.foreground); expect(cancelled.foreground).not.toEqual(normal.foreground);
      expect(cancelled.foreground[0]).toBeGreaterThan(cancelled.foreground[1]!);
      await page.mouse.up();
    } else await page.getByRole('button', { name: '取消录音', exact: true }).click();
    await expect(page.locator(panel)).toHaveCount(0);
    expect((await hub.store.snapshot('owner', chat)).messages.length).toBe(before);
  });
});

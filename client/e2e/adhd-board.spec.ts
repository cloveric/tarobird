import { setListOption } from "./fixtures/mobile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConversationFolders } from "../../src/hub/conversation-folders.js";
import { adhdLegacyBoardSchema } from "../src/adhd-board-state.js";
import { DEFAULT_PALETTE } from "../src/palettes.js";
import { HubServer } from "../../src/hub/server.js";
import { HubAvatars } from "../../src/hub/avatars.js";
import { avatarDataUrl } from "../../tests/helpers/avatar-fixture.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { settleReadingLayout } from "./fixtures/reading-position.js";
import { selectConversation } from "./fixtures/mobile.js";
// Keep route-controlled upload tests independent of service-worker fetch ownership.
test.use({ serviceWorkers: "block" });
async function pair(page: Page, hub: HubServer, name: string) {
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  await page.getByLabel("主机名称", { exact: true }).fill(name); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
}
async function bot(hub: HubServer, root: string, id: string, name: string, received: string[], handle?: CoreBridgeLike["handleAuthorizedMessage"]) {
  const stateDir = path.join(root, id); await mkdir(stateDir, { recursive: true }); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET secret_hash=excluded.secret_hash", [id, name, hashSecret(secret)]);
  return attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: id, secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async input => { received.push(input.text); if (handle) return handle(input); return { text: `${name} 已收到：${input.text}` }; } } });
}
const pane = (page: Page, id: string) => page.locator(`.adhd-card[data-pane-conversation="${id}"]`);

test("ADHD display selects keep text clear of chevrons and rings follow input intent", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-display-selects-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    await hub.store.createConversation("owner", ["alpha"], "布局检查", "selects");
    await page.goto(hub.url); await pair(page, hub, "测试主机");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const columns = page.getByLabel("ADHD 每行窗口数", { exact: true });
    const font = page.getByLabel("ADHD 窗口字号", { exact: true });
    await expect(columns).toBeEnabled();
    for (const width of [1360, 900]) {
      await page.setViewportSize({ width, height: 900 });
      for (const palette of ["mono", "white-orange", "cli"]) for (const theme of ["light", "dark"]) {
        await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
        for (const [control, values] of [[columns, ["0", "2", "6"]], [font, ["11", "12", "13", "14", "15", "16"]]] as const) {
          for (const value of values) {
            await control.selectOption(value);
            const metrics = await control.evaluate((node: HTMLSelectElement) => {
              const style = getComputedStyle(node), rect = node.getBoundingClientRect();
              const label = document.createElement("span");
              label.style.cssText = "position:fixed;visibility:hidden;white-space:pre";
              for (const property of ["font-family", "font-size", "font-weight", "font-style", "letter-spacing"]) label.style.setProperty(property, style.getPropertyValue(property));
              label.textContent = node.selectedOptions[0]!.textContent;
              document.body.append(label); const textWidth = label.getBoundingClientRect().width; label.remove();
              return { rightPadding: parseFloat(style.paddingRight), textWidth,
                textSpace: rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
                background: style.backgroundImage, visible: rect.right <= innerWidth && rect.left >= 0 };
            });
            const context = JSON.stringify({ width, palette, theme, value, metrics });
            // The largest shared chevron is 14px, inset 10px; reserve a gap too.
            expect.soft(metrics.rightPadding, context).toBeGreaterThanOrEqual(28);
            expect.soft(metrics.textSpace + 1, context).toBeGreaterThanOrEqual(metrics.textWidth);
            expect.soft(metrics.background, context).not.toBe("none");
            expect.soft(metrics.visible, context).toBe(true);
          }
        }
        if (palette === "mono") {
          await columns.selectOption("0"); await font.selectOption("12");
          await page.locator(".adhd-toolbar").screenshot({ path: info.outputPath(`selects-${width}-${theme}.png`) });
        }
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = "light"; });
    // Native selects can retain :focus-visible after mouse selection in WebKit.
    await font.focus(); await font.press("ArrowUp");
    await expect(font).toBeFocused();
    await expect(font).not.toHaveCSS("box-shadow", "none");
    await font.dispatchEvent("pointerdown", { pointerType: "mouse" });
    await expect(font).toBeFocused();
    await expect(font).toHaveCSS("box-shadow", "none");
    await font.press("ArrowDown");
    await expect(font).not.toHaveCSS("box-shadow", "none");
    await font.dispatchEvent("pointerdown", { pointerType: "touch" });
    await expect(font).toHaveCSS("box-shadow", "none");
    await columns.selectOption("3"); await font.selectOption("14");
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled();
    await page.reload();
    // An empty board reopens in ordinary chat; its display preferences still persist.
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(columns).toHaveValue("3"); await expect(font).toHaveValue("14");
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD removes message portraits without leaving gutters or changing ordinary chat identities", async ({ page }, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-message-portraits-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "研究助手", []);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','设计助手','fixture')");
    await new HubAvatars(hub.store).set("owner", { kind: "bot", id: "beta" }, { expectedRevision: 0, dataUrl: avatarDataUrl() });
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "群聊作者验收", "portraits", { type: "group" });
    const chats = [group];
    for (let i = 0; i < 2; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `并排窗口 ${i + 1}`, `portrait-peer-${i}`));
    await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "question", text: "去掉消息头像后，仍能认出每位 Bot 的发言。", attachments: [] });
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: group.id, status: "streaming", blocks: [{ type: "text", text: "正在核对，窄窗口里的文字应正常换行。" }] });
    await hub.store.publishBotMessage("beta", { conversationId: group.id, status: "complete", blocks: [{ type: "text", text: "这条回复使用上传的自定义头像。" }] });
    await page.goto(hub.url); await pair(page, hub, "测试主机");
    const checkPortraits = async (scope: Locator) => {
      const rows = scope.locator(".message.bot");
      await expect(rows).toHaveCount(2);
      for (const id of ["alpha", "beta"]) {
        const avatar = scope.locator(`.message-avatar.bot [data-avatar="bot:${id}"]`);
        await expect(avatar).toBeVisible();
        await expect(avatar.locator("img")).toBeVisible();
        await expect.poll(() => avatar.locator("img").evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
        if (id === "alpha") await expect(avatar).toHaveAttribute("data-preset");
        else await expect(avatar.locator("img")).toHaveAttribute("src", /^blob:/);
      }
      // Visibility alone misses zero-width gutters and avatars overlapping text.
      expect(await rows.evaluateAll(nodes => nodes.every(row => {
        const portrait = row.querySelector(".message-avatar")!.getBoundingClientRect();
        const body = row.querySelector(".message-body")!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return portrait.width >= 18 && portrait.height >= 18 && portrait.right + 1 <= body.left && body.right <= bounds.right + 1;
      }))).toBe(true);
      await expect(scope.locator(".message.user .message-avatar")).toBeHidden();
      expect(await scope.locator(".message-scroll").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    };
    const normal = page.locator(".host-workspace:not([hidden])");
    await normal.locator(`.sidebar [data-conversation-id="${group.id}"]`).click();
    await checkPortraits(normal);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("3");
    const card = pane(page, group.id);
    const author = card.locator(`.message[data-message-id="${reply.id}"] .message-meta>strong`);
    const marker = () => author.evaluate(node => { const style = getComputedStyle(node, "::after"); return { content: style.content, display: style.display, width: style.width, animation: style.animationName }; });
    const checkTextOnly = async () => {
      const rows = card.locator(".message.bot");
      await expect(rows).toHaveCount(2);
      for (const avatar of await card.locator(".message-avatar").all()) await expect(avatar).toBeHidden();
      await expect(rows.locator(".message-meta strong")).toHaveText(["研究助手", "设计助手"]);
      expect(await rows.evaluateAll(nodes => nodes.every(row => {
        const body = row.querySelector(".message-body")!.getBoundingClientRect(), bounds = row.getBoundingClientRect();
        return Math.abs(body.left - bounds.left) <= 1 && body.right <= bounds.right + 1 && body.width >= bounds.width - 1;
      }))).toBe(true);
      expect(await card.locator(".message-scroll").evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    };
    for (const palette of ["white-violet", "mono", "cli"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      await checkTextOnly();
      expect(await marker()).toMatchObject({ content: '""', display: 'inline-block', width: '3px' });
      if (palette === "mono") await page.screenshot({ path: info.outputPath(`message-text-only-adhd-${theme}.png`) });
    }
    await expect(card.locator(`.message[data-message-id="${reply.id}"] .message-avatar`)).toHaveClass(/is-working/);
    await page.evaluate(() => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = "light"; document.documentElement.dataset.monoAccent = "mist"; });
    for (const font of ["11", "16"]) {
      await page.getByLabel("ADHD 窗口字号", { exact: true }).selectOption(font);
      await checkTextOnly();
      expect(await author.evaluate(node => getComputedStyle(node).fontSize)).toBe(await author.locator("..").evaluate(node => getComputedStyle(node).fontSize));
      await page.screenshot({ path: info.outputPath(`message-author-size-${font}.png`) });
    }
    await card.getByRole("button", { name: "放大此面板", exact: true }).click();
    await checkTextOnly();
    await page.screenshot({ path: info.outputPath('expanded-author-and-activity.png') });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await marker()).animation).toBe('tc-reply-dots');
    await hub.store.publishBotMessage("alpha", { id: reply.id, conversationId: group.id, status: "complete", blocks: [{ type: "text", text: "核对完成，作者名称保留。" }] });
    await expect(card.locator(`.message[data-message-id="${reply.id}"] .message-avatar`)).not.toHaveClass(/is-working|is-pending/);
    expect((await marker()).content).toBe('none');
    await checkTextOnly();
    await card.getByRole("button", { name: "在单对话中打开", exact: true }).click();
    await checkPortraits(normal);
    for (const platform of ["ios", "android"]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(platform => { document.documentElement.dataset.platform = platform; document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = "light"; }, platform);
      await selectConversation(page, group.title);
      await checkPortraits(normal);
      await page.screenshot({ path: info.outputPath(`message-portraits-${platform}.png`) });
    }
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD topics start collapsed on every visit while search, drafts and ordinary folds stay independent", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-topic-fold-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const group = await hub.store.createConversation("owner", ["alpha"], "测试群组", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["alpha"], "回归话题", "topic", { parentId: group.id });
    const other = await hub.store.createConversation("owner", ["alpha"], "另一个话题", "other", { parentId: group.id });
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    const normal = page.locator(".host-workspace:not([hidden])");
    await normal.locator(`.sidebar [data-conversation-id="${topic.id}"]`).click();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const initialToggle = page.locator(".adhd-topic-toggle");
    await expect(initialToggle).toHaveAttribute("aria-expanded", "false");
    await initialToggle.click();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 回归话题", exact: true }).check();
    const card = pane(page, topic.id), input = card.locator(".composer textarea");
    await input.fill("折叠和切换模式不能丢失这份草稿");
    const tree = page.locator(".adhd-picker-list .adhd-group-topics").filter({ has: page.locator(`[data-conversation-id="${group.id}"]`) });
    const toggle = tree.locator(".adhd-topic-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(tree.locator(`[data-conversation-id="${topic.id}"]`)).toBeHidden();
    for (const mode of ["按对话", "按 Bot", "返回聊天"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      await expect(normal.locator(".conversation-header h1")).toHaveText(topic.title);
      await expect(normal.locator(".composer textarea")).toHaveValue("折叠和切换模式不能丢失这份草稿");
      if (mode === "按 Bot") {
        // ADHD's local choice must not change the ordinary sidebar preference.
        await expect(normal.getByRole("button", { name: "收起「测试群组」的话题", exact: true })).toHaveAttribute("aria-expanded", "true");
        await expect(normal.locator(`.sidebar [data-conversation-id="${topic.id}"]`)).toBeVisible();
        await normal.getByRole("button", { name: "收起「测试群组」的话题", exact: true }).click();
      }
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(tree.locator(`[data-conversation-id="${topic.id}"]`)).toBeHidden();
      await input.focus();
      // Leave this visit expanded: re-entry must collapse it again.
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    await toggle.click();
    // Searching reveals matching children temporarily, without overwriting the fold.
    await page.getByRole("textbox", { name: "筛选面板对话", exact: true }).fill(topic.title);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(tree.locator(`[data-conversation-id="${topic.id}"]`)).toBeVisible();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await hub.store.publishBotMessage("alpha", { conversationId: other.id, blocks: [{ type: "text", text: "折叠期间到达的新回复" }], status: "complete" });
    // Draft previews intentionally take priority over incoming message text.
    await expect(tree.locator(`[data-conversation-id="${group.id}"] .unread-badge`)).toHaveText("1");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(input).toHaveValue("折叠和切换模式不能丢失这份草稿");
    await tree.screenshot({ path: info.outputPath("topics-stay-folded.png") });
    await toggle.click();
    await expect(tree.locator(`[data-conversation-id="${topic.id}"]`)).toBeVisible();
    // Querying away unmounts the slice; the board still owns its open state.
    await page.getByRole("textbox", { name: "筛选面板对话", exact: true }).fill("无匹配项");
    await expect(toggle).toHaveCount(0);
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    for (const theme of ["light", "dark"]) for (const accent of ["none", "sage", "warm-gray"]) {
      await page.evaluate(({ theme, accent }) => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = theme; document.documentElement.dataset.monoAccent = accent; }, { theme, accent });
      for (const density of ["compact", "standard", "comfortable"]) {
        await page.evaluate(density => { document.documentElement.dataset.density = density; }, density);
        const metrics = await tree.evaluate(node => {
          const rows = [...node.querySelectorAll<HTMLElement>(".topic-row")], label = node.querySelector<HTMLElement>(".adhd-topic-toggle>span")!;
          const parent = node.querySelector<HTMLElement>(".adhd-picker-row>.conversation-row")!;
          return { heights: rows.map(row => row.getBoundingClientRect().height), parent: parent.getBoundingClientRect().height,
            background: getComputedStyle(label).backgroundColor, ink: getComputedStyle(label).color };
        });
        expect(metrics.heights.every(height => height >= 30 && height <= 50), JSON.stringify({ theme, accent, density, metrics })).toBe(true);
        expect(metrics.heights.every(height => height < metrics.parent)).toBe(true);
        expect(metrics.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(metrics.ink).not.toBe(metrics.background);
      }
      await page.evaluate(() => { document.documentElement.dataset.density = "compact"; });
      await tree.screenshot({ path: info.outputPath(`topics-${theme}-${accent}.png`) });
    }
    await page.reload();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(tree.locator(`[data-conversation-id="${topic.id}"]`)).toBeHidden();
    await expect(input).toHaveValue("折叠和切换模式不能丢失这份草稿");
    await page.getByRole("button", { name: "按 Bot", exact: true }).click();
    await expect(normal.getByRole("button", { name: "展开「测试群组」的话题", exact: true })).toHaveAttribute("aria-expanded", "false");
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group topic folds stay independent for identical IDs on different hosts", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-topic-fold-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const ga = await bot(a, path.join(root, "ba"), "alpha", "助手", []), gb = await bot(b, path.join(root, "bb"), "alpha", "助手", []);
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,parent_id,created_at,client_action_id) VALUES('same-group','group','同名群组','owner',NULL,1,'group'),('same-topic','group','同名话题','owner','same-group',2,'topic')");
      for (const id of ["same-group", "same-topic"]) {
        await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [id]);
        await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot','alpha',0)", [id]);
      }
    }
    await page.goto(a.url); await pair(page, a, "主机 A"); await clickAppAction(page, "连接另一台主机"); await pair(page, b, "主机 B");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const tree = (name: string) => page.locator(".adhd-group-topics").filter({ has: page.getByRole("checkbox", { name: `加入面板：${name} · 同名群组`, exact: true }) });
    const toggleA = tree("主机 A").locator(".adhd-topic-toggle"), toggleB = tree("主机 B").locator(".adhd-topic-toggle");
    await expect(toggleA).toHaveAttribute("aria-expanded", "false");
    await expect(toggleB).toHaveAttribute("aria-expanded", "false");
    await toggleA.click();
    await expect(toggleA).toHaveAttribute("aria-expanded", "true");
    await expect(toggleB).toHaveAttribute("aria-expanded", "false");
    await setListOption(page, '按主机分组', true);
    await expect(toggleA).toHaveAttribute("aria-expanded", "true");
    await expect(toggleB).toHaveAttribute("aria-expanded", "false");
    await toggleB.click();
    await toggleA.click();
    await expect(toggleB).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "按对话", exact: true }).click();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(toggleA).toHaveAttribute("aria-expanded", "false");
    await expect(toggleB).toHaveAttribute("aria-expanded", "false");
    await toggleA.click();
    await page.reload();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(toggleA).toHaveAttribute("aria-expanded", "false");
    await expect(toggleB).toHaveAttribute("aria-expanded", "false");
  } finally { await page.close(); await ga.disconnect(); await gb.disconnect(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD mode switches open the focused chat or topic and retain each draft", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-mode-selection-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const old = await hub.store.createConversation("owner", ["alpha"], "进入前的对话", "old");
    const chat = await hub.store.createConversation("owner", ["alpha"], "正在处理的对话", "focused");
    const group = await hub.store.createConversation("owner", ["alpha"], "项目群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["alpha"], "当前话题", "topic", { parentId: group.id });
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    const normal = page.locator(".host-workspace:not([hidden])");
    await normal.locator(`.sidebar [data-conversation-id="${old.id}"]`).click();
    await normal.locator(".composer textarea").fill("进入前的草稿");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    // An empty board has no new target and keeps the ordinary chat.
    await page.getByRole("button", { name: "按对话", exact: true }).click();
    await expect(normal.locator(".composer textarea")).toHaveValue("进入前的草稿");
    for (const [target, mode, focus] of [[chat, "按对话", "pointer"], [topic, "按对话", "sidebar"], [chat, "按 Bot", "keyboard"], [topic, "返回聊天", "pointer"]] as const) {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await expect(page.getByLabel("ADHD 每行窗口数", { exact: true })).toBeEnabled();
      await page.locator(".adhd-topic-toggle").click();
      for (const item of [old, chat, topic]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${item.title}`, exact: true }).check();
      const card = pane(page, target.id), input = card.locator(".composer textarea");
      await input.fill(`保留草稿：${target.title}`);
      await pane(page, old.id).locator(".composer textarea").click();
      if (focus === "sidebar") await page.locator(`.adhd-picker-list [data-conversation-id="${target.id}"]`).click();
      else if (focus === "keyboard") await input.focus();
      else await card.locator(".message-scroll").click();
      await expect(card).toHaveClass(/is-focused/);
      await page.getByRole("button", { name: mode, exact: true }).click();
      await expect(page.locator(".adhd-shell")).toHaveCount(0);
      await expect(normal.locator(".conversation-header h1")).toHaveText(target.title);
      await expect(normal.locator(".composer textarea")).toHaveValue(`保留草稿：${target.title}`);
      await expect(normal.locator(".composer textarea")).toBeFocused();
      if (mode !== "返回聊天") await expect(normal.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(pane(page, old.id).locator(".composer textarea")).toHaveValue("进入前的草稿");
    await expect(page.locator(".adhd-card")).toHaveCount(3);
    // Reopening the saved board without selecting a pane keeps the last ordinary chat.
    await page.getByRole("button", { name: "按对话", exact: true }).click();
    await expect(normal.locator(".conversation-header h1")).toHaveText(topic.title);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD mode switches preserve the owning host for identical conversation IDs", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-mode-host-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const ga = await bot(a, path.join(root, "ba"), "alpha", "同名 Bot", []), gb = await bot(b, path.join(root, "bb"), "alpha", "同名 Bot", []);
  try {
    for (const [hub, label] of [[a, "A"], [b, "B"]] as const) {
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','bot','alpha',0)");
      await hub.store.publishBotMessage("alpha", { conversationId: "same", blocks: [{ type: "text", text: `主机 ${label} 的记录` }], status: "complete" });
    }
    await page.goto(a.url); await pair(page, a, "主机 A"); await clickAppAction(page, "连接另一台主机"); await pair(page, b, "主机 B");
    for (const label of ["A", "B"]) {
      await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
      await expect(page.getByLabel("ADHD 每行窗口数", { exact: true })).toBeEnabled();
      for (const name of ["主机 A", "主机 B"]) await page.getByRole("checkbox", { name: `加入面板：${name} · 同名对话`, exact: true }).check();
      const card = page.getByRole("region", { name: `对话面板：主机 ${label} · 同名对话`, exact: true });
      await card.locator(".composer textarea").fill(`${label} 专属草稿`);
      await page.getByRole("button", { name: "按对话", exact: true }).click();
      const normal = page.locator(".host-workspace:not([hidden])");
      await expect(normal.getByText(`主机 ${label} 的记录`, { exact: true })).toBeVisible();
      await expect(normal.locator(".composer textarea")).toHaveValue(`${label} 专属草稿`);
      await expect(normal.locator(".composer textarea")).toBeFocused();
    }
  } finally { await page.close(); await ga.disconnect(); await gb.disconnect(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD header blank space previews and settles pane moves without stealing controls or drafts", async ({ page }, info) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-header-motion-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const chats = [];
    for (let i = 0; i < 3; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `窗口 ${i}`, `motion-${i}`));
    await page.goto(hub.url); await pair(page, hub, "测试主机");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("3");
    const first = pane(page, chats[0]!.id), second = pane(page, chats[1]!.id), grid = page.locator(".adhd-grid");
    const original = chats.map(chat => chat.id);
    const order = () => page.locator(".adhd-card").evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.paneConversation));
    const settled = () => expect.poll(() => grid.evaluate(node => node.getAnimations({ subtree: true }).filter(a => (a.effect as KeyframeEffect)?.getKeyframes().some(f => f.transform !== undefined)).length)).toBe(0);
    const beginBlank = async () => {
      await settled();
      const point = await first.locator(".conversation-header").evaluate(header => {
        const rect = header.getBoundingClientRect(), y = rect.top + rect.height / 2;
        for (let x = rect.left + 35; x < rect.right - 30; x += 2) {
          const node = document.elementFromPoint(x, y);
          if (node && header.contains(node) && node.matches(".header-title,.header-heading-row,.conversation-header")) return { x, y };
        }
        throw new Error("Expected real blank header space between the title and controls");
      });
      await page.mouse.move(point.x, point.y); await page.mouse.down(); return point;
    };
    await first.locator(".composer textarea").fill("移动后仍在这一个窗口的草稿");
    const editor = await first.locator(".composer textarea").elementHandle();
    // Instrument actual pointerdown geometry to check a second pickup while
    // the first drop animation is still in flight, without a timing guess.
    await first.evaluate(node => {
      node.addEventListener("pointerdown", () => { (node as HTMLElement).dataset.pickupLeft = String(node.getBoundingClientRect().left); }, true);
      // Record the real animation as it is created. Polling getAnimations()
      // after the async order assertion can miss a short, already-finished drop.
      const animate = node.animate;
      node.animate = function (...args) {
        const animation = animate.apply(this, args);
        if ((animation.effect as KeyframeEffect)?.getKeyframes().some(frame => frame.transform !== undefined)) {
          (node as HTMLElement).dataset.dropAnimationCount = String(Number((node as HTMLElement).dataset.dropAnimationCount ?? 0) + 1);
        }
        return animation;
      };
    });
    // A slight wobble is still a click, and control hit areas never start drags.
    const point = await beginBlank(); await page.mouse.move(point.x + 3, point.y + 1); await page.mouse.up();
    expect(await order()).toEqual(original); await expect(grid).not.toHaveAttribute("data-adhd-dragging", "true");
    await second.locator(".composer textarea").focus(); await beginBlank(); await page.mouse.up();
    await expect(second.locator(".composer textarea")).not.toBeFocused();
    for (const control of await first.locator(".conversation-header button:visible:not(.adhd-grip)").all()) {
      await expect(control).not.toHaveCSS("cursor", "grab");
      const box = (await control.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 3 });
      await expect(grid).not.toHaveAttribute("data-adhd-dragging", "true"); await page.mouse.up();
    }
    await first.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await expect(page.getByRole("group", { name: "聊天操作" })).toBeVisible(); await page.keyboard.press("Escape");
    const before = (await first.boundingBox())!, destination = (await second.boundingBox())!;
    await beginBlank(); await page.mouse.move(destination.x + destination.width / 2, destination.y + 70, { steps: 8 });
    await expect(second).toHaveAttribute("data-adhd-drop-target", "true");
    await expect.poll(async () => (await first.boundingBox())!.x).toBeGreaterThan(before.x + 60);
    await expect.poll(async () => (await second.boundingBox())!.x).toBeLessThan(destination.x - 60);
    expect(await order()).toEqual(original);
    // Hold still after the neighbour has moved: the original slot must stay
    // selected rather than oscillating between the animated card rectangles.
    await settled(); await expect(second).toHaveAttribute("data-adhd-drop-target", "true");
    expect(Math.abs((await page.locator(".adhd-drop-slot").boundingBox())!.x - destination.x)).toBeLessThan(1);
    await page.mouse.move(destination.x + destination.width + 5, destination.y + 70);
    await settled(); await expect(second).toHaveAttribute("data-adhd-drop-target", "true");
    expect(Math.abs((await page.locator(".adhd-drop-slot").boundingBox())!.x - destination.x)).toBeLessThan(1);
    await page.mouse.move(destination.x + destination.width / 2, destination.y + 70);
    await page.screenshot({ path: info.outputPath("header-drag-preview.png") });
    const animationsBeforeDrop = Number(await first.getAttribute("data-drop-animation-count") ?? 0);
    await page.mouse.up();
    await expect.poll(order).toEqual([original[1], original[0], original[2]]);
    await expect.poll(async () => Number(await first.getAttribute("data-drop-animation-count") ?? 0)).toBeGreaterThan(animationsBeforeDrop);
    await settled();
    expect(await first.locator(".composer textarea").evaluate((node, saved) => node === saved, editor)).toBe(true);
    await expect(first.locator(".composer textarea")).toHaveValue("移动后仍在这一个窗口的草稿");
    await expect(page.locator(".adhd-drop-slot,[data-adhd-dragging],[data-adhd-settling]")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("header-drag-settled.png") });
    // Re-grab during landing. Freeze the visual position at pointerdown and
    // keep the pointer's offset within that card when a new drag starts.
    const returnSlot = (await second.boundingBox())!;
    await beginBlank(); await page.mouse.move(returnSlot.x + 100, returnSlot.y + 70, { steps: 5 }); await page.mouse.up();
    await expect.poll(order).toEqual(original);
    const moving = (await first.locator(".adhd-grip").boundingBox())!;
    await page.mouse.move(moving.x + moving.width / 2, moving.y + moving.height / 2); await page.mouse.down();
    const pickedUp = Number(await first.getAttribute("data-pickup-left"));
    await page.mouse.move(moving.x + moving.width / 2 + 8, moving.y + moving.height / 2);
    await expect.poll(async () => Math.abs((await first.boundingBox())!.x - pickedUp - 8)).toBeLessThan(2);
    await page.keyboard.press("Escape"); await page.mouse.up(); await settled();
    // Restore the prior order before changing the system motion signal.
    await beginBlank(); await page.mouse.move(destination.x + destination.width / 2, destination.y + 70, { steps: 6 }); await page.mouse.up(); await settled();
    // Changing the system motion signal must not disable the return gesture.
    await page.emulateMedia({ reducedMotion: "reduce" });
    const back = (await second.boundingBox())!;
    await beginBlank(); await page.mouse.move(back.x + back.width / 2, back.y + 70, { steps: 6 });
    await expect(second).toHaveAttribute("data-adhd-drop-target", "true"); await settled();
    await page.mouse.up(); await expect.poll(order).toEqual(original); await settled();
    // Layout changes cancel the gesture and remove every transient transform.
    await beginBlank(); await page.mouse.move(destination.x + 80, destination.y + 70, { steps: 4 });
    await page.setViewportSize({ width: 1650, height: 900 }); await page.mouse.up();
    expect(await order()).toEqual(original);
    await expect(page.locator(".adhd-drop-slot,[data-adhd-dragging],[data-adhd-settling]")).toHaveCount(0);
    expect(await page.locator(".adhd-card").evaluateAll(nodes => nodes.every(node => !(node as HTMLElement).style.transform))).toBe(true);
    // macOS Control-click/context menus and a lost release cannot leave a
    // gesture armed for the next ordinary mouse movement.
    await page.keyboard.down("Control"); await beginBlank(); await page.mouse.move(destination.x + 100, destination.y + 70); await page.mouse.up(); await page.keyboard.up("Control"); await page.keyboard.press("Escape");
    await expect(grid).not.toHaveAttribute("data-adhd-dragging", "true"); expect(await order()).toEqual(original);
    await beginBlank(); await grid.dispatchEvent("pointermove", { pointerId: 1, buttons: 0, clientX: destination.x + 100, clientY: destination.y + 70 }); await page.mouse.up();
    await expect(grid).not.toHaveAttribute("data-adhd-dragging", "true"); expect(await order()).toEqual(original);
    const removed = pane(page, chats[2]!.id), handle = (await removed.locator(".adhd-grip").boundingBox())!;
    await page.mouse.move(handle.x + 12, handle.y + 13); await page.mouse.down();
    // Model a board change arriving while the pointer is still pending. The
    // source can disappear before crossing the 6px threshold.
    await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chats[2]!.title}`, exact: true }).evaluate(node => (node as HTMLInputElement).click());
    await expect(removed).toHaveCount(0);
    await page.mouse.move(handle.x - 30, handle.y + 60); await page.mouse.up();
    await expect(grid).not.toHaveAttribute("data-adhd-dragging", "true");
    // Recorded native WKWebView input reports buttons=0 on both down and move.
    // Preserve those gestures, while the reliable-buttons cancellation above
    // still detects a lost release in ordinary browser input.
    await page.evaluate(() => {
      for (const type of ["pointerdown", "pointermove"]) window.addEventListener(type, event => Object.defineProperty(event, "buttons", { value: 0 }), true);
    });
    const nativeTarget = (await second.boundingBox())!;
    await beginBlank(); await page.mouse.move(nativeTarget.x + nativeTarget.width / 2, nativeTarget.y + 70, { steps: 5 });
    await expect(second).toHaveAttribute("data-adhd-drop-target", "true");
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
    await page.mouse.up(); await expect.poll(order).toEqual([original[1], original[0]]); await settled();
    // Leaving the board cancels without selecting sidebar text in WKWebView.
    await beginBlank(); await page.mouse.move(180, 60, { steps: 8 });
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
    await page.mouse.up(); await settled();
    expect(await order()).toEqual([original[1], original[0]]);
    await expect(grid).not.toHaveAttribute("data-adhd-dragging", "true");
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD reordering preserves every pane's independent history position", async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-reorder-reading-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const chats = [];
    for (let i = 0; i < 3; i++) {
      const chat = await hub.store.createConversation("owner", ["alpha"], `历史 ${i}`, `reading-${i}`); chats.push(chat);
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: Array.from({ length: 50 }, (_, n) => `第 ${n} 段：${"保持每个窗口的独立阅读位置。".repeat(5)}`).join("\n\n") }] });
    }
    await page.goto(hub.url); await pair(page, hub, "测试主机");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("3");
    for (const [i, chat] of chats.entries()) {
      const scroll = pane(page, chat.id).locator(".message-scroll"); await settleReadingLayout(scroll);
      await scroll.evaluate((node, top) => { node.scrollTop = top; }, 150 + i * 120); await settleReadingLayout(scroll);
    }
    const tops = async () => Promise.all(chats.map(chat => pane(page, chat.id).locator(".message-scroll").evaluate(node => node.scrollTop)));
    const before = await tops(); expect(before.every(top => top > 100)).toBe(true);
    const check = async () => { for (const chat of chats) await settleReadingLayout(pane(page, chat.id).locator(".message-scroll")); expect(await tops()).toEqual(before); };
    const first = pane(page, chats[0]!.id), last = pane(page, chats[2]!.id);
    const from = (await first.locator(".adhd-card-host").boundingBox())!, to = (await last.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 180, { steps: 8 });
    await expect(last).toHaveAttribute("data-adhd-drop-target", "true");
    expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toBe("");
    await page.mouse.up(); await check();
    // Move last -> first; React can physically move all the other DOM nodes.
    await first.locator(".adhd-grip").focus(); await page.keyboard.press("Alt+ArrowLeft"); await check();
    await page.keyboard.press("Alt+ArrowLeft"); await check();
    await expect(first.locator(".adhd-grip")).toBeFocused();
    // An expanded pane disables pointer dragging, but its existing keyboard
    // shortcut must still preserve reading state when reordering hidden peers.
    await first.getByRole("button", { name: "放大此面板", exact: true }).click();
    const expandedScroll = first.locator(".message-scroll"); await settleReadingLayout(expandedScroll);
    await expandedScroll.evaluate(node => { node.scrollTop = 220; }); await settleReadingLayout(expandedScroll);
    await first.locator(".adhd-grip").focus(); await page.keyboard.press("Alt+ArrowRight"); await settleReadingLayout(expandedScroll);
    expect(await expandedScroll.evaluate(node => node.scrollTop)).toBe(220);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

for (const fitAfterExpansion of [true, false]) test(`ADHD expansion ${fitAfterExpansion ? "clears the latest button when the complete history fits" : "keeps the latest button when long history still overflows"}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1700, height: 960 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-expanded-latest-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const chat = await hub.store.createConversation("owner", ["alpha"], fitAfterExpansion ? "放大后全部可见" : "放大后仍有长历史", "latest-target");
    const paragraph = "这一段用于观察小窗口中的自动换行，放大后应完整展示，而不需要返回最新消息按钮。".repeat(3);
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: Array.from({ length: fitAfterExpansion ? 8 : 35 }, (_, index) => `第 ${index + 1} 段：${paragraph}`).join("\n\n") }] });
    const peers = [];
    for (let index = 0; index < 3; index++) peers.push(await hub.store.createConversation("owner", ["alpha"], `并行对话 ${index + 1}`, `latest-peer-${index}`));
    await page.goto(hub.url); await pair(page, hub, "测试主机"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const item of [chat, ...peers]) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${item.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("4");
    const card = pane(page, chat.id), scroller = card.locator(".message-scroll"), latest = card.getByRole("button", { name: "回到最新消息", exact: true });
    const geometry = () => scroller.evaluate(node => {
      const history = node.querySelector<HTMLElement>(".virtual-messages")!, tail = history.lastElementChild;
      return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, clientWidth: node.clientWidth,
        historyHeight: history.getBoundingClientRect().height, mountedRows: history.childElementCount,
        realRowHeight: [...history.children].reduce((height, row) => height + row.getBoundingClientRect().height, 0),
        markdownPending: !!history.querySelector(".markdown-pending"), tailConnected: !!tail?.isConnected,
        tailBottom: tail?.getBoundingClientRect().bottom, viewportBottom: node.getBoundingClientRect().top + node.clientTop + node.clientHeight };
    });
    await settleReadingLayout(scroller);
    const compact = await geometry(); expect(compact.scrollHeight).toBeGreaterThan(compact.clientHeight + 100);
    // Native wheel input opts out of following; do not set React/DOM scroll state.
    await scroller.hover(); await page.mouse.wheel(0, -100_000);
    await expect.poll(async () => (await geometry()).scrollTop).toBeLessThanOrEqual(2);
    await expect(latest).toBeVisible(); await settleReadingLayout(scroller);
    const compactReading = await geometry();
    await card.getByRole("button", { name: "放大此面板", exact: true }).click();
    await settleReadingLayout(scroller);
    const expanded = await geometry();
    await writeFile(info.outputPath("latest-geometry.json"), JSON.stringify({ fitAfterExpansion, compact, compactReading, expanded, latestVisible: await latest.isVisible() }, null, 2));
    await page.screenshot({ path: info.outputPath("expanded-latest.png") });
    expect(expanded.clientWidth).toBeGreaterThan(compact.clientWidth * 2);
    if (fitAfterExpansion) {
      expect(expanded.scrollHeight).toBeLessThanOrEqual(expanded.clientHeight + 2);
      expect(expanded.scrollTop).toBeLessThanOrEqual(2);
      await expect(latest).toBeHidden();
    } else {
      expect(expanded.scrollHeight).toBeGreaterThan(expanded.clientHeight + 100);
      expect(expanded.scrollHeight - expanded.clientHeight - expanded.scrollTop).toBeGreaterThan(100);
      await expect(latest).toBeVisible();
    }
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD pointer reordering survives native drag interception, cancellation and board scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-pointer-drag-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const chats = [];
    for (let i = 0; i < 6; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `拖动测试 ${i}`, `drag-${i}`));
    await page.goto(hub.url); await pair(page, hub, "测试主机");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("3");
    const first = pane(page, chats[0]!.id), second = pane(page, chats[1]!.id), grid = page.locator(".adhd-grid");
    await first.locator(".composer textarea").fill("拖动时保留这份草稿");
    // Native WebViews may claim HTML drag-and-drop before the page receives a
    // drop. The pointer path must work even when every HTML drag is cancelled.
    await page.evaluate(() => document.addEventListener("dragstart", event => event.preventDefault(), true));
    const order = () => page.locator(".adhd-card").evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.paneConversation));
    const original = chats.map(chat => chat.id);
    const begin = async () => {
      await expect.poll(() => grid.evaluate(node => node.getAnimations({ subtree: true }).filter(a => (a.effect as KeyframeEffect)?.getKeyframes().some(f => f.transform !== undefined)).length)).toBe(0);
      const from = (await first.locator(".adhd-grip").boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
    };
    const over = async (card: ReturnType<typeof pane>) => {
      const to = (await card.boundingBox())!;
      await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 6 });
      await expect(card).toHaveAttribute("data-adhd-drop-target", "true");
    };
    // A click or a cancelled/outside drop never changes persistent order.
    await first.locator(".adhd-grip").click(); expect(await order()).toEqual(original);
    await begin(); await over(second); expect(await order()).toEqual(original);
    await page.keyboard.press("Escape"); await page.mouse.up();
    await expect(grid).not.toHaveAttribute("data-adhd-dragging", "true"); expect(await order()).toEqual(original);
    await begin(); await over(second); await page.mouse.move(20, 60); await page.mouse.up();
    expect(await order()).toEqual(original); await expect(page.locator("[data-adhd-drop-target]")).toHaveCount(0);
    await begin(); await over(second); await grid.dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true }); await page.mouse.up();
    expect(await order()).toEqual(original);
    await begin(); await over(second); await page.mouse.up();
    await expect.poll(order).toEqual([chats[1]!.id, chats[0]!.id, ...original.slice(2)]);
    await expect(first.locator(".composer textarea")).toHaveValue("拖动时保留这份草稿");
    await expect(first.locator(".adhd-grip")).toHaveText("02");
    // Move between rows, then restore with the existing keyboard alternative.
    await begin(); await over(pane(page, chats[4]!.id)); await page.mouse.up();
    await expect(first.locator(".adhd-grip")).toHaveText("05");
    await first.locator(".adhd-grip").focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Alt+ArrowLeft");
    await expect.poll(order).toEqual(original);
    // Dragging near the board edge scrolls the board, not a chat transcript.
    await page.getByLabel("ADHD 每行窗口数").selectOption("2");
    await begin();
    const bounds = (await grid.boundingBox())!;
    await page.mouse.move(bounds.x + 100, bounds.y + bounds.height - 10, { steps: 5 });
    await expect.poll(() => grid.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
    await page.keyboard.press("Escape"); await page.mouse.up(); expect(await order()).toEqual(original);
    await grid.evaluate(node => { node.scrollTop = 0; });
    await begin(); await over(second); await page.mouse.up();
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled();
    await page.reload(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect.poll(order).toEqual([chats[1]!.id, chats[0]!.id, ...original.slice(2)]);
    await expect(first.locator(".composer textarea")).toHaveValue("拖动时保留这份草稿");
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("background report readers preserve ADHD drafts, focus and geometry through live updates and virtual scrolling", async ({ page }, info) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1700, height: 940 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-background-report-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const secondGateway = await bot(hub, root, "beta", "另一助手", []);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const chats = [];
    for (let i = 0; i < 6; i++) chats.push(await hub.store.createConversation("owner", [i < 3 ? "alpha" : "beta"], `后台检查 ${i}`, `report-${i}`));
    const request = await hub.store.sendMessage("owner", { conversationId: chats[0].id, clientMsgId: "source", text: "检查视频并交付封面", attachments: [] });
    const text = "## 检查回报\n\n" + "公开的完整检查记录。\n\n".repeat(100) + "最后一段完整结果。";
    const start = Date.now();
    const reportBlock = (revision: number, body = text) => ({ type: "card" as const, elements: [
      { type: "markdown" as const, text: "后台任务已完成" }, { type: "markdown" as const, id: "background_context", text: "后台任务回报 · 这是关联请求的后续通知。" }, { type: "markdown" as const, text: body },
    ], extra: { backgroundTask: { version: 1, origin: "bound" }, scopedRun: { version: 1, id: "scoped", revision, phase: "working", startedAt: start, updatedAt: Date.now(), count: revision, completed: 0, failed: 0, truncated: false } } });
    const report = await hub.store.publishBotMessage("alpha", { conversationId: chats[0].id, replyTo: request.message.id, status: "complete", blocks: [reportBlock(1)] });
    // Install the clock before App timers/read throttles start. Installing it
    // halfway through resets performance.now(), mixing two monotonic origins
    // and delaying the next history refresh beyond the assertion window.
    await page.clock.setFixedTime(start);
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${chat.title}`, exact: true }).check();
    const reader = pane(page, chats[0].id), writer = pane(page, chats[3].id), card = reader.locator(".is-scoped");
    await expect(card.getByRole("button", { name: "查看关联请求", exact: true })).toBeVisible();
    await expect(reader.locator(".composer-stop")).toHaveCount(0);
    for (const columns of [4, 5, 6]) {
      await page.getByLabel("ADHD 每行窗口数").selectOption(String(columns));
      for (const font of [11, 12, 16]) {
        await page.getByLabel("ADHD 窗口字号").selectOption(String(font));
        expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect((await card.boundingBox())!.height).toBeLessThan(280);
      }
    }
    await page.getByLabel("ADHD 每行窗口数").selectOption("4"); await page.getByLabel("ADHD 窗口字号").selectOption("12");
    await writer.locator(".composer textarea").fill("保留另一窗口的草稿");
    const before = await card.boundingBox(), composerBefore = await writer.locator(".composer").boundingBox();
    await page.clock.setFixedTime(start + 141000);
    await expect(card.locator(".native-run-status time")).toHaveText(/2m \d+s/);
    await expect(card).not.toContainText("未收到新进展");
    expect(Math.abs((await card.boundingBox())!.height - before!.height)).toBeLessThanOrEqual(1);
    expect((await writer.locator(".composer").boundingBox())!.y).toBe(composerBefore!.y);
    await expect(writer.locator(".composer textarea")).toBeFocused();
    await card.getByRole("button", { name: "查看运行过程", exact: true }).click();
    const process = page.getByRole("dialog", { name: "运行过程", exact: true });
    await expect(process.locator(".run-update-relative")).toHaveText("2分钟前");
    await expect(process.locator(".run-update-time time")).toBeVisible();
    await expect(process.locator(".run-update-explanation")).toContainText("不一定代表任务停顿");
    await page.screenshot({ path: info.outputPath("adhd-progress-reader.png") });
    await page.keyboard.press("Escape");
    await expect(process).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查看运行过程", exact: true })).toBeFocused();
    await expect(writer.locator(".composer textarea")).toHaveValue("保留另一窗口的草稿");
    await writer.locator(".composer textarea").focus();
    await page.clock.setFixedTime(Date.now());
    for (let i = 2; i < 12; i++) await hub.store.publishBotMessage("alpha", { id: report.id, conversationId: chats[0].id, replyTo: request.message.id, status: "complete", blocks: [reportBlock(i, text + "新的进展。".repeat(i))] });
    await expect(card.getByRole("button", { name: "查看运行过程", exact: true })).toContainText("11");
    expect(Math.abs((await card.boundingBox())!.height - before!.height)).toBeLessThanOrEqual(1);
    expect((await writer.locator(".composer").boundingBox())!.y).toBe(composerBefore!.y);
    await expect(writer.locator(".composer textarea")).toBeFocused();
    await card.getByRole("button", { name: "查看完整回复", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "后台任务结果", exact: true });
    await expect(dialog).toContainText("最后一段完整结果。");
    expect((await dialog.boundingBox())!.width).toBeGreaterThan((await reader.boundingBox())!.width);
    await page.screenshot({ path: info.outputPath("adhd-background-reader.png") });
    // New messages move the virtual range far beyond the reader's owning row.
    for (let i = 0; i < 35; i++) await hub.store.publishBotMessage("alpha", { conversationId: chats[0].id, status: "complete", blocks: [{ type: "text", text: `新的消息 ${i}：` + "保留完整报告阅读窗口。".repeat(20) }] });
    await expect(dialog).toBeVisible();
    await expect.poll(() => reader.locator(`.message[data-message-id="${report.id}"]`).count()).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查看完整回复", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "查看关联请求", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(reader.locator(".focused-message")).toContainText("检查视频并交付封面");
    await expect(reader.locator(".focused-message")).toBeInViewport();
    expect(await reader.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await expect(writer.locator(".composer textarea")).toHaveValue("保留另一窗口的草稿");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await secondGateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD composer actions keep equal sizes and a right anchor across draft and reply states", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1600, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-composer-alignment-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const chats = [];
    for (const [i, title] of ["空白对话", "保留草稿", "正在回复"].entries()) chats.push(await hub.store.createConversation("owner", ["alpha"], title, `composer-alignment-${i}`));
    const run = await hub.store.publishBotMessage("alpha", { conversationId: chats[2]!.id, status: "streaming", blocks: [{ type: "text", text: "正在核对产品细节。" }] });
    // Exercise the live steering control without starting a model. Capability
    // belongs only to this conversation; an engine name alone is insufficient.
    await page.route(`**/api/conversations/${chats[2]!.id}/steer?*`, route => route.fulfill({ json: { supported: true, targetId: "layout-turn" } }));
    await page.goto(hub.url); await pair(page, hub, "example-mac");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：example-mac · ${chat.title}`, exact: true }).check();
    const empty = pane(page, chats[0]!.id), drafted = pane(page, chats[1]!.id), busy = pane(page, chats[2]!.id);
    await drafted.locator(".composer textarea").fill("这个草稿保留在自己的窗口");
    await expect(drafted.locator(".draft-save-status")).toHaveText("草稿已保存");
    // Codex now exposes steering in the shared send-choice control; the
    // toolbar-only steer button is intentionally absent on this path.
    await expect(busy.getByRole("radio", { name: "补充", exact: true })).toBeEnabled();
    await expect(busy.getByRole("radio", { name: "排队", exact: true })).toBeChecked();
    const check = async (card: ReturnType<typeof pane>, state: string) => {
      const metrics = await card.locator(".composer-toolbar").evaluate(toolbar => {
        const bounds = toolbar.getBoundingClientRect(), send = toolbar.querySelector(".send-button")!.getBoundingClientRect();
        const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button:is(.icon-button,.composer-steer,.send-button)")].filter(button => button.getClientRects().length);
        return { rightGap: bounds.right - send.right, height: bounds.height, controls: buttons.map(button => {
          const rect = button.getBoundingClientRect(), icon = button.querySelector("svg")!.getBoundingClientRect();
          return { name: button.getAttribute("aria-label"), width: rect.width, height: rect.height, iconWidth: icon.width, iconHeight: icon.height,
            offset: rect.top + rect.height / 2 - (send.top + send.height / 2), contained: rect.left >= bounds.left && rect.right <= bounds.right };
        }) };
      });
      expect(metrics.rightGap, `${state}: Send must remain at the right edge`).toBeLessThanOrEqual(6);
      expect(metrics.rightGap).toBeGreaterThanOrEqual(0);
      expect(metrics.height, state).toBeLessThanOrEqual(34);
      for (const control of metrics.controls) {
        expect([control.width, control.height], `${state}: ${control.name}`).toEqual([28, 28]);
        expect([control.iconWidth, control.iconHeight], `${state}: ${control.name} icon`).toEqual([18, 18]);
        expect(Math.abs(control.offset), `${state}: ${control.name} baseline`).toBeLessThanOrEqual(1);
        expect(control.contained, `${state}: ${control.name} clipped`).toBe(true);
      }
    };
    for (const columns of [3, 6]) {
      await page.getByLabel("ADHD 每行窗口数").selectOption(String(columns));
      for (const font of [12, 16]) {
        await page.getByLabel("ADHD 窗口字号").selectOption(String(font));
        for (const theme of ["light", "dark", "cli"]) {
          await page.evaluate(({ theme, palette }) => { document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light"; document.documentElement.dataset.palette = ["cli"].includes(theme) ? theme : palette; }, { theme, palette: DEFAULT_PALETTE });
          for (const [index, card] of [empty, drafted, busy].entries()) await check(card, `${columns} columns / ${font}px / ${theme} / pane ${index}`);
          if (columns === 3 && font === 12) await page.screenshot({ path: info.outputPath(`composer-${theme}.png`), animations: "disabled" });
        }
      }
    }
    // A single window also stays put when its spacer text or live controls disappear.
    await empty.locator(".composer textarea").fill("临时草稿"); await check(empty, "new draft");
    await empty.locator(".composer textarea").fill(""); await expect(empty.locator(".draft-save-status")).toBeEmpty(); await check(empty, "cleared draft");
    await drafted.locator(".composer textarea").fill(""); await expect(drafted.locator(".draft-save-status")).toBeEmpty(); await check(drafted, "saved draft cleared");
    await hub.store.publishBotMessage("alpha", { id: run.id, conversationId: chats[2]!.id, status: "complete", blocks: [{ type: "text", text: "核对完成。" }] });
    await expect(busy.locator(".composer-stop")).toHaveCount(0); await check(busy, "reply completed");
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD keeps workspace tools and the last composer reachable without outer scrollbars", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1440, height: 700 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-workspace-tools-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const chats = [];
    for (let i = 0; i < 5; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `工作 ${i}`, `tools-${i}`));
    const archived = await hub.store.createConversation("owner", ["alpha"], "已归档工作", "tools-archived");
    await hub.store.updateConversation("owner", archived.id, { archived: true });
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const footer = page.locator(".adhd-shell>.sidebar>.sidebar-footer"), grid = page.locator(".adhd-grid");
    await expect(footer.getByRole("button", { name: "设置", exact: true })).toBeInViewport();
    await footer.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "设置分类", exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "设置分类", exact: true }).getByRole("button", { name: /^网络与连接/ }).click();
    const networkSettings = page.getByRole("region", { name: "网络与连接", exact: true });
    await networkSettings.getByRole("button", { name: /^连接状态与线路/ }).click();
    await expect(page.getByRole("dialog", { name: "连接状态与线路", exact: true })).toContainText("Mac mini");
    await page.keyboard.press("Escape");
    await expect(networkSettings.getByRole("button", { name: /^连接状态与线路/ })).toBeFocused();
    await networkSettings.getByRole("button", { name: /^设备与网络/ }).click();
    await expect(page.getByRole("dialog", { name: "设备与网络", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(networkSettings.getByRole("button", { name: /^设备与网络/ })).toBeFocused();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(footer.getByRole("button", { name: "设置", exact: true })).toBeFocused();
    // Every host tool remains available even before selecting a conversation.
    for (const label of ["文件中心", "Skills 与 MCP", "定时任务", "运行状态", "已归档对话", "连接状态与线路", "设备与网络"]) {
      await footer.getByRole("button", { name: /^工作台：Mac mini/ }).click();
      await page.getByRole("group", { name: "工作台", exact: true }).getByRole("button", { name: label, exact: label !== "已归档对话" }).click();
      await expect(page.getByRole("dialog", { name: label, exact: true })).toBeVisible();
      if (label === "已归档对话") {
        const dialog = page.getByRole("dialog", { name: label, exact: true });
        const title = (await dialog.getByRole("heading", { name: label, exact: true }).boundingBox())!;
        const close = (await dialog.getByRole("button", { name: "关闭已归档对话", exact: true }).boundingBox())!;
        expect(title.height).toBeLessThan(40);
        expect(close.width).toBeLessThanOrEqual(48);
        expect(close.x).toBeGreaterThan(title.x + title.width);
        await dialog.screenshot({ path: info.outputPath("adhd-archives.png"), animations: "disabled" });
        const row = page.getByRole("article", { name: archived.title, exact: true });
        await expect(row.getByRole("button", { name: "查看记录", exact: true })).toBeEnabled();
        await expect(row.getByRole("button", { name: "恢复", exact: true })).toBeEnabled();
      }
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: label, exact: true })).toHaveCount(0);
      await expect(page.locator(".adhd-shell")).toBeVisible();
    }
    await footer.getByRole("button", { name: /^工作台：Mac mini/ }).click();
    await page.getByRole("group", { name: "工作台", exact: true }).getByRole("button", { name: "设备与网络", exact: true }).click();
    await page.getByRole("button", { name: "此设备的连接", exact: true }).click();
    await page.getByRole("button", { name: "设置连接", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "连接状态与线路", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "此设备的连接", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "设置连接", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "关闭连接管理", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设备与网络", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭设备与网络", exact: true }).click();
    await expect(page.locator(".adhd-shell")).toBeVisible();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${chat.title}`, exact: true }).check();
    await pane(page, chats[0]!.id).locator(".composer textarea").fill("保留面板草稿");
    await page.getByLabel("ADHD 每行窗口数").selectOption("2");
    await page.addStyleTag({ content: "::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#111}" });
    await page.setViewportSize({ width: 1120, height: 560 });
    // Board scroll is still available in the gaps; only its visible bar is gone.
    const box = (await grid.boundingBox())!;
    await page.mouse.move(box.x + 3, box.y + 70); await page.mouse.wheel(0, 10000);
    await expect.poll(() => grid.evaluate(node => node.scrollTop > 0)).toBe(true);
    await expect(pane(page, chats[4]!.id).locator(".send-button")).toBeInViewport();
    const dimensions = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".adhd-grid")!, footer = document.querySelector(".adhd-shell>.sidebar>.sidebar-footer")!;
      const rect = footer.getBoundingClientRect(), root = document.documentElement;
      return { excessX: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth, excessY: Math.max(root.scrollHeight, document.body.scrollHeight) - root.clientHeight, gridBar: getComputedStyle(grid).scrollbarWidth, gridBarDisplay: getComputedStyle(grid, "::-webkit-scrollbar").display, footerBottom: rect.bottom };
    });
    expect(dimensions.excessX).toBeLessThanOrEqual(1); expect(dimensions.excessY).toBeLessThanOrEqual(1);
    expect(dimensions.gridBar === "none" || dimensions.gridBarDisplay === "none").toBe(true); expect(dimensions.footerBottom).toBeLessThanOrEqual(560);
    await writeFile(info.outputPath("workspace-tools-geometry.json"), JSON.stringify(dimensions));
    await page.screenshot({ path: info.outputPath("adhd-workspace-tools.png") });
    await footer.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(pane(page, chats[0]!.id).locator(".composer textarea")).toHaveValue("保留面板草稿");
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("visible ADHD replies are read without moving keyboard focus and history keeps its unread badge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-reading-receipts-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const reads: string[] = [];
  page.on("websocket", socket => socket.on("framesent", event => { try { const frame = JSON.parse(String(event.payload)); if (frame.type === "read.mark") reads.push(frame.conversationId); } catch {} }));
  try {
    const a = await hub.store.createConversation("owner", ["alpha"], "正在输入", "writing"), b = await hub.store.createConversation("owner", ["alpha"], "滚轮阅读", "reading");
    for (let i = 0; i < 24; i++) await hub.store.publishBotMessage("alpha", { conversationId: b.id, blocks: [{ type: "text", text: `阅读记录 ${i}\n\n` + "保留原来的阅读位置。".repeat(10) }], status: "complete" });
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of [b, a]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${chat.title}`, exact: true }).check();
    const writer = pane(page, a.id), reader = pane(page, b.id), scroller = reader.locator(".message-scroll");
    await writer.locator(".composer textarea").fill("尚未发送的草稿");
    await expect(writer.locator(".composer textarea")).toBeFocused();
    await settleReadingLayout(scroller);
    reads.length = 0;
    await hub.store.publishBotMessage("alpha", { conversationId: b.id, blocks: [{ type: "text", text: "最新回复在另一个可见面板" }], status: "complete" });
    await expect(reader.getByText("最新回复在另一个可见面板", { exact: true })).toBeInViewport();
    await expect.poll(() => reads).toContain(b.id);
    await expect(reader.locator(".adhd-unread")).toHaveCount(0);
    await expect(writer.locator(".composer textarea")).toBeFocused();
    await scroller.hover(); await page.mouse.wheel(0, -900);
    await expect(reader.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible(); await settleReadingLayout(scroller);
    reads.length = 0;
    await hub.store.publishBotMessage("alpha", { conversationId: b.id, blocks: [{ type: "text", text: "还没有读到这条" }], status: "complete" });
    await expect(reader.locator(".adhd-unread")).toHaveText("1");
    // Focusing a pane while reading history must not merely hide its badge.
    await reader.locator(".composer textarea").focus();
    await page.waitForTimeout(400); expect(reads).not.toContain(b.id);
    await expect(reader.locator(".adhd-unread")).toHaveText("1");
    await writer.locator(".composer textarea").focus();
    await scroller.hover(); await page.mouse.wheel(0, 10000);
    await expect.poll(() => reads).toContain(b.id);
    await expect(reader.locator(".adhd-unread")).toHaveCount(0);
    await expect(writer.locator(".composer textarea")).toBeFocused();
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD desktop wheel boundaries and live typing keep the outer shell and composer stationary", async ({ page }, info) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1600, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-live-geometry-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  let streaming = false;
  let stream: Promise<void> | undefined;
  try {
    const chats = [];
    for (let i = 0; i < 3; i++) {
      const chat = await hub.store.createConversation("owner", ["alpha"], `工作 ${i}`, `geometry-${i}`); chats.push(chat);
      for (let n = 0; n < 20; n++) await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: `记录 ${n}\n\n` + "这里是独立对话的历史。".repeat(8) + "\n\n| 方法 | 说明 |\n| --- | --- |\n| 本地执行 | 支持继续阅读历史与输入 |" }], status: "complete" });
    }
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    // Reproduce macOS's always-visible scrollbars instead of assuming overlays.
    await page.addStyleTag({ content: "::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#aaa}" });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("3"); await page.getByLabel("ADHD 窗口字号").selectOption("14");
    const card = pane(page, chats[0]!.id), scroller = card.locator(".message-scroll"), input = card.locator(".composer textarea");
    await settleReadingLayout(scroller);
    const geometry = () => page.evaluate(() => {
      const root = document.documentElement, body = document.body, brand = document.querySelector(".adhd-shell>.sidebar .brand")!.getBoundingClientRect();
      return { pageX: scrollX, pageY: scrollY, excessX: Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth, excessY: Math.max(root.scrollHeight, body.scrollHeight) - root.clientHeight, brandTop: brand.top };
    });
    const before = await geometry();
    await writeFile(info.outputPath("outer-before.json"), JSON.stringify(before));
    expect.soft(before.excessX).toBeLessThanOrEqual(1); expect.soft(before.excessY).toBeLessThanOrEqual(1);
    await scroller.hover(); await page.mouse.wheel(0, 800); await page.waitForTimeout(250);
    await page.mouse.wheel(0, -100000); await page.waitForTimeout(500); await page.mouse.wheel(0, -800); await page.waitForTimeout(250);
    const after = await geometry();
    await writeFile(info.outputPath("outer-after.json"), JSON.stringify(after));
    expect.soft(after.brandTop).toBeCloseTo(before.brandTop, 0); expect.soft(after.pageY).toBe(0);
    await card.getByRole("button", { name: "回到最新消息", exact: true }).click();
    const longReply = Array.from({ length: 120 }, (_, n) => `段落 ${n}：` + "持续输出时也能平稳查看上面的内容。".repeat(8)).join("\n\n");
    const live = await hub.store.publishBotMessage("alpha", { conversationId: chats[0]!.id, blocks: [{ type: "text", text: longReply }], status: "streaming" });
    await expect(card.locator(".composer-stop")).toBeVisible(); await input.fill("补充说明"); await settleReadingLayout(scroller);
    streaming = true;
    stream = (async () => { for (let n = 0; streaming && n < 180; n++) { await hub.store.publishBotMessage("alpha", { id: live.id, conversationId: chats[0]!.id, blocks: [{ type: "text", text: longReply + "\n\n" + "追加的回复。".repeat(n + 1) }], status: "streaming" }); await new Promise(resolve => setTimeout(resolve, 60)); } })();
    await input.evaluate(node => {
      const samples: number[][] = []; let active = true;
      Object.assign(window, { adhdTypingSamples: samples, stopAdhdTyping: () => { active = false; } });
      const sample = () => { const composer = node.closest(".composer")!.getBoundingClientRect(); samples.push([composer.top, composer.height, node.getBoundingClientRect().height, scrollY]); if (active) requestAnimationFrame(sample); }; sample();
    });
    await input.pressSequentially("这段话先排队处理", { delay: 100 }); await page.waitForTimeout(300);
    const samples = await page.evaluate(() => { (window as any).stopAdhdTyping(); return (window as any).adhdTypingSamples as number[][]; });
    await info.attach("typing-frames", { body: JSON.stringify(samples), contentType: "application/json" });
    for (let i = 0; i < 4; i++) expect.soft(Math.max(...samples.map(row => row[i]!)) - Math.min(...samples.map(row => row[i]!)), `typing geometry ${i}`).toBeLessThanOrEqual(1);
    await input.evaluate(node => {
      const samples: number[][] = []; let active = true;
      Object.assign(window, { adhdGrowthSamples: samples, stopAdhdGrowth: () => { active = false; } });
      const sample = () => { const composer = node.closest(".composer")!.getBoundingClientRect(), brand = document.querySelector(".adhd-shell>.sidebar .brand")!.getBoundingClientRect(); samples.push([composer.bottom, brand.top, scrollY, node.getBoundingClientRect().height]); if (active) requestAnimationFrame(sample); }; sample();
    });
    // A growing focused field must not scroll the document to chase its caret.
    await input.pressSequentially("继续补充多行文字，说明这次修改的完整要求。".repeat(5), { delay: 15 });
    await page.waitForTimeout(250);
    const growth = await page.evaluate(() => { (window as any).stopAdhdGrowth(); return (window as any).adhdGrowthSamples as number[][]; });
    await writeFile(info.outputPath("typing-growth.json"), JSON.stringify(growth));
    for (let i = 0; i < 3; i++) expect.soft(Math.max(...growth.map(row => row[i]!)) - Math.min(...growth.map(row => row[i]!)), `growing draft geometry ${i}`).toBeLessThanOrEqual(1);
    await scroller.hover(); await page.mouse.wheel(0, -1000);
    await expect(card.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();
    await settleReadingLayout(scroller);
    const anchor = await scroller.evaluate(node => {
      const viewport = node.getBoundingClientRect();
      const paragraphs = [...node.querySelectorAll<HTMLElement>(".markdown p")];
      const paragraph = paragraphs.find(p => p.getBoundingClientRect().top >= viewport.top && p.getBoundingClientRect().top < viewport.bottom);
      if (!paragraph) throw new Error("No visible paragraph in the long streaming reply");
      return { text: paragraph.textContent!, top: paragraph.getBoundingClientRect().top - viewport.top, scrollTop: node.scrollTop };
    });
    await page.waitForTimeout(650);
    const anchorAfter = await scroller.evaluate((node, text) => {
      const paragraph = [...node.querySelectorAll<HTMLElement>(".markdown p")].find(p => p.textContent === text);
      if (!paragraph) throw new Error("The reading paragraph was replaced");
      return paragraph.getBoundingClientRect().top - node.getBoundingClientRect().top;
    }, anchor.text);
    expect.soft(anchorAfter).toBeCloseTo(anchor.top, 0);
    await page.mouse.wheel(0, -200); await page.waitForTimeout(350);
    expect.soft(await scroller.evaluate(node => node.scrollTop)).toBeLessThan(anchor.scrollTop - 150);
    await page.screenshot({ path: info.outputPath("adhd-live-reading.png") });
    streaming = false; await stream;
    // A wheel at an inner edge must not drag other panels through the board.
    await page.setViewportSize({ width: 1600, height: 560 });
    await page.getByLabel("ADHD 每行窗口数").selectOption("2");
    const grid = page.locator(".adhd-grid");
    await grid.evaluate(node => { node.scrollTop = 0; });
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await settleReadingLayout(scroller);
    await scroller.hover(); await page.mouse.wheel(0, 600); await page.waitForTimeout(350);
    expect(await grid.evaluate(node => node.scrollTop)).toBe(0);
    await grid.evaluate(node => { node.scrollTop = 100; });
    await scroller.evaluate(node => { node.scrollTop = 0; });
    const frame = (await grid.boundingBox())!, box = (await scroller.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, Math.max(frame.y + 40, box.y + 40));
    await page.mouse.wheel(0, -600); await page.waitForTimeout(350);
    expect(await grid.evaluate(node => node.scrollTop)).toBe(100);
  } finally { streaming = false; await stream; await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop board preserves independent chats, drafts, live replies, focus, order and saved layout", async ({ page }, info) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1600, height: 1060 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-ui-")), received: string[] = [];
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateways = await Promise.all([bot(hub, root, "alpha", "研究助手", received), bot(hub, root, "beta", "工程助手", received)]);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const titles = ["产品设计", "代码审查", "市场研究", "发布准备", "知识整理", "方案推敲"], chats = [];
  try {
    for (let i = 0; i < titles.length; i++) {
      const chat = await hub.store.createConversation("owner", [i % 2 ? "beta" : "alpha"], titles[i]!, `c${i}`); chats.push(chat);
      await hub.store.publishBotMessage(chat.botIds[0]!, { conversationId: chat.id, blocks: [{ type: "text", text: `**${titles[i]}**\n\n这一项可以独立推进。\n\n- 核对现有资料\n- 整理关键结论\n- 完成后给出下一步` }], status: "complete" });
    }
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    const original = chats.at(-1)!;
    await page.locator(`.sidebar [data-conversation-id="${original.id}"]`).click(); await page.locator(".composer textarea").fill("原有聊天草稿");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(page.getByText("让每个对话，都有自己的位置", { exact: true })).toBeVisible(); await expect(page.locator(".adhd-card")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("adhd-empty.png") });
    for (const title of titles) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${title}`, exact: true }).check();
    await expect(page.locator(".adhd-card")).toHaveCount(6); await expect(pane(page, original.id).locator(".composer textarea")).toHaveValue("原有聊天草稿");
    const a = pane(page, chats[0]!.id), b = pane(page, chats[1]!.id);
    await a.locator(".composer textarea").fill("设计草稿 A"); await b.locator(".composer textarea").fill("审查草稿 B");
    await b.getByRole("button", { name: "放大此面板", exact: true }).click(); await expect(a).toBeHidden(); await expect(b.locator(".composer textarea")).toHaveValue("审查草稿 B");
    await b.locator(".composer textarea").focus(); await page.keyboard.press("ControlOrMeta+f"); await expect(b.locator(".history-search-header")).toBeVisible();
    await page.keyboard.press("Escape"); await expect(b.locator(".history-search-header")).toHaveCount(0); await expect(a).toBeHidden(); await expect(b.getByRole("button", { name: "搜索当前对话", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(a.locator(".composer textarea")).toHaveValue("设计草稿 A");
    await a.locator(".composer textarea").focus(); await page.keyboard.press("ControlOrMeta+f");
    await expect(a.locator(".history-search-header")).toBeVisible(); await expect(page.locator(".history-search-header")).toHaveCount(1);
    await page.keyboard.press("Escape"); await expect(a.locator(".history-search-header")).toHaveCount(0);
    await a.locator(".composer textarea").fill("只发给研究助手"); await a.locator(".send-button").click();
    await expect.poll(() => received).toContain("只发给研究助手"); await expect(b.locator(".composer textarea")).toHaveValue("审查草稿 B");
    expect(await hub.store.db.all("SELECT conversation_id FROM messages WHERE author_type='user' AND blocks_json LIKE '%只发给研究助手%'" )).toEqual([{ conversation_id: chats[0]!.id }]);
    await hub.store.publishBotMessage("beta", { conversationId: chats[1]!.id, blocks: [{ type: "text", text: "仅在审查面板实时出现" }], status: "streaming" });
    await expect(b.getByText("仅在审查面板实时出现", { exact: true })).toBeVisible(); await expect(a.getByText("仅在审查面板实时出现", { exact: true })).toHaveCount(0);
    await b.getByRole("button", { name: "移动面板 02：代码审查", exact: true }).focus(); await page.keyboard.press("Alt+ArrowLeft");
    await expect(page.locator(".adhd-card").first()).toHaveAttribute("data-pane-conversation", chats[1]!.id); await expect(b.locator(".composer textarea")).toHaveValue("审查草稿 B");
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("3"); await expect(page.getByLabel("ADHD 每行窗口数", { exact: true })).toHaveValue("3"); await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled();
    await expect.poll(() => page.locator('.adhd-card').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations()).filter(a => (a.effect as KeyframeEffect)?.getKeyframes().some(f => f.transform !== undefined)).length)).toBe(0);
    await page.screenshot({ path: info.outputPath("adhd-six-light.png"), animations: "disabled" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; }); await page.waitForTimeout(200); await page.screenshot({ path: info.outputPath("adhd-six-dark.png"), animations: "disabled" }); await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await b.getByRole("button", { name: "移除此面板", exact: true }).click(); await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 代码审查", exact: true })).not.toBeChecked();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 代码审查", exact: true }).check(); await expect(b.locator(".composer textarea")).toHaveValue("审查草稿 B");
    await page.getByRole("button", { name: "返回聊天", exact: true }).click(); await expect(page.locator(".composer textarea")).toHaveValue("审查草稿 B"); await expect(page.locator(".composer textarea")).toBeFocused();
    await page.reload(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await expect(page.locator(".adhd-card")).toHaveCount(6); await expect(b.locator(".composer textarea")).toHaveValue("审查草稿 B");
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".adhd-shell")).toBeHidden(); await expect(page.getByRole("button", { name: "打开 ADHD 模式", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 1600, height: 1060 }); await expect(page.locator(".adhd-card")).toHaveCount(6); expect(errors).toEqual([]);
  } finally { await page.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD sidebar resizes like ordinary chat, keeps Bot labels and scrolls without a visible bar", async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 820 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-sidebar-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "研究助手", []);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    let targetId = "";
    for (let i = 0; i < 24; i++) targetId = (await hub.store.createConversation("owner", ["alpha"], `项目对话 ${i}`, `sidebar-${i}`)).id;
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const board = page.locator(".adhd-shell"), sidebar = board.locator(":scope > .sidebar");
    const handle = sidebar.getByRole("separator", { name: "调整侧栏宽度" });
    await expect(sidebar).toHaveCSS("width", "272px");
    const row = sidebar.locator(`[data-conversation-id="${targetId}"]`);
    await expect(row.locator(".bot-name-label")).toBeVisible();
    await expect(row.locator(".bot-name-label")).toHaveText("研究助手");
    await sidebar.getByRole("checkbox", { name: "加入面板：Mac mini · 项目对话 23", exact: true }).check();
    const chat = pane(page, targetId), composer = chat.locator(".composer textarea");
    await composer.fill("宽度变化也要保留草稿");
    const before = (await board.locator(".adhd-workbench").boundingBox())!;
    const divider = (await handle.boundingBox())!;
    expect(Math.abs(divider.x + divider.width / 2 - ((await sidebar.boundingBox())!.x + (await sidebar.boundingBox())!.width))).toBeLessThan(2);
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 250);
    await page.mouse.down(); await page.mouse.move(divider.x + divider.width / 2 + 100, divider.y + 250, { steps: 8 }); await page.mouse.up();
    await expect(sidebar).toHaveCSS("width", "372px");
    const after = (await board.locator(".adhd-workbench").boundingBox())!;
    expect(after.width).toBeCloseTo(before.width - 100, 0);
    await expect(composer).toHaveValue("宽度变化也要保留草稿");
    const scroller = board.locator(".adhd-picker-list");
    await expect(scroller).toHaveCSS("scrollbar-width", "none");
    expect(await scroller.evaluate(node => getComputedStyle(node, "::-webkit-scrollbar").display)).toBe("none");
    await scroller.hover(); await page.mouse.wheel(0, 900);
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await scroller.evaluate(node => { node.scrollTop = 0; });
    await handle.focus(); await page.keyboard.press("Home"); await expect(sidebar).toHaveCSS("width", "200px");
    // The splitter deliberately extends four pixels outside the sidebar.
    expect(await scroller.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.keyboard.press("End"); await expect(sidebar).toHaveCSS("width", "480px");
    await page.setViewportSize({ width: 800, height: 820 }); await expect(sidebar).toHaveCSS("width", "440px");
    await page.setViewportSize({ width: 1600, height: 900 });
    await handle.dblclick(); await expect(sidebar).toHaveCSS("width", "288px");
    await page.screenshot({ path: info.outputPath("adhd-sidebar-restored.png") });
    await handle.focus(); await page.keyboard.press("Shift+ArrowRight"); await expect(sidebar).toHaveCSS("width", "320px");
    await sidebar.getByRole("button", { name: "按对话", exact: true }).click();
    const normal = page.locator(".host-workspace:not([hidden])");
    await expect(normal.locator(".sidebar")).toHaveCSS("width", "320px");
    await page.reload(); await expect(normal.locator(".sidebar")).toHaveCSS("width", "288px");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(sidebar).toHaveCSS("width", "288px"); await expect(composer).toHaveValue("宽度变化也要保留草稿");
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("same-ID conversations on two hosts keep drafts, files and sends isolated", async ({ page }, info) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1440, height: 960 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-hosts-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") }); let b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const receivedA: string[] = [], receivedB: string[] = [], errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const ga = await bot(a, path.join(root, "ba"), "alpha", "同名 Bot", receivedA); let gb = await bot(b, path.join(root, "bb"), "alpha", "同名 Bot", receivedB);
  try {
    for (const [hub, label] of [[a, "A"], [b, "B"]] as const) {
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')"); await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)"); await hub.store.db.run("INSERT INTO conversation_members VALUES('same','bot','alpha',0)");
      await hub.store.publishBotMessage("alpha", { conversationId: "same", blocks: [{ type: "text", text: `主机 ${label} 的记录` }], status: "complete" });
    }
    await page.goto(a.url); await pair(page, a, "主机 A"); await clickAppAction(page, "连接另一台主机"); await pair(page, b, "主机 B");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：主机 A · 同名对话", exact: true }).check(); await page.getByRole("checkbox", { name: "加入面板：主机 B · 同名对话", exact: true }).check();
    const pa = page.getByRole("region", { name: "对话面板：主机 A · 同名对话", exact: true }), pb = page.getByRole("region", { name: "对话面板：主机 B · 同名对话", exact: true });
    await expect(pa.getByText("主机 A 的记录", { exact: true })).toBeVisible(); await expect(pb.getByText("主机 B 的记录", { exact: true })).toBeVisible();
    await pa.locator(".composer textarea").fill("A 专属草稿"); await pb.locator(".composer textarea").fill("B 专属草稿");
    // The shared footer follows the focused pane, including same-ID chats.
    for (const [card, name, origin] of [[pa, "主机 A", a.url], [pb, "主机 B", b.url]] as const) {
      await card.locator(".composer textarea").focus();
      const footer = page.locator(".adhd-shell>.sidebar>.sidebar-footer");
      await footer.getByRole("button", { name: new RegExp(`^工作台：${name}`) }).click();
      const request = page.waitForRequest(request => request.url().startsWith(origin) && new URL(request.url()).pathname === "/api/files");
      await page.getByRole("group", { name: "工作台", exact: true }).getByRole("button", { name: "文件中心", exact: true }).click();
      await request;
      await expect(page.getByRole("dialog", { name: "文件中心", exact: true }).getByText(`运行于 ${name}`, { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }

    await pa.locator('input[type="file"]').setInputFiles({ name: "only-a.txt", mimeType: "text/plain", buffer: Buffer.from("only host A") });
    await expect(pa.getByText("only-a.txt", { exact: true })).toBeVisible(); await expect(pb.getByText("only-a.txt", { exact: true })).toHaveCount(0);
    await pa.locator(".send-button").click(); await expect.poll(() => receivedA.some(text => text.includes("A 专属草稿"))).toBe(true); expect(receivedB).toEqual([]); await expect(pb.locator(".composer textarea")).toHaveValue("B 专属草稿");
    await page.screenshot({ path: info.outputPath("adhd-multiple-hosts.png") });
    // A disconnected host queues durably; the other host continues working.
    const port = Number(new URL(b.url).port); await gb.disconnect(); await b.close();
    await expect(pb.locator(".offline-banner")).toBeVisible(); await pb.locator(".composer textarea").fill("B 断线任务"); await pb.locator(".send-button").click();
    await expect(pb.locator(".queued-message")).toHaveCount(1);
    await pa.locator(".composer textarea").fill("A 仍可工作"); await pa.locator(".send-button").click(); await expect.poll(() => receivedA).toContain("A 仍可工作");
    b = await HubServer.start({ stateDir: path.join(root, "b"), port, origins: [a.url] }); gb = await bot(b, path.join(root, "bb"), "alpha", "同名 Bot", receivedB);
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); await expect.poll(() => receivedB.filter(text => text === "B 断线任务").length).toBe(1);
    await expect(pb.locator(".queued-message")).toHaveCount(0); await pb.locator(".composer textarea").fill("B 专属草稿");

    await page.getByRole("button", { name: "返回聊天", exact: true }).click(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await expect(pb.locator(".composer textarea")).toHaveValue("B 专属草稿"); expect(errors).toEqual([]);
  } finally { await page.close(); await ga.disconnect(); await gb.disconnect(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("a late send draft receipt cannot steal focus from another host pane or the sidebar", async ({ page }) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    const remove = IDBObjectStore.prototype.delete;
    const controls = { hold: false, held: 0, release: () => {} }; Object.assign(window, { draftClearReceipts: controls });
    let pending: (() => void)[] = [];
    controls.release = () => { controls.hold = false; const all = pending; pending = []; for (const run of all) run(); };
    IDBObjectStore.prototype.delete = function(key) {
      const request = remove.call(this, key);
      if (this.name === "settings" && String(key).startsWith("draft:") && controls.hold) {
        const add = request.addEventListener.bind(request);
        request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === "success") add(type, event => {
            const run = () => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event);
            if (controls.hold) { controls.held++; pending.push(run); } else run();
          }, options); else add(type, listener, options);
        }) as typeof request.addEventListener;
      }
      return request;
    };
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-send-focus-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const ga = await bot(a, path.join(root, "ba"), "alpha", "同名 Bot", []), gb = await bot(b, path.join(root, "bb"), "alpha", "同名 Bot", []);
  const release = () => page.evaluate(() => (window as unknown as { draftClearReceipts: { release: () => void } }).draftClearReceipts.release());
  try {
    for (const hub of [a, b]) {
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','同名对话','owner',1,'same')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same','bot','alpha',0)");
    }
    await page.goto(a.url); await pair(page, a, "主机 A"); await clickAppAction(page, "连接另一台主机"); await pair(page, b, "主机 B");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const host of ["主机 A", "主机 B"]) await page.getByRole("checkbox", { name: `加入面板：${host} · 同名对话`, exact: true }).check();
    const pa = page.getByRole("region", { name: "对话面板：主机 A · 同名对话", exact: true }), pb = page.getByRole("region", { name: "对话面板：主机 B · 同名对话", exact: true });
    const aInput = pa.locator(".composer textarea"), bInput = pb.locator(".composer textarea"), search = page.getByRole("textbox", { name: "筛选面板对话", exact: true });
    // Keep B's queue real and offline, while its already-committed draft clear
    // receipt is deferred. No extra sleep or changed send assertion hides a race.
    await gb.disconnect(); await b.close(); await expect(pb.locator(".offline-banner")).toBeVisible();
    for (const [destination, target] of [["另一主机输入框", aInput], ["侧栏", search], ["原输入框", bInput]] as const) {
      await bInput.fill(`B 任务：${destination}`); await expect(pb.getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
      await page.evaluate(() => { const controls = (window as unknown as { draftClearReceipts: { hold: boolean; held: number } }).draftClearReceipts; controls.hold = true; controls.held = 0; });
      await pb.locator(".send-button").click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { draftClearReceipts: { held: number } }).draftClearReceipts.held)).toBeGreaterThan(0);
      if (destination !== "原输入框") { await target.focus(); await expect(target).toBeFocused(); }
      await release();
      await expect(pb.getByRole("button", { name: "移除此面板", exact: true })).toBeEnabled();
      await expect(target).toBeFocused();
      if (destination === "另一主机输入框") {
        await page.keyboard.insertText("A 仍可工作"); await expect(aInput).toHaveValue("A 仍可工作"); await expect(bInput).toHaveValue("");
      }
    }
  } finally { await release().catch(() => undefined); await page.close(); await ga.disconnect(); await gb.disconnect(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("simultaneous question cards and queues remain bound to their own pane", async ({ page }) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1440, height: 960 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-questions-")), receivedA: string[] = [], receivedB: string[] = [], decisions: { bot: string; answer: unknown }[] = [];
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const handler = (name: string): CoreBridgeLike["handleAuthorizedMessage"] => async input => {
    if (input.text.startsWith("ask")) decisions.push({ bot: name, answer: await input.onApprovalRequest?.({ engine: "claude", toolName: "AskUserQuestion", toolInput: { questions: [{ header: name, question: `${name} 请选择`, options: [{ label: "继续", description: "继续此任务" }, { label: "稍后", description: "稍后处理" }] }] } }) });
    return { text: `${name} 完成 ${input.text}` };
  };
  const ga = await bot(hub, root, "alpha", "A 助手", receivedA, handler("A")), gb = await bot(hub, root, "beta", "B 助手", receivedB, handler("B"));
  try {
    const ca = await hub.store.createConversation("owner", ["alpha"], "A 任务", "a"), cb = await hub.store.createConversation("owner", ["beta"], "B 任务", "b");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const name of ["A 任务", "B 任务"]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${name}`, exact: true }).check();
    const a = pane(page, ca.id), b = pane(page, cb.id);
    await a.locator(".composer textarea").fill("ask A"); await a.locator(".send-button").click();
    await expect(a.getByRole("radio", { name: "继续", exact: true })).toBeVisible();
    await b.locator(".composer textarea").fill("ask B"); await b.locator(".send-button").click();
    await expect(b.getByRole("radio", { name: "继续", exact: true })).toBeVisible();
    await expect(a.getByRole("button", { name: "待回答", exact: true })).toBeVisible(); await expect(b.getByRole("button", { name: "待回答", exact: true })).toBeVisible();
    await page.getByLabel("ADHD 每行窗口数").selectOption("6");
    await page.getByLabel("ADHD 窗口字号").selectOption("16");
    for (const card of [a, b]) {
      const bounds = await card.locator(".conversation-header").evaluate(n => {
        const header = n.getBoundingClientRect(), host = n.querySelector(".adhd-card-host")!.getBoundingClientRect(), attention = n.querySelector(".adhd-attention")!.getBoundingClientRect(), tools = n.querySelector(".mobile-chat-more")!.getBoundingClientRect();
        return { host: host.width, contained: [...n.querySelectorAll("button")].filter(b => b.getClientRects().length).every(b => b.getBoundingClientRect().right <= header.right + 1), separate: host.right <= attention.left && attention.right <= tools.left };
      });
      expect(bounds.contained).toBe(true); expect(bounds.separate).toBe(true); expect(bounds.host).toBeGreaterThanOrEqual(18);
    }
    await a.getByRole("button", { name: "待回答", exact: true }).click();
    await expect(a.getByRole("radio", { name: "继续", exact: true })).toBeVisible();
    await page.getByLabel("ADHD 每行窗口数").selectOption("2");
    await a.getByRole("button", { name: "移除此面板", exact: true }).click();
    const aRow = page.locator(".adhd-picker-row").filter({ has: page.getByRole("checkbox", { name: "加入面板：Mac mini · A 任务", exact: true }) });
    await expect(aRow.locator(".adhd-picker-attention")).toHaveText("待回答");
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · A 任务", exact: true }).check();
    await expect(a.getByRole("radio", { name: "继续", exact: true })).toBeVisible();
    // A second prompt must queue, not become either question card's answer.
    await a.locator(".composer textarea").fill("A 排队任务"); await a.locator(".send-button").click();
    await expect(a.getByText("A 排队任务", { exact: true }).first()).toBeVisible(); expect(decisions).toEqual([]); expect(receivedA).toEqual(["ask A"]);
    await b.getByRole("radio", { name: "继续", exact: true }).check(); await b.getByRole("button", { name: "提交", exact: true }).click();
    await expect.poll(() => decisions.map(value => value.bot)).toEqual(["B"]); await expect(b.getByText("B 完成 ask B", { exact: true })).toBeVisible();
    await expect(a.getByRole("radio", { name: "继续", exact: true })).not.toBeChecked(); expect(receivedA).toEqual(["ask A"]);
    await a.getByRole("radio", { name: "稍后", exact: true }).check(); await a.getByRole("button", { name: "提交", exact: true }).click();
    await expect.poll(() => receivedA).toEqual(["ask A", "A 排队任务"]); expect(receivedB).toEqual(["ask B"]);
    await expect.poll(() => decisions.map(value => value.bot)).toEqual(["B", "A"]); await expect(a.getByText("A 完成 A 排队任务", { exact: true })).toBeVisible();
  } finally { await page.close(); await ga.disconnect(); await gb.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("streaming does not reread other histories, move their scroll, or steal command completion", async ({ page }) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    const getAll = IDBIndex.prototype.getAll;
    const counts: Record<string, number> = {}; Object.assign(window, { historyReads: counts });
    IDBIndex.prototype.getAll = function(...args) { if (this.objectStore.name === "messages" && this.name === "conversation") { const id = String(args[0]); counts[id] = (counts[id] ?? 0) + 1; } return getAll.apply(this, args); };
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-stream-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const ga = await bot(hub, root, "alpha", "助手 A", []), gb = await bot(hub, root, "beta", "助手 B", []);
  try {
    const ca = await hub.store.createConversation("owner", ["alpha"], "阅读历史", "a"), cb = await hub.store.createConversation("owner", ["beta"], "流式输出", "b");
    for (let i = 0; i < 40; i++) await hub.store.publishBotMessage("alpha", { conversationId: ca.id, blocks: [{ type: "text", text: `历史条目 ${i}：这段内容应保持原来的阅读位置。` }], status: "complete" });
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const name of ["阅读历史", "流式输出"]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${name}`, exact: true }).check();
    const a = pane(page, ca.id), b = pane(page, cb.id), scroller = a.locator(".message-scroll");
    await expect(a.getByText(/历史条目 39/)).toBeVisible();
    await scroller.hover(); await page.mouse.wheel(0, -1100);
    await expect(a.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();
    // Finish the wheel gesture and virtual row measurement before taking the
    // reading-position baseline (WebKit can initially report an empty range).
    await page.waitForTimeout(500);
    const before = await scroller.evaluate(node => node.scrollTop);
    await b.getByRole("button", { name: "放大此面板", exact: true }).click(); await page.keyboard.press("Escape"); await expect(a).toBeVisible();
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(before);
    await a.locator(".composer textarea").fill("/hel"); await expect(a.locator(".command-menu")).toContainText("/help");
    await b.locator(".composer textarea").fill("/sta"); await expect(b.locator(".command-menu")).toContainText("/status");
    await a.locator(".composer textarea").fill(""); await b.locator(".composer textarea").focus(); await expect(b.locator(".command-menu")).toContainText("/status");
    // Wait for prior local read receipts, then count only a streaming-only interval.
    await page.waitForTimeout(500); const readsBefore = await page.evaluate(id => (window as unknown as { historyReads: Record<string, number> }).historyReads[id] ?? 0, ca.id);
    const message = await hub.store.publishBotMessage("beta", { conversationId: cb.id, blocks: [{ type: "text", text: "流式 0" }], status: "streaming" });
    for (let i = 1; i <= 30; i++) { await hub.store.publishBotMessage("beta", { id: message.id, conversationId: cb.id, blocks: [{ type: "text", text: `流式 ${i}` }], status: "streaming" }); await new Promise(resolve => setTimeout(resolve, 30)); }
    await expect(b.getByText("流式 30", { exact: true })).toBeVisible();
    expect(await page.evaluate(id => (window as unknown as { historyReads: Record<string, number> }).historyReads[id] ?? 0, ca.id)).toBe(readsBefore);
    expect(Math.abs(await scroller.evaluate(node => node.scrollTop) - before)).toBeLessThan(3);
    await expect(b.locator(".composer textarea")).toHaveValue("/sta");
  } finally { await page.close(); await ga.disconnect(); await gb.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("upload survives notification and narrow resize; unreadable layout can be exited without erasure", async ({ page }) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1440, height: 960 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-safety-")), received: string[] = [];
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }); const gateway = await bot(hub, root, "alpha", "助手", received);
  let releaseUpload = () => {}; let uploading = false;
  const held = new Promise<void>(resolve => { releaseUpload = resolve; });
  try {
    const ca = await hub.store.createConversation("owner", ["alpha"], "文件任务", "a"), cb = await hub.store.createConversation("owner", ["alpha"], "通知任务", "b");
    const target = await hub.store.publishBotMessage("alpha", { conversationId: cb.id, blocks: [{ type: "text", text: "通知需要定位的消息" }], status: "complete" });
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await page.getByRole("checkbox", { name: "加入面板：Mac mini · 文件任务", exact: true }).check();
    const a = pane(page, ca.id); await a.locator('input[type="file"]').setInputFiles({ name: "held.txt", mimeType: "text/plain", buffer: Buffer.from("retained upload") }); await expect(a.getByText("held.txt", { exact: true })).toBeVisible();
    await page.route("**/api/uploads", async route => { if (route.request().method() === "POST") { uploading = true; await held; } await route.continue(); });
    await a.locator(".composer textarea").fill("上传中保留"); await a.locator(".send-button").click(); await expect.poll(() => uploading).toBe(true);
    await expect(a.getByRole("button", { name: "移除此面板", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toHaveAttribute("title", /Mac mini · 文件任务/);
    await page.getByRole("button", { name: "查看进行中的操作（1）", exact: true }).click(); await expect(a).toHaveClass(/is-focused/); await expect(a.getByRole("button", { name: "取消上传", exact: true })).toBeFocused();
    const hostId = await a.getAttribute("data-pane-host"); await page.evaluate(detail => window.dispatchEvent(new CustomEvent("tarocub-navigate", { detail, cancelable: true })), { hostId, conversationId: cb.id, messageId: target.id });
    await expect(pane(page, cb.id)).toBeVisible(); await expect(pane(page, cb.id).locator(`article[data-message-id="${target.id}"]`)).toHaveClass(/focused-message/);
    await page.setViewportSize({ width: 700, height: 850 }); await expect(page.locator(".adhd-shell")).toBeHidden(); await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 1440, height: 960 });
    // Denied microphone permission releases the board-wide lease immediately.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => new Promise((_resolve, reject) => Object.assign(window, { rejectBoardMic: () => reject(new DOMException("denied", "NotAllowedError")) })) } });
    });
    const b = pane(page, cb.id); await b.getByRole("button", { name: "录制语音", exact: true }).click();
    await expect(b.getByRole("button", { name: "取消录音", exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { rejectBoardMic: () => void }).rejectBoardMic());
    await expect(b.getByRole("button", { name: "取消录音", exact: true })).toHaveCount(0);
    await b.getByRole("button", { name: "录制语音", exact: true }).click(); await expect(b.getByRole("button", { name: "取消录音", exact: true })).toBeVisible(); await b.getByRole("button", { name: "取消录音", exact: true }).click();
    releaseUpload(); await expect.poll(() => received.some(text => text.includes("上传中保留"))).toBe(true);
    await expect(a.getByRole("button", { name: "移除此面板", exact: true })).toBeEnabled();
    await b.getByRole("button", { name: "移除此面板", exact: true }).click(); await page.getByRole("checkbox", { name: "加入面板：Mac mini · 通知任务", exact: true }).check();
    await expect(b.locator(".composer textarea")).toBeVisible(); await expect(b.locator(".focused-message")).toHaveCount(0);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.evaluate(async () => { const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("tarocub-hosts-v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); try { await new Promise<void>((resolve, reject) => { const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put("invalid-saved-layout", "adhd-board-v1"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); } });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("面板布局未能读取"); await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("面板布局未能读取");
  } finally { releaseUpload(); await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("failed draft save offers keep-editing or explicit discard instead of locking the board", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-draft-error-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const chat = await hub.store.createConversation("owner", ["alpha"], "未保存草稿", "a");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await page.getByRole("checkbox", { name: "加入面板：Mac mini · 未保存草稿", exact: true }).check();
    const a = pane(page, chat.id);
    await a.locator('input[type="file"]').setInputFiles(Array.from({ length: 33 }, (_, i) => ({ name: `f${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`file ${i}`) })));
    await expect(a.getByText("草稿离线保存空间不足", { exact: false })).toBeVisible(); await expect(a.getByRole("button", { name: "移除此面板", exact: true })).toBeEnabled();
    await a.getByRole("button", { name: "移除此面板", exact: true }).click(); const confirmation = page.getByRole("dialog", { name: "有草稿尚未保存", exact: true }); await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click(); await expect(a.getByText("f32.txt", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回聊天", exact: true }).click(); await expect(confirmation).toBeVisible(); await confirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
    await a.getByRole("button", { name: "移除此面板", exact: true }).click(); await confirmation.getByRole("button", { name: "放弃未保存的修改", exact: true }).click(); await expect(a).toHaveCount(0); await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 未保存草稿", exact: true })).toBeFocused();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 未保存草稿", exact: true }).check(); await expect(a.locator(".composer textarea")).toBeVisible(); await expect(a.getByText("f32.txt", { exact: true })).toHaveCount(0);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("entering the board waits for uploads in hidden host workspaces", async ({ page }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-background-upload-")), receivedB: string[] = [];
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") }), b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] });
  const ga = await bot(a, path.join(root, "ba"), "alpha", "A 助手", []), gb = await bot(b, path.join(root, "bb"), "beta", "B 助手", receivedB);
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let uploading = false; const failures: string[] = [];
  page.on("requestfailed", request => { if (request.url().includes("/api/uploads")) failures.push(request.failure()?.errorText ?? "failed"); });
  try {
    const ca = await a.store.createConversation("owner", ["alpha"], "A 对话", "a"), cb = await b.store.createConversation("owner", ["beta"], "B 对话", "b");
    await page.goto(a.url); await pair(page, a, "主机 A"); await clickAppAction(page, "连接另一台主机"); await pair(page, b, "主机 B");
    const normal = page.locator(".host-workspace:not([hidden])"); await normal.locator(`.sidebar [data-conversation-id="${cb.id}"]`).click();
    await normal.locator('input[type="file"]').setInputFiles({ name: "background.txt", mimeType: "text/plain", buffer: Buffer.from("keep uploading") }); await expect(normal.getByText("background.txt", { exact: true })).toBeVisible();
    await page.route(`${b.url}/api/uploads`, async route => { if (route.request().method() === "POST") { uploading = true; await held; } await route.continue(); });
    await normal.locator(".composer textarea").fill("B 后台上传"); await normal.locator(".send-button").click(); await expect.poll(() => uploading).toBe(true);
    await normal.locator(`.sidebar [data-conversation-id="${ca.id}"]`).click(); await expect(normal.getByRole("heading", { name: "A 对话", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 ADHD 模式", exact: true })).toBeDisabled(); expect(failures).toEqual([]);
    release(); await expect.poll(() => receivedB.some(text => text.includes("B 后台上传"))).toBe(true);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await expect(page.locator(".adhd-shell")).toBeVisible(); expect(failures).toEqual([]);
  } finally { release(); await page.close(); await ga.disconnect(); await gb.disconnect(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("picker keeps groups and topics even when all their Bots are disconnected", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-picker-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "在线助手", []);
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('offline','离线助手','fixture')");
    const group = await hub.store.createConversation("owner", ["offline"], "离线成员群组", "g", { type: "group" });
    await hub.store.createConversation("owner", [], "独立话题", "topic", { parentId: group.id });
    await hub.store.createConversation("owner", ["offline"], "离线私聊", "d");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 离线成员群组", exact: true })).toBeVisible();
    await expect(page.locator(".adhd-topic-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.locator(".adhd-topic-toggle").click();
    await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 独立话题", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 离线私聊", exact: true })).toHaveCount(0);
    await setListOption(page, '显示未连接 Bot', true); await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 离线私聊", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 离线私聊", exact: true }).check(); await setListOption(page, '显示未连接 Bot', false);
    await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 离线私聊", exact: true })).toBeChecked();
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("the first click on a partially visible panel works without moving the clicked control", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-pointer-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const chats = []; for (let i = 0; i < 9; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `对话 ${i}`, String(i)));
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (let i = 0; i < 9; i++) await page.getByRole("checkbox", { name: `加入面板：Mac mini · 对话 ${i}`, exact: true }).check();
    const first = pane(page, chats[0]!.id), target = pane(page, chats[7]!.id); await first.locator(".composer textarea").click();
    await page.locator(".adhd-grid").evaluate(node => { node.scrollTop = 70; });
    await target.getByRole("button", { name: "放大此面板", exact: true }).click({ delay: 180 }); await expect(first).toBeHidden(); await expect(target).toBeVisible();
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("group pane reflects topic unread activity without another send or history refresh", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-topic-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "群助手", []);
  try {
    const group = await hub.store.createConversation("owner", ["alpha"], "研发群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["alpha"], "发布话题", "topic", { parentId: group.id });
    await hub.store.createConversation("owner", ["alpha"], "单聊", "direct");
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const title of ["研发群", "单聊"]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${title}`, exact: true }).check();
    const gp = pane(page, group.id); await expect(gp.locator(".header-topic")).toBeVisible();
    await hub.store.publishBotMessage("alpha", { conversationId: topic.id, blocks: [{ type: "text", text: "话题里的新回复" }], status: "complete" });
    await expect(gp.locator(".topic-unread-dot")).toHaveCount(1);
    expect(await hub.store.db.all("SELECT id FROM messages WHERE author_type='user'")).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("deleting a topic replaces its panel with the parent instead of consuming another slot", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-topic-remove-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const group = await hub.store.createConversation("owner", ["alpha"], "研发群", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["alpha"], "发布话题", "topic", { parentId: group.id });
    const another = await hub.store.createConversation("owner", ["alpha"], "另一个话题", "topic2", { parentId: group.id });
    const independent = await hub.store.createConversation("owner", ["alpha"], "独立检查", "independent");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.locator(".adhd-topic-toggle").click();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 发布话题", exact: true }).check();
    await pane(page, topic.id).getByRole("button", { name: "更多聊天操作", exact: true }).click();
    await page.getByRole("group", { name: "聊天操作", exact: true }).getByRole("button", { name: "删除话题", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "删除话题", exact: true }).click();
    const gp = pane(page, group.id);
    await expect(gp.locator(".composer textarea")).toBeVisible(); await expect(page.locator(".adhd-card")).toHaveCount(1);
    await expect.poll(() => gp.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 另一个话题", exact: true }).check();
    await pane(page, another.id).getByRole("button", { name: "更多聊天操作", exact: true }).click(); await page.getByRole("group", { name: "聊天操作", exact: true }).getByRole("button", { name: "删除话题", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "删除话题", exact: true }).click();
    await expect(page.locator(".adhd-card")).toHaveCount(1); await expect(gp.locator(".composer textarea")).toBeFocused();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 独立检查", exact: true }).check(); const other = pane(page, independent.id);
    await other.getByRole("button", { name: "放大此面板", exact: true }).click(); await other.locator(".composer textarea").focus(); await page.keyboard.press("Escape");
    await expect(gp).toBeVisible(); await expect(other.locator(".composer textarea")).toBeFocused();
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a failed draft in a previous normal chat requires explicit discard before entering the board", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-entry-failure-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const a = await hub.store.createConversation("owner", ["alpha"], "未保存的附件", "a"), b = await hub.store.createConversation("owner", ["alpha"], "其他对话", "b");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.locator(`.sidebar [data-conversation-id="${a.id}"]`).click();
    await page.locator('input[type="file"][multiple]').setInputFiles(Array.from({ length: 33 }, (_, i) => ({ name: `f${i}.txt`, mimeType: "text/plain", buffer: Buffer.from(`file ${i}`) })));
    await expect(page.getByText("草稿离线保存空间不足", { exact: false })).toBeVisible();
    await page.locator(`.sidebar [data-conversation-id="${b.id}"]`).click();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "有草稿尚未保存", exact: true });
    await expect(dialog).toContainText("Mac mini"); await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
    await page.locator(`.sidebar [data-conversation-id="${a.id}"]`).click(); await expect(page.getByText("f32.txt", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click(); await dialog.getByRole("button", { name: "放弃未保存的修改", exact: true }).click(); await expect(page.locator(".adhd-shell")).toBeVisible();
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("entering and leaving remember the click while a draft write receipt is pending", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    const controls = { hold: false, release: () => {} }; Object.assign(window, { draftReceipts: controls });
    let queued: (() => void)[] = [];
    controls.release = () => { controls.hold = false; const all = queued; queued = []; for (const run of all) run(); };
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (this.name === "settings" && String(key).startsWith("draft:") && controls.hold) {
        const add = request.addEventListener.bind(request);
        request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === "success") add(type, event => {
            const run = () => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event);
            if (controls.hold) queued.push(run); else run();
          }, options); else add(type, listener, options);
        }) as typeof request.addEventListener;
      }
      return request;
    };
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-save-wait-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const hold = () => page.evaluate(() => { (window as unknown as { draftReceipts: { hold: boolean } }).draftReceipts.hold = true; });
  const release = () => page.evaluate(() => (window as unknown as { draftReceipts: { release: () => void } }).draftReceipts.release());
  try {
    const other = await hub.store.createConversation("owner", ["alpha"], "另一对话", "other");
    const chat = await hub.store.createConversation("owner", ["alpha"], "等待草稿", "a");
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    // Fixture conversations can share the same creation millisecond. Select
    // the draft owner explicitly instead of depending on the initial tie order.
    await selectConversation(page, chat.title);
    await hold(); await page.locator(".composer textarea").fill("保存后进入");
    await expect(page.getByRole("button", { name: "打开 ADHD 模式", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(page.locator(".adhd-entry-notice")).toContainText("正在保存草稿"); await expect(page.locator(".adhd-shell")).toHaveCount(0);
    await release(); await expect(page.locator(".adhd-shell")).toBeVisible(); await page.getByRole("checkbox", { name: "加入面板：Mac mini · 等待草稿", exact: true }).check();
    await expect(pane(page, chat.id).locator(".composer textarea")).toHaveValue("保存后进入");
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 另一对话", exact: true }).check();
    await hold(); await pane(page, chat.id).locator(".composer textarea").fill("保存后退出");
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(page.locator(".adhd-notice")).toContainText("正在保存草稿"); await expect(pane(page, chat.id)).toBeVisible();
    await expect(pane(page, chat.id).getByRole("button", { name: "移除此面板", exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 等待草稿", exact: true })).toBeDisabled();
    await page.locator(".adhd-notice").getByRole("button", { name: "取消", exact: true }).click(); await release();
    await expect(pane(page, chat.id).locator(".composer textarea")).toHaveValue("保存后退出"); await expect(page.locator(".adhd-notice")).toHaveCount(0);
    await expect(pane(page, chat.id).getByRole("button", { name: "移除此面板", exact: true })).toBeEnabled();
    await hold(); await pane(page, chat.id).locator(".composer textarea").fill("再保存后退出"); await page.getByRole("button", { name: "返回聊天", exact: true }).click(); await expect(page.locator(".adhd-notice")).toContainText("正在保存草稿");
    await pane(page, chat.id).locator(".composer textarea").press("End"); await page.keyboard.type("续");
    await pane(page, other.id).locator(".composer textarea").click();
    await expect(pane(page, other.id)).toHaveClass(/is-focused/);
    await release(); await expect(page.locator(".adhd-shell")).toHaveCount(0); await expect(page.locator(".composer textarea")).toHaveValue("再保存后退出续");
  } finally { await release().catch(() => undefined); await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("offscreen focused panes keep arriving replies unread until their messages are visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-offscreen-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const reads: string[] = [];
  page.on("websocket", socket => socket.on("framesent", event => { try { const frame = JSON.parse(String(event.payload)); if (frame.type === "read.mark") reads.push(frame.conversationId); } catch {} }));
  try {
    const chats = [];
    for (let i = 0; i < 9; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `任务 ${i}`, `a${i}`));
    await hub.store.publishBotMessage("alpha", { conversationId: chats[6]!.id, blocks: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `已有记录 ${i}`).join("\n\n") }], status: "complete" });
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (let i = 0; i < 9; i++) await page.getByRole("checkbox", { name: `加入面板：Mac mini · 任务 ${i}`, exact: true }).check();
    const first = pane(page, chats[0]!.id), grid = page.locator(".adhd-grid");
    await first.locator(".composer textarea").focus();
    await expect(first).toHaveClass(/is-focused/);
    await grid.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(first).not.toBeInViewport();
    await hub.store.publishBotMessage("alpha", { conversationId: chats[0]!.id, blocks: [{ type: "text", text: "屏幕外的新回复" }], status: "complete" });
    const row = page.locator(".adhd-picker-row").filter({ has: page.getByRole("checkbox", { name: "加入面板：Mac mini · 任务 0", exact: true }) });
    await expect(row.locator(".adhd-picker-unread")).toHaveText("1");
    await expect(row.locator(".adhd-picker-target")).toHaveAccessibleName(/1 条新消息/);
    await page.waitForTimeout(700);
    expect(reads).not.toContain(chats[0]!.id);
    await expect(row.locator(".adhd-picker-unread")).toHaveText("1");
    await grid.evaluate(node => { node.scrollTop = 0; });
    await expect(first.locator(".message-scroll")).toBeInViewport();
    await expect.poll(() => reads).toContain(chats[0]!.id);
    await expect(row.locator(".adhd-picker-unread")).toHaveCount(0);
    // A card can be partly visible while its latest messages are below the
    // outer viewport. Seeing only the top of its message area is not reading.
    const partial = pane(page, chats[6]!.id);
    await partial.locator(".composer textarea").focus();
    await expect.poll(() => reads).toContain(chats[6]!.id);
    reads.length = 0;
    await partial.locator(".message-scroll").evaluate(node => {
      const grid = node.closest<HTMLElement>(".adhd-grid")!, box = node.getBoundingClientRect(), frame = grid.getBoundingClientRect();
      grid.scrollTop += box.top - (frame.bottom - box.height * .6);
    });
    expect(await partial.locator(".message-scroll").evaluate(node => node.getBoundingClientRect().bottom > node.closest(".adhd-grid")!.getBoundingClientRect().bottom)).toBe(true);
    await hub.store.publishBotMessage("alpha", { conversationId: chats[6]!.id, blocks: [{ type: "text", text: "只露出上半部也不能误读" }], status: "complete" });
    await page.waitForTimeout(700);
    expect(reads).not.toContain(chats[6]!.id);
    await partial.locator(".composer textarea").focus();
    await partial.scrollIntoViewIfNeeded();
    await expect.poll(() => reads).toContain(chats[6]!.id);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("pending text send retains its draft owner until the durable queue receipt completes", async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    const controls = { hold: false, held: 0, release: () => {} }; Object.assign(window, { sendReceipts: controls });
    let queued: (() => void)[] = [];
    controls.release = () => { controls.hold = false; const all = queued; queued = []; for (const run of all) run(); };
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (this.name === "outbox" && controls.hold) {
        const add = request.addEventListener.bind(request);
        request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === "success") add(type, event => {
            const run = () => typeof listener === "function" ? listener.call(request, event) : listener.handleEvent(event);
            if (controls.hold) { controls.held++; queued.push(run); } else run();
          }, options); else add(type, listener, options);
        }) as typeof request.addEventListener;
      }
      return request;
    };
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-send-pending-")), received: string[] = [];
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", received);
  const release = () => page.evaluate(() => (window as unknown as { sendReceipts: { release: () => void } }).sendReceipts.release());
  try {
    const chat = await hub.store.createConversation("owner", ["alpha"], "发送中的对话", "a");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 发送中的对话", exact: true }).check();
    const card = pane(page, chat.id);
    await card.locator(".composer textarea").fill("只投递一次");
    await expect(card.getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
    await page.evaluate(() => { (window as unknown as { sendReceipts: { hold: boolean } }).sendReceipts.hold = true; });
    await card.locator(".send-button").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { sendReceipts: { held: number } }).sendReceipts.held)).toBeGreaterThan(0);
    await expect(card.getByRole("button", { name: "移除此面板", exact: true })).toBeDisabled();
    await expect(card.getByRole("button", { name: "在单对话中打开", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeDisabled();
    await release();
    await expect.poll(() => received.filter(text => text === "只投递一次").length).toBe(1);
    await expect(card.locator(".composer textarea")).toHaveValue("");
    await expect(card.getByRole("button", { name: "移除此面板", exact: true })).toBeEnabled();
    await card.getByRole("button", { name: "移除此面板", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 发送中的对话", exact: true }).check();
    await expect(card.locator(".composer textarea")).toHaveValue("");
  } finally { await release().catch(() => undefined); await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("compact pane menus stay fully accessible outside their card clipping", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-menu-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const ids = ["alpha"];
    for (let i = 0; i < 9; i++) { const id = `extra${i}`; ids.push(id); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, `协作助手 ${i}`, hashSecret(randomBytes(32).toString("hex"))]); }
    const group = await hub.store.createConversation("owner", ids, "工作群", "g", { type: "group" });
    const chats = [group];
    for (let i = 0; i < 5; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `其他 ${i}`, `a${i}`));
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${chat.title}`, exact: true }).check();
    const first = pane(page, group.id);
    await first.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    const menu = page.getByRole("group", { name: "聊天操作", exact: true });
    await expect(menu).toBeVisible();
    const last = menu.getByRole("button", { name: "停止当前轮次", exact: true });
    await page.screenshot({ path: info.outputPath("compact-menu.png") });
    await expect.poll(() => last.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0);
    await expect(first.getByRole("button", { name: "更多聊天操作", exact: true })).toBeFocused();
    await first.locator(".composer-recipients").click();
    const recipients = page.getByRole("group", { name: "回复的 Bot", exact: true });
    const firstBot = recipients.getByRole("checkbox").first();
    await expect(firstBot).toBeFocused();
    await page.screenshot({ path: info.outputPath("compact-recipients.png") });
    await expect.poll(() => firstBot.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    await page.keyboard.press("End");
    await expect(recipients.getByRole("checkbox").last()).toBeFocused();
    await expect.poll(() => recipients.getByRole("checkbox").last().evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    await page.keyboard.press("Escape"); await expect(recipients).toHaveCount(0); await expect(first.locator(".composer-recipients")).toBeFocused();
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("revoked device keeps readable drafts but cannot queue new work in any pane", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-revoked-")), received: string[] = [];
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", received);
  try {
    const chats = [];
    for (let i = 0; i < 2; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `授权检查 ${i}`, `a${i}`));
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (let i = 0; i < 2; i++) { await page.getByRole("checkbox", { name: `加入面板：Mac mini · 授权检查 ${i}`, exact: true }).check(); await pane(page, chats[i]!.id).locator(".composer textarea").fill(`保留草稿 ${i}`); }
    for (const chat of chats) await expect(pane(page, chat.id).getByLabel("草稿状态", { exact: true })).toHaveText("草稿已保存");
    const device = (await hub.store.db.all<{ id: string }>("SELECT id FROM devices WHERE id != 'pairing_fixture_owner'"))[0]!.id;
    await hub.auth.revoke(device, "local-owner");
    for (let i = 0; i < 2; i++) {
      const card = pane(page, chats[i]!.id);
      await expect(card.getByRole("alert").filter({ hasText: "此设备已被吊销" })).toBeVisible({ timeout: 15000 });
      await expect(card.locator(".composer textarea")).toHaveAttribute("readonly", "");
      await expect(card.locator(".composer textarea")).toHaveValue(`保留草稿 ${i}`);
      await expect(card.locator(".send-button")).toBeDisabled();
      await card.locator(".composer textarea").press("Enter");
      await expect(card.locator(".queued-message")).toHaveCount(0);
    }
    expect(received).toEqual([]);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(page.locator(".composer textarea")).toHaveAttribute("readonly", "");
    await page.reload(); await expect(page.locator(".composer textarea")).toHaveAttribute("readonly", "");
    expect(received).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("offline counts describe only the owning pane and reconnect sends each item once", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-offline-counts-")), received: string[] = [];
  let hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", received);
  try {
    const a = await hub.store.createConversation("owner", ["alpha"], "离线 A", "a"), b = await hub.store.createConversation("owner", ["alpha"], "离线 B", "b");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const name of ["离线 A", "离线 B"]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${name}`, exact: true }).check();
    const pa = pane(page, a.id), pb = pane(page, b.id), port = Number(new URL(hub.url).port);
    await gateway.disconnect(); await hub.close();
    await expect(pa.locator(".offline-banner")).toBeVisible(); await expect(pb.locator(".offline-banner")).toBeVisible();
    await pa.locator(".composer textarea").fill("A 的离线消息"); await pa.locator(".send-button").click();
    await expect(pa.locator(".offline-banner")).toContainText("1 条消息将在重连后发送"); await expect(pb.locator(".offline-banner")).not.toContainText("条消息");
    for (const text of ["B 的第一条", "B 的第二条"]) { await pb.locator(".composer textarea").fill(text); await pb.locator(".send-button").click(); await expect(pb.locator(".composer textarea")).toHaveValue(""); }
    await expect(pa.locator(".offline-banner")).toContainText("1 条消息将在重连后发送"); await expect(pb.locator(".offline-banner")).toContainText("2 条消息将在重连后发送");
    expect(received).toEqual([]);
    hub = await HubServer.start({ stateDir: path.join(root, "hub"), port, clientDir: path.resolve("dist") }); gateway = await bot(hub, root, "alpha", "助手", received);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => [...received].sort()).toEqual(["A 的离线消息", "B 的第一条", "B 的第二条"].sort());
    await expect(pa.locator(".queued-message")).toHaveCount(0); await expect(pb.locator(".queued-message")).toHaveCount(0);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("created panes receive focus; a full board confirms creation without a misleading retry", async ({ page }) => {
  test.setTimeout(90000); await page.setViewportSize({ width: 1440, height: 960 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-create-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const chats = [];
    for (let i = 0; i < 12; i++) chats.push(await hub.store.createConversation("owner", ["alpha"], `现有 ${i}`, `a${i}`));
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 现有 0", exact: true }).check();
    const create = async (title: string) => {
      await pane(page, chats[0]!.id).getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await page.getByRole("group", { name: "聊天操作", exact: true }).getByRole("button", { name: "新对话", exact: true }).click();
      await page.getByRole("dialog").getByPlaceholder("为这段对话起个名字").fill(title);
      await page.getByRole("dialog").getByRole("button", { name: "创建对话", exact: true }).click();
    };
    await create("新建并聚焦");
    const fresh = page.getByRole("region", { name: "对话面板：Mac mini · 新建并聚焦", exact: true });
    await expect(fresh.locator(".composer textarea")).toBeFocused();
    await page.getByLabel("筛选面板对话", { exact: true }).focus(); await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "跳到对话面板", exact: true })).toBeFocused(); await page.keyboard.press("Enter");
    await expect(pane(page, chats[0]!.id).locator(".composer textarea")).toBeFocused();
    for (let i = 1; i <= 10; i++) await page.getByRole("checkbox", { name: `加入面板：Mac mini · 现有 ${i}`, exact: true }).check();
    await expect(page.locator(".adhd-card")).toHaveCount(12);
    await create("已创建但未放入面板");
    const notice = page.locator(".adhd-notice").filter({ hasText: "已创建「已创建但未放入面板」" });
    await expect(notice).toBeVisible(); await expect(notice.getByRole("button", { name: "重试", exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 已创建但未放入面板", exact: true })).not.toBeChecked();
    await expect(page.locator(".adhd-card")).toHaveCount(12);
    expect((await hub.store.db.all("SELECT id FROM conversations WHERE title='已创建但未放入面板'"))).toHaveLength(1);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD reuses the folder inbox and isolates persisted text size and four-to-six-column layouts", async ({ page }, info) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 2300, height: 1100 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-density-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "研究助手", []);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const chats = [];
    for (let i = 0; i < 6; i++) {
      const chat = await hub.store.createConversation("owner", ["alpha"], i ? `任务 ${i}` : "需要保留完整名称的产品体验与实现审阅", `density-${i}`); chats.push(chat);
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: `**工作进度 ${i}**\n\n独立推进每项工作，保留完整消息与输入。\n\n- 核对资料与结论\n- 整理今天的待办\n- 完成后继续下一步\n\n| 内容 | 状态 |\n| --- | --- |\n| 产品体验 | 已核对 |` }] });
    }
    const folders = new ConversationFolders(hub.store.db);
    await folders.change("owner", { type: "create", id: "work", name: "工作", conversationId: chats[0]!.id, revision: 0 });
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    // Seed the user's ordinary preference, then hydrate through the real app.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta");
      const req = store.get("preferences"); req.onsuccess = () => store.put(JSON.stringify({ ...JSON.parse(req.result ?? "{}"), fontSize: 18, sidebarLayout: "conversations" }), "preferences");
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
    });
    await page.reload(); await expect(page.locator(".connection-pill.online")).toBeVisible();
    const normal = page.locator(".host-workspace:not([hidden])");
    await normal.locator(`[data-conversation-id="${chats[0]!.id}"]`).click();
    await normal.locator(".composer textarea").fill("保留在原列表里的草稿");
    const rowOrder = await normal.locator(".sidebar [data-conversation-id]").evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.conversationId));
    await expect(normal.locator(".message .markdown").first()).toHaveCSS("font-size", "18px");
    const switcher = normal.getByRole("group", { name: "列表排列方式", exact: true });
    await expect(switcher.getByRole("button")).toHaveCount(3);
    await switcher.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const board = page.locator(".adhd-shell"), list = board.locator(".sidebar");
    await expect(list.locator(".folder-name").filter({ hasText: "工作" })).toBeVisible();
    await expect(list.getByText("保留在原列表里的草稿", { exact: false })).toBeVisible();
    expect(await list.locator("[data-conversation-id]").evaluateAll(nodes => nodes.map(n => (n as HTMLElement).dataset.conversationId))).toEqual(rowOrder);
    for (const chat of chats) await list.getByRole("checkbox", { name: `加入面板：Mac mini · ${chat.title}`, exact: true }).check();
    const first = pane(page, chats[0]!.id), grid = page.locator(".adhd-grid");
    await expect(first.locator(".message .markdown").first()).toHaveCSS("font-size", "12px");
    await expect(first.locator(".composer textarea")).toHaveCSS("font-size", "12px");
    await expect(first.locator(".composer textarea")).toHaveValue("保留在原列表里的草稿");
    expect(await first.locator(".conversation-header").evaluate(n => n.getBoundingClientRect().height)).toBeLessThanOrEqual(48);
    expect(await board.locator(".adhd-toolbar").evaluate(n => n.getBoundingClientRect().height)).toBeLessThanOrEqual(52);
    expect(await grid.evaluate(n => getComputedStyle(n).gridTemplateColumns.split(" ").length)).toBe(6);
    await page.screenshot({ path: info.outputPath("six-columns-light.png") });
    for (const count of [4, 5, 6]) {
      await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption(String(count));
      expect(await grid.evaluate(n => getComputedStyle(n).gridTemplateColumns.split(" ").length)).toBe(count);
    }
    const lastRow = list.locator(".adhd-picker-row").filter({ has: page.getByRole("checkbox", { name: `加入面板：Mac mini · ${chats[5]!.title}`, exact: true }) });
    await expect(lastRow.locator(".unread-badge")).toHaveCount(0);
    await page.setViewportSize({ width: 1360, height: 900 });
    await grid.evaluate(n => { n.scrollLeft = 0; });
    await hub.store.publishBotMessage("alpha", { conversationId: chats[5]!.id, status: "complete", blocks: [{ type: "text", text: "横向屏幕外的回复应保持未读" }] });
    await expect(lastRow.locator(".unread-badge")).toHaveText("1");
    await page.waitForTimeout(250); await expect(lastRow.locator(".unread-badge")).toHaveText("1");
    expect(await grid.evaluate(n => getComputedStyle(n).gridTemplateColumns.split(" ").length)).toBe(6);
    expect(await grid.evaluate(n => n.scrollWidth > n.clientWidth)).toBe(true);
    await page.getByLabel("ADHD 窗口字号", { exact: true }).selectOption("16");
    await expect(first.locator(".message .markdown").first()).toHaveCSS("font-size", "16px");
    await expect(first.locator(".composer textarea")).toHaveCSS("font-size", "16px");
    await expect(page.locator("html")).toHaveCSS("font-size", "18px");
    await page.evaluate(() => { document.documentElement.dataset.palette = "cli"; document.documentElement.dataset.theme = "dark"; });
    await expect(first.locator(".message .markdown").first()).toHaveCSS("font-size", "16px");
    await page.screenshot({ path: info.outputPath("independent-font-cli.png") });
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled();
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction("meta"), store = tx.objectStore("meta");
      const get = (key: string) => new Promise<string>((resolve, reject) => { const r = store.get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const [layout, view, preferences] = await Promise.all([get("adhd-board-v1"), get("adhd-view-v1"), get("preferences")]); db.close();
      return { layout: JSON.parse(layout), view: JSON.parse(view), preferences: JSON.parse(preferences) };
    });
    expect(adhdLegacyBoardSchema.parse(stored.layout).panes).toHaveLength(6);
    expect(stored.layout).not.toHaveProperty("fontSize"); expect(stored.view).toEqual({ version: 1, columns: 6, fontSize: 16 }); expect(stored.preferences.fontSize).toBe(18);
    await list.getByRole("button", { name: "按 Bot", exact: true }).click();
    await expect(normal.getByRole("button", { name: "按 Bot", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(normal.locator(".message .markdown").first()).toHaveCSS("font-size", "18px");
    await page.reload(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(page.getByLabel("ADHD 窗口字号", { exact: true })).toHaveValue("16");
    await expect(page.getByLabel("ADHD 每行窗口数", { exact: true })).toHaveValue("6");
    await page.locator(".adhd-shell .sidebar").getByRole("button", { name: "按对话", exact: true }).click();
    await expect(normal.getByRole("button", { name: "按对话", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("a failed ADHD display write keeps both saved records intact and retries without changing ordinary preferences", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-display-failure-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const chat = await hub.store.createConversation("owner", ["alpha"], "保留布局", "display-failure");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 保留布局", exact: true }).check();
    await expect(pane(page, chat.id)).toBeVisible();
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled();
    const read = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction("meta"), store = tx.objectStore("meta");
      const get = (key: string) => new Promise<string>((resolve, reject) => { const r = store.get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const value = await Promise.all([get("adhd-board-v1"), get("adhd-view-v1"), get("preferences")]); db.close(); return value;
    });
    const original = await read();
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (window as any).restoreDisplayWrite = () => { IDBObjectStore.prototype.put = original; };
      IDBObjectStore.prototype.put = function(value, key) { if (this.name === "meta" && key === "adhd-view-v1") throw new DOMException("Simulated metadata storage failure", "QuotaExceededError"); return original.call(this, value, key!); };
    });
    await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("4");
    await expect(page.getByRole("alert")).toContainText("面板布局尚未保存");
    expect(await read()).toEqual(original);
    await page.evaluate(() => (window as any).restoreDisplayWrite());
    await page.getByRole("alert").getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect.poll(async () => JSON.parse((await read())[0]!).columns).toBe(4);
    const saved = await read(); expect(JSON.parse(saved[1]!).columns).toBe(4); expect(saved[2]).toBe(original[2]);
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("ADHD header keeps number, title, host and controls on one line across pane sizes", async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-single-header-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "研究助手", []);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const chats = [];
    for (const [i, title] of ["产品体验与设计审阅", "发布准备", "方案推敲"].entries()) {
      const chat = await hub.store.createConversation("owner", ["alpha"], title, `single-header-${i}`); chats.push(chat);
      await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: i === 0 ? "streaming" : "complete", blocks: [{ type: "text", text: `**${title}**\n\n正在核对界面与交互细节。\n\n- 保留完整对话与草稿\n- 每个面板独立工作\n- 统一标题和操作的位置` }] });
      if (i === 1) await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "complete", blocks: [{ type: "text", text: "用于停留在历史位置的内容。\n\n".repeat(60) }] });
    }
    await page.goto(hub.url); await pair(page, hub, "example-mac");
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const chat of chats) await page.getByRole("checkbox", { name: `加入面板：example-mac · ${chat.title}`, exact: true }).check();
    const first = pane(page, chats[0]!.id), second = pane(page, chats[1]!.id);
    await expect(first.locator(".header-activity")).toContainText("正在回复");
    // Visible latest replies are correctly marked read. Keep this pane in
    // history before delivering a new reply so the unread slot is deterministic.
    const secondScroll = second.locator(".message-scroll");
    await settleReadingLayout(secondScroll);
    await secondScroll.hover();
    await page.mouse.wheel(0, -2000);
    await settleReadingLayout(secondScroll);
    await expect(second.getByRole("button", { name: "回到最新消息", exact: true })).toBeVisible();
    await hub.store.publishBotMessage("alpha", { conversationId: chats[1]!.id, status: "complete", blocks: [{ type: "text", text: "保持未读的标题栏布局样本。" }] });
    await expect(second.locator(".adhd-unread")).toBeVisible();
    await expect(page.locator(".adhd-grip")).toHaveText(["01", "02", "03"]);
    await expect(first.locator(".adhd-grip")).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowLeft Alt+ArrowRight");
    expect((await first.locator(".adhd-grip").boundingBox())!.width).toBeGreaterThanOrEqual(24);
    for (const columns of [3, 6]) {
      await page.getByLabel("ADHD 每行窗口数").selectOption(String(columns));
      for (const font of [12, 16]) {
        await page.getByLabel("ADHD 窗口字号").selectOption(String(font));
        for (const theme of ["light", "dark", "cli"]) {
          await page.evaluate(({ theme, palette }) => { document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light"; document.documentElement.dataset.palette = theme === "cli" ? "cli" : palette; }, { theme, palette: DEFAULT_PALETTE });
          for (const card of [first, second]) {
            const metrics = await card.locator(".conversation-header").evaluate(n => {
              const header = n.getBoundingClientRect(), identity = n.querySelector(".chat-identity")!.getBoundingClientRect(), center = identity.top + identity.height / 2;
              const elements = [...n.querySelectorAll<HTMLElement>("button,.adhd-card-host,.adhd-card-number,.header-bot-name,.activity-dot")].filter(e => e.getClientRects().length);
              const title = n.querySelector<HTMLElement>(".chat-identity>span[title]")!, host = n.querySelector<HTMLElement>(".adhd-card-host")!;
              return { height: header.height, titleWidth: title.getBoundingClientRect().width, titleSize: parseFloat(getComputedStyle(title).fontSize), hostWidth: host.getBoundingClientRect().width,
                offsets: elements.map(e => { const r = e.getBoundingClientRect(); return { node: e.className, offset: r.top + r.height / 2 - center, width: r.width }; }),
                aligned: elements.every(e => { const r = e.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - center) <= 1.5; }),
                contained: elements.every(e => { const r = e.getBoundingClientRect(); return r.left >= header.left - 1 && r.right <= header.right + 1; }) };
            });
            expect(metrics.height).toBeLessThanOrEqual(36);
            expect(metrics.aligned, JSON.stringify({ columns, font, theme, metrics })).toBe(true); expect(metrics.contained, JSON.stringify({ columns, font, theme, metrics })).toBe(true);
            expect(metrics.titleWidth).toBeGreaterThanOrEqual(metrics.titleSize * 4 - 1);
            expect(metrics.hostWidth).toBeGreaterThanOrEqual(18);
          }
          if (columns === 6) {
            await expect(second.locator(".header-activity")).toBeEmpty();
            await expect(second.locator(".header-activity")).toHaveCSS("position", "absolute");
          }
          if (columns === 3) {
            const state = first.locator(".header-activity>span");
            expect(await state.evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
            const relativeModelX = async (card: ReturnType<typeof pane>) => card.locator(".conversation-header").evaluate(n => n.querySelector(".header-bot-name")!.getBoundingClientRect().right - n.getBoundingClientRect().left);
            expect(Math.abs(await relativeModelX(first) - await relativeModelX(second))).toBeLessThanOrEqual(1);
          }
          if (columns === 3 && font === 12 && theme !== "cli") {
            await page.screenshot({ path: info.outputPath(`single-line-${theme}.png`), animations: "disabled" });
            const bounds = (await page.locator(".adhd-workbench").boundingBox())!;
            await page.screenshot({ path: info.outputPath(`header-preview-${theme}.png`), clip: { x: bounds.x, y: bounds.y, width: bounds.width, height: 300 }, animations: "disabled" });
            await first.locator(".conversation-header").screenshot({ path: info.outputPath(`header-detail-${theme}.png`), animations: "disabled" });
          }
        }
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.modelIcons = "hidden"; });
    await expect(first.locator(".header-bot-name .bot-name-label")).toBeVisible();
    const noOverlap = await first.locator(".conversation-header").evaluate(n => {
      const source = n.querySelector(".adhd-card-source")!.getBoundingClientRect(), model = n.querySelector(".header-bot-name")!.getBoundingClientRect(), tools = n.querySelector(".mobile-chat-more")!.getBoundingClientRect();
      return source.right <= model.left + 1 && model.right <= tools.left;
    });
    expect(noOverlap).toBe(true);
    await first.locator(".composer textarea").fill("排序后保留草稿");
    await page.getByLabel("ADHD 每行窗口数").selectOption("3");
    await first.locator(".adhd-grip").dragTo(second.locator(".adhd-grip"));
    await expect(page.locator(".adhd-card").first()).toHaveAttribute("data-pane-conversation", chats[1]!.id);
    await expect(first.locator(".adhd-grip")).toHaveText("02");
    await expect(second.locator(".adhd-grip")).toHaveText("01");
    await expect(first.locator(".composer textarea")).toHaveValue("排序后保留草稿");
    await first.locator(".adhd-grip").focus(); await page.keyboard.press("Alt+ArrowLeft");
    await expect(first.locator(".adhd-grip")).toHaveText("01");
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled();
    // A saved pane can outlive its conversation. Its fallback header keeps the
    // same left-to-right order and controls instead of jumping on reconnect.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open("tarocub-hosts-v1"); request.onsuccess = () => resolve(request.result); });
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta"), request = store.get("adhd-board-v1");
        request.onsuccess = () => { const board = JSON.parse(request.result); board.panes.push({ ...board.panes[0], conversationId: "missing-header" }); store.put(JSON.stringify(board), "adhd-board-v1"); };
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      }); } finally { db.close(); }
    });
    await page.reload(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    const fallback = pane(page, "missing-header").locator(".adhd-card-bar");
    await expect(fallback).toBeVisible(); await expect(fallback.locator(".adhd-grip")).toHaveText("04");
    expect(await fallback.evaluate(n => {
      const number = n.querySelector(".adhd-grip")!.getBoundingClientRect(), host = n.querySelector(".adhd-card-host")!.getBoundingClientRect(), tools = n.querySelector(".adhd-card-tools")!.getBoundingClientRect(), header = n.getBoundingClientRect();
      return number.right <= host.left && host.right <= tools.left && tools.right <= header.right && header.height <= 36;
    })).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("narrow group and topic panes keep their own titles and compact topic navigation at both ADHD font sizes", async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-topic-header-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const ga = await bot(hub, root, "alpha", "研究助手", [], async input => {
    if (input.text === "ask narrow header") await input.onApprovalRequest?.({ engine: "claude", toolName: "AskUserQuestion", toolInput: { questions: [{ question: "继续核对界面？", options: [{ label: "继续", description: "继续验证" }, { label: "稍后", description: "稍后处理" }] }] } });
    return { text: "界面已核对" };
  }), gb = await bot(hub, root, "beta", "工程助手", []);
  try {
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "研发协作", "compact-group", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["alpha"], "发布话题", "compact-topic", { parentId: group.id });
    const a = await hub.store.createConversation("owner", ["alpha"], "工作一", "compact-one"), b = await hub.store.createConversation("owner", ["beta"], "工作二", "compact-two");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.locator(".adhd-topic-toggle").click();
    for (const chat of [group, topic, a, b]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${chat.title}`, exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("4");
    for (const fontSize of [12, 16]) {
      await page.getByLabel("ADHD 窗口字号").selectOption(String(fontSize));
      for (const chat of [group, topic]) {
        const card = pane(page, chat.id), title = card.locator(".chat-identity>span[title]");
        await expect(title).toHaveText(chat.title);
        const metrics = await title.evaluate(n => ({ width: n.getBoundingClientRect().width, size: parseFloat(getComputedStyle(n).fontSize) }));
        expect(metrics.width).toBeGreaterThanOrEqual(metrics.size * 4 - 1);
        await expect(card.locator(".header-topic-count")).toHaveText("1");
        await expect(card.locator(".header-topic")).toHaveAttribute("aria-label", "研发协作 · 1 个话题 · 全部话题");
        await expect(card.locator(".adhd-card-host")).toHaveCSS("font-size", `${Math.max(11, fontSize - 2)}px`);
        const bounds = await card.locator(".conversation-header").evaluate(n => { const header = n.getBoundingClientRect(); return [...n.querySelectorAll("button")].filter(b => b.getClientRects().length).every(b => { const r = b.getBoundingClientRect(); return r.right <= header.right + 1 && r.left >= header.left - 1; }); });
        expect(bounds).toBe(true);
      }
    }
    const shortTitle = await pane(page, a.id).locator(".chat-identity>span[title]").evaluate(n => ({ width: n.getBoundingClientRect().width, font: parseFloat(getComputedStyle(n).fontSize) }));
    expect(shortTitle.width).toBeLessThanOrEqual(shortTitle.font * 3 + 1);
    const groupCard = pane(page, group.id);
    // Ordinary group chat needs an explicit recipient before it can ask a question.
    await groupCard.locator(".composer-recipients").click();
    await page.getByRole("checkbox", { name: "研究助手", exact: true }).check();
    await page.keyboard.press("Escape");
    await groupCard.locator(".composer textarea").fill("ask narrow header"); await groupCard.locator(".send-button").click();
    await expect(groupCard.getByRole("button", { name: "待回答", exact: true })).toBeVisible();
    const pendingBounds = await groupCard.locator(".conversation-header").evaluate(n => {
      const title = n.querySelector<HTMLElement>(".chat-identity>span[title]")!, host = n.querySelector(".adhd-card-host")!.getBoundingClientRect(), attention = n.querySelector(".adhd-attention")!.getBoundingClientRect(), topics = n.querySelector(".header-topic")!.getBoundingClientRect();
      const target = document.elementFromPoint(attention.left + attention.width / 2, attention.top + attention.height / 2);
      return { readable: title.getBoundingClientRect().width >= parseFloat(getComputedStyle(title).fontSize) * 4 - 1, host: host.width, separate: host.right <= attention.left && attention.right <= topics.left, clickable: !!target?.closest(".adhd-attention") };
    });
    expect(pendingBounds).toMatchObject({ readable: true, separate: true, clickable: true }); expect(pendingBounds.host).toBeGreaterThanOrEqual(18);
    await expect(groupCard.getByRole("button", { name: "搜索当前对话", exact: true })).toBeVisible();
    await groupCard.locator(".conversation-header").screenshot({ path: info.outputPath("narrow-pending-header.png"), animations: "disabled" });
    await groupCard.getByRole("radio", { name: "继续", exact: true }).check(); await groupCard.getByRole("button", { name: "提交", exact: true }).click();
    await expect(groupCard.getByRole("button", { name: "待回答", exact: true })).toHaveCount(0);
    await pane(page, topic.id).locator(".header-topic").click();
    await expect(page.getByRole("dialog")).toContainText("研发协作");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(pane(page, topic.id).locator(".header-topic")).toBeFocused();
    await page.screenshot({ path: info.outputPath("narrow-group-topic.png") });
    await page.evaluate(() => { document.documentElement.dataset.modelIcons = "hidden"; });
    await expect(pane(page, a.id).locator(".header-bot-name .bot-name-label")).toBeVisible();
    await expect(pane(page, a.id).locator(".header-bot-name .bot-name-label")).toHaveText("研究助手");
    await expect(pane(page, a.id).locator(".header-bot-name .bot-name-label")).toHaveCSS("font-size", "14px");
    await page.evaluate(() => { document.documentElement.dataset.palette = "cli"; });
    await expect(pane(page, a.id).locator(".header-bot-name .bot-name-label")).toHaveCSS("font-size", "14px");
    await expect(page.locator(`.adhd-picker-row [data-conversation-id="${a.id}"] .inbox-row-bot .bot-name-label`)).toBeVisible();
  } finally { await page.close(); await ga.disconnect(); await gb.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("bad display preferences preserve a valid board and legacy column edits survive a rollback", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-view-recovery-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), gateway = await bot(hub, root, "alpha", "助手", []);
  const readView = () => page.evaluate(async () => { const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); try { return await new Promise<string>(resolve => { const r = db.transaction("meta").objectStore("meta").get("adhd-view-v1"); r.onsuccess = () => resolve(r.result); }); } finally { db.close(); } });
  try {
    const chat = await hub.store.createConversation("owner", ["alpha"], "保留对话", "view-recovery");
    await page.goto(hub.url); await pair(page, hub, "Mac mini"); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: "加入面板：Mac mini · 保留对话", exact: true }).check();
    await page.getByLabel("ADHD 每行窗口数").selectOption("6"); await page.getByLabel("ADHD 窗口字号").selectOption("14");
    await expect(page.getByRole("button", { name: "返回聊天", exact: true })).toBeEnabled();
    const storedView = await readView();
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); });
      try { await new Promise<void>((resolve, reject) => { const tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta"), r = store.get("adhd-board-v1"); r.onsuccess = () => store.put(JSON.stringify({ ...JSON.parse(r.result), columns: 3 }), "adhd-board-v1"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); }
    });
    await page.reload(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(pane(page, chat.id)).toBeVisible(); await expect(page.getByLabel("ADHD 每行窗口数")).toHaveValue("3"); await expect(page.getByLabel("ADHD 窗口字号")).toHaveValue("14");
    expect(await readView()).toBe(storedView);
    await page.evaluate(async () => { const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("tarocub-hosts-v1"); r.onsuccess = () => resolve(r.result); }); try { await new Promise<void>((resolve, reject) => { const tx = db.transaction("meta", "readwrite"); tx.objectStore("meta").put("{invalid-display", "adhd-view-v1"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); } finally { db.close(); } });
    await page.reload(); await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(pane(page, chat.id)).toBeVisible(); await expect(page.getByLabel("ADHD 每行窗口数")).toHaveValue("3"); await expect(page.getByLabel("ADHD 窗口字号")).toHaveValue("12");
    await expect(page.getByRole("checkbox", { name: "加入面板：Mac mini · 保留对话", exact: true })).toBeEnabled();
    expect(await readView()).toBe("{invalid-display");
    await page.getByLabel("ADHD 窗口字号").selectOption("13");
    await expect.poll(async () => JSON.parse(await readView()).fontSize).toBe(13);
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("ADHD separates gray chrome from white chats and marks focus with the selected accent", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-mono-focus-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateway = await bot(hub, root, "alpha", "助手", []);
  try {
    const first = await hub.store.createConversation("owner", ["alpha"], "第一个面板", "mono-focus-first");
    const second = await hub.store.createConversation("owner", ["alpha"], "第二个面板", "mono-focus-second");
    for (const chat of [first, second]) await hub.store.publishBotMessage("alpha", {
      conversationId: chat.id, status: "complete",
      blocks: [{ type: "text", text: "核对面板、回复卡片和输入框，不能只检查最外层。" }],
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(hub.url); await pair(page, hub, "Mac mini");
    // Ordinary chat keeps its existing card/composer presentation.
    await expect(page.locator('.host-workspace:not([hidden]) .message.bot .rich-card')).not.toHaveCSS('box-shadow', 'none');
    await expect(page.locator('.host-workspace:not([hidden]) .conversation-main')).toHaveCSS('border-left-width', '1px');
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const item of [first, second]) await page.getByRole("checkbox", { name: `加入面板：Mac mini · ${item.title}`, exact: true }).check();
    await pane(page, first.id).locator(".composer textarea").click();
    await expect(pane(page, first.id)).toHaveClass(/is-focused/);
    const edge = (card: Locator) => card.evaluate(el => { const style = getComputedStyle(el); return { border: style.borderTopColor, width: style.borderTopWidth, radius: style.borderTopLeftRadius, shadow: style.boxShadow }; });
    for (const palette of ["mono", "white-violet", "white-orange"]) for (const theme of ["light", "dark", "system"]) {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      // The resting card has its own border transition after a palette/focus
      // change. Flush styles and await both cards before sampling final colors.
      await expect.poll(() => Promise.all([first, second].map(item => pane(page, item.id).evaluate(el => {
        getComputedStyle(el).borderTopColor;
        return el.getAnimations().length;
      })))).toEqual([0, 0]);
      const focused = await edge(pane(page, first.id)), resting = await edge(pane(page, second.id));
      const bubble = await edge(pane(page, first.id).locator('.message.bot .rich-card'));
      expect(resting.border).toBe(bubble.border);
      expect(focused.border).not.toBe(resting.border);
      for (const frame of [focused, resting]) {
        expect(frame.width).toBe(bubble.width);
        expect(frame.radius).toBe(bubble.radius);
      }
      const gripColor = (card: Locator) => card.locator('.adhd-grip').evaluate(el => getComputedStyle(el).color);
      expect(await gripColor(pane(page, first.id))).not.toBe(await gripColor(pane(page, second.id)));
      expect(focused.shadow).toBe('none'); expect(resting.shadow).toBe('none');
      for (const card of [pane(page, first.id), pane(page, second.id)]) {
        // Outer-frame checks alone missed the second rule painted beside it.
        await expect(card).toHaveCSS('border-left-width', bubble.width);
        await expect(card.locator('.conversation-main')).toHaveCSS('border-left-width', '0px');
        await expect(card.locator('.message.bot .rich-card')).toHaveCSS('box-shadow', 'none');
        await expect(card.locator('.composer')).toHaveCSS('box-shadow', 'none');
      }
      const surfaces = page.locator('.adhd-shell,.adhd-workbench,.adhd-toolbar');
      const paints = await surfaces.evaluateAll(nodes => nodes.map(el => getComputedStyle(el).backgroundColor));
      expect(new Set(paints).size).toBe(1);
      if (theme === 'light') {
        expect(paints[0]).toBe('rgb(247, 248, 250)');
        await expect(pane(page, first.id).locator('.conversation-header')).toHaveCSS('background-color', 'rgb(252, 252, 252)');
        await expect(pane(page, first.id)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await expect(pane(page, first.id).locator('.conversation-pane')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await expect(pane(page, first.id).locator('.message.bot .rich-card')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        for (const select of await page.locator('.adhd-display-control select').all()) {
          await expect(select).toHaveCSS('background-color', 'rgb(255, 255, 255)');
          await expect(select).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
        }
      } else {
        expect(paints[0]).not.toBe('rgb(255, 255, 255)');
        await expect(pane(page, first.id)).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await expect(pane(page, first.id).locator('.conversation-pane')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await expect(pane(page, first.id).locator('.composer')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
      }
      if (palette === 'mono' && theme !== 'system') await page.screenshot({ path: info.outputPath(`adhd-gray-chrome-${theme}.png`), animations: 'disabled' });
      if (theme === 'system') {
        await page.emulateMedia({ colorScheme: 'light' });
        await expect(page.locator('.adhd-toolbar')).toHaveCSS('background-color', 'rgb(247, 248, 250)');
        await expect(pane(page, first.id).locator('.composer')).toHaveCSS('box-shadow', 'none');
        await expect(pane(page, first.id).locator('.message.bot .rich-card')).toHaveCSS('box-shadow', 'none');
      }
    }
    // Monochrome accents are separate from its black/white primary controls.
    // Switching the focused conversation must move all four colored edges
    // without moving content or changing the white reading surface.
    await page.evaluate(() => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = "light"; });
    for (const [accent, expected] of [["warm-gray", "rgb(163, 155, 145)"], ["mist", "rgb(125, 142, 163)"], ["mauve", "rgb(152, 142, 168)"], ["sage", "rgb(140, 154, 132)"], ["none", "rgb(23, 23, 23)"]]) {
      await page.evaluate(accent => { document.documentElement.dataset.monoAccent = accent; }, accent);
      for (const [active, inactive] of [[first, second], [second, first]]) {
        const card = pane(page, active.id), other = pane(page, inactive.id), before = await card.boundingBox();
        const contentBefore = await card.locator('.message').first().boundingBox(), scrollBefore = await card.locator('.message-scroll').evaluate(node => node.scrollTop);
        await card.locator('.composer textarea').click();
        await expect(card).toHaveClass(/is-focused/);
        await expect(other).not.toHaveClass(/is-focused/);
        for (const side of ['top', 'right', 'bottom', 'left']) await expect(card).toHaveCSS(`border-${side}-color`, expected);
        await expect(other).not.toHaveCSS('border-left-color', expected);
        expect(await card.boundingBox()).toEqual(before);
        expect(await card.locator('.message').first().boundingBox()).toEqual(contentBefore);
        expect(await card.locator('.message-scroll').evaluate(node => node.scrollTop)).toBe(scrollBefore);
        await expect(card.locator('.conversation-pane')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        // A pending-question edge must not break the focused full accent frame.
        await card.evaluate(node => node.classList.add('needs-attention'));
        await expect(card).toHaveCSS('border-top-color', expected);
        await card.evaluate(node => node.classList.remove('needs-attention'));
      }
      if (accent === 'mist' || accent === 'warm-gray') await page.screenshot({ path: info.outputPath(`adhd-accent-${accent}.png`), animations: 'disabled' });
    }
    await pane(page, first.id).locator('.composer textarea').click();
    // The separate CLI palette keeps its original pane shadow and separator.
    await page.evaluate(() => { document.documentElement.dataset.palette = "cli"; document.documentElement.dataset.theme = "light"; });
    await expect.poll(async () => (await edge(pane(page, first.id))).shadow).toMatch(/0px 0px 0px 2px/);
    await expect(pane(page, first.id).locator('.conversation-main')).toHaveCSS('border-left-width', '1px');
  } finally { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

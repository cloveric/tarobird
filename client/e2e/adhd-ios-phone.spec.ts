import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { preparePairing } from "./fixtures/pairing-invite.js";

// An unfolded iPhone (Duo) runs the desktop layout. Browsers cannot be native
// iOS, so the board-state chunks answer their platform checks as iOS. Native
// overlay attributes exercise the shipping iOS CSS too, including nested panes.
// The App, Hub, layout and exit paths are real; UIKit delivery is not simulated.
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
test.use({ serviceWorkers: "block", userAgent: IPHONE });
test.skip(({ browserName }) => browserName === "firefox", "The iPhone check is exercised once in Chromium/WebKit.");

async function asIphone(page: Page) {
  await page.route("**/assets/{adhd-board-state,ios-window}-*.js", async route => {
    const response = await route.fetch(), body = await response.text();
    const patched = body.replace("[`ios`,`android`].includes(", "[`web`,`ios`,`android`].includes(").replaceAll("===`ios`", "===`web`");
    if (patched === body) throw new Error("board platform checks changed; update this fixture");
    await route.fulfill({ response, body: patched });
  });
}
async function overlay(page: Page, keyboardHeight = 0) {
  await page.evaluate(height => {
    const root = document.documentElement;
    root.dataset.platform = "ios";
    root.dataset.keyboardResize = "overlay";
    root.dataset.keyboardOpen = height ? "true" : "false";
    root.style.setProperty("--app-height", `${innerHeight - height}px`);
  }, keyboardHeight);
}
async function assertPaneContent(page: Page) {
  for (const card of await page.locator(".adhd-card:not([hidden])").all()) {
    const pane = card.locator(".conversation-pane");
    await expect(pane).not.toHaveCSS("position", "fixed");
    const header = card.locator(".conversation-header");
    await expect(header).toBeVisible();
    await expect(card.locator(".message-scroll")).toContainText("第一条回复");
    const input = card.getByRole("textbox");
    await expect(input).toBeVisible();
    const geometry = await card.evaluate(node => {
      const outer = node.getBoundingClientRect();
      return [".conversation-header", ".message-scroll .markdown", ".composer textarea"].map(selector => {
        const child = node.querySelector(selector)!;
        const rect = child.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { inside: rect.width > 0 && rect.height > 0 && rect.left >= outer.left && rect.right <= outer.right && rect.top >= outer.top && rect.bottom <= outer.bottom,
          reachable: !!hit && child.contains(hit) };
      });
    });
    for (const item of geometry) expect(item).toEqual({ inside: true, reachable: true });
  }
}
async function setup(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "adhd-iphone-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const gateways: Awaited<ReturnType<typeof attachGateway>>[] = [], chats = [];
  for (const [id, name, title] of [["alpha", "Claude 助手", "重构重试逻辑"], ["beta", "Codex 助手", "周报数据整理"], ["gamma", "Kimi 助手", "明天北京天气"]] as const) {
    const stateDir = path.join(root, id); await mkdir(stateDir, { recursive: true }); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
    const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
    gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: id, secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "ok" }) } }));
    const chat = await hub.store.createConversation("owner", [id], title, title); chats.push(chat);
    await hub.store.publishBotMessage(id, { conversationId: chat.id, blocks: [{ type: "text", text: `${title}：第一条回复` }] });
  }
  await asIphone(page);
  await page.goto(hub.url);
  await hub.profile.update({ name: "macmini", revision: (await hub.profile.read()).revision });
  await page.getByLabel("主机名称", { exact: true }).fill("macmini"); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await overlay(page);
  const close = async () => { await page.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); };
  return { hub, chats, close };
}
async function openBoard(page: Page, titles: string[]) {
  await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
  for (const title of titles) await page.getByRole("checkbox", { name: new RegExp(`^加入面板：.*${title}$`) }).check();
  await expect(page.locator(".adhd-card")).toHaveCount(titles.length);
}
const layout = (page: Page) => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
  const open = indexedDB.open("tarocub-hosts-v1"); open.onerror = () => reject(open.error);
  open.onsuccess = () => { const get = open.result.transaction("meta").objectStore("meta").get("preferences"); get.onsuccess = () => { open.result.close(); resolve(get.result ? JSON.parse(get.result).sidebarLayout : undefined); }; };
}));

test('ordinary iPhone rotation keeps ADHD hidden; expanding and reducing height updates the entry', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { close } = await setup(page);
  try {
    const entry = page.getByRole('button', { name: '打开 ADHD 模式', exact: true });
    for (const [width, height] of [[390, 844], [844, 390], [430, 932], [932, 430], [440, 956], [956, 440]]) {
      await page.setViewportSize({ width: width!, height: height! });
      await expect(entry).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390 || width === 932) await page.screenshot({ path: info.outputPath(`ordinary-phone-${width}-${height}.png`) });
    }
    await page.setViewportSize({ width: 956, height: 669 });
    await expect(entry).toBeVisible();
    await openBoard(page, ['重构重试逻辑']);
    await page.setViewportSize({ width: 956, height: 440 });
    await expect(page.locator('[data-adhd-mode]')).toHaveCount(0);
    await expect(entry).toHaveCount(0);
  } finally { await close(); }
});

for (const width of [880, 1000]) test(`unfolded iPhone at ${width}px: two tall panes beside the full list, at most two panes, no Bot name or model mark`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: Math.round(width / 1.455) });
  const { close } = await setup(page);
  try {
    await openBoard(page, ["重构重试逻辑", "周报数据整理"]);
    const third = page.getByRole("checkbox", { name: /加入面板：.*明天北京天气$/ });
    await expect(third).toBeDisabled();
    // The row is also a navigation entry; it must not bypass the checkbox cap.
    await page.getByRole("button", { name: /^在面板中查看 明天北京天气/ }).click();
    await expect(page.locator(".adhd-notice")).toContainText("最多同时打开 2 个对话");
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await assertPaneContent(page);
    const shell = page.locator(".adhd-shell");
    await expect(page.getByRole("button", { name: "打开 Agent Bus" })).toHaveCount(0); // desktop-only
    await expect(shell).toHaveAttribute("data-adhd-device", "phone");
    const columns = page.getByLabel("ADHD 每行窗口数", { exact: true });
    await expect(columns.locator("option")).toHaveText(["自动", "2 列"]);
    const boxes = await page.locator(".adhd-card").evaluateAll(cards => cards.map(card => card.getBoundingClientRect()).map(r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) })));
    expect(boxes[0]!.y).toBe(boxes[1]!.y);
    for (const box of boxes) expect(box.w).toBeGreaterThanOrEqual(260);
    expect(await page.locator(".adhd-grid").evaluate(grid => grid.scrollWidth <= grid.clientWidth + 1)).toBe(true);
    expect(Math.round(await page.locator(".adhd-shell > .sidebar").evaluate(node => node.getBoundingClientRect().width))).toBeGreaterThanOrEqual(272);
    const marks = shell.locator(".inbox-row-bot, .adhd-card .header-bot-name");
    expect(await shell.locator(".inbox-row-bot").count()).toBeGreaterThan(0); expect(await shell.locator(".adhd-card .header-bot-name").count()).toBeGreaterThan(0);
    for (const node of await marks.all()) await expect(node).toBeHidden();
    await page.mouse.move(0, 0); await page.screenshot({ path: info.outputPath(`iphone-board-${width}.png`) });
  } finally { await close(); }
});

test("folding shut opens the focused panel's conversation in 按对话; unfolding in time keeps the board", async ({ page }, info) => {
  await page.setViewportSize({ width: 1000, height: 687 });
  const { close } = await setup(page);
  try {
    await openBoard(page, ["重构重试逻辑", "周报数据整理"]);
    const first = page.locator(".adhd-card").first();
    await first.getByRole("textbox").click();
    await page.setViewportSize({ width: 466, height: 678 });
    await expect(page.locator(".adhd-folding")).toBeVisible();
    await page.screenshot({ path: info.outputPath("folding.png") });
    await page.setViewportSize({ width: 1000, height: 687 });
    await expect(page.locator(".adhd-folding")).toHaveCount(0);
    await page.waitForTimeout(800);
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    // Folding must retain the mounted upload until it can safely leave.
    let uploadRoute: import("@playwright/test").Route | undefined;
    await page.route("**/api/uploads**", route => { uploadRoute = route; });
    await first.locator("input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.alloc(256 * 1024, 97) });
    await first.getByRole("textbox").fill("附件");
    await first.getByRole("textbox").press("Enter");
    await expect(first.getByRole("textbox")).toBeDisabled(); // uploading
    await page.setViewportSize({ width: 466, height: 678 });
    await expect(page.locator(".adhd-compact")).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await page.unroute("**/api/uploads**");
    await expect.poll(() => !!uploadRoute).toBe(true);
    await uploadRoute!.continue();
    await expect(page.locator("[data-adhd-mode]")).toHaveCount(0, { timeout: 10000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /重构重试逻辑/ })).toBeVisible();
    expect(await layout(page)).toBe("conversations");
    await page.setViewportSize({ width: 1000, height: 687 });
    await page.waitForTimeout(800);
    await expect(page.locator("[data-adhd-mode]")).toHaveCount(0);
  } finally { await close(); }
});

for (const device of ["Duo", "iPad"] as const) for (const touch of [true, false]) test.describe(`${device} native overlay ${touch ? "touch" : "pointer"}`, () => {
  test.use({ hasTouch: touch, userAgent: device === "Duo" ? IPHONE : (touch ? IPHONE.replace("(iPhone; CPU iPhone OS", "(iPad; CPU OS") : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15") });
  test("pane contents stay within their cards", async ({ page }, info) => {
    await page.setViewportSize({ width: 1000, height: 687 });
    const { close } = await setup(page);
    try {
      await openBoard(page, ["重构重试逻辑", "周报数据整理"]);
      if (device === "Duo") await expect(page.locator(".adhd-shell")).toHaveAttribute("data-adhd-device", "phone");
      else await expect(page.locator(".adhd-shell")).not.toHaveAttribute("data-adhd-device");
      await assertPaneContent(page);
      await page.screenshot({ path: info.outputPath("native-board.png") });
      const input = page.locator(".adhd-card").first().getByRole("textbox");
      await input.fill("保留草稿");
      await overlay(page, 240);
      await expect.poll(() => page.locator(".adhd-shell").evaluate(node => node.getBoundingClientRect().height)).toBe(447);
      await assertPaneContent(page);
      await overlay(page);
      await expect(input).toHaveValue("保留草稿");
      if (device === "iPad") {
        const third = page.getByRole("checkbox", { name: /加入面板：.*明天北京天气$/ });
        await expect(third).toBeEnabled();
        await third.check();
        await expect(page.locator(".adhd-card")).toHaveCount(3);
        await third.uncheck();
        for (const size of [{ width: 834, height: 1194 }, { width: 1194, height: 834 }, { width: 800, height: 834 }]) {
          await page.setViewportSize(size); await overlay(page);
          await assertPaneContent(page);
          await expect(input).toHaveValue("保留草稿");
        }
        await page.setViewportSize({ width: 600, height: 834 }); await overlay(page);
        await expect(page.locator(".adhd-compact")).toBeVisible();
        await page.setViewportSize({ width: 1194, height: 834 }); await overlay(page);
        await assertPaneContent(page);
        await expect(input).toHaveValue("保留草稿");
      }
    } finally { await close(); }
  });
});

test("restoring an older three-pane phone layout keeps conversations and saved drafts", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 687 });
  const { chats, close } = await setup(page);
  const toggle = (title: string) => page.getByRole("checkbox", { name: new RegExp(`^加入面板：.*${title}$`) });
  try {
    await openBoard(page, ["明天北京天气"]);
    await page.locator(".adhd-card").getByRole("textbox").fill("第三个对话的草稿不能丢");
    // Removal may await the outstanding draft write; setChecked asserts synchronously.
    await expect(toggle("明天北京天气")).toBeChecked();
    await toggle("明天北京天气").click();
    await expect(toggle("明天北京天气")).not.toBeChecked();
    await expect(page.locator(".adhd-card")).toHaveCount(0);
    await toggle("重构重试逻辑").check(); await toggle("周报数据整理").check();
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await expect(page.locator("[data-adhd-mode]")).toHaveCount(0);
    // Preserve a layout written by the older client; do not touch draft stores.
    await page.evaluate(conversationId => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("tarocub-hosts-v1"); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta");
        const get = store.get("adhd-board-v1");
        get.onsuccess = () => { const saved = JSON.parse(get.result); saved.panes.push({ ...saved.panes[0], conversationId }); store.put(JSON.stringify(saved), "adhd-board-v1"); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    }), chats[2]!.id);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await expect(page.locator(".adhd-notice")).toContainText("已恢复前 2 个");
    await expect(toggle("明天北京天气")).not.toBeChecked();
    await expect(toggle("明天北京天气")).toBeDisabled();
    await toggle("重构重试逻辑").uncheck(); await toggle("明天北京天气").check();
    await expect(page.locator(`[data-pane-conversation="${chats[2]!.id}"]`).getByRole("textbox")).toHaveValue("第三个对话的草稿不能丢");
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await expect(page.locator(".adhd-selection-count")).toHaveText("已选 2");
  } finally { await close(); }
});

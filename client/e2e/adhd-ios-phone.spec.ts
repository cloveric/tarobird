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
// iOS, so the board-state chunk alone answers its platform checks as iOS; the
// App, Hub, layout and exit paths are the real ones. Not a device test.
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
test.use({ serviceWorkers: "block", userAgent: IPHONE });
test.skip(({ browserName }) => browserName === "firefox", "The iPhone check is exercised once in Chromium/WebKit.");

async function asIphone(page: Page) {
  await page.route("**/assets/adhd-board-state-*.js", async route => {
    const response = await route.fetch(), body = await response.text();
    const patched = body.replace("[`ios`,`android`].includes(", "[`web`,`ios`,`android`].includes(").replace("===`ios`&&/\\biPhone\\b/", "===`web`&&/\\biPhone\\b/");
    if (patched === body || patched.includes("=`ios`&&")) throw new Error("board platform checks changed; update this fixture");
    await route.fulfill({ response, body: patched });
  });
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

for (const width of [880, 1000]) test(`unfolded iPhone at ${width}px: two tall panes beside the full list, at most two columns, no Bot name or model mark`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: Math.round(width / 1.455) });
  const { close } = await setup(page);
  try {
    await openBoard(page, ["重构重试逻辑", "周报数据整理", "明天北京天气"]);
    const shell = page.locator(".adhd-shell");
    await expect(page.getByRole("button", { name: "打开 Agent Bus" })).toHaveCount(0); // desktop-only
    await expect(shell).toHaveAttribute("data-adhd-device", "phone");
    const columns = page.getByLabel("ADHD 每行窗口数", { exact: true });
    await expect(columns.locator("option")).toHaveText(["自动", "2 列"]);
    const boxes = await page.locator(".adhd-card").evaluateAll(cards => cards.map(card => card.getBoundingClientRect()).map(r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) })));
    expect(boxes[0]!.y).toBe(boxes[1]!.y); expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
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

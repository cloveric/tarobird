import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots } from "./fixtures/mobile.js";
import { clickAppAction, revealReplyBots, dismissReplyBots } from "./fixtures/desktop-actions.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
// Keep fault injection on the page request. Service-worker offline reload is covered by hub.spec.ts.
test.use({ serviceWorkers: "block" });
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  if ((page.viewportSize()?.width ?? 1360) <= 760) await expect(page.locator(".host-workspace:not([hidden]) .mobile-home")).toBeVisible();
  else await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
}
test("conversation dialog drags by its desktop header, stays reachable and preserves creation and mobile layout", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creation-drag-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pair(page, hub); await showDisconnectedBots(page);
    const open = () => clickAppAction(page, "新建对话", page.getByRole("button", { name: "新建对话", exact: true }));
    await open();
    const dialog = page.getByRole("dialog", { name: "新建对话", exact: true });
    const header = dialog.locator(":scope > header");
    const bounds = async () => {
      // UI motion is always enabled. Measure the settled dialog, not the
      // transient opening scale (which also occurs on unmodified main).
      await dialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => undefined))));
      return (await dialog.boundingBox())!;
    };
    const drag = async (dx: number, dy: number) => {
      const r = (await header.boundingBox())!;
      await page.mouse.move(r.x + 90, r.y + r.height / 2); await page.mouse.down();
      await page.mouse.move(r.x + 90 + dx, r.y + r.height / 2 + dy, { steps: 6 }); await page.mouse.up();
    };
    await dialog.getByPlaceholder("为这段对话起个名字").fill("拖动后创建");
    await dialog.getByRole("checkbox").check();
    const initial = await bounds();
    await page.screenshot({ path: info.outputPath("dialog-before.png") });
    await drag(150, -90);
    let moved = await bounds();
    expect(moved.x - initial.x).toBeCloseTo(150, 0); expect(moved.y - initial.y).toBeCloseTo(-90, 0);
    await expect(dialog.getByPlaceholder("为这段对话起个名字")).toHaveValue("拖动后创建");
    await expect(dialog.getByRole("checkbox")).toBeChecked();
    await page.screenshot({ path: info.outputPath("dialog-moved.png") });
    await drag(1500, 1000); moved = await bounds();
    expect(moved.x + moved.width).toBeLessThanOrEqual(1348.5); expect(moved.y + moved.height).toBeLessThanOrEqual(888.5);
    await drag(-2000, -2000); moved = await bounds();
    expect(moved.x).toBeGreaterThanOrEqual(11.5); expect(moved.y).toBeGreaterThanOrEqual(11.5);
    // A shrinking desktop must not strand the close button off screen.
    await drag(1500, 1000); await page.setViewportSize({ width: 800, height: 580 });
    await expect.poll(async () => { const r = await bounds(); return r.x >= 11 && r.y >= 11 && r.x + r.width <= 789 && r.y + r.height <= 569; }).toBe(true);
    await dialog.getByRole("button", { name: "关闭新建对话", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 1360, height: 900 }); await open();
    expect((await bounds()).x).toBeCloseTo(initial.x, 0);
    await dialog.getByPlaceholder("为这段对话起个名字").fill("拖动后创建"); await dialog.getByRole("checkbox").check();
    await drag(-120, 40); await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
    await expect(page.getByRole("heading", { name: "拖动后创建", exact: true })).toBeVisible();
    expect(await hub.store.conversations("owner")).toHaveLength(1);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "为 研究助手 新建对话", exact: true }).click();
    await drag(140, 60); await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => Math.abs((await bounds()).x)).toBeLessThan(1);
    const mobile = await bounds(); await drag(70, -70);
    expect((await bounds()).x).toBeCloseTo(mobile.x, 0); expect((await bounds()).y).toBeCloseTo(mobile.y, 0);
    await expect(dialog.getByRole("button", { name: "关闭新建对话", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("dialog-mobile.png") });
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    expect(await hub.store.conversations("owner")).toHaveLength(1);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
test("reuse a Bot for fast chats, one-Bot groups and isolated topics; retry a lost creation receipt", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creation-ui-")), stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", model: "gpt-6-astra", effort: "high", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手',?)", [hashSecret("test-only-creation-secret-at-least-32")]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret: "test-only-creation-secret-at-least-32", engine: "codex", model: "gpt-6-astra", effort: "high", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "当前话题的回答" }) } });
  try {
    await pair(page, hub); await clickAppAction(page, "新建群组", page.getByRole("button", { name: "新建群组", exact: true }));
    const dialog = page.getByRole("dialog", { name: "新建群组" });
    await dialog.getByRole("checkbox").check(); await dialog.getByPlaceholder("为这段对话起个名字").fill("项目研究");
    await expect(dialog.getByRole("combobox")).toHaveCount(0); await dialog.getByRole("button", { name: "创建群组", exact: true }).click();
    await expect(page.getByRole("heading", { name: "项目研究", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeFocused();
    await revealReplyBots(page); await page.getByRole("checkbox", { name: "研究助手", exact: true }).check(); await dismissReplyBots(page);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("默认讨论的消息"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message-scroll").getByText("当前话题的回答", { exact: true })).toBeVisible();
    await clickAppAction(page, "新建话题", page.getByRole("button", { name: "新建话题", exact: true })); await expect(page.getByRole("dialog", { name: "新建话题" }).getByRole("checkbox")).toHaveCount(0);
    await page.getByPlaceholder("为这段对话起个名字").fill("单独分析估值");
    let lost = false;
    await page.route("**/api/conversations", async (route) => { if (!lost && route.request().postDataJSON().type === "topic.create") { lost = true; await route.fetch(); await route.abort(); } else await route.continue(); });
    await page.getByRole("button", { name: "创建话题", exact: true }).click(); await expect.poll(() => lost).toBe(true); await expect(page.getByRole("button", { name: "重试创建", exact: true })).toBeVisible(); await page.getByRole("button", { name: "重试创建", exact: true }).click();
    await expect(page.getByRole("heading", { name: "单独分析估值", exact: true })).toBeVisible(); await expect(page.locator(".message-blocks").getByText("默认讨论的消息", { exact: true })).toHaveCount(0);
    await revealReplyBots(page); await page.getByRole("checkbox", { name: "研究助手", exact: true }).check(); await dismissReplyBots(page);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("只在此话题里"); await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(page.locator(".message-scroll").getByText("当前话题的回答", { exact: true })).toBeVisible();
    const conversations = await hub.store.conversations("owner"); expect(conversations).toHaveLength(2); expect(conversations.find((c) => c.parentId)?.botIds).toEqual(["alpha"]);
    await page.screenshot({ path: info.outputPath("group-topic-desktop.png"), fullPage: true });
    await clickAppAction(page, "全部话题");
    await page.getByRole("dialog", { name: "群内话题", exact: true }).getByRole("button", { name: /默认讨论/ }).click(); await expect(page.locator(".message-blocks").getByText("默认讨论的消息", { exact: true })).toBeVisible(); await expect(page.locator(".message-blocks").getByText("只在此话题里", { exact: true })).toHaveCount(0);
    await clickAppAction(page, "新对话", page.getByRole("button", { name: "新对话", exact: true })); await expect(page.getByRole("dialog").getByRole("checkbox")).toBeChecked(); await page.getByPlaceholder("为这段对话起个名字").press("Enter");
    await expect(page.getByRole("heading", { name: "与 研究助手 的新对话", exact: true })).toBeVisible(); expect(await hub.store.bots("owner")).toHaveLength(1); expect(await hub.store.conversations("owner")).toHaveLength(3);
    await expect(page.locator(".bot-tree").locator(".conversation-row")).toHaveCount(1);
    await page.getByRole("button", { name: "打开 研究助手", exact: true }).click();
    expect(await hub.store.conversations("owner")).toHaveLength(3);
    await page.getByRole("button", { name: "为 研究助手 新建对话", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "新建对话", exact: true }).getByRole("checkbox")).toBeChecked();
    await page.keyboard.press("Escape");
    await clickAppAction(page, "对话设置", page.getByRole("button", { name: "对话设置", exact: true }));
    await page.getByRole("button", { name: "新建独立对话", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "新建对话", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("checkbox")).toBeChecked();
    expect(await hub.store.conversations("owner")).toHaveLength(3);
    await page.keyboard.press("Escape");
    await page.reload(); await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible(); await page.locator(".topic-row").click(); await expect(page.getByRole("heading", { name: "单独分析估值", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".sidebar")).not.toBeInViewport(); await expect(page.getByRole("button", { name: "新建话题", exact: true })).toBeInViewport(); await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("group-topic-mobile.png"), fullPage: true }); await clickAppAction(page, "新建话题", page.getByRole("button", { name: "新建话题", exact: true })); await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
for (const { engine, mobile } of [{ engine: "codex", mobile: false }, { engine: "codex", mobile: true }, { engine: "claude", mobile: false }, { engine: "antigravity", mobile: false }, { engine: "antigravity", mobile: true }] as const) {
  test(`create a named ${engine} Bot using TaroCub model and effort choices, then enter its first session (${mobile ? "mobile" : "desktop"})`, async ({ page }, info) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "new-bot-ui-"));
    const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist"), managedBots: { entrypoint: path.resolve("../tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath, CLAUDE_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: path.resolve("../tests/fixtures/agy-models.mjs") } } });
    const selectedModel = engine === "claude" ? "claude-opus-5-5[1m]" : engine === "antigravity" ? "gemini-4-argon-high" : "gpt-6.1-sol";
    const selectedEffort = engine === "claude" ? "xhigh" : engine === "antigravity" ? "high" : "ultra";
    try {
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await pair(page, hub);
      if (mobile) {
        await page.getByRole("button", { name: "新建", exact: true }).filter({ visible: true }).click();
        await page.getByRole("menuitem", { name: "新建 Bot", exact: true }).click();
      } else await clickAppAction(page, "新建 Bot");
      await page.getByLabel("Bot 名称", { exact: true }).fill("代码助手"); await page.getByLabel("引擎", { exact: true }).selectOption(engine);
      if (engine === "claude") {
        await expect(page.getByLabel("模型", { exact: true })).toHaveValue(selectedModel);
        await expect(page.getByLabel("推理强度（effort）")).toHaveValue(selectedEffort);
      } else if (engine === "antigravity") {
        await expect(page.getByLabel("模型", { exact: true })).toHaveValue("gemini-4-argon-medium");
        await expect(page.getByLabel("模型", { exact: true }).locator("option:checked")).toHaveText("Gemini 4 Argon");
        await expect(page.getByLabel("推理强度（effort）")).toHaveValue("medium");
        await expect(page.getByLabel("模型", { exact: true }).locator("option")).toHaveText(["跟随引擎默认模型", "Gemini 4 Argon", "Gemini 3.8 Flash", "Gemini 3.7 Flash", "Gemini 3.1 Pro", "GPT-OSS 120B"]);
        await page.getByLabel("模型", { exact: true }).selectOption("gemini-3.1-pro-high");
        await expect(page.getByLabel("推理强度（effort）").locator("option")).toHaveText(["low", "high"]);
        await page.getByLabel("模型", { exact: true }).selectOption("gpt-oss-120b-medium");
        await expect(page.getByLabel("推理强度（effort）").locator("option")).toHaveText(["medium"]);
        await page.getByLabel("模型", { exact: true }).selectOption("");
        await expect(page.getByLabel("推理强度（effort）").locator("option")).toHaveCount(1);
        await page.getByLabel("模型", { exact: true }).selectOption("gemini-4-argon-medium");
        await expect(page.getByLabel("推理强度（effort）").locator("option")).toHaveText(["low", "medium", "high"]);
      } else {
        await expect(page.getByLabel("模型", { exact: true })).toHaveValue("gpt-6-astra");
        for (const model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
          await page.getByLabel("模型", { exact: true }).selectOption(model);
          const options = page.getByLabel("推理强度（effort）").locator("option");
          expect(await options.evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))).toEqual(["", "low", "medium", "high", "xhigh", "max", ...(model === "gpt-6-luna" ? [] : ["ultra"])]);
        }
        await page.getByLabel("模型", { exact: true }).selectOption("gpt-5.5");
        await expect(page.getByLabel("推理强度（effort）").locator('option[value="ultra"]')).toHaveCount(0);
      }
      await expect(page.getByLabel("权限与批准", { exact: true })).toHaveValue("bypass");
      await expect(page.getByLabel("权限与批准", { exact: true }).locator('option[value="bypass"]')).toContainText("默认");
      await page.getByLabel("权限与批准", { exact: true }).selectOption(engine === "claude" ? "claude-auto" : "normal");
      await page.getByLabel("模型", { exact: true }).selectOption(engine === "antigravity" ? "gemini-4-argon-medium" : selectedModel); await page.getByLabel("推理强度（effort）").selectOption(selectedEffort); await page.screenshot({ path: info.outputPath("new-bot-settings.png"), fullPage: true, animations: "disabled" });
      await page.getByRole("button", { name: "创建 Bot", exact: true }).click(); await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible();
      await expect(page.locator(".bot-created [data-preset] img")).toBeVisible();
      await expect(page.locator(".bot-created [data-preset]")).toHaveAttribute("data-preset", "pastel-fox");
      // A browser/phone controlling a host must not show native first-host setup.
      await expect(page.locator(".bot-created .integration-recommendations")).toHaveCount(0);
      // The approved animal library ships individual 256px crops, not 2048px sprite sheets.
      await expect.poll(() => page.locator(".bot-created [data-preset] img").evaluate((img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight])).toEqual([256, 256]);
      const bots = await hub.store.bots("owner"); expect(bots).toHaveLength(1); expect(bots[0]).toMatchObject({ name: "代码助手", model: selectedModel, effort: selectedEffort, online: 1 });
      expect(bots[0]?.defaultAvatar).toBe("pastel-fox");
      expect(JSON.parse(await readFile(path.join(root, "bots", bots[0]!.id, "config.json"), "utf8"))).toMatchObject({ engine, model: selectedModel, effort: selectedEffort, approvalMode: "normal", ...(engine === "claude" ? { claudePermissionMode: "auto" } : {}) });
      await page.getByRole("button", { name: "开始对话", exact: true }).click(); await expect(page.getByRole("heading", { name: "与 代码助手 的新对话", exact: true })).toBeVisible(); expect((await hub.store.conversations("owner"))[0]?.botIds).toEqual([bots[0]!.id]);
    } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
  });

}

test("a delayed creation receipt cannot undo a rename already synced from another device", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "creation-receipt-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
  const firstContext = await browser.newContext(), secondContext = await browser.newContext();
  const first = await firstContext.newPage(), second = await secondContext.newPage();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','研究助手','fixture')");
    await pair(first, hub); await pair(second, hub);
    await first.route("**/api/conversations", async (route) => {
      const response = await route.fetch();
      await held; await route.fulfill({ response });
    });
    await clickAppAction(first, "新建群组", first.getByRole("button", { name: "新建群组", exact: true }));
    const dialog = first.getByRole("dialog", { name: "新建群组", exact: true });
    await dialog.getByRole("checkbox").check();
    await dialog.getByPlaceholder("为这段对话起个名字").fill("创建时的名称");
    await dialog.getByRole("button", { name: "创建群组", exact: true }).click();
    await second.locator(".conversation-row").filter({ hasText: "创建时的名称" }).click();
    await clickAppAction(second, "对话设置", second.getByRole("button", { name: "对话设置", exact: true }));
    await second.getByLabel("对话名称", { exact: true }).fill("另一设备更新的名称");
    await second.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(first.locator(".conversation-row").filter({ hasText: "另一设备更新的名称" })).toHaveCount(1);
    release();
    await expect(dialog).toHaveCount(0);
    await expect(first.getByRole("heading", { name: "另一设备更新的名称", exact: true })).toBeVisible();
    await expect(first.locator(".conversation-row").filter({ hasText: "创建时的名称" })).toHaveCount(0);
    expect((await hub.store.conversations("owner"))[0]?.title).toBe("另一设备更新的名称");
  } finally { release(); await firstContext.close(); await secondContext.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

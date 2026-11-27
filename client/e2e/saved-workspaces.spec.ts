import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openBotSettings } from "./fixtures/bot-settings.js";

test("BotWorkspaceDialog recovers from workspace_conflict via Reload and WorkspacePicker handles invalid browse, errors, and out-of-order browse", async ({ browser }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-saved-workspaces-ui-"));
  const stateDir = path.join(root, "bot");
  const folderA = path.join(root, "alpha");
  const folderB = path.join(root, "beta");
  const folderC = path.join(root, "gamma");
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(folderA, { recursive: true }),
    mkdir(folderB, { recursive: true }),
    mkdir(folderC, { recursive: true }),
  ]);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", workspacePath: folderA, locale: "zh" }));

  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,?)", ["alpha", "代码助手", hashSecret(secret), "codex"]);
  const gateway = await attachGateway({
    stateDir,
    url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`,
    secret,
    botId: "alpha",
    engine: "codex",
    runtime: createCoreServiceRuntime(),
    bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) },
  });

  const contexts = await Promise.all([1360, 1360].map(width => browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" })));
  const [pageA, pageB] = await Promise.all(contexts.map(c => c.newPage()));
  const errors: string[] = [];
  for (const page of [pageA!, pageB!]) page.on("pageerror", error => errors.push(error.message));

  try {
    await hub.savedWorkspaces.add("owner", { path: folderA, name: "Alpha" });
    await hub.savedWorkspaces.add("owner", { path: folderB, name: "Beta" });
    await hub.savedWorkspaces.add("owner", { path: folderC, name: "Gamma" });
    await hub.store.createConversation("owner", ["alpha"], "默认测试对话", "ws-chat-1");

    for (const page of [pageA!, pageB!]) {
      await page.goto(hub.url);
      await preparePairing(page, hub);
      await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page);
      await selectConversation(page, "默认测试对话");
      await openBotSettings(page);
      await page.getByRole("button", { name: /^切换 Bot 默认工作区：/ }).click();
      await expect(page.getByRole("dialog", { name: "默认工作区", exact: true })).toBeVisible();
    }

    // 1. Bug #9: Device B switches workspace to Beta; Device A attempts stale switch to Gamma -> 409 conflict.
    // Reload button MUST be visible even while data is retained, and clicking it recovers cleanly.
    const dialogB = pageB!.getByRole("dialog", { name: "默认工作区", exact: true });
    await dialogB.getByRole("button", { name: /^Beta/ }).click();
    await expect(dialogB.getByRole("status")).toContainText("已切换默认工作区为「beta」");

    const dialogA = pageA!.getByRole("dialog", { name: "默认工作区", exact: true });
    await dialogA.getByRole("button", { name: /^Gamma/ }).click();
    await expect(dialogA.getByRole("alert")).toContainText("其他设备或本机已修改默认工作区，请重新读取后再切换。");
    const reloadBtn = dialogA.getByRole("button", { name: "重新读取", exact: true });
    await expect(reloadBtn).toBeVisible();
    await reloadBtn.click();
    await expect(dialogA.getByText(path.resolve(folderB)).first()).toBeVisible();
    await dialogA.getByRole("button", { name: /^Gamma/ }).click();
    await expect(dialogA.getByRole("status")).toContainText("已切换默认工作区为「gamma」");

    // 2. Bug #10a: Invalid typed path on Browse does NOT dead-end Home button; clicking Home loads home directory.
    await dialogA.getByRole("button", { name: "添加文件夹", exact: true }).click();
    const pathInput = dialogA.getByLabel("文件夹路径", { exact: true });
    await pathInput.fill(path.join(root, "does-not-exist-anywhere"));
    await dialogA.getByRole("button", { name: "浏览目录", exact: true }).click();
    await expect(dialogA.getByRole("alert")).toContainText("无法浏览主机上的该目录");
    const homeBtn = dialogA.getByRole("button", { name: "回到主目录", exact: true });
    await expect(homeBtn).toBeEnabled();
    await homeBtn.click();
    await expect(dialogA.locator(".workspace-browser-path")).toHaveText(path.resolve(os.homedir()));

    // 3. Bug #10b: Out-of-order browse responses cannot overwrite a newer navigation.
    let releaseSlowBrowse!: () => void;
    const slowBrowsePending = new Promise<void>(resolve => { releaseSlowBrowse = resolve; });
    let slowStarted!: () => void;
    const slowStartedPromise = new Promise<void>(resolve => { slowStarted = resolve; });
    await pageA!.route("**/api/workspaces/browse*", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("path") === path.resolve(folderA)) {
        slowStarted();
        await slowBrowsePending;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ path: path.resolve(folderA), parent: path.resolve(root), home: path.resolve(root), entries: [] }),
        });
        return;
      }
      if (!url.searchParams.get("path") || url.searchParams.get("path") === path.resolve(root)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ path: path.resolve(root), parent: null, home: path.resolve(root), entries: [{ name: "alpha", path: path.resolve(folderA) }] }),
        });
        return;
      }
      await route.continue();
    });
    await dialogA.getByRole("button", { name: "收起目录", exact: true }).click();
    await pathInput.fill(path.resolve(folderA));
    await dialogA.getByRole("button", { name: "浏览目录", exact: true }).click();
    await slowStartedPromise;
    // Close and re-open browse with root while the slow folderA browse is still in flight
    await dialogA.getByRole("button", { name: "收起目录", exact: true }).click();
    await pathInput.fill(path.resolve(root));
    await dialogA.getByRole("button", { name: "浏览目录", exact: true }).click();
    await expect(dialogA.locator(".workspace-browser-path")).toHaveText(path.resolve(root));
    releaseSlowBrowse();
    await pageA!.waitForTimeout(100);
    await expect(dialogA.locator(".workspace-browser-path")).toHaveText(path.resolve(root));
    await pageA!.unroute("**/api/workspaces/browse*");

    // 4. Bug #10c: Failed DELETE /api/workspaces/:id surfaces alert without unhandled rejection.
    await pageA!.route("**/api/workspaces/*", async route => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
        return;
      }
      await route.continue();
    });
    await dialogA.getByRole("button", { name: "移除常用工作区「Alpha」", exact: true }).click();
    await expect(dialogA.getByRole("alert")).toContainText("移除常用工作区失败");
    await pageA!.unroute("**/api/workspaces/*");

    // 5. Bug #10d: Failed GET /api/workspaces surfaces error instead of false empty state in BotWorkspaceDialog.
    await pageA!.route("**/api/workspaces", async route => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
        return;
      }
      await route.continue();
    });
    await dialogA.getByRole("button", { name: "关闭默认工作区设置", exact: true }).click();
    await pageA!.getByRole("button", { name: /^切换 Bot 默认工作区：/ }).click();
    await expect(dialogA.getByRole("alert")).toContainText("暂时无法读取常用工作区列表。");
    await expect(dialogA.getByText("还没有常用工作区")).toHaveCount(0);
    await dialogA.getByRole("button", { name: "关闭默认工作区设置", exact: true }).click();
    await pageA!.getByRole("button", { name: "关闭 Bot 设置", exact: true }).click();

    // NewConversation also renders savedWorkspaces.error when GET /api/workspaces fails.
    await pageA!.getByRole("button", { name: "新建独立对话", exact: true }).click();
    const newChatDialog = pageA!.getByRole("dialog", { name: "新建对话", exact: true });
    await expect(newChatDialog.getByRole("alert")).toContainText("暂时无法读取常用工作区列表。");
    await pageA!.unroute("**/api/workspaces");

    expect(errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
    await gateway.disconnect();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

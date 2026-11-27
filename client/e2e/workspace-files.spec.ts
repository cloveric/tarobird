import { test, expect, type Page } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { enterMobileChat, mobileHome, selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

const execFile = promisify(execFileCallback);

test.use({ serviceWorkers: "block", actionTimeout: 15_000 });

const back = (page: Page) => page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
}

async function createFixture(page: Page, options: { phone?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-files-e2e-"));
  const stateDir = path.join(root, "hub");
  const wsA = path.join(root, "workspace-a");
  const wsB = path.join(root, "workspace-b");
  await mkdir(path.join(wsA, "subA"), { recursive: true });
  await mkdir(wsB, { recursive: true });

  // Workspace A is a git repo with modified, deleted, and special-named files.
  await git(wsA, "init", "-q");
  await writeFile(path.join(wsA, "README.md"), "# Workspace A\n");
  await writeFile(path.join(wsA, "Makefile"), "all:\n\techo hi\n");
  await writeFile(path.join(wsA, "My Notes.md"), "Notes A\n");
  await writeFile(path.join(wsA, "需求文档.md"), "# 需求\n");
  await writeFile(path.join(wsA, "deleted.txt"), "will be deleted\n");
  await writeFile(path.join(wsA, "subA", "slow.txt"), "SLOW_FILE_CONTENT\n");
  await writeFile(path.join(wsA, "subA", "fast.txt"), "FAST_FILE_CONTENT\n");
  await git(wsA, "add", ".");
  await git(wsA, "commit", "-q", "-m", "initial");
  await rm(path.join(wsA, "deleted.txt"));
  await writeFile(path.join(wsA, "subA", "fast.txt"), "FAST_FILE_CONTENT_EDITED\n");

  // Workspace B is a separate workspace without subA.
  await writeFile(path.join(wsB, "only-in-b.txt"), "HELLO_B\n");

  const botAState = path.join(stateDir, "bots", "bot_a");
  const botBState = path.join(stateDir, "bots", "bot_b");
  await mkdir(botAState, { recursive: true });
  await mkdir(botBState, { recursive: true });
  await writeFile(path.join(botAState, "config.json"), JSON.stringify({ workspacePath: wsA }));
  await writeFile(path.join(botBState, "config.json"), JSON.stringify({ workspacePath: wsB }));

  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  (hub as unknown as { botManager: unknown }).botManager = {
    owns: async (id: string) => id === "bot_a" || id === "bot_b",
    beginShutdown: () => {},
    close: async () => {},
    shutdownComplete: true,
  };
  await hub.store.db.run(
    "INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('bot_a','Architect',?,'claude',1),('bot_b','Reviewer',?,'codex',1)",
    [hashSecret(randomBytes(16).toString("hex")), hashSecret(randomBytes(16).toString("hex"))],
  );
  const convA = await hub.store.createConversation("owner", ["bot_a"], "工作区对话 A", "ws_conv_a");
  const convB = await hub.store.createConversation("owner", ["bot_b"], "工作区对话 B", "ws_conv_b");
  const groupConv = await hub.store.createConversation("owner", ["bot_a", "bot_b"], "工作区群聊", "ws_group");

  if (options.phone) await page.setViewportSize({ width: 390, height: 844 });
  else await page.setViewportSize({ width: 1360, height: 900 });

  await page.goto(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
  await showDisconnectedBots(page);

  return {
    hub,
    convA,
    convB,
    groupConv,
    close: async () => {
      await hub.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("desktop Files panel hides cleanly when closed, coexists with Workspace rail, guards preview/switch races, and mentions safely in groups", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const f = await createFixture(page, { phone: false });
  try {
    await selectConversation(page, f.convA.title);

    // Closed Files panel must be display:none and inert, leaving <main> unobstructed.
    const filesPanel = page.locator("aside.workspace-files-panel");
    await expect(filesPanel).toBeHidden();
    expect(await filesPanel.evaluate((node) => ({
      hidden: node.hidden,
      inert: (node as HTMLElement).inert,
      display: getComputedStyle(node).display,
    }))).toEqual({ hidden: true, inert: true, display: "none" });
    const mainWidthClosed = await page.locator("main.conversation-main").evaluate((n) => n.getBoundingClientRect().width);
    expect(mainWidthClosed).toBeGreaterThanOrEqual(900);

    // Mutual exclusion with Conversation Workspace rail.
    const workspaceBtn = page.getByRole("button", { name: "会话工作区", exact: true });
    const filesBtn = page.getByRole("button", { name: "文件", exact: true });
    await workspaceBtn.click();
    await expect(page.locator("aside.conversation-workspace-rail")).toBeVisible();

    await filesBtn.click();
    await expect(filesPanel).toBeVisible();
    await expect(page.locator("aside.conversation-workspace-rail")).toHaveCount(0);

    // Opening Workspace rail over Files covers Files and restores Files on close.
    await workspaceBtn.click();
    await expect(page.locator("aside.conversation-workspace-rail")).toBeVisible();
    await expect(filesPanel).toBeHidden();
    await workspaceBtn.click();
    await expect(page.locator("aside.conversation-workspace-rail")).toHaveCount(0);
    await expect(filesPanel).toBeVisible();

    // Deleted git file appears with "已删" badge and survives "改动" filter; subdirectories use changes=0.
    const subRequests: string[] = [];
    await page.route("**/workspace-files/tree*", async (route) => {
      subRequests.push(route.request().url());
      await route.continue();
    });
    await expect(filesPanel.getByText("deleted.txt", { exact: true })).toBeVisible();
    await expect(filesPanel.locator(".wf-git-badge.is-deleted")).toHaveText("已删");
    await filesPanel.locator(".wf-filter-pill").click();
    await expect(filesPanel.getByText("deleted.txt", { exact: true })).toBeVisible();
    await filesPanel.locator(".wf-filter-pill").click();

    // Expand subA and verify changes=0 was sent for subdirectory.
    await filesPanel.getByRole("button", { name: /subA/ }).first().click();
    await expect(filesPanel.getByText("slow.txt", { exact: true })).toBeVisible();
    await expect(filesPanel.getByText("fast.txt", { exact: true })).toBeVisible();
    expect(subRequests.some((url) => url.includes("path=subA") && url.includes("changes=0"))).toBe(true);

    // Out-of-order preview race: click slow.txt, return to directory while loading, click fast.txt.
    // Late slow.txt response must NOT overwrite fast.txt preview.
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    await page.route("**/workspace-files/preview*", async (route) => {
      if (route.request().url().includes("slow.txt")) {
        await slowGate;
      }
      await route.continue();
    });
    await filesPanel.getByRole("button", { name: /slow\.txt/ }).first().click();
    await expect(filesPanel.getByRole("button", { name: "返回目录", exact: true })).toBeVisible();
    await filesPanel.getByRole("button", { name: "返回目录", exact: true }).click();
    await filesPanel.getByRole("button", { name: /fast\.txt/ }).first().click();
    await expect(filesPanel).toContainText("FAST_FILE_CONTENT_EDITED");
    releaseSlow();
    await page.waitForTimeout(150);
    await expect(filesPanel).toContainText("FAST_FILE_CONTENT_EDITED");
    await expect(filesPanel).not.toContainText("SLOW_FILE_CONTENT");

    // Click slow.txt, then click "返回目录" while it is still loading; late response must NOT reopen preview.
    let releaseBackSlow!: () => void;
    const backSlowGate = new Promise<void>((resolve) => { releaseBackSlow = resolve; });
    await page.unroute("**/workspace-files/preview*");
    await page.route("**/workspace-files/preview*", async (route) => {
      if (route.request().url().includes("slow.txt")) {
        await backSlowGate;
      }
      await route.continue();
    });
    await filesPanel.getByRole("button", { name: "返回目录", exact: true }).click();
    await filesPanel.getByRole("button", { name: /slow\.txt/ }).first().click();
    await expect(filesPanel.getByRole("button", { name: "返回目录", exact: true })).toBeVisible();
    await filesPanel.getByRole("button", { name: "返回目录", exact: true }).click();
    releaseBackSlow();
    await page.waitForTimeout(150);
    await expect(filesPanel.getByRole("button", { name: "返回目录", exact: true })).toHaveCount(0);
    await expect(filesPanel.getByText("README.md", { exact: true })).toBeVisible();

    // Switching conversations while Files panel stays visible on both conversations must NOT query Conv A's expanded subA against Conv B.
    const convBRequests: string[] = [];
    await page.unroute("**/workspace-files/tree*");
    await page.unroute("**/workspace-files/preview*");
    // Open Files in Conv B first so both Conv A and Conv B have Files open.
    await selectConversation(page, f.convB.title);
    await filesBtn.click();
    await expect(filesPanel.getByText("only-in-b.txt", { exact: true })).toBeVisible();
    // Switch back to Conv A (Files stays visible), expand subA, then switch directly to Conv B (Files stays visible across switch).
    await selectConversation(page, f.convA.title);
    await expect(filesPanel.getByText("README.md", { exact: true })).toBeVisible();
    await filesPanel.getByRole("button", { name: /subA/ }).first().click();
    await expect(filesPanel.getByText("slow.txt", { exact: true })).toBeVisible();
    await page.route(`**/api/conversations/${f.convB.id}/workspace-files/tree*`, async (route) => {
      convBRequests.push(route.request().url());
      await route.continue();
    });
    await selectConversation(page, f.convB.title);
    await expect(filesPanel).toBeVisible();
    await expect(filesPanel.getByText("only-in-b.txt", { exact: true })).toBeVisible();
    expect(convBRequests.some((url) => url.includes("subA"))).toBe(false);
    await page.unroute(`**/api/conversations/${f.convB.id}/workspace-files/tree*`);

    // Truncated directory state displays a friendly notice.
    await page.route(`**/api/conversations/${f.convB.id}/workspace-files/tree*`, async (route) => {
      const response = await route.fetch();
      const body = await response.json() as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...body, truncated: true, fingerprint: `${String(body.fingerprint)}-t` },
      });
    }, { times: 1 });
    await filesPanel.getByRole("button", { name: "刷新文件树", exact: true }).click();
    await expect(filesPanel.locator(".wf-truncated-dir")).toContainText("500");

    // Group chat: mentioning extensionless / spaced / CJK files must not trigger mentionProblem error.
    await selectConversation(page, f.groupConv.title);
    await filesBtn.click();
    await expect(filesPanel.getByText("Makefile", { exact: true })).toBeVisible();
    await filesPanel.getByRole("button", { name: "引用文件：Makefile", exact: true }).click();
    await filesPanel.getByRole("button", { name: "引用文件：My Notes.md", exact: true }).click();
    await filesPanel.getByRole("button", { name: "引用文件：需求文档.md", exact: true }).click();
    const composer = page.locator(".conversation-main textarea").last();
    await expect(composer).toHaveValue("`@Makefile` `@My Notes.md` `@需求文档.md` ");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".error-banner")).toHaveCount(0);

    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("phone Files panel stays non-blocking when hidden, uses horizontal safe-area insets, and handles Back (Preview -> Tree -> Chat -> Home)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const f = await createFixture(page, { phone: true });
  try {
    // Hidden phone Files panel must not intercept clicks on MobileHome.
    await enterMobileChat(page, f.convA.title);
    const filesPanel = page.locator("aside.workspace-files-panel.workspace-files-phone");
    await expect(filesPanel).toBeHidden();

    // The phone header leaves room for the title. Open workspace files from chat actions.
    const header = page.locator(".conversation-header:visible");
    await expect(header.getByRole("button", { name: "文件", exact: true })).toHaveCount(0);
    await header.getByRole("button", { name: "更多聊天操作", exact: true }).click();
    const actions = page.getByRole("dialog", { name: "聊天操作", exact: true });
    await actions.getByRole("button", { name: "工作区文件", exact: true }).click();
    await expect(actions).toBeHidden();
    await expect(filesPanel).toBeVisible();
    await expect(filesPanel.getByText("README.md", { exact: true })).toBeVisible();

    // Verify horizontal safe-area insets are applied on .workspace-files-phone.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--app-safe-left", "24px");
      document.documentElement.style.setProperty("--app-safe-right", "20px");
    });
    const padding = await filesPanel.evaluate((node) => {
      const style = getComputedStyle(node);
      return { left: style.paddingLeft, right: style.paddingRight };
    });
    expect(padding).toEqual({ left: "24px", right: "20px" });

    // Open preview -> 1st Back returns to Tree -> 2nd Back returns to Chat -> 3rd Back returns to MobileHome.
    await filesPanel.getByRole("button", { name: /README\.md/ }).first().click();
    await expect(filesPanel.getByRole("button", { name: "返回目录", exact: true })).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(filesPanel).toBeVisible();
    await expect(filesPanel.getByRole("button", { name: "返回目录", exact: true })).toHaveCount(0);
    await expect(filesPanel.getByText("README.md", { exact: true })).toBeVisible();

    expect(await back(page)).toBe(true);
    await expect(filesPanel).toBeHidden();
    await expect(page.getByRole("heading", { name: f.convA.title, exact: true })).toBeVisible();

    expect(await back(page)).toBe(true);
    await expect(mobileHome(page)).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

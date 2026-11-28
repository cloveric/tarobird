import { test, expect, type Page } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HubServer } from "../../src/hub/server.js";
import { RunJournal } from "../../src/hub/run-journal.js";
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


test("Files panel says where the Bot works and what this turn changed; 文件 is a labelled entry with a count and 本轮改动 opens it", async ({ page }) => {
  const f = await createFixture(page, { phone: false });
  try {
    // A finished reply in A that recorded edits to two files.
    const { message: ask } = await f.hub.store.sendMessage("owner", { conversationId: f.convA.id, clientMsgId: "cm_files_turn", text: "改一下说明", attachments: [], mentions: ["bot_a"], previewUrl: null });
    const runId = "run_files_turn", start = Date.now() - 10_000, end = Date.now() - 1_000;
    const reply = await f.hub.store.publishBotMessage("bot_a", { conversationId: f.convA.id, replyTo: ask.id, status: "complete", blocks: [{ type: "card", title: "完成", elements: [{ type: "markdown", text: "已改好。" }], extra: {
      nativeRun: { version: 1, id: runId, revision: 2, phase: "done", startedAt: start, updatedAt: end, endedAt: end, count: 2, completed: 2, failed: 0, truncated: false },
      runChanges: { v: 1, runId, revision: 2, files: 2, edits: 2, additions: 3, deletions: 1, unavailable: 0, partial: false, childEdits: 0 },
    } }] as never });
    await new RunJournal(f.hub.store).write("bot_a", { conversationId: f.convA.id, messageId: reply.id, runId, entries: [
      { seq: 1, revision: 1, kind: "tool", status: "done", at: start + 1000, endedAt: start + 2000, name: "edit_file", changes: [{ path: "subA/fast.txt", diff: "@@ -1,1 +1,2 @@\n-a\n+b\n+c" }] },
      { seq: 2, revision: 2, kind: "tool", status: "done", at: start + 3000, endedAt: end, name: "edit_file", changes: [{ path: "README.md", diff: "@@ -1,1 +1,1 @@\n-x\n+y" }] },
    ] } as never);
    await selectConversation(page, f.convA.title);
    const header = page.locator(".host-workspace:not([hidden]) .conversation-header");

    // Option A: a labelled 「文件」 button with this turn's changed-file count, like 「工作区」.
    const filesBtn = header.getByRole("button", { name: "文件，本轮改动 2 个", exact: true });
    await expect(filesBtn).toBeVisible();
    await expect(filesBtn.locator(".workspace-rail-trigger-label")).toHaveText("文件");
    await expect(filesBtn.locator(".workspace-rail-trigger-badge")).toHaveText("2");
    await filesBtn.click();
    const panel = page.locator("aside.workspace-files-panel");
    await expect(panel).toBeVisible();

    // The panel's header rule continues the conversation header's rule.
    const ruleY = async (selector: string) => page.locator(selector).evaluate((node) => Math.round(node.getBoundingClientRect().bottom));
    for (const width of [1360, 820, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await ruleY("aside.workspace-files-panel .wf-header")) - (await ruleY(".host-workspace:not([hidden]) .conversation-header"))).toBe(0);
    }

    // Where the Bot works: the real directory, not only its name.
    const root = panel.locator(".wf-crumb-root");
    await expect(root).toHaveClass(/is-path/);
    await expect(root).toContainText("/workspace-a");
    await expect(panel.locator(".wf-root-note")).toHaveText("Bot 的工作目录");

    // This turn's changes: both files with their counts; the tree marks changed files and their folders.
    const changes = panel.getByRole("region", { name: "这轮改动", exact: true });
    await expect(changes).toContainText("这轮改动 · 2 个文件");
    await expect(changes.locator(".wf-run-change-name")).toHaveText(["fast.txt", "README.md"]);
    await expect(changes.locator(".wf-run-change-counts")).toHaveCount(2);
    await expect(panel.locator(".wf-section-title", { hasText: "全部文件" })).toBeVisible();
    await expect(panel.locator(".wf-row", { hasText: "subA" }).locator(".wf-git-dot")).toBeVisible();
    await expect(panel.locator(".wf-row", { hasText: "deleted.txt" }).locator(".wf-git-badge")).toBeVisible();

    // 「只看改动的」 filters the tree and hides the turn section while on.
    const only = panel.getByRole("button", { name: /^只看改动的/ });
    await only.click(); await expect(only).toHaveAttribute("aria-pressed", "true");
    await expect(changes).toHaveCount(0);
    await expect(panel.locator(".wf-row", { hasText: "Makefile" })).toHaveCount(0);
    await only.click(); await expect(changes).toBeVisible();

    // The hint lists what works, and dragging a file into the composer references it.
    await expect(panel.locator(".wf-hint")).toContainText("单击");
    await expect(panel.locator(".wf-hint")).toContainText("拖到输入框");
    const composer = page.getByRole("textbox", { name: "消息", exact: true }).filter({ visible: true });
    await panel.locator(".wf-row", { hasText: "Makefile" }).dragTo(composer);
    await expect(composer).toHaveValue(/`@Makefile`/);

    // 「看全部变更」 opens the run's diff viewer.
    await changes.getByRole("button", { name: /看全部变更/ }).click();
    const viewer = page.getByRole("dialog", { name: "本轮改动", exact: true });
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "关闭改动查看器" }).click();
    await expect(viewer).toBeHidden();

    // Closed panel; the reply's 「本轮改动」 opens it at this turn's changes (not the viewer).
    await panel.getByRole("button", { name: "关闭文件面板", exact: true }).click();
    await expect(panel).toBeHidden();
    await page.locator(".message-body").getByRole("button", { name: "本轮改动", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(changes).toBeInViewport();
    await expect(viewer).toHaveCount(0);

    // A tighter window with the panel open: the label gives way, the icon and the count stay (as 「工作区」 does).
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(filesBtn.locator(".workspace-rail-trigger-label")).toBeHidden();
    await expect(filesBtn.locator(".workspace-rail-trigger-badge")).toBeVisible();
    await page.setViewportSize({ width: 1360, height: 900 });

    // A conversation without recorded changes: plain 「文件」, no count.
    await selectConversation(page, f.convB.title);
    const plain = header.getByRole("button", { name: "文件", exact: true });
    await expect(plain).toBeVisible();
    await expect(plain.locator(".workspace-rail-trigger-badge")).toHaveCount(0);
  } finally { await f.close(); }
});

test("group reply changes open the workspace of the Bot that made them", async ({ page }) => {
  const f = await createFixture(page);
  try {
    const { message: prompt } = await f.hub.store.sendMessage("owner", {
      conversationId: f.groupConv.id, clientMsgId: "group_workspace", text: "更新文件",
      attachments: [], mentions: ["bot_b"],
    });
    const at = Date.now();
    const message = await f.hub.store.publishBotMessage("bot_b", {
      conversationId: f.groupConv.id, replyTo: prompt.id, status: "complete",
      blocks: [{
        type: "card", title: "完成", elements: [{ type: "markdown", text: "改好了" }],
        extra: {
          nativeRun: { version: 1, id: "example_run", revision: 1, phase: "done", startedAt: at - 1000, updatedAt: at, endedAt: at, count: 1, completed: 1, failed: 0, truncated: false },
          runChanges: { v: 1, runId: "example_run", revision: 1, files: 1, edits: 1, additions: 1, deletions: 0, unavailable: 0, partial: false, childEdits: 0 },
        },
      }],
    });
    await new RunJournal(f.hub.store).write("bot_b", {
      conversationId: f.groupConv.id, messageId: message.id, runId: "example_run",
      entries: [{ seq: 1, revision: 1, kind: "tool", status: "done", at: at - 300, endedAt: at, name: "edit_file",
        changes: [{ path: "only-in-b.txt", diff: "@@ -0,0 +1 @@\n+hello" }] }],
    });
    await selectConversation(page, f.groupConv.title);
    await page.locator(".message-body").getByRole("button", { name: "本轮改动", exact: true }).click();
    const panel = page.locator("aside.workspace-files-panel");
    await expect(panel.getByRole("region", { name: "这轮改动", exact: true })).toContainText("only-in-b.txt");
    await expect(panel.locator(".wf-crumb-root")).toContainText("/workspace-b");
    await expect(panel.locator(".wf-row", { hasText: "only-in-b.txt" })).toBeVisible();
    await expect(panel.locator(".wf-row", { hasText: "Makefile" })).toHaveCount(0);
    await panel.getByRole("button", { name: "关闭文件面板", exact: true }).click();

    await page.locator(".conversation-header").getByRole("button", { name: "文件，本轮改动 1 个" }).click();
    await expect(panel.locator(".wf-crumb-root")).toContainText("/workspace-b");
    await expect(panel.getByRole("region", { name: "这轮改动", exact: true })).toContainText("only-in-b.txt");
  } finally {
    await page.close();
    await f.close();
  }
});

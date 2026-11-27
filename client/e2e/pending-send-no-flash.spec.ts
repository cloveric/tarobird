import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { messageAction } from "./fixtures/message-actions.js";
import { singleHostCacheName } from "./fixtures/cache.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

type SampleReport = {
  queuedCountMax: number;
  maxBubbleCopies: number;
  lefts: number[];
  widths: number[];
  bgs: string[];
  prevBottomDelta: number;
  sawFinalBubble: boolean;
};

async function installSendFrameSampler(page: Page, text: string) {
  await page.evaluate((targetText) => {
    const state = {
      active: true,
      queuedCountMax: 0,
      maxBubbleCopies: 0,
      lefts: [] as number[],
      widths: [] as number[],
      bgs: [] as string[],
      initialPrevBottom: undefined as number | undefined,
      prevBottomDelta: 0,
      sawFinalBubble: false,
    };
    const prevRow = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].at(-1);
    if (prevRow) state.initialPrevBottom = prevRow.getBoundingClientRect().bottom;

    const record = () => {
      const queued = document.querySelectorAll(".queued-message").length;
      if (queued > state.queuedCountMax) state.queuedCountMax = queued;
      const matches = [...document.querySelectorAll<HTMLElement>(".message.user")].filter(
        (node) => node.innerText.includes(targetText),
      );
      if (matches.length > state.maxBubbleCopies) state.maxBubbleCopies = matches.length;
      const row = matches[0];
      if (row) {
        const bubble = row.querySelector<HTMLElement>(".message-blocks");
        if (bubble) {
          const rect = bubble.getBoundingClientRect();
          const bg = getComputedStyle(bubble).backgroundColor;
          if (!state.lefts.length || Math.abs(state.lefts.at(-1)! - rect.left) > 0.5) state.lefts.push(Math.round(rect.left));
          if (!state.widths.length || Math.abs(state.widths.at(-1)! - rect.width) > 0.5) state.widths.push(Math.round(rect.width));
          if (!state.bgs.length || state.bgs.at(-1) !== bg) state.bgs.push(bg);
        }
        if (!row.classList.contains("is-pending-outbox")) state.sawFinalBubble = true;
      }
      if (prevRow && prevRow.isConnected && state.initialPrevBottom !== undefined) {
        const delta = Math.abs(prevRow.getBoundingClientRect().bottom - state.initialPrevBottom);
        if (delta > state.prevBottomDelta) state.prevBottomDelta = delta;
      }
    };

    const observer = new MutationObserver(() => { if (state.active) record(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const tick = () => {
      if (!state.active) return;
      record();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Object.assign(window, {
      __sendSampleStop: (): SampleReport => {
        state.active = false;
        observer.disconnect();
        record();
        return {
          queuedCountMax: state.queuedCountMax,
          maxBubbleCopies: state.maxBubbleCopies,
          lefts: state.lefts,
          widths: state.widths,
          bgs: state.bgs,
          prevBottomDelta: state.prevBottomDelta,
          sawFinalBubble: state.sawFinalBubble,
        };
      },
    });
  }, text);
}

async function stopSendFrameSampler(page: Page): Promise<SampleReport> {
  return page.evaluate(() => (window as any).__sendSampleStop());
}

for (const formFactor of [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
]) {
  for (const length of ["short", "long"] as const) {
    test(`normal online send shows zero dashed box and zero bubble jump (${formFactor.name}, ${length})`, async ({ page }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "no-flash-"));
      const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
      try {
        await page.setViewportSize(formFactor.viewport);
        await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_codex','Codex Bot','codex','fixture',1)");
        const chat = await hub.store.createConversation("owner", ["bot_codex"], "No Flash Chat", "chat_1");
        const seedCount = length === "long" ? 40 : 2;
        for (let i = 0; i < seedCount; i++) {
          await hub.store.publishBotMessage("bot_codex", { conversationId: chat.id, blocks: [{ type: "text", text: `Seed message ${i}` }] });
        }
        await page.goto(hub.url);
        await preparePairing(page, hub);
        await page.getByRole("button", { name: "配对此设备", exact: true }).click();
        await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
        await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
        await waitForClientOnline(page);
        await selectConversation(page, "No Flash Chat");
        await expect(page.locator(".message-blocks").filter({ hasText: `Seed message ${seedCount - 1}` })).toBeInViewport();

        const targetText = `Direct online message ${formFactor.name} ${length}`;
        const input = page.getByRole("textbox", { name: "消息", exact: true });
        await input.fill(targetText);
        await installSendFrameSampler(page, targetText);
        await page.getByRole("button", { name: "发送消息", exact: true }).click();
        await expect(page.locator(".message.user").filter({ hasText: targetText })).toBeInViewport();
        await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: targetText })).toHaveCount(0);
        const report = await stopSendFrameSampler(page);

        expect(report.queuedCountMax).toBe(0);
        expect(report.maxBubbleCopies).toBe(1);
        expect(report.sawFinalBubble).toBe(true);
        expect(report.lefts).toHaveLength(1);
        expect(report.widths).toHaveLength(1);
        expect(report.bgs).toHaveLength(1);
        if (length === "short") {
          expect(report.prevBottomDelta).toBeLessThanOrEqual(1);
        }
      } finally {
        await page.close();
        await hub.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("all engines, groups, forwards, and card actions emit no dashed box on normal online send", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "no-flash-engines-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const engines = [
    { id: "bot_claude", name: "Claude Bot", engine: "claude" },
    { id: "bot_codex", name: "Codex Bot", engine: "codex" },
    { id: "bot_kimi", name: "Kimi Bot", engine: "kimi" },
    { id: "bot_agy", name: "Antigravity Bot", engine: "antigravity" },
    { id: "bot_deepseek", name: "DeepSeek Bot", engine: "deepseek" },
    { id: "bot_pi", name: "Pi Bot", engine: "pi" },
  ];
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    let kimiConvId = "";
    for (const bot of engines) {
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES(?,?,?,'fixture',1)", [bot.id, bot.name, bot.engine]);
      const conv = await hub.store.createConversation("owner", [bot.id], bot.name, `conv_${bot.id}`);
      if (bot.engine === "kimi") kimiConvId = conv.id;
      await hub.store.publishBotMessage(bot.id, {
        conversationId: conv.id,
        blocks: [
          { type: "text", text: `Ready ${bot.engine}` },
          ...(bot.engine === "kimi"
            ? [{ type: "card" as const, title: "Quick Action", elements: [{ type: "button" as const, text: "Confirm Kimi", actionId: "confirm_kimi", value: {} }] }]
            : []),
        ],
      });
    }
    const group = await hub.store.createConversation("owner", ["bot_kimi", "bot_deepseek"], "Engine Group", "conv_group", { type: "group" });
    await hub.store.publishBotMessage("bot_kimi", { conversationId: group.id, blocks: [{ type: "text", text: "Group Ready" }] });

    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await showDisconnectedBots(page);

    for (const bot of engines) {
      await selectConversation(page, bot.name);
      const text = `Normal send ${bot.engine}`;
      const input = page.getByRole("textbox", { name: "消息", exact: true });
      await input.fill(text);
      await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
      await installSendFrameSampler(page, text);
      await input.press("Enter");
      await expect(page.locator(".message.user").filter({ hasText: text })).toBeVisible();
      await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: text })).toHaveCount(0);
      const report = await stopSendFrameSampler(page);
      expect(report.queuedCountMax, `${bot.engine} flashed .queued-message`).toBe(0);
      expect(report.maxBubbleCopies).toBe(1);
    }

    // Card action (online) must not flash .queued-message either.
    await selectConversation(page, "Kimi Bot");
    await installSendFrameSampler(page, "卡片操作");
    await page.getByRole("button", { name: "Confirm Kimi", exact: true }).click();
    await expect.poll(async () => (await hub.store.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM action_deliveries WHERE conversation_id=?",
      [kimiConvId],
    ))?.count ?? 0).toBe(1);
    const cacheName = await singleHostCacheName(page);
    await expect.poll(() => page.evaluate(async (dbName) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const req = db.transaction("outbox").objectStore("outbox").count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    }, cacheName)).toBe(0);
    const cardReport = await stopSendFrameSampler(page);
    expect(cardReport.queuedCountMax).toBe(0);

    // Group send (ordinary mentions) must not flash .queued-message.
    await selectConversation(page, "Engine Group");
    const groupText = "Group online send";
    const groupInput = page.getByRole("textbox", { name: "消息", exact: true });
    await groupInput.fill(groupText);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await installSendFrameSampler(page, groupText);
    await groupInput.press("Enter");
    await expect(page.locator(".message.user").filter({ hasText: groupText })).toBeVisible();
    await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: groupText })).toHaveCount(0);
    const groupReport = await stopSendFrameSampler(page);
    expect(groupReport.queuedCountMax).toBe(0);
    expect(groupReport.maxBubbleCopies).toBe(1);

    // Forwarded message must not flash .queued-message.
    await selectConversation(page, "DeepSeek Bot");
    await installSendFrameSampler(page, "Ready deepseek");
    await messageAction(page, page.locator(".message.bot").filter({ hasText: "Ready deepseek" }), "转发消息");
    const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
    await dialog.getByRole("button", { name: "Engine Group", exact: true }).click();
    await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    await expect(page.locator(".message.user").filter({ hasText: "Ready deepseek" })).toBeVisible();
    await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: "Ready deepseek" })).toHaveCount(0);
    const forwardReport = await stopSendFrameSampler(page);
    expect(forwardReport.queuedCountMax).toBe(0);
    expect(forwardReport.maxBubbleCopies).toBe(1);
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("open media viewer and keyboard focus on an off-screen pending row survive canonical settlement", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "no-flash-overlay-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let holdSend = false;
  const heldFrames: Array<() => void> = [];
  const releaseHeld = () => { while (heldFrames.length) heldFrames.shift()!(); };
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_codex','Codex Bot','codex','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["bot_codex"], "Overlay Continuity", "chat_overlay");
    for (let i = 0; i < 40; i++) {
      await hub.store.publishBotMessage("bot_codex", {
        conversationId: chat.id,
        blocks: [{ type: "text", text: `Seed ${i} ` + "长历史消息内容用于撑开虚拟滚动高度。".repeat(12) }],
      });
    }
    await page.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", (socket) => {
      const remote = socket.connectToServer();
      socket.onMessage((data) => {
        const frame = JSON.parse(data.toString());
        if (holdSend && frame.type === "message.send") {
          heldFrames.push(() => remote.send(data));
          return;
        }
        remote.send(data);
      });
    });

    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await selectConversation(page, "Overlay Continuity");
    await expect(page.locator(".message-blocks").filter({ hasText: "Seed 39" })).toBeInViewport();

    // Part 1: Open image lightbox on a pending row, scroll it outside the virtual window, then settle.
    holdSend = true;
    await page.locator('input[type="file"]').setInputFiles({ name: "pending-shot.png", mimeType: "image/png", buffer: SAMPLE_PNG });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const pendingImgRow = page.locator(".message.user.is-pending-outbox").last();
    await expect(pendingImgRow).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => heldFrames.length).toBe(1);
    const imgRowKey = await pendingImgRow.getAttribute("data-row-key");
    expect(imgRowKey).toMatch(/^user:owner:/);
    await pendingImgRow.evaluate((node) => { (node as any).__persistedArticle = "image"; });

    const thumb = pendingImgRow.getByRole("button", { name: "pending-shot.png", exact: true });
    await expect(thumb).toBeEnabled();
    await thumb.click();
    const viewer = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(viewer).toBeVisible();

    // Scroll far above the pending row so virtualization would drop it if retention broke.
    const scroller = page.locator(".message-scroll");
    await scroller.evaluate((node) => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -2000, bubbles: true }));
      node.scrollTop = 0;
    });
    await expect(page.locator(`article[data-row-key="${imgRowKey}"]`)).toBeAttached();

    // Release canonical message; lightbox and row instance must survive intact.
    holdSend = false;
    releaseHeld();
    const settledImgRow = page.locator(`article[data-row-key="${imgRowKey}"]`);
    await expect(settledImgRow).not.toHaveClass(/is-pending-outbox/);
    await expect(settledImgRow).toHaveAttribute("data-message-id", /^msg_/);
    await expect(viewer).toBeVisible();
    expect(await settledImgRow.evaluate((node) => (node as any).__persistedArticle)).toBe("image");

    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // Part 2: Keyboard focus on an off-screen pending row survives canonical settlement.
    const latestBtn = page.getByRole("button", { name: "回到最新消息", exact: true });
    if (await latestBtn.isVisible()) await latestBtn.click();
    await expect(settledImgRow).toBeInViewport();

    holdSend = true;
    const focusText = "Focus must survive canonical settlement";
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    await input.fill(focusText);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
    await input.press("Enter");
    const pendingFocusRow = page.locator(".message.user.is-pending-outbox").filter({ hasText: focusText });
    await expect(pendingFocusRow).toBeVisible();
    await expect.poll(() => heldFrames.length).toBe(1);
    const focusRowKey = await pendingFocusRow.getAttribute("data-row-key");
    expect(focusRowKey).toMatch(/^user:owner:/);
    await pendingFocusRow.focus();
    await pendingFocusRow.evaluate((node) => { (node as any).__persistedArticle = "focus"; });

    await scroller.evaluate((node) => {
      node.dispatchEvent(new WheelEvent("wheel", { deltaY: -2000, bubbles: true }));
      node.scrollTop = 0;
    });
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row-key"))).toBe(focusRowKey);

    holdSend = false;
    releaseHeld();
    const settledFocusRow = page.locator(`article[data-row-key="${focusRowKey}"]`);
    await expect(settledFocusRow).not.toHaveClass(/is-pending-outbox/);
    await expect(settledFocusRow).toHaveAttribute("data-message-id", /^msg_/);
    expect(await page.evaluate(() => ({
      activeRowKey: document.activeElement?.getAttribute("data-row-key"),
      persisted: (document.activeElement as any)?.__persistedArticle,
    }))).toEqual({ activeRowKey: focusRowKey, persisted: "focus" });
  } finally {
    releaseHeld();
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("resending attachments after reload and forwarding a user message match canonical media and author while pending", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "no-flash-retry-forward-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  let holdType: "message.send" | "message.forward" | undefined;
  const heldFrames: Array<() => void> = [];
  const releaseHeld = () => { while (heldFrames.length) heldFrames.shift()!(); };
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_codex','Codex Bot','codex','fixture',1)");
    const sourceChat = await hub.store.createConversation("owner", ["bot_codex"], "Source Chat", "chat_source");
    const targetChat = await hub.store.createConversation("owner", ["bot_codex"], "Forward Target", "chat_target");
    await hub.store.publishBotMessage("bot_codex", { conversationId: sourceChat.id, blocks: [{ type: "text", text: "Source Ready" }] });
    await hub.store.publishBotMessage("bot_codex", { conversationId: targetChat.id, blocks: [{ type: "text", text: "Target Ready" }] });

    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await selectConversation(page, "Source Chat");

    // Upload image + named PDF and let it settle cleanly.
    await page.locator('input[type="file"]').setInputFiles([
      { name: "diagram.png", mimeType: "image/png", buffer: SAMPLE_PNG },
      { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(1024, 65) },
    ]);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("Attachments to retry");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const originalUserRow = page.locator(".message.user").filter({ hasText: "Attachments to retry" });
    await expect(originalUserRow).toBeVisible({ timeout: 15_000 });
    await expect(originalUserRow).not.toHaveClass(/is-pending-outbox/);

    // Install WS hold before reload so initial pairing/upload is unintercepted
    // and the reloaded page has a completely cold upload-metadata cache.
    await page.routeWebSocket(hub.url.replace(/^http/, "ws") + "/ws", (socket) => {
      const remote = socket.connectToServer();
      socket.onMessage((data) => {
        const frame = JSON.parse(data.toString());
        if (holdType && frame.type === holdType) {
          heldFrames.push(() => remote.send(data));
          return;
        }
        remote.send(data);
      });
    });

    // Reload to guarantee the in-memory upload metadata cache is completely cold.
    await page.reload();
    await waitForClientOnline(page);
    await selectConversation(page, "Source Chat");
    const reloadedUserRow = page.locator(".message.user").filter({ hasText: "Attachments to retry" });
    await expect(reloadedUserRow).toBeVisible();

    // Hold message.send and click retry: pending bubble must render real image + report.pdf (not generic "附件 / 0 B").
    holdType = "message.send";
    await messageAction(page, reloadedUserRow, "重新发送消息");
    const pendingRetry = page.locator(".message.user.is-pending-outbox").filter({ hasText: "Attachments to retry" });
    await expect(pendingRetry).toBeVisible();
    await expect.poll(() => heldFrames.length).toBe(1);
    await expect(pendingRetry.locator("figure.attachment-image")).toHaveCount(1);
    await expect(pendingRetry.locator(".file-card")).toContainText("report.pdf");
    await expect(pendingRetry.locator(".file-card")).toContainText("1 KiB");
    await expect(pendingRetry.locator(".file-card")).not.toContainText("0 B");
    await expect(page.locator(".queued-message")).toHaveCount(0);

    holdType = undefined;
    releaseHeld();
    await expect(page.locator(".message.user.is-pending-outbox")).toHaveCount(0);
    await expect(page.locator(".message.user").filter({ hasText: "Attachments to retry" })).toHaveCount(2);

    // Forward the user-authored message while holding message.forward: pending authorName must match Hub's "Owner".
    holdType = "message.forward";
    await messageAction(page, page.locator(".message.user").filter({ hasText: "Attachments to retry" }).first(), "转发消息");
    const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
    await dialog.getByRole("button", { name: "Forward Target", exact: true }).click();
    await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    const pendingForward = page.locator(".message.user.is-pending-outbox").filter({ hasText: "Attachments to retry" });
    await expect(pendingForward).toBeVisible();
    await expect.poll(() => heldFrames.length).toBe(1);
    await expect(pendingForward.locator(".forwarded-message")).toContainText("转发自 Owner");
    await expect(pendingForward.locator(".forwarded-message")).not.toContainText("转发自 我");

    holdType = undefined;
    releaseHeld();
    await expect(page.locator(".message.user.is-pending-outbox")).toHaveCount(0);
    await expect(page.locator(".message.user").filter({ hasText: "Attachments to retry" }).locator(".forwarded-message")).toContainText("转发自 Owner");
  } finally {
    releaseHeld();
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

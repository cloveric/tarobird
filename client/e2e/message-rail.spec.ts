import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";

test.use({ serviceWorkers: "block" });

async function pairClient(page: import("@playwright/test").Page, hub: HubServer) {
  await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill("macmini");
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await page.locator(".host-workspace:not([hidden])").waitFor({ state: "visible" });
}

test("desktop message rail jumps to unrendered earlier messages in a long conversation, shows hover preview, and tracks scrolling", async ({ page }) => {
  test.setTimeout(90_000);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "message-rail-long-"));
  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot_codex','Codex','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["bot_codex"], "Long History Check", "chat_long");

    const turnCount = 55;
    const userMessageIds: string[] = [];
    for (let i = 1; i <= turnCount; i++) {
      const sent = await hub.store.sendMessage("owner", {
        conversationId: chat.id,
        clientMsgId: `c_u_${i}`,
        text: `Turn ${i}: Check milestone ${i} architecture and rollout checklist.`,
        attachments: [],
      });
      userMessageIds.push(sent.message.id);
      await hub.store.publishBotMessage("bot_codex", {
        conversationId: chat.id,
        replyTo: sent.message.id,
        status: "complete",
        blocks: [{
          type: "text",
          text: `Reply ${i}: Verified step ${i}.\n\n` + Array.from({ length: 6 }, (_, j) => `- Detail line ${j + 1} for turn ${i} covering implementation and verification.`).join("\n"),
        }],
      });
    }

    await pairClient(page, hub);
    await page.locator(".sidebar").getByRole("button", { name: "按对话", exact: true }).click();
    await page.locator(`[data-conversation-id="${chat.id}"]`).click();

    const rail = page.getByRole("navigation", { name: "消息刻度条", exact: true });
    await expect(rail).toBeVisible();

    // Long conversation samples ticks cleanly (<= 44) while keeping first and last turns,
    // and exposes each tick with both listitem and native button ARIA roles.
    const ticks = rail.locator(".message-rail-tick");
    const count = await ticks.count();
    expect(count).toBeGreaterThanOrEqual(20);
    expect(count).toBeLessThanOrEqual(44);
    await expect(rail.getByRole("button")).toHaveCount(count);
    await expect(rail.getByRole("listitem")).toHaveCount(count);
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[0]}"]`)).toBeVisible();
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[turnCount - 1]}"]`)).toBeVisible();

    // Line-mode wheel events over the rail normalize deltaMode instead of moving 3 CSS pixels.
    const wheelDelta = await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>(".message-scroll");
      const nav = document.querySelector<HTMLElement>(".message-rail");
      if (!vp || !nav) return 0;
      const before = vp.scrollTop;
      nav.dispatchEvent(new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, bubbles: true }));
      return before - vp.scrollTop;
    });
    expect(wheelDelta).toBeGreaterThanOrEqual(30);
    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>(".message-scroll");
      if (vp) vp.scrollTop = vp.scrollHeight;
    });

    // Initially at bottom -> last turn tick is active, and Turn 1 is NOT mounted in the DOM yet (virtualized).
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[turnCount - 1]}"]`)).toHaveClass(/is-active/);
    await expect(page.locator(`[data-message-id="${userMessageIds[0]}"]`)).toHaveCount(0);

    // Hovering first tick displays the preview card with both prompt and reply preview.
    const firstTick = rail.locator(`[data-rail-message-id="${userMessageIds[0]}"]`);
    await firstTick.hover();
    const preview = rail.locator(".message-rail-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Turn 1: Check milestone 1");
    await expect(preview).toContainText("Reply 1: Verified step 1.");

    // Clicking the first tick jumps straight to the previously unrendered message and lands it in the viewport.
    await firstTick.click();
    const firstMessage = page.locator(`[data-message-id="${userMessageIds[0]}"]`);
    await expect(firstMessage).toBeVisible();
    await expect(firstMessage).toHaveClass(/focused-message/);
    await expect(firstTick).toHaveClass(/is-active/);
    const inViewport = await page.evaluate((id) => {
      const vp = document.querySelector(".message-scroll")?.getBoundingClientRect();
      const row = document.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect();
      return !!vp && !!row && row.bottom > vp.top && row.top < vp.bottom;
    }, userMessageIds[0]!);
    expect(inViewport).toBe(true);

    // Scrolling back down updates the active tick to follow the scroll position.
    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>(".message-scroll");
      if (vp) vp.scrollTop = vp.scrollHeight;
    });
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[turnCount - 1]}"]`)).toHaveClass(/is-active/);

    // On a shorter viewport with a multi-line draft, ticks stay inside the rail and
    // hover previews for first and last ticks never bleed into header or composer.
    await page.setViewportSize({ width: 1280, height: 520 });
    await page.getByLabel("消息", { exact: true }).fill("line 1\nline 2\nline 3\nline 4\nline 5\nline 6");
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const nav = document.querySelector(".message-rail")?.getBoundingClientRect();
        const header = document.querySelector(".conversation-header")?.getBoundingClientRect();
        const composer = document.querySelector(".composer-wrap")?.getBoundingClientRect();
        const tickEls = [...document.querySelectorAll(".message-rail-tick")];
        if (!nav || !header || !composer || !tickEls.length) return false;
        const first = tickEls[0]!.getBoundingClientRect();
        const last = tickEls[tickEls.length - 1]!.getBoundingClientRect();
        return first.top >= header.bottom - 1 && last.bottom <= composer.top + 1 && first.top >= nav.top - 1 && last.bottom <= nav.bottom + 1;
      });
    }).toBe(true);

    for (const targetId of [userMessageIds[0]!, userMessageIds[turnCount - 1]!]) {
      await rail.locator(`[data-rail-message-id="${targetId}"]`).hover();
      await expect(preview).toBeVisible();
      await expect.poll(async () => {
        return await page.evaluate(() => {
          const nav = document.querySelector(".message-rail")?.getBoundingClientRect();
          const tip = document.querySelector(".message-rail-preview")?.getBoundingClientRect();
          if (!nav || !tip) return false;
          return tip.top >= nav.top - 1 && tip.bottom <= nav.bottom + 1;
        });
      }).toBe(true);
    }
  } finally {
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("desktop message rail works in group conversations and stays hidden on phone viewports", async ({ page }) => {
  test.setTimeout(90_000);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "message-rail-group-"));
  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot_a','Architect','fixture',1),('bot_b','Reviewer','fixture',1)");
    const group = await hub.store.createConversation("owner", ["bot_a", "bot_b"], "Design Sync", "group_sync", "group");
    const u1 = await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "g_u1", text: "Kickoff: compare storage options", attachments: [] });
    await hub.store.publishBotMessage("bot_a", { conversationId: group.id, replyTo: u1.message.id, status: "complete", blocks: [{ type: "text", text: "Option A uses local cache plus sync." }] });
    const u2 = await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "g_u2", text: "Follow-up: check latency budget", attachments: [] });
    await hub.store.publishBotMessage("bot_b", { conversationId: group.id, replyTo: u2.message.id, status: "complete", blocks: [{ type: "text", text: "P95 stays under 20 ms." }] });

    await pairClient(page, hub);
    await page.locator(".sidebar").getByRole("button", { name: "按对话", exact: true }).click();
    await page.locator(`[data-conversation-id="${group.id}"]`).click();

    const rail = page.getByRole("navigation", { name: "消息刻度条", exact: true });
    await expect(rail).toBeVisible();
    await expect(rail.locator(".message-rail-tick")).toHaveCount(2);

    await rail.locator(`[data-rail-message-id="${u1.message.id}"]`).hover();
    await expect(rail.locator(".message-rail-preview")).toContainText("Architect:");
    await expect(rail.locator(".message-rail-preview")).toContainText("Option A uses local cache");

    // Phone viewport hides the rail cleanly.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rail).toHaveCount(0);
  } finally {
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("message rail handles short early turns, non-scrolling chats, unanswered tail turns, and landscape touch viewports", async ({ browser }) => {
  test.setTimeout(90_000);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "message-rail-edge-"));
  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const touchContext = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot_codex','Codex','fixture',1)");
    const shortEarlyChat = await hub.store.createConversation("owner", ["bot_codex"], "Short Early Turns", "chat_short_early");
    const shortEarlyIds: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const sent = await hub.store.sendMessage("owner", {
        conversationId: shortEarlyChat.id,
        clientMsgId: `se_u_${i}`,
        text: `Short prompt ${i}`,
        attachments: [],
      });
      shortEarlyIds.push(sent.message.id);
      if (i === 1) await new Promise((resolve) => setTimeout(resolve, 2));
      await hub.store.publishBotMessage("bot_codex", {
        conversationId: shortEarlyChat.id,
        replyTo: sent.message.id,
        status: "complete",
        blocks: [{ type: "text", text: `Brief reply ${i}.` }],
      });
      if (i === 1 || i === 30) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // Add an unanswered user turn at the tail to verify last-tick followLatest recovery.
    const tailTurn = await hub.store.sendMessage("owner", {
      conversationId: shortEarlyChat.id,
      clientMsgId: "se_u_31",
      text: "Final unanswered prompt",
      attachments: [],
    });
    shortEarlyIds.push(tailTurn.message.id);

    const fittingChat = await hub.store.createConversation("owner", ["bot_codex"], "Short Fitting Chat", "chat_fitting");
    const fittingIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const sent = await hub.store.sendMessage("owner", {
        conversationId: fittingChat.id,
        clientMsgId: `fit_u_${i}`,
        text: `Mini prompt ${i}`,
        attachments: [],
      });
      fittingIds.push(sent.message.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      await hub.store.publishBotMessage("bot_codex", {
        conversationId: fittingChat.id,
        replyTo: sent.message.id,
        status: "complete",
        blocks: [{ type: "text", text: `Ok ${i}.` }],
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const page = await desktopContext.newPage();
    await pairClient(page, hub);
    await page.locator(".sidebar").getByRole("button", { name: "按对话", exact: true }).click();

    // 1. Short early turns on 1280x900: clicking Tick #1 keeps Turn 1 active even while streaming updates arrive.
    await page.locator(`[data-conversation-id="${shortEarlyChat.id}"]`).click();
    const rail = page.getByRole("navigation", { name: "消息刻度条", exact: true });
    await expect(rail).toBeVisible();
    const firstTick = rail.locator(`[data-rail-message-id="${shortEarlyIds[0]}"]`);
    await firstTick.click();
    await expect(page.locator(`[data-message-id="${shortEarlyIds[0]}"]`)).toBeVisible();
    await expect(firstTick).toHaveClass(/is-active/);
    // Confirm active state does not flip to Turn 2 after rAF sync.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(firstTick).toHaveClass(/is-active/);

    // 2. Clicking the last tick (unanswered tail turn) returns to tail following so a long new reply stays in view.
    const lastTick = rail.locator(`[data-rail-message-id="${tailTurn.message.id}"]`);
    await lastTick.click();
    await expect(page.locator(".jump-latest")).toHaveCount(0);
    await hub.store.publishBotMessage("bot_codex", {
      conversationId: shortEarlyChat.id,
      replyTo: tailTurn.message.id,
      status: "complete",
      blocks: [{
        type: "text",
        text: Array.from({ length: 18 }, (_, i) => `Long tail reply paragraph ${i + 1}: verifying automatic follow after clicking the final unanswered tick.`).join("\n\n"),
      }],
    });
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const vp = document.querySelector<HTMLElement>(".message-scroll");
        return vp ? vp.scrollHeight - vp.scrollTop - vp.clientHeight : 999;
      });
    }).toBeLessThanOrEqual(8);

    // 2b. Jumping back to an unrendered earlier turn while a streaming reply updates the tail still settles in view.
    const streamMsg = await hub.store.publishBotMessage("bot_codex", {
      conversationId: shortEarlyChat.id,
      replyTo: tailTurn.message.id,
      status: "streaming",
      blocks: [{ type: "text", text: "Streaming chunk 0" }],
    });
    let streamingActive = true;
    const streamTask = (async () => {
      for (let chunk = 1; chunk <= 12 && streamingActive; chunk++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await hub.store.publishBotMessage("bot_codex", {
          id: streamMsg.id,
          conversationId: shortEarlyChat.id,
          replyTo: tailTurn.message.id,
          status: chunk === 12 ? "complete" : "streaming",
          blocks: [{ type: "text", text: `Streaming chunk ${chunk}\n\n` + "Extra streaming lines. ".repeat(chunk) }],
        });
      }
    })();
    try {
      await firstTick.click();
      await expect(page.locator(`[data-message-id="${shortEarlyIds[0]}"]`)).toBeVisible();
      await expect(firstTick).toHaveClass(/is-active/);
      const firstVisible = await page.evaluate((id) => {
        const vp = document.querySelector(".message-scroll")?.getBoundingClientRect();
        const row = document.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect();
        return !!vp && !!row && row.bottom > vp.top + 8 && row.top < vp.bottom - 8;
      }, shortEarlyIds[0]!);
      expect(firstVisible).toBe(true);
    } finally {
      streamingActive = false;
      await streamTask;
    }

    // 3. Short chat fitting in viewport: clicking Tick #1 does NOT show .jump-latest and keeps auto-follow working.
    await page.locator(`[data-conversation-id="${fittingChat.id}"]`).click();
    await expect(rail).toBeVisible();
    const fitFirstTick = rail.locator(`[data-rail-message-id="${fittingIds[0]}"]`);
    await fitFirstTick.click();
    await expect(page.locator(".jump-latest")).toHaveCount(0);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(fitFirstTick).toHaveClass(/is-active/);
    for (let i = 1; i <= 8; i++) {
      await hub.store.publishBotMessage("bot_codex", {
        conversationId: fittingChat.id,
        status: "complete",
        blocks: [{ type: "text", text: `Follow-up burst message ${i}\n\n` + "Extra lines to force vertical overflow beyond the viewport. ".repeat(4) }],
      });
    }
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const vp = document.querySelector<HTMLElement>(".message-scroll");
        return vp ? vp.scrollHeight - vp.scrollTop - vp.clientHeight : 999;
      });
    }).toBeLessThanOrEqual(8);

    // 4. Landscape touch phone (>760px wide, coarse pointer): rail must not mount.
    const touchPage = await touchContext.newPage();
    await pairClient(touchPage, hub);
    await touchPage.locator(".sidebar").getByRole("button", { name: "按对话", exact: true }).click();
    await touchPage.locator(`[data-conversation-id="${shortEarlyChat.id}"]`).click();
    await expect(touchPage.locator(".message-scroll")).toBeVisible();
    await expect(touchPage.getByRole("navigation", { name: "消息刻度条", exact: true })).toHaveCount(0);
  } finally {
    await desktopContext.close();
    await touchContext.close();
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

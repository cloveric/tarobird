import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

for (const width of [390, 1360]) test(`late replies identify their original prompt while newer prompts stay queued (${width})`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const root = await mkdtemp(path.join(os.tmpdir(), "queued-reply-source-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','助手','fixture','codex')");
    const queue = new HubPromptQueue(hub.store);
    await queue.registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "排队消息归属", "chat");
    const prompts = [];
    for (const [index, text] of ["把安卓通知功能补齐", "这个管理分组多余了", "没有看到问题问我，是 bug？"].entries()) {
      prompts.push((await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `prompt-${index}`, text, attachments: [] })).message);
    }
    expect((await queue.claim("alpha", true, false)).map(message => message.id)).toEqual([prompts[0].id]);
    const response = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: prompts[0].id,
      blocks: [{ type: "text", text: "我先检查通知链路，再补齐权限申请和任务完成提醒。" }] });
    const expired = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: prompts[0].id,
      blocks: [{ type: "text", text: "问题已过期，没有代你选择答案。" }] });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
    const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
    for (const message of [response, expired]) {
      const source = row(message.id).getByRole("button", { name: "查看回复对应的消息", exact: true });
      await expect(source).toHaveText("回复：把安卓通知功能补齐");
      await expect(source).toHaveAttribute("data-reply-to", prompts[0].id);
    }
    await page.getByRole("button", { name: "管理待执行消息，共 2 条", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "待执行消息", exact: true });
    // Only still-queued prompts are listed; the claimed one is already executing.
    await expect(panel.locator(".prompt-queue-item")).toHaveCount(2);
    await expect(panel.locator(".prompt-queue-item").nth(0)).toContainText("这个管理分组多余了");
    await expect(panel.locator(".prompt-queue-item").nth(1)).toContainText("没有看到问题问我");
    await panel.getByRole("button", { name: "关闭待执行消息", exact: true }).click();
    await row(response.id).getByRole("button", { name: "查看回复对应的消息", exact: true }).click();
    await expect(row(prompts[0].id)).toHaveClass(/focused-message/);
    await expect(row(prompts[2].id)).not.toHaveClass(/focused-message/);
    // Reload/cache replay must retain the exact source, not the closest prompt.
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
    await expect(row(response.id).locator(".bot-reply-source")).toHaveText("回复：把安卓通知功能补齐");
    for (const palette of ["white-violet", "cli"]) for (const theme of ["light", "dark"]) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, { palette, theme });
      expect(await row(response.id).locator(".bot-reply-source").evaluate(node => node.getBoundingClientRect().right <= innerWidth && node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${width}-${palette}-${theme}.png`) });
    }
    // A removed source is unavailable, never rebound to another queued prompt.
    await hub.store.deleteMessages("owner", chat.id, { messageIds: [prompts[0].id] });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
    const unavailable = row(response.id).getByRole("button", { name: "查看回复对应的消息", exact: true });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toContainText("原消息已删除或当前不可访问");
    expect((await queue.read("owner", "alpha", chat.id)).items.filter(item => item.state === "queued").map(item => item.message.id)).toEqual([prompts[1].id, prompts[2].id]);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("reply sources stay left aligned, bound click targets and ellipsize in ordinary chat, ADHD and phone", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reply-source-width-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','助手','fixture','codex')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "引用阅读", "source");
    const others = await Promise.all(["检查一", "检查二"].map((title, index) => hub.store.createConversation("owner", ["alpha"], title, `other-${index}`)));
    const text = "我发现我们现在出字的速度，是不是效率问题，这么多轮更新后，有没有卡顿什么的现象，请检查不同引擎的表现。".repeat(4);
    const cases = [];
    for (const [index, value] of [text, "longUnbrokenReference".repeat(20), "好的"].entries()) {
      const { message: original } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `long-source-${index}`, text: value, attachments: [] });
      const receipt = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: original.id, blocks: value === "好的" ? [{ type: "text", text: "我会核对这个问题，检查完整链路并说明验证结果。".repeat(8) }] : [{ type: "card", title: "✅ 已提交", summary: "已提交", elements: [{ type: "markdown", text: "问题 1：主要是思考内容显示得有点顿。\n\n答案已送达当前任务，后续进展会显示在对话中。" }] }] });
      cases.push({ original, receipt, value });
    }
    const row = (id: string) => page.locator(`.message[data-message-id="${id}"]`);
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
    for (const mode of ["ordinary", "adhd", "phone"] as const) {
      if (mode === "adhd") {
        await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
        for (const item of [chat, ...others]) await page.getByRole("checkbox", { name: new RegExp(`加入面板：.* · ${item.title}$`) }).check();
        await page.getByLabel("ADHD 每行窗口数", { exact: true }).selectOption("3");
      } else if (mode === "phone") {
        await row(cases[0]!.receipt.id).locator(".bot-reply-source").click();
        await page.getByRole("button", { name: "返回聊天", exact: true }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await selectConversation(page, chat.title);
      }
      for (const { original, receipt, value } of cases) {
        const source = row(receipt.id).locator(".bot-reply-source");
        await expect(source).toHaveAttribute("title", value.slice(0, 180));
        await source.scrollIntoViewIfNeeded();
        for (const theme of ["light", "dark"]) {
          await page.evaluate(theme => { document.documentElement.dataset.palette = "mono"; document.documentElement.dataset.theme = theme; }, theme);
          const metrics = await source.evaluate(node => {
            const scroll = node.closest(".message-scroll")!, body = node.closest(".message-body")!;
            const excerpt = node.querySelector(".bot-reply-source-excerpt")!, arrow = node.querySelector("svg:last-child")!;
            const rect = node.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
            return { scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, sourceWidth: rect.width, bodyWidth: body.getBoundingClientRect().width,
              left: rect.left, bodyLeft: body.getBoundingClientRect().left, firstChildLeft: node.firstElementChild!.getBoundingClientRect().left, right: rect.right, viewportRight: viewport.right, arrowRight: arrow.getBoundingClientRect().right,
              ellipsis: getComputedStyle(excerpt).textOverflow, truncated: excerpt.scrollWidth > excerpt.clientWidth + 1 };
          });
          expect(metrics.scrollWidth, JSON.stringify({ mode, metrics })).toBeLessThanOrEqual(metrics.clientWidth + 1);
          expect(metrics.sourceWidth).toBeLessThanOrEqual(metrics.bodyWidth + 1);
          expect(metrics.right).toBeLessThanOrEqual(metrics.viewportRight);
          expect(metrics.arrowRight).toBeLessThanOrEqual(metrics.right + 1);
          expect(metrics.ellipsis).toBe("ellipsis"); expect(metrics.truncated).toBe(value !== "好的");
          expect(Math.abs(metrics.firstChildLeft - metrics.bodyLeft)).toBeLessThanOrEqual(1);
          if (value === "好的") {
            expect(metrics.sourceWidth).toBeLessThan(metrics.bodyWidth - 40);
            const box = (await source.boundingBox())!;
            // Empty row space must not count as the source link's click target.
            const blank = { x: box.x + box.width + 30, y: box.y + box.height / 2 };
            expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.bot-reply-source'), blank)).toBe(false);
            const scrollBefore = await source.evaluate(node => node.closest('.message-scroll')!.scrollTop);
            await page.mouse.click(blank.x, blank.y);
            expect(await source.evaluate(node => node.closest('.message-scroll')!.scrollTop)).toBe(scrollBefore);
            if (mode === "phone") expect(box.height).toBeGreaterThanOrEqual(44);
            await page.screenshot({ path: info.outputPath(`source-short-${mode}-${theme}.png`) });
          }
          if (value === text) await page.screenshot({ path: info.outputPath(`source-${mode}-${theme}.png`) });
        }
        await source.click();
        await expect(page.locator(`.message[data-message-id="${original.id}"]`)).toHaveClass(/focused-message/);
        expect((await hub.store.messageForUser("owner", original.id)).blocks).toEqual([{ type: "text", text: value }]);
      }
    }
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

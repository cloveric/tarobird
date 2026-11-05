import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

for (const width of [320, 390, 1360]) test(`Bot activity preserves the input layout and draft (${width}px)`, async ({ browser }, info) => {
  const phone = width <= 760;
  const root = await mkdtemp(path.join(os.tmpdir(), "composer-busy-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: phone, hasTouch: phone, serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','布局助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "稳定输入框", "busy-layout");
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    const input = page.getByRole("textbox", { name: "消息", exact: true });
    const composer = page.locator(".composer");
    let runId: string | undefined;
    for (const draft of ["", "下一项", "第一行\n第二行"]) {
      await input.fill(draft);
      await page.waitForTimeout(150);
      const send = page.getByRole("button", { name: "发送消息", exact: true });
      const actionBefore = await send.boundingBox();
      await page.evaluate(() => {
        const frames: number[][] = []; let active = true;
        Object.assign(window, { busyFrames: frames, stopBusyFrames: () => { active = false; } });
        const sample = () => {
          const box = document.querySelector(".composer")!.getBoundingClientRect(), field = document.querySelector(".composer textarea")!.getBoundingClientRect();
          frames.push([box.top, box.height, field.width, field.height]);
          if (active) requestAnimationFrame(sample);
        };
        sample();
      });
      const run = await hub.store.publishBotMessage("alpha", { id: runId, conversationId: chat.id, blocks: [{ type: "text", text: "正在处理任务" }], status: "streaming" }); runId = run.id;
      await expect(composer).toHaveClass(/is-live/);
      await expect(input).toHaveValue(draft); await expect(input).toBeFocused();
      if (phone) {
        const action = page.getByRole("button", { name: draft ? "发送消息" : "停止当前轮次", exact: true });
        expect(await action.boundingBox()).toEqual(actionBefore);
        await expect(action).toBeInViewport();
        await expect(page.getByRole("button", { name: "录制语音", exact: true })).toBeInViewport();
        await expect(page.locator(".composer-steer")).toHaveCount(0);
        if (draft) await expect(send).toHaveAttribute("title", /排队/);
      }
      await page.screenshot({ path: info.outputPath(`busy-${draft ? draft.includes("\n") ? "multiline" : "draft" : "empty"}.png`) });
      await hub.store.publishBotMessage("alpha", { id: runId, conversationId: chat.id, blocks: [{ type: "text", text: "处理完成" }], status: "complete" });
      await expect(composer).not.toHaveClass(/is-live/);
      await page.waitForTimeout(150);
      const frames = await page.evaluate(() => { (window as any).stopBusyFrames(); return (window as any).busyFrames as number[][]; });
      await info.attach(`geometry-${draft || "empty"}`, { body: JSON.stringify(frames), contentType: "application/json" });
      for (const [index, name] of ["top", "height", "text width", "text height"].entries()) {
        const values = frames.map(frame => frame[index]!);
        expect(Math.max(...values) - Math.min(...values), `${draft || "empty"}: ${name}`).toBeLessThanOrEqual(1);
      }
      await expect(input).toHaveValue(draft); await expect(input).toBeFocused();
    }
    if (phone) {
      // With a file-only draft, Send remains available and Stop moves to More.
      await input.fill("");
      await page.locator('input.attachment-picker-input').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("keep this attachment") });
      await expect(page.locator(".attachment-draft-file")).toHaveCount(1);
      const before = await composer.boundingBox();
      await hub.store.publishBotMessage("alpha", { id: runId, conversationId: chat.id, blocks: [{ type: "text", text: "继续处理任务" }], status: "streaming" });
      await expect(composer).toHaveClass(/is-live/);
      await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
      expect(await composer.boundingBox()).toEqual(before);
      await page.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      // A streaming message alone is not proof of native steering support.
      // This layout fixture has no connected, capable worker.
      await expect(page.getByRole("button", { name: "引导当前任务", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "停止当前轮次", exact: true })).toBeVisible();
      await expect(page.getByText("未检测到进行中的回复。仍会向 Bot 发送停止请求，结果显示在对话中。", { exact: true })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

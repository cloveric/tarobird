import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

// Explicit real-model gate: two disposable Bots, actual queues/workers and App UI.
// Uses an existing allowlisted acceptance-root prefix for scoped session teardown.
test("real Codex and Claude complete sequential and independent group discussions", async ({ page }, info) => {
  test.skip(process.env.TAROBOT_LIVE_GROUP_DISCUSSION !== "1", "requires authenticated native Codex and Claude CLIs");
  test.setTimeout(480_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-client-bus-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js") } });
  const evidence: unknown[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const bots = [];
    for (const [index, definition] of [
      { name: "Codex 验收", engine: "codex", model: "gpt-6.1-sol" },
      { name: "Claude 验收", engine: "claude", model: "sonnet" },
    ].entries()) bots.push(await hub.botManager!.create("owner", { requestId: `live_group_${index}`, ...definition, effort: "low", workspace: "" }));
    await expect.poll(async () => (await hub.store.bots("owner")).filter(bot => bot.online).length, { timeout: 30_000 }).toBe(2);
    const group = await hub.store.createConversation("owner", bots.map(bot => bot.id), "真实引擎群讨论验收", "live-group", { type: "group" });
    await page.goto(hub.url);
    await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, group.title);
    for (const [mode, label] of [["sequential", "轮流讨论"], ["independent", "独立评议"]] as const) {
      await page.getByRole("button", { name: "设置群聊方式", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "群组设置", exact: true });
      await settings.getByRole("radio", { name: new RegExp(`^${label}`) }).check();
      await settings.getByLabel("最多讨论轮数", { exact: true }).selectOption("1");
      await settings.getByRole("button", { name: "保存", exact: true }).click();
      await expect(settings).toHaveCount(0);
      await page.getByRole("button", { name: "发起讨论", exact: true }).click();
      await page.getByLabel("讨论课题", { exact: true }).fill(`这是隔离验收，只讨论本条合成资料，不调用任何工具、不读文件、不发外部消息。资料：A有3个苹果，B有2个。每位成员只用一句话说明合计数量，保留标记 GROUP_${mode.toUpperCase()}_OK，并遵循本轮的 group_stance 规则。`);
      await page.getByRole("button", { name: "开始讨论", exact: true }).click();
      await expect.poll(async () => (await hub.groupDiscussions.view("owner", group.id)).run?.status, { timeout: 180_000 }).toBe("completed");
      const run = (await hub.groupDiscussions.view("owner", group.id)).run!;
      expect(run.mode).toBe(mode);
      expect(run.steps).toHaveLength(2);
      expect(run.steps.map(step => step.botId).sort()).toEqual(bots.map(bot => bot.id).sort());
      for (const step of run.steps) {
        expect(step).toMatchObject({ status: "completed", result: "answered" });
        expect(step.text).toContain(`GROUP_${mode.toUpperCase()}_OK`);
      }
      if (mode === "sequential") {
        expect(run.steps.map(step => step.botId)).toEqual(bots.map(bot => bot.id));
        expect(run.steps[1]!.startedAt!).toBeGreaterThanOrEqual(run.steps[0]!.finishedAt!);
      } else expect(run.steps.every(step => step.blind)).toBe(true);
      const dialog = page.getByRole("dialog", { name: "讨论进展", exact: true });
      await expect(dialog.locator(".discussion-turn")).toHaveCount(2);
      await dialog.locator(".discussion-turn summary").first().click();
      await expect(dialog.locator(".discussion-turn-text")).toContainText(`GROUP_${mode.toUpperCase()}_OK`);
      await page.screenshot({ path: info.outputPath(`real-group-${mode}.png`) });
      evidence.push({ mode, engines: ["codex", "claude"], run });
      await page.getByRole("button", { name: "关闭讨论进展", exact: true }).click();
      await page.reload(); await waitForClientOnline(page); await selectConversation(page, group.title);
      expect((await hub.groupDiscussions.view("owner", group.id)).run?.id).toBe(run.id);
    }
    expect(errors).toEqual([]);
  } finally {
    await writeFile(info.outputPath("real-group-report.json"), JSON.stringify({ evidence, errors }, null, 2));
    await page.close(); await hub.close();
    await archiveAcceptanceThreads(root);
    await rm(root, { recursive: true, force: true });
  }
});

import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { backupHubState, restoreHubState } from "../../src/hub/state-backup.js";
import { blocksText } from "../../src/client-protocol/index.js";

test("a real Codex Bot keeps device trust and conversation memory after a full Hub restore", async ({ page }, info) => {
  test.skip(process.env.TAROCUB_LIVE_WORKER !== "1", "requires explicit real-engine acceptance");
  test.setTimeout(180_000);
  const parent = await mkdtemp(path.join(os.tmpdir(), "live-hub-backup-")), root = path.join(parent, "hub");
  const options = { stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js") } };
  let hub: HubServer | undefined = await HubServer.start(options);
  try {
    const url = hub.url, port = Number(new URL(url).port), identity = hub.auth.publicKey;
    await page.goto(url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("备份恢复验收助手");
    await page.getByLabel("引擎", { exact: true }).selectOption("codex");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-astra");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click();
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    const session = async () => {
      const state = JSON.parse(await readFile(path.join(root, "bots", bot.id, "session.json"), "utf8"));
      return state.chats.find((s: { conversationKey: string }) => s.conversationKey === `lark:${conversation.id}`).codexSessionId;
    };
    const send = async (text: string) => { await page.getByRole("textbox", { name: "消息", exact: true }).fill(text); await page.getByRole("button", { name: "发送消息", exact: true }).click(); };
    const reply = async (marker: string) => {
      await expect.poll(async () => (await hub!.store.snapshot("owner", conversation.id)).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(marker)), { timeout: 60_000 }).toBe(true);
      await expect(page.locator(".message-blocks").getByText(marker, { exact: true })).toBeVisible();
      await expect.poll(async () => (await hub!.store.pendingForBot(bot.id)).length).toBe(0);
    };
    await send("这是本地备份恢复验收。不要调用任何工具、读取文件或发送外部消息。记住口令：蓝色松塔73。只回复一行 TAROCUB_BACKUP_READY。"); await reply("TAROCUB_BACKUP_READY");
    const originalSession = await session(), messages = (await hub.store.snapshot("owner", conversation.id)).messages;
    await hub.close(); hub = undefined;
    const bundle = path.join(parent, "backup"); const manifest = await backupHubState(root, bundle);
    await rename(root, path.join(parent, "original-preserved")); await restoreHubState(bundle, root);
    hub = await HubServer.start({ ...options, port }); expect(hub.auth.publicKey).toBe(identity);
    expect((await hub.store.snapshot("owner", conversation.id)).messages).toEqual(messages);
    expect(await session()).toBe(originalSession);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "配对此设备", exact: true })).toHaveCount(0);
    await send("不要调用工具。刚才我给你的口令是什么？只回复口令本身。"); await reply("蓝色松塔73");
    expect(await session()).toBe(originalSession);
    await page.screenshot({ path: info.outputPath("worker-backup-restored.png") });
    await info.attach("backup-lifecycle", { body: JSON.stringify({ realEngine: "codex", restoredSamePath: true, deviceTrustPreserved: true, historyPreserved: true, rememberedContext: true, nativeSessionUnchanged: true, files: manifest.entries.filter((e) => e.type === "file").length, engineStateIsExternal: true }), contentType: "application/json" });
  } finally { await page.close(); await hub?.close(); await archiveAcceptanceThreads(parent); await rm(parent, { recursive: true, force: true }); }
});

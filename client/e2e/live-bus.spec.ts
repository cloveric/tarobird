import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";
import { test, expect, type Page } from "@playwright/test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { readRegistry } from "../../src/bus/bus-registry.js";
import { blocksText } from "../../src/client-protocol/index.js";

test("real configured Bus peers answer group ask, fan, chain, verify and obey phone stop", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_BUS !== "1", "requires explicit real-engine acceptance");
  test.setTimeout(360_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-client-bus-"));
  const events = path.join(root, "native-events.jsonl"), wrapper = path.join(root, "codex-observer.cjs");
  // Observe method names only, never prompts, results, credentials or native IDs.
  await writeFile(wrapper, `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const child = spawn(${JSON.stringify(process.env.CODEX_EXECUTABLE || "codex")}, process.argv.slice(2), { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
let pending = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk); pending += chunk.toString();
  const lines = pending.split('\\n'); pending = lines.pop();
  for (const line of lines) { try { const f = JSON.parse(line);
    if (f.method === 'item/agentMessage/delta') appendFileSync(${JSON.stringify(events)}, JSON.stringify({ bot: process.env.TAROCUB_INSTANCE, method: f.method }) + '\\n');
  } catch {} }
});
child.on('error', () => process.exit(1)); child.on('exit', (code) => process.exit(code ?? 1));
`);
  await chmod(wrapper, 0o700);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js"), env: { ...process.env, CODEX_EXECUTABLE: wrapper } } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  const stateDir = (id: string) => path.join(root, "hub", "bots", id);
  const jsonl = async (file: string): Promise<Record<string, unknown>[]> => (await readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device);
  };
  try {
    const bots = [];
    for (const [index, name] of ["协调助手", "分析助手", "复核助手"].entries()) bots.push(await hub.botManager!.create("owner", { requestId: `bus_fixture_${index}`, name, engine: "codex", model: "gpt-6-astra", effort: "low", workspace: "" }));
    const [main, beta, gamma] = bots;
    await expect.poll(async () => (await hub.store.bots("owner")).filter((bot) => bot.online).length).toBe(3);
    await pair(page);
    // Enable the native Bus through the same owner UI used on desktop/phone.
    // Only isolated fixture Bots are selected, then their idle workers restart.
    for (const bot of bots) {
      await clickAppAction(page, "运行状态", page.getByRole("button", { name: "运行状态", exact: true }));
      await page.locator(".operation-bot").filter({ hasText: bot.name }).getByRole("button", { name: "协作设置", exact: true }).click();
      await page.getByLabel("启用多 Bot 协作", { exact: true }).check();
      for (const peer of bots.filter((peer) => peer.id !== bot.id)) await page.getByRole("checkbox", { name: peer.name, exact: true }).check();
      if (bot.id === main!.id) {
        for (const peer of [beta!, gamma!]) {
          await page.getByRole("combobox", { name: "添加到并行询问", exact: true }).selectOption(peer.id);
          await page.getByRole("combobox", { name: "添加到串联步骤", exact: true }).selectOption(peer.id);
        }
        await page.getByRole("combobox", { name: "复核 Bot", exact: true }).selectOption(gamma!.id);
      }
      await page.getByRole("button", { name: "保存协作设置", exact: true }).click(); await expect(page.getByRole("status")).toContainText("协作设置已保存");
      await page.getByRole("button", { name: "空闲后重启并应用", exact: true }).click(); await expect(page.getByRole("status")).toContainText("已安排空闲后重启");
      await page.getByRole("button", { name: "关闭运行状态", exact: true }).click();
    }
    await expect.poll(async () => Object.keys((await readRegistry(path.join(root, "hub", "bots"))).instances).length, { timeout: 20_000 }).toBe(3);
    await clickAppAction(page, "新建群组", page.getByRole("button", { name: "新建群组", exact: true }));
    const dialog = page.getByRole("dialog", { name: "新建群组" });
    for (const bot of bots) await dialog.getByRole("checkbox", { name: new RegExp(bot.name) }).check();
    await dialog.getByPlaceholder("为这段对话起个名字").fill("多 Bot 协作验收"); await dialog.getByRole("button", { name: "创建群组", exact: true }).click();
    await expect(page.getByRole("heading", { name: "多 Bot 协作验收", exact: true })).toBeVisible();
    await pair(phone);
    const conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const send = async (text: string) => {
      const match = text.match(/^\/(ask|fan|chain|verify)\s+([\s\S]+)$/); if (!match) throw new Error("fixture_command_invalid");
      const mode = match[1]!, input = match[2]!, split = input.indexOf(" ");
      const target = mode === "ask" ? input.slice(0, split) : undefined, prompt = mode === "ask" ? input.slice(split + 1) : input;
      await page.getByRole("button", { name: "发起 Bot 协作", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "发起 Bot 协作", exact: true });
      await dialog.getByRole("combobox", { name: "发起 Bot", exact: true }).selectOption(main!.id);
      await dialog.getByRole("combobox", { name: "协作方式", exact: true }).selectOption(mode);
      if (target) await dialog.getByRole("combobox", { name: "协作对象", exact: true }).selectOption(target);
      await dialog.getByRole("textbox", { name: "协作任务", exact: true }).fill(prompt);
      await dialog.getByRole("button", { name: "发送协作任务", exact: true }).click();
    };
    const idle = async () => { await expect.poll(async () => (await hub.store.pendingForBot(main!.id)).length).toBe(0); };
    const command = async (text: string, marker: string) => {
      const before = new Set((await hub.store.snapshot("owner", conversation.id)).messages.map((m) => m.id));
      await send(text);
      const result = async () => (await hub.store.snapshot("owner", conversation.id)).messages.find((m) => !before.has(m.id) && m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes(marker));
      await expect.poll(async () => !!await result(), { timeout: 90_000 }).toBe(true); await idle();
      const message = (await result())!;
      for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${message.id}"]`)).toContainText(marker);
      expect(blocksText(message.blocks)).not.toMatch(/Error:|失败：/);
      return blocksText(message.blocks);
    };
    const plain = "这是隔离验收，不使用工具、不读取文件、不发外部消息。";
    await command(`/ask ${beta!.id} ${plain}只回复 BUS_ASK_OK。`, "BUS_ASK_OK");
    const fan = await command(`/fan ${plain}只回复 BUS_FAN_OK。`, "BUS_FAN_OK");
    expect(fan.match(/BUS_FAN_OK/g)).toHaveLength(3);
    const chain = await command(`/chain ${plain}若没有上一阶段输出只回复 BUS_CHAIN_STAGE_1；若存在上一阶段输出且其中有该标记则只回复 BUS_CHAIN_STAGE_2。`, "BUS_CHAIN_STAGE_2");
    expect(chain).toContain("BUS_CHAIN_STAGE_1");
    const verification = await command(`/verify ${plain}回答 2+3，回复中包含 BUS_VERIFY_OK；若你正在复核，请明确给出结果且保留这个验收标记。`, "的验证]");
    expect(verification).toContain("BUS_VERIFY_OK");
    expect((await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot").every((m) => m.authorId === main!.id)).toBe(true);
    for (const peer of [beta!, gamma!]) {
      const audit = await jsonl(path.join(stateDir(peer.id), "audit.log.jsonl"));
      expect(audit.filter((entry) => entry.type === "bus.handle" && entry.outcome === "success")).toHaveLength(3);
      const sessions = JSON.parse(await readFile(path.join(stateDir(peer.id), "session.json"), "utf8").catch(() => '{"chats":[]}')) as { chats: unknown[] };
      expect(sessions.chats).toHaveLength(0);
    }
    const deltas = async () => (await jsonl(events)).filter((event) => event.bot === beta!.id).length;
    const previousDeltas = await deltas();
    await send(`/ask ${beta!.id} ${plain}这是取消验收。先输出 BUS_NATIVE_STREAM_START，再逐行从 1 数到 3000，每行写一句解释，不要省略。`);
    await expect.poll(deltas, { timeout: 60_000 }).toBeGreaterThan(previousDeltas);
    await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
    await expect.poll(async () => (await jsonl(path.join(stateDir(beta!.id), "timeline.log.jsonl"))).some((entry) => entry.type === "turn.completed" && entry.outcome === "interrupted"), { timeout: 15_000 }).toBe(true);
    await idle();
    for (const device of [page, phone]) await expect(device.locator(".message-blocks").getByText(/was cancelled/)).toBeVisible();
    await command(`/ask ${beta!.id} ${plain}只回复 BUS_AFTER_STOP_OK。`, "BUS_AFTER_STOP_OK");
    // Group stop intentionally asks all Bots and they may acknowledge no local
    // group run. Only the selected Bot publishes the delegated answer itself.
    const peerMessages = (await hub.store.snapshot("owner", conversation.id)).messages.filter((m) => m.authorType === "bot" && m.authorId !== main!.id);
    expect(peerMessages.every((m) => blocksText(m.blocks) === "当前没有正在运行的任务。")).toBe(true);
    await page.screenshot({ path: info.outputPath("bus-desktop.png") }); await phone.screenshot({ path: info.outputPath("bus-phone.png") });
    await writeFile(info.outputPath("live-bus.json"), JSON.stringify({ engine: "codex", model: "gpt-6-astra", configuredManagedPeers: 3, collaborationConfiguredThroughUI: true, collaborationStartedThroughUI: true, pairedDevices: 2, groupCreatedThroughUI: true, ask: true, fanResults: 3, chainStageHandoff: true, verify: true, peerEphemeralSessionsNotBound: true, onlySelectedGroupBotPublishedAnswers: true, nativeDeltaBeforeStop: true, peerCancellationRecorded: true, nextDelegationCompleted: true }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("messages.json"), JSON.stringify(await Promise.all((await hub.store.conversations("owner")).map((conversation) => hub.store.snapshot("owner", conversation.id))), null, 2));
    for (const bot of await hub.store.bots("owner")) await writeFile(info.outputPath(`${bot.id}-diagnostics.json`), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), timeline: await jsonl(path.join(stateDir(bot.id), "timeline.log.jsonl")) }, null, 2));
    throw error;
  } finally { await phoneContext.close(); await page.close(); await hub.close(); await archiveAcceptanceThreads(root); await rm(root, { recursive: true, force: true }); }
});

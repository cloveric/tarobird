import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HubServer } from "../../src/hub/server.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";

const engine = process.env.TAROCUB_LIVE_ENGINE ?? "codex";
test(`native ${engine} steering stays in the same running turn and syncs to both devices`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_STEERING !== "1", "Opt-in native CLI acceptance only");
  if (!["codex", "deepseek"].includes(engine)) throw new Error("Unsupported live steering engine");
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-client-worker-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const entrypoint = path.resolve("../dist/src/index.js"), log = path.join(root, "steering-observer.jsonl");
  const env = { ...process.env, TAROCUB_GOAL_WORKER_ENTRY: entrypoint, TAROCUB_GOAL_OBSERVER_LOG: log,
    TAROCUB_GOAL_PROTOCOL_MODULE: pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-protocol.js")).href,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("e2e/fixtures/goal-observer.mjs")).href}` };
  const observations = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: { entrypoint, env } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device);
  };
  try {
    await pair(page); await clickAppAction(page, "新建 Bot", page.getByRole("button", { name: "新建 Bot", exact: true }));
    await page.getByLabel("Bot 名称", { exact: true }).fill("原生引导验收");
    await page.getByLabel("引擎", { exact: true }).selectOption(engine);
    await page.getByLabel("模型", { exact: true }).selectOption(engine === "codex" ? "gpt-6-astra" : "");
    await page.getByLabel("推理强度（effort）").selectOption("low");
    await page.getByText("高级设置", { exact: true }).click(); await page.getByLabel("工作区（可选）", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click();
    await expect(page.getByText("Bot 已上线，可以开始对话。", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "开始对话", exact: true }).click(); await pair(phone);
    const bot = (await hub.store.bots("owner"))[0]!, conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const snapshot = () => hub.store.snapshot("owner", conversation.id);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("这是临时本机验收。先输出 NATIVE_STEER_STARTED，然后通过命令工具执行 sleep 12，等待命令完成后再回答。除此之外不要调用工具、读取文件或发送外部消息。执行期间我会补充一条指令，请按收到的最新指令调整最终回答；没有补充则回复 BASELINE。");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await snapshot()).messages.some((m) => m.authorType === "bot" && m.status === "streaming" && blocksText(m.blocks).includes("NATIVE_STEER_STARTED")), { timeout: 90_000 }).toBe(true);
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill("任务要求已改变，等待刚才的命令完成后，只回复 NATIVE_STEER_APPLIED，然后结束当前轮次。不要调用任何工具。");
    await clickAppAction(phone, "引导当前任务", phone.getByRole("button", { name: "引导当前任务", exact: true }));
    for (const device of [page, phone]) await expect(device.getByText("CLI 已接收引导", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await snapshot()).messages.some((m) => m.authorType === "bot" && m.status === "complete" && blocksText(m.blocks).includes("NATIVE_STEER_APPLIED")), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    const messages = (await snapshot()).messages;
    expect(messages.filter((m) => m.authorType === "user")).toHaveLength(2);
    const controls = messages.filter((m) => m.blocks.some((b) => b.type === "steering")); expect(controls).toHaveLength(1);
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [controls[0]!.id])).toEqual([]);
    const timeline = (await readFile(path.join(root, "bots", bot.id, "timeline.log.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(timeline.filter((event) => event.type === "turn.started")).toHaveLength(1);
    for (const [device, name] of [[page, "desktop"], [phone, "phone"]] as const) await device.screenshot({ path: info.outputPath(`native-steering-${engine}-${name}.png`), animations: "disabled" });
    const native = await observations();
    if (engine === "deepseek") {
      const admitted = native.filter((o) => o.type === "exact-steer-result" && o.outcome === "accepted"); expect(admitted).toHaveLength(1);
      expect(native.filter((o) => o.type === "turn/start")).toHaveLength(1);
      expect(native.some((o) => o.type === "user/message" && o.source?.rpcId === admitted[0].requestId)).toBe(true);
    }
    await writeFile(info.outputPath(`native-steering-${engine}.json`), JSON.stringify({ engine, nativeAck: true, newTurnCount: 1, instructionApplied: true, devices: 2, physicalDevices: false, native }, null, 2));
  } catch (error) {
    for (const bot of await hub.store.bots("owner")) await writeFile(info.outputPath(`steering-${engine}-diagnostics.json`), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), conversations: await hub.store.conversations("owner"), timeline: await readFile(path.join(root, "bots", bot.id, "timeline.log.jsonl"), "utf8").catch(() => "") }));
    throw error;
  } finally { await phoneContext.close(); await hub.close(); if (engine === "codex") await archiveAcceptanceThreads(root); await rm(root, { recursive: true, force: true }); }
});

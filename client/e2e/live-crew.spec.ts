import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { readRegistry } from "../../src/bus/bus-registry.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { CrewRunRecordSchema } from "../../src/state/crew-run-schema.js";
import { archiveAcceptanceThreads } from "../../tests/helpers/codex-acceptance.js";

// Explicit opt-in: five already-authenticated native CLIs, isolated managed Bots.
// The root prefix also opts into the existing scoped Codex-history teardown.
test("five native engines complete a configured group Crew after phone cancellation", async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_CREW !== "1", "requires explicit five-engine acceptance");
  test.setTimeout(600_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-client-bus-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint: path.resolve("../dist/src/index.js") } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  const stateDir = (id: string) => path.join(root, "hub", "bots", id);
  const jsonl = async (file: string): Promise<Record<string, unknown>[]> => (await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const pair = async (device: Page) => {
    await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(device);
  };
  try {
    const definitions = [
      { name: "协调助手", engine: "codex", model: "gpt-6-astra" },
      { name: "研究助手", engine: "claude", model: "sonnet" },
      { name: "分析助手", engine: "kimi", model: "" },
      { name: "写作助手", engine: "deepseek", model: "" },
      { name: "复核助手", engine: "antigravity", model: "" },
    ];
    const bots = [];
    for (const [index, definition] of definitions.entries()) bots.push(await hub.botManager!.create("owner", { requestId: `crew_fixture_${index}`, ...definition, effort: "low", workspace: "" }));
    const main = bots[0]!, researcher = bots[1]!;
    await expect.poll(async () => (await hub.store.bots("owner")).filter((bot) => bot.online).length, { timeout: 20_000 }).toBe(5);
    await pair(page);
    for (const bot of bots) {
      await clickAppAction(page, "运行状态", page.getByRole("button", { name: "运行状态", exact: true }));
      await page.locator(".operation-bot").filter({ hasText: bot.name }).getByRole("button", { name: "协作设置", exact: true }).click();
      await page.getByLabel("启用多 Bot 协作", { exact: true }).check();
      // Only coordinator<->specialist grants are necessary for this workflow.
      for (const peer of bot.id === main.id ? bots.slice(1) : [main]) await page.getByRole("checkbox", { name: peer.name, exact: true }).check();
      if (bot.id === main.id) {
        await page.getByText("研究团队与高级设置", { exact: true }).click();
        await page.getByLabel("启用 Crew 研究团队", { exact: true }).check();
        for (const [index, role] of ["研究员", "分析员", "撰写者", "审阅者"].entries()) await page.getByRole("combobox", { name: role, exact: true }).selectOption(bots[index + 1]!.id);
        await page.getByLabel("最多研究问题数", { exact: true }).fill("1");
        await page.getByLabel("最多修订轮数", { exact: true }).fill("1");
      }
      await page.getByRole("button", { name: "保存协作设置", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("协作设置已保存");
      await page.getByRole("button", { name: "空闲后重启并应用", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("已安排空闲后重启");
      await page.getByRole("button", { name: "关闭运行状态", exact: true }).click();
    }
    await expect.poll(async () => Object.keys((await readRegistry(path.join(root, "hub", "bots"))).instances).length, { timeout: 20_000 }).toBe(5);
    await clickAppAction(page, "新建群组", page.getByRole("button", { name: "新建群组", exact: true }));
    const dialog = page.getByRole("dialog", { name: "新建群组", exact: true });
    for (const bot of bots) await dialog.getByRole("checkbox", { name: new RegExp(bot.name) }).check();
    await dialog.getByPlaceholder("为这段对话起个名字").fill("五引擎协作验收");
    await dialog.getByRole("button", { name: "创建群组", exact: true }).click();
    await expect(page.getByRole("heading", { name: "五引擎协作验收", exact: true })).toBeVisible();
    await pair(phone);
    const conversation = (await hub.store.conversations("owner"))[0]!;
    await selectConversation(phone, conversation.title);
    const runs = async () => {
      const directory = path.join(stateDir(main.id), "crew-runs");
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      return Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => CrewRunRecordSchema.parse(JSON.parse(await readFile(path.join(directory, name), "utf8")))));
    };
    const send = async (text: string) => {
      const recipients = page.getByRole("group", { name: "回复的 Bot", exact: true });
      for (const bot of bots) {
        const option = recipients.getByRole("checkbox", { name: bot.name, exact: true });
        if ((await option.getAttribute("aria-checked") === "true") !== (bot.id === main.id)) await option.click();
      }
      await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
    };
    const plain = "这是隔离验收，只使用本条合成资料，不调用工具、不读取文件、不访问网络或发送外部消息。";
    await send(`${plain}请研究从 1 到 3000 的每个整数对应的平方，研究阶段逐项完整列出且不省略；这是取消流程测试。`);
    await expect.poll(async () => (await jsonl(path.join(stateDir(researcher.id), "timeline.log.jsonl"))).some((event) => event.type === "turn.started"), { timeout: 90_000 }).toBe(true);
    const interruptedId = (await runs())[0]!.runId;
    await clickAppAction(phone, "停止当前轮次", phone.getByRole("button", { name: "停止当前轮次", exact: true }));
    await expect.poll(async () => (await runs()).find((run) => run.runId === interruptedId)?.status, { timeout: 15_000 }).toBe("failed");
    await expect.poll(async () => (await jsonl(path.join(stateDir(researcher.id), "timeline.log.jsonl"))).some((event) => event.type === "turn.completed" && event.outcome === "interrupted"), { timeout: 15_000 }).toBe(true);
    expect((await runs()).find((run) => run.runId === interruptedId)?.stages.analysis).toBeUndefined();
    await expect.poll(async () => (await hub.store.pendingForBot(main.id)).length).toBe(0);
    console.log("Crew phone cancellation verified; starting complete five-engine workflow");
    const prompt = `${plain}请按各自角色完成一份不超过 250 字的简短报告，报告保留标记 CREW_MIXED_OK。合成资料：纸船实验 A 组测试 20 次、成功 15 次；B 组测试 20 次、成功 10 次。比较成功率与百分点差，不外推真实世界结论。协调者只拆出 1 个子问题；研究、分析和写作各输出简短内容；审阅者遵循其 VERDICT/ISSUES 格式，按资料如实评审。`;
    await send(prompt);
    await expect.poll(async () => (await runs()).filter((run) => run.runId !== interruptedId).map((run) => run.status), { timeout: 300_000 }).toEqual(["completed"]);
    const complete = (await runs()).find((run) => run.runId !== interruptedId)!;
    for (const stage of ["decomposition", "research", "analysis", "writing", "review"] as const) expect(complete.stages[stage]?.status).toBe("completed");
    expect(complete.stages.research?.subQuestions).toHaveLength(1);
    expect(complete.stages.review?.verdict).toBe("pass");
    expect(complete.finalOutput).toContain("CREW_MIXED_OK");
    const snapshot = await hub.store.snapshot("owner", conversation.id);
    const result = snapshot.messages.find((message) => message.authorType === "bot" && message.authorId === main.id && message.status === "complete" && blocksText(message.blocks).includes("CREW_MIXED_OK"));
    expect(result).toBeDefined();
    for (const device of [page, phone]) await expect(device.locator(`[data-message-id="${result!.id}"]`)).toContainText("CREW_MIXED_OK");
    expect(snapshot.messages.filter((message) => message.authorType === "user").every((message) => JSON.stringify(message.mentions) === JSON.stringify([main.id]))).toBe(true);
    expect(snapshot.messages.filter((message) => message.authorType === "bot" && message.authorId !== main.id).every((message) => blocksText(message.blocks) === "当前没有正在运行的任务。")).toBe(true);
    const peerCalls = [];
    for (const [index, peer] of bots.slice(1).entries()) {
      const audit = await jsonl(path.join(stateDir(peer.id), "audit.log.jsonl"));
      const successes = audit.filter((event) => event.type === "bus.handle" && event.outcome === "success").length;
      expect(successes).toBeGreaterThan(0);
      const sessions = JSON.parse(await readFile(path.join(stateDir(peer.id), "session.json"), "utf8").catch(() => '{"chats":[]}')) as { chats: unknown[] };
      expect(sessions.chats).toHaveLength(0);
      peerCalls.push({ engine: definitions[index + 1]!.engine, successCount: successes });
    }
    await page.screenshot({ path: info.outputPath("crew-desktop.png") }); await phone.screenshot({ path: info.outputPath("crew-phone.png") });
    await writeFile(info.outputPath("live-crew.json"), JSON.stringify({ engines: definitions.map(({ engine, model }) => ({ engine, model: model || "CLI default" })), pairedDevices: 2, configuredThroughUI: true, groupCreatedThroughUI: true, recipientsSelectedThroughUI: true, phoneStop: true, interruptedResearchRecorded: true, stoppedBeforeAnalysis: true, subsequentCrewCompleted: true, stages: Object.fromEntries(Object.entries(complete.stages).map(([name, stage]) => [name, { status: stage?.status, ...(stage?.verdict ? { verdict: stage.verdict } : {}) }])), peerCalls, onlyCoordinatorPublishedReport: true, peerSessionsUnbound: true, nativeContainers: false }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath("messages.json"), JSON.stringify(await Promise.all((await hub.store.conversations("owner")).map((conversation) => hub.store.snapshot("owner", conversation.id))), null, 2));
    for (const bot of await hub.store.bots("owner")) {
      const directory = path.join(stateDir(bot.id), "crew-runs"), files = await readdir(directory).catch(() => []);
      await writeFile(info.outputPath(`${bot.engine}-diagnostics.json`), JSON.stringify({ status: hub.botManager!.serviceStatus(bot.id), timeline: await jsonl(path.join(stateDir(bot.id), "timeline.log.jsonl")), runs: await Promise.all(files.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")))) }, null, 2));
    }
    throw error;
  } finally { await phoneContext.close(); await page.close(); await hub.close(); await archiveAcceptanceThreads(root); await rm(root, { recursive: true, force: true }); }
});

import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { startGatewayBus } from "../../src/gateway/bus.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

// Real production UI -> Hub API -> queue -> Gateway -> local Bus HTTP ->
// durable stage records. Only the model is scripted; no Bus API route mocks.
test.use({ serviceWorkers: "block" });
const panel = (page: Page) => page.getByRole("complementary", { name: "Agent Bus 设置与运行", exact: true });
type Turn = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
async function setup(page: Page) {
  page.setDefaultTimeout(10_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "bus-real-ui-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: process.env.TAROBOT_E2E_CLIENT_DIR ?? path.resolve("dist"), managedBots: { entrypoint: path.join(root, "never-start-a-worker.js") } });
  const ids = ["alpha", "beta"], calls: { id: string; turn: Turn }[] = [];
  const listeners: { stop(): Promise<void> }[] = [], channels: Awaited<ReturnType<typeof attachGateway>>[] = [];
  const errors: string[] = [];
  // WebKit reports even caught fetch failures during document unload as a
  // protocol pageerror. Observe actual uncaught errors/rejections in every
  // document instead, retaining reload coverage without hiding App failures.
  await page.exposeFunction("recordBusRuntimeError", (message: string) => errors.push(message));
  await page.addInitScript(() => {
    const report = (message: string) => {
      void (window as unknown as { recordBusRuntimeError(message: string): Promise<void> }).recordBusRuntimeError(message).catch(() => {});
    };
    addEventListener("error", event => report(event.message));
    addEventListener("unhandledrejection", event => report(String(event.reason)));
  });
  for (const id of ids) {
    const secret = randomBytes(32).toString("base64url"), dir = path.join(root, "bots", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", approvalMode: "bypass", bus: { peers: ids.filter(peer => peer !== id), secret: randomBytes(32).toString("hex") } }));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id === "alpha" ? "研究助手" : "复核助手", hashSecret(secret)]);
    await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
    const bridge: CoreBridgeLike = { handleAuthorizedMessage: async (turn: Turn) => {
      calls.push({ id, turn });
      if (turn.text.includes("WAIT_FOR_STOP")) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        const stop = () => { clearTimeout(timer); reject(new Error("fixture_cancelled")); };
        if (turn.abortSignal?.aborted) stop(); else turn.abortSignal?.addEventListener("abort", stop, { once: true });
      });
      if (turn.text.includes("FAIL_STEP")) throw new Error("fixture_stage_failure");
      if (turn.text.includes("DELIVERY_FAIL")) return { text: `工作已完成，但附件不存在。[send-file:${path.join(root, "absent.txt")}]` };
      return { text: `${id} 完成 ${calls.length}`, usage: { inputTokens: 1, outputTokens: 1 } };
    } };
    listeners.push((await startGatewayBus(dir, id, bridge))!);
    channels.push(await attachGateway({ stateDir: dir, botId: id, secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge }));
  }
  await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill("隔离验收主机");
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page);
  return { hub, calls, errors, close: async () => { await page.close(); for (const channel of channels) await channel.disconnect(); for (const listener of listeners) await listener.stop(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test("real runtime: create, reopen, chain repeated Bots, fail, stop and return to ADHD", async ({ page }, info) => {
  test.setTimeout(120_000);
  const f = await setup(page);
  try {
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("真实链路验收");
    await editor.getByRole("button", { name: "串联步骤", exact: true }).click();
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("alpha");
    const slots = editor.locator(".agent-bus-slot");
    await slots.nth(1).locator('select[data-focus="bot"]').selectOption("beta");
    await slots.nth(1).locator("textarea").fill("FIRST_TASK");
    await editor.getByRole("button", { name: "添加步骤", exact: true }).click();
    await slots.nth(2).locator('select[data-focus="bot"]').selectOption("beta");
    await slots.nth(2).locator("textarea").fill("SECOND_TASK");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    const [saved] = await f.hub.agentBuses.list("owner");
    expect(saved!.members.map(member => member.instruction)).toEqual(["FIRST_TASK", "SECOND_TASK"]);
    expect(new Set(saved!.members.map(member => member.conversationId)).size).toBe(2);
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await page.getByRole("button", { name: "打开 Bus：真实链路验收", exact: true }).click();
    const start = async (text: string, status: string) => {
      await editor.getByLabel("Bus 共同目标", { exact: true }).fill(text);
      await editor.getByRole("button", { name: "启动协作", exact: true }).click();
      await expect.poll(async () => (await f.hub.agentBuses.detail("owner", saved!.id)).runs[0]?.status, { timeout: 20_000 }).toBe(status);
    };
    await start("SHARED_GOAL", "completed");
    expect(f.calls.map(call => call.id)).toEqual(["beta", "beta"]);
    expect(f.calls[0]!.turn.text).toContain("FIRST_TASK"); expect(f.calls[0]!.turn.text).not.toContain("SECOND_TASK");
    expect(f.calls[1]!.turn.text).toContain("SECOND_TASK"); expect(f.calls[1]!.turn.text).toContain("beta 完成 1");
    const first = (await f.hub.agentBuses.detail("owner", saved!.id)).runs[0]!;
    expect(first.stages.map(stage => stage.conversationId)).toEqual(saved!.members.map(member => member.conversationId));
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible({ timeout: 8000 });
    await start("FAIL_STEP", "failed");
    expect(f.calls).toHaveLength(3);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible({ timeout: 8000 });
    await start("WAIT_FOR_STOP", "running");
    await editor.getByRole("button", { name: "停止本次协作", exact: true }).click();
    await page.getByRole("dialog", { name: "停止本次协作？", exact: true }).getByRole("button", { name: "停止本次协作", exact: true }).click();
    await expect.poll(async () => (await f.hub.agentBuses.detail("owner", saved!.id)).runs[0]?.status, { timeout: 10000 }).toBe("cancelled");
    expect(f.calls).toHaveLength(4);
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toBeVisible({ timeout: 8000 });
    await start("DELIVERY_FAIL", "failed");
    const incomplete = (await f.hub.agentBuses.detail("owner", saved!.id)).runs[0]!;
    expect(incomplete.error).toBe("agent_bus_output_not_delivered");
    expect(incomplete.stages.every(stage => stage.status === "completed")).toBe(true);
    expect(f.calls).toHaveLength(6);
    await expect(editor.getByText("结果未完整交付，请查看发起者对话中的失败原因。已发送的附件不会自动重发。", { exact: true })).toBeVisible({ timeout: 8000 });
    await editor.getByRole("button", { name: "收起 Agent Bus", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("real-chain-return.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("real Hub: choosing a default record repairs an archived binding and preserves its history", async ({ page }, info) => {
  const f = await setup(page);
  try {
    const saved = await f.hub.agentBuses.create("owner", { requestId: "archived-record", config: { name: "修复记录对话", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta", instruction: "保存这份分工" }] } });
    await f.hub.store.updateConversation("owner", saved.members[0]!.conversationId, { archived: true });
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Bus：修复记录对话", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const member = editor.locator('.agent-bus-slot[data-slot-index="0"]');
    await expect(member.locator("textarea")).toHaveValue("保存这份分工");
    await member.locator(".agent-bus-slot-record select").selectOption("");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    const updated = (await f.hub.agentBuses.detail("owner", saved.id)).workspace;
    expect(updated.members[0]!.conversationId).not.toBe(saved.members[0]!.conversationId);
    expect(updated.members[0]!.instruction).toBe("保存这份分工");
    expect(await f.hub.store.db.get("SELECT archived FROM conversations WHERE id=?", [saved.members[0]!.conversationId])).toEqual({ archived: 1 });
    await editor.screenshot({ path: info.outputPath("repaired-record.png") });
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("real Hub: lost create and save replies reconcile without duplicate workspaces", async ({ page }) => {
  test.setTimeout(90_000);
  const f = await setup(page);
  try {
    let loseCreate = true, loseUpdate = true;
    // Execute the actual mutation, then lose only its response. Persistence and
    // receipt replay still belong to the real Hub, not a route-response fixture.
    await page.route("**/api/agent-buses", async route => {
      if (route.request().method() !== "POST" || !loseCreate) return route.continue();
      loseCreate = false;
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("待修正的名称");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("alpha");
    await editor.locator('.agent-bus-slot[data-slot-index="0"] select[data-focus="bot"]').selectOption("beta");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect.poll(async () => (await f.hub.agentBuses.list("owner")).length).toBe(1);
    await expect.poll(async () => await editor.getByRole("tab", { name: "运行", exact: true }).getAttribute("aria-selected") === "true"
      || await editor.getByRole("button", { name: "创建 Bus", exact: true }).isEnabled()).toBe(true);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("修正后的名称");
    const [original] = await f.hub.agentBuses.list("owner");
    let loseRecoveryUpdate = true;
    await page.route(`**/api/agent-buses/${original!.id}`, async route => {
      if (route.request().method() !== "PUT" || !loseRecoveryUpdate) return route.continue();
      loseRecoveryUpdate = false;
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await editor.getByRole("button", { name: /^(创建 Bus|保存配置)$/ }).click();
    await expect.poll(async () => (await f.hub.agentBuses.detail("owner", original!.id)).workspace.name).toBe("修正后的名称");
    await expect(editor.getByRole("button", { name: /^(创建 Bus|保存配置)$/ })).toBeEnabled();
    // Losing the response of the recovery update must also be recoverable,
    // without another workspace or an endless revision-conflict loop.
    await editor.getByRole("button", { name: /^(创建 Bus|保存配置)$/ }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    const saved = await f.hub.agentBuses.list("owner");
    expect(saved).toHaveLength(1); expect(saved[0]!.name).toBe("修正后的名称");
    expect(await f.hub.store.db.get("SELECT COUNT(*) AS count FROM conversations WHERE client_action_id LIKE 'agentbus_%'")).toEqual({ count: 2 });

    await page.route(`**/api/agent-buses/${saved[0]!.id}`, async route => {
      if (route.request().method() !== "PUT" || !loseUpdate) return route.continue();
      loseUpdate = false;
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.locator('.agent-bus-slot[data-slot-index="0"] textarea').fill("完整保存这一段分工");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect.poll(async () => (await f.hub.agentBuses.detail("owner", saved[0]!.id)).workspace.members[0]!.instruction).toBe("完整保存这一段分工");
    await expect.poll(async () => await editor.getByRole("tab", { name: "运行", exact: true }).getAttribute("aria-selected") === "true"
      || await editor.getByRole("button", { name: "保存配置", exact: true }).isEnabled()).toBe(true);
    if (await editor.getByRole("tab", { name: "运行", exact: true }).getAttribute("aria-selected") !== "true")
      await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(await f.hub.agentBuses.list("owner")).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("real Hub: a default-record draft cannot acknowledge another device's explicit binding", async ({ page }) => {
  const f = await setup(page);
  try {
    const saved = await f.hub.agentBuses.create("owner", { requestId: "binding-conflict", config: { name: "绑定冲突验收", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }] } });
    const ordinary = await f.hub.store.createConversation("owner", ["beta"], "另一设备选择的普通对话", "ordinary-record");
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Bus：绑定冲突验收", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const record = editor.locator('.agent-bus-slot[data-slot-index="0"] .agent-bus-slot-record select');
    await record.selectOption("");
    await f.hub.agentBuses.update("owner", saved.id, { revision: saved.revision, config: { name: saved.name, mode: saved.mode, coordinator: saved.coordinator, members: [{ botId: "beta", conversationId: ordinary.id }] } });
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("当前配置与主机记录不一致");
    await expect(record).toHaveValue("");
    await expect(editor.getByRole("tab", { name: "配置", exact: true })).toHaveAttribute("aria-selected", "true");
    expect((await f.hub.agentBuses.detail("owner", saved.id)).workspace.members[0]!.conversationId).toBe(ordinary.id);
    expect(f.calls).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("real Hub: recovering a lost create cannot overwrite later edits from another device", async ({ page }) => {
  const f = await setup(page);
  try {
    let loseCreate = true;
    await page.route("**/api/agent-buses", async route => {
      if (route.request().method() !== "POST" || !loseCreate) return route.continue();
      loseCreate = false;
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("创建恢复竞争");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("alpha");
    await editor.locator('.agent-bus-slot[data-slot-index="0"] select[data-focus="bot"]').selectOption("beta");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect.poll(async () => (await f.hub.agentBuses.list("owner")).length).toBe(1);
    const [saved] = await f.hub.agentBuses.list("owner");
    await f.hub.agentBuses.update("owner", saved!.id, { revision: saved!.revision, config: { name: saved!.name, mode: saved!.mode, coordinator: saved!.coordinator, members: [{ ...saved!.members[0]!, instruction: "保留另一设备的新分工" }] } });
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("本机修正名称");
    await editor.getByRole("button", { name: /^(创建 Bus|保存配置)$/ }).click();
    await expect.poll(async () => await editor.getByRole("tab", { name: "运行", exact: true }).getAttribute("aria-selected") === "true"
      || await editor.getByRole("button", { name: /^(创建 Bus|保存配置)$/ }).isEnabled()).toBe(true);
    const current = await f.hub.agentBuses.list("owner");
    expect(current).toHaveLength(1);
    expect(current[0]!.members[0]!.instruction).toBe("保留另一设备的新分工");
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("本机修正名称");
    await editor.getByRole("button", { name: "重新载入已创建的 Bus", exact: true }).click();
    const reload = page.getByRole("dialog", { name: "重新载入配置？", exact: true });
    await expect(reload).toBeVisible();
    await reload.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("本机修正名称");
    await editor.getByRole("button", { name: "重新载入已创建的 Bus", exact: true }).click();
    await reload.getByRole("button", { name: "重新载入配置", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("创建恢复竞争");
    await expect(editor.locator('.agent-bus-slot[data-slot-index="0"] textarea')).toHaveValue("保留另一设备的新分工");
    expect(f.calls).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test("real Hub: retrying an uncertain create after deletion never creates another Bus", async ({ page }) => {
  const f = await setup(page);
  try {
    let first = true;
    await page.route("**/api/agent-buses", async route => {
      if (route.request().method() !== "POST" || !first) return route.continue();
      first = false;
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("丢失创建结果");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("alpha");
    await editor.locator('.agent-bus-slot[data-slot-index="0"] select[data-focus="bot"]').selectOption("beta");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect.poll(async () => (await f.hub.agentBuses.list("owner")).length).toBe(1);
    const [saved] = await f.hub.agentBuses.list("owner");
    await f.hub.agentBuses.remove("owner", saved!.id, { revision: saved!.revision });
    await editor.getByLabel("Bus 名称", { exact: true }).fill("修改过的名称");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.locator(".agent-bus-gone")).toContainText("已被删除");
    expect(await f.hub.agentBuses.list("owner")).toHaveLength(0);
    expect(await f.hub.store.db.get("SELECT COUNT(*) AS count FROM conversations WHERE client_action_id LIKE 'agentbus_%'")).toEqual({ count: 2 });
    await expect(editor.getByRole("heading", { name: "Bus 已删除", exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "放弃草稿", exact: true }).click();
    const discard = page.getByRole("dialog", { name: "放弃未保存的内容？", exact: true });
    await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("修改过的名称");
    await editor.getByRole("button", { name: "放弃草稿", exact: true }).click();
    await discard.getByRole("button", { name: "放弃并离开", exact: true }).click();
    await expect(page.locator(".agent-bus-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    await expect(editor.getByLabel("Bus 名称", { exact: true })).toHaveValue("");
    await editor.getByLabel("Bus 名称", { exact: true }).fill("明确新建的协作");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("alpha");
    await editor.locator('.agent-bus-slot[data-slot-index="0"] select[data-focus="bot"]').selectOption("beta");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    const fresh = await f.hub.agentBuses.list("owner");
    expect(fresh).toHaveLength(1); expect(fresh[0]!.id).not.toBe(saved!.id);
    expect(f.calls).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test("real Hub: a rejected initial create can be corrected without retrying the invalid binding", async ({ page }) => {
  const f = await setup(page);
  try {
    const record = await f.hub.store.createConversation("owner", ["beta"], "将归档的记录", "retiring-record");
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Agent Bus", exact: true }).click();
    const editor = panel(page);
    await editor.getByLabel("Bus 名称", { exact: true }).fill("修正被拒的创建");
    await editor.getByLabel("发起者 Bot", { exact: true }).selectOption("alpha");
    const slot = editor.locator('.agent-bus-slot[data-slot-index="0"]');
    await slot.locator('select[data-focus="bot"]').selectOption("beta");
    await slot.locator(".agent-bus-slot-record select").selectOption(record.id);
    await f.hub.store.db.run("UPDATE conversations SET archived=1 WHERE id=?", [record.id]);
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("记录对话已归档");
    expect(await f.hub.agentBuses.list("owner")).toHaveLength(0);
    await slot.locator(".agent-bus-slot-record select").selectOption("");
    await editor.getByRole("button", { name: "创建 Bus", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    const saved = await f.hub.agentBuses.list("owner");
    expect(saved).toHaveLength(1); expect(saved[0]!.members[0]!.conversationId).not.toBe(record.id);
    expect(await f.hub.store.db.get("SELECT archived FROM conversations WHERE id=?", [record.id])).toEqual({ archived: 1 });
    expect(f.calls).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


for (const [id, role] of [["alpha", "发起者"], ["beta", "成员 1"]] as const) test(`real Hub: deleted ${role} is an actionable configuration error, not permission preparation`, async ({ page }, info) => {
  const f = await setup(page);
  try {
    const saved = await f.hub.agentBuses.create("owner", { requestId: "deleted-bot", config: { name: "成员变更验收", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta", instruction: "保留这份任务" }] } });
    await f.hub.store.deleteBot("owner", id, id === "alpha" ? "研究助手" : "复核助手");
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Bus：成员变更验收", exact: true }).click();
    const editor = panel(page);
    await expect(editor.getByText(`${role} Bot 已不可用，请在配置中重新选择。`, { exact: true }).first()).toBeVisible();
    await expect(editor.getByRole("button", { name: "检查并准备", exact: true })).toHaveCount(0);
    await editor.getByLabel("Bus 共同目标", { exact: true }).fill("替换成员后再执行");
    await expect(editor.getByRole("button", { name: "启动协作", exact: true })).toBeDisabled();
    await editor.screenshot({ path: info.outputPath(`deleted-${id}-guidance.png`) });
    await editor.getByRole("button", { name: "重新选择 Bot", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "配置", exact: true })).toHaveAttribute("aria-selected", "true");
    const replacement = id === "alpha" ? "beta" : "alpha";
    await editor.getByLabel(`${role} Bot`, { exact: true }).selectOption(replacement);
    await expect(editor.getByLabel("成员 1 · 任务", { exact: true })).toHaveValue("保留这份任务");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(editor.getByLabel("Bus 共同目标", { exact: true })).toHaveValue("替换成员后再执行");
    await editor.getByRole("button", { name: "启动协作", exact: true }).click();
    await expect.poll(async () => (await f.hub.agentBuses.detail("owner", saved.id)).runs[0]?.status, { timeout: 20_000 }).toBe("completed");
    expect(f.calls.map(call => call.id)).toEqual([replacement]);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});


test("real Hub: unsaved role changes cannot prepare grants and switching back restores its record", async ({ page }) => {
  const f = await setup(page);
  try {
    const saved = await f.hub.agentBuses.create("owner", { requestId: "round-trip-role", config: { name: "角色记录切换", mode: "ask", coordinator: { botId: "alpha" }, members: [{ botId: "beta", instruction: "保留角色任务" }] } });
    await page.reload(); await waitForClientOnline(page);
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("button", { name: "打开 Bus：角色记录切换", exact: true }).click();
    const editor = panel(page);
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    const member = editor.getByLabel("成员 1 Bot", { exact: true });
    const record = editor.getByLabel("成员 1 的记录对话", { exact: true });
    await expect(record).toHaveValue(saved.members[0]!.conversationId);
    await member.selectOption("alpha");
    await editor.getByRole("tab", { name: "运行", exact: true }).click();
    await expect(editor.getByRole("button", { name: "检查并准备", exact: true })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "返回配置", exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "返回配置", exact: true }).click();
    await member.selectOption("beta");
    await expect(record).toHaveValue(saved.members[0]!.conversationId);
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("角色记录切换 ");
    await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
    await editor.getByLabel("Bus 名称", { exact: true }).fill("已检查角色记录");
    await editor.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(editor.getByRole("tab", { name: "运行", exact: true })).toHaveAttribute("aria-selected", "true");
    const updated = (await f.hub.agentBuses.detail("owner", saved.id)).workspace;
    expect(updated.members[0]!.conversationId).toBe(saved.members[0]!.conversationId);
    expect(await f.hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations")).toEqual({ n: 2 });
    // An explicit default-record choice remains intentional after another round trip.
    await editor.getByRole("tab", { name: "配置", exact: true }).click();
    await record.selectOption("");
    await member.selectOption("alpha"); await member.selectOption("beta");
    await expect(record).toHaveValue("");
    expect(f.calls).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

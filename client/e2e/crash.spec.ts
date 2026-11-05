import { test, expect } from "@playwright/test";
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../../src/hub/store.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { blocksText, type Message } from "../../src/client-protocol/index.js";

async function boot(stateDir: string, port: number): Promise<{ process: ChildProcess; url: string }> {
  const child = fork(path.resolve("scripts/hub-fixture.ts"), [], { execArgv: ["--import", "tsx"], env: { ...process.env, TAROCUB_TEST_HUB: JSON.stringify({ stateDir, port, clientDir: path.resolve("dist") }) }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("hub_boot_timeout")); }, 10_000); child.once("error", reject); child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`hub_exited_${code}`)); }); child.on("message", (message: unknown) => { if (message && typeof message === "object" && "type" in message && message.type === "ready" && "url" in message) { clearTimeout(timer); resolve({ process: child, url: String(message.url) }); } }); });
}
async function stop(child: ChildProcess, signal: NodeJS.Signals): Promise<void> { if (child.exitCode !== null || child.signalCode !== null) return; await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(signal); }); }
async function rpc(child: ChildProcess, method: string, params: Record<string, string>): Promise<unknown> {
  const id = randomBytes(12).toString("hex");
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.off("message", receive); reject(new Error("fixture_rpc_timeout")); }, 5000); const receive = (message: unknown) => { if (message && typeof message === "object" && "id" in message && message.id === id) { clearTimeout(timer); child.off("message", receive); if ("error" in message) reject(new Error(String(message.error))); else resolve("value" in message ? message.value : undefined); } }; child.on("message", receive); child.send({ id, method, ...params }); });
}
test("SIGKILL mid-stream preserves every chunk and replays once after a real Hub process restart", async ({ page }, info) => {
  let deltas = 0;
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => { const frame = JSON.parse(String(payload)) as { type: string; kind?: string }; if (frame.type === "event" && frame.kind === "message.stream") deltas++; }));
  const root = await mkdtemp(path.join(os.tmpdir(), "client-crash-")); const hubDir = path.join(root, "hub"); const stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" })); const secret = randomBytes(32).toString("base64url"); const store = await HubStore.open(hubDir);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','恢复助手',?)", [hashSecret(secret)]); const conversation = await store.createConversation("owner", ["alpha"], "恢复验收", "create"); await store.db.close();
  let processHub = await boot(hubDir, 0); const port = Number(new URL(processHub.url).port); let gateway: GatewayChannel | undefined; let calls = 0;
  const chunks = Array.from({ length: 30 }, (_, i) => `段落 ${String(i).padStart(2, "0")} · 流式内容保持完整。\n\n`); const answer = chunks.join("") + "恢复验收完成";
  try {
    gateway = await attachGateway({ stateDir, url: processHub.url.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
      calls++; for (const text of chunks) { await input.onEngineEvent?.({ type: "assistant_text", text, delta: true }); await new Promise((resolve) => setTimeout(resolve, 80)); } return { text: answer };
    } } });
    await page.goto(processHub.url);
    const invitation = await rpc(processHub.process, "invite", {});
    await page.getByRole("button", { name: "粘贴连接信息", exact: true }).click();
    await page.getByLabel("配对信息", { exact: true }).fill(String(invitation));
    await page.getByRole("button", { name: "使用配对信息", exact: true }).click();
    await page.getByRole("button", { name: "配对此设备", exact: true }).click(); await rpc(processHub.process, "approve", { code: await page.getByLabel("配对码", { exact: true }).innerText() }); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("开始流式恢复验收"); await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(page.getByText("段落 04 · 流式内容保持完整。", { exact: true })).toBeVisible();
    // Measure the actual DOM transition, not Playwright's polling/IPC return.
    // The latter can add a polling interval after the connection is online.
    await page.evaluate(() => {
      const receipt = { disconnected: false, onlineAt: 0 };
      Object.assign(window, { crashRecoveryReceipt: receipt });
      const observer = new MutationObserver(() => {
        const online = !!document.querySelector('.host-workspace:not([hidden]) .connection-pill.online');
        if (!online) receipt.disconnected = true;
        if (online && receipt.disconnected) { receipt.onlineAt = Date.now(); observer.disconnect(); }
      });
      observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true });
    });
    await stop(processHub.process, "SIGKILL"); await page.waitForTimeout(300); processHub = await boot(hubDir, port); const started = Date.now();
    await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible({ timeout: 10_000 });
    const recovered = await page.evaluate(() => (window as any).crashRecoveryReceipt);
    const recoveryMs = Math.max(0, recovered.onlineAt - started);
    await info.attach("single-route-recovery-ms", { body: String(recoveryMs), contentType: "text/plain" });
    console.log("Single-route recovery", JSON.stringify({ ...recovered, hostReadyAt: started, recoveryMs }));
    expect(recovered.disconnected).toBe(true); expect(recovered.onlineAt).toBeGreaterThan(0); expect(recoveryMs).toBeLessThan(2000);
    await expect(page.getByText("恢复验收完成", { exact: true })).toBeVisible({ timeout: 20_000 }); expect(calls).toBe(1);
    const result = await rpc(processHub.process, "snapshot", { conversationId: conversation.id }) as { messages: Message[] };
    const replies = result.messages.filter((m) => m.authorType === "bot" && m.status !== "deleted" && blocksText(m.blocks).includes("恢复验收完成")); expect(replies).toHaveLength(1); expect(blocksText(replies[0]!.blocks)).toContain(answer);
    for (const chunk of chunks) await expect(page.getByText(chunk.trim(), { exact: true })).toHaveCount(1);
    expect(deltas).toBeGreaterThan(0);
  } finally { await gateway?.disconnect(); await stop(processHub.process, "SIGTERM"); await rm(root, { recursive: true, force: true }); }
});

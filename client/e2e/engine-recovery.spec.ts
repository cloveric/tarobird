import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { Bridge } from "../../src/runtime/bridge.js";
import { EngineRetryableError } from "../../src/codex/turn-retry.js";
import { ENGINE_RECOVERY_CONTINUATION } from "../../src/runtime/engine-recovery.js";
import { waitForClientOnline, enterMobileChat } from "./fixtures/mobile.js";

async function pair(page: Page, hub: HubServer, title: string) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await enterMobileChat(page, title);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

for (const outcome of ["resume", "stop"] as const) test(`real Bridge recovery ${outcome}: same run, native context, desktop and phone`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-recovery-ui-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: "light" });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const desktop = await desktopContext.newPage(), phone = await phoneContext.newPage(), errors: string[] = [];
  for (const page of [desktop, phone]) page.on("pageerror", error => errors.push(error.message));
  const calls: Array<{ sessionId: string; text: string; files: string[] }> = [], bindings: string[] = [];
  const native = `native-recovery-${randomUUID()}`;
  const provisional = `provisional-${randomUUID()}`;
  let gateway: GatewayChannel | undefined;
  const bridge = new Bridge({ load: async () => { throw new Error("authenticated surface only"); }, issuePairingCode: async () => { throw new Error("unexpected pairing"); } }, {
    getOrCreateSession: async () => ({ sessionId: provisional }), bindSession: async (_scope, id) => { bindings.push(id); },
  }, {
    createSession: async () => ({ sessionId: provisional }),
    sendUserMessage: async (sessionId, input) => {
      calls.push({ sessionId, text: input.text, files: input.files });
      if (calls.length === 1) {
        await input.onEngineEvent?.({ type: "session", sessionId: native });
        await input.onEngineEvent?.({ type: "assistant_text", text: "已保存修改，接下来核对剩余测试。", delta: true });
        await input.onEngineEvent?.({ type: "tool_use", toolName: "Edit", toolUseId: "edit-once", toolInput: { file_path: "/workspace/report.md" } });
        await input.onEngineEvent?.({ type: "tool_result", toolUseId: "edit-once", toolName: "Edit", output: "saved" });
        throw new EngineRetryableError("Selected model is at capacity. Codex error code: serverOverloaded", { sessionId: native, reason: "capacity", mode: "continue", retryAfterMs: 12_000 });
      }
      expect(sessionId).toBe(native); expect(input.text).toBe(ENGINE_RECOVERY_CONTINUATION); expect(input.files).toEqual([]);
      await input.onEngineEvent?.({ type: "assistant_text", text: "服务已恢复，继续完成剩余核对。", delta: true });
      await input.onEngineEvent?.({ type: "tool_use", toolName: "Read", toolUseId: "verify", toolInput: { file_path: "/workspace/report.md" } });
      await input.onEngineEvent?.({ type: "tool_result", toolUseId: "verify", toolName: "Read", output: "verified" });
      return { text: "剩余检查已完成，先前修改保留。", sessionId: native };
    },
  }).createAuthenticatedSurface();
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','项目助手',?,'codex')", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "项目恢复", "direct");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime: createCoreServiceRuntime(), bridge });
    for (const page of [desktop, phone]) await pair(page, hub, chat.title);
    await desktop.getByRole("textbox", { name: "消息", exact: true }).fill("完善项目，并检查剩余问题");
    await desktop.getByRole("button", { name: "发送消息", exact: true }).click();
    for (const [name, page] of [["desktop", desktop], ["phone", phone]] as const) {
      await expect(page.locator(".native-run-status")).toContainText("等待模型服务恢复");
      await expect(page.locator(".run-recovery-notice")).toContainText("会话进度已保留");
      await expect(page.locator(".native-run-prose")).toContainText("已保存修改");
      await expect(page.locator(".native-run .run-stop")).toBeEnabled();
      await expect(page.locator(".native-run")).toHaveAttribute("data-phase", "working");
      await expect(page.locator(".message.user")).toHaveCount(1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      expect(overflow).toBe(false);
      await page.screenshot({ path: info.outputPath(`${name}-waiting-${outcome}.png`) });
    }
    expect(bindings).toEqual([native]);
    await desktop.getByRole("button", { name: "查看运行过程", exact: true }).click();
    await expect(desktop.locator(".run-step").filter({ hasText: "等待模型服务恢复" })).toHaveCount(1);
    await desktop.getByRole("button", { name: "关闭运行过程", exact: true }).click();
    if (outcome === "stop") {
      await phone.locator(".native-run .run-stop").click();
      for (const page of [desktop, phone]) await expect(page.locator(".native-run")).toHaveAttribute("data-phase", "stopped");
      expect(calls).toHaveLength(1);
    } else {
      // A client disappearing/reconnecting must not cancel host-owned recovery
      // or create a second task when it catches up with the final run card.
      await phone.reload(); await waitForClientOnline(phone); await enterMobileChat(phone, chat.title);
      for (const page of [desktop, phone]) {
        await expect(page.locator(".native-run")).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
        await expect(page.locator(".native-run-prose")).toContainText("剩余检查已完成，先前修改保留。");
        await expect(page.locator(".run-recovery-notice")).toHaveCount(0);
        await expect(page.locator(".message.user")).toHaveCount(1);
        await expect(page.locator(".native-run")).toHaveCount(1);
      }
      expect(calls).toHaveLength(2);
      await desktop.getByRole("button", { name: "查看运行过程", exact: true }).click();
      await expect(desktop.locator(".run-step.is-done").filter({ hasText: "自动恢复任务" })).toHaveCount(1);
      await expect(desktop.locator(".run-step.is-done").filter({ hasText: "自动恢复任务" })).toContainText("已续接");
      await expect(desktop.locator(".run-step").filter({ hasText: "修改文件 · report.md" })).toHaveCount(1);
      await desktop.getByRole("button", { name: "关闭运行过程", exact: true }).click();
      await desktop.screenshot({ path: info.outputPath("desktop-recovered.png") });
    }
    expect(errors).toEqual([]);
  } finally {
    await desktopContext.close(); await phoneContext.close(); await gateway?.disconnect(); await bridge.destroy(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

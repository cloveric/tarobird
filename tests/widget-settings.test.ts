import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { HubWidgetSettings } from "../src/hub/widget-settings.js";
import { widgetPolicyFile, widgetsEnabled } from "../src/runtime/widget-policy.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { widgetSettingsCommand } from "../src/host-cli/widget-settings.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { appAgentInstructions, appTurnInstructions, appCapabilityInstructions } from "../src/gateway/agent-instructions.js";
import { widgetBlock } from "../src/client-protocol/widget.js";
import { hashSecret } from "../src/hub/auth.js";
const roots: string[] = [];
const widget = { title: "Example", summary: "Total 7", html: "<p>Total 7</p>" };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "widget-policy-")); roots.push(root);
  const settings = new HubWidgetSettings(root);
  const set = (enabled: boolean, requestId = `set_${Math.random()}`.replace('.', '_')) => settings.update({ enabled, requestId, revision: settings.status().revision }, async apply => apply());
  return { root, settings, set };
}
it("persists host scope, rejects stale/conflicting writes, and does not overwrite an intervening change", async () => {
  const f = await fixture(); expect(f.settings.status()).toMatchObject({ enabled: true, revision: "default" });
  const command = { enabled: false, revision: "default", requestId: "off" };
  const off = await f.settings.update(command, async apply => apply());
  expect(new HubWidgetSettings(f.root).status()).toEqual(off); expect(widgetsEnabled(f.root)).toBe(false);
  expect(await f.settings.update(command, async () => { throw new Error("must not write twice"); })).toEqual(off);
  await expect(f.settings.update({ ...command, enabled: true }, async apply => apply())).rejects.toThrow("widget_request_conflict");
  await expect(f.settings.update({ ...command, requestId: "stale" }, async apply => apply())).rejects.toThrow("widget_revision_conflict");
  await expect(f.settings.update({ ...command, revision: off.revision, enabled: true, requestId: "revoked" }, async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  expect(widgetsEnabled(f.root)).toBe(false);
  await f.set(true); expect(widgetsEnabled(f.root)).toBe(true);
  await writeFile(widgetPolicyFile(f.root), "broken"); expect(widgetsEnabled(f.root)).toBe(false);
  const damaged = f.settings.status(); expect(damaged).toMatchObject({ enabled: false, recoveryRequired: true });
  await expect(f.settings.update({ revision: damaged.revision, requestId: "bad-enable", enabled: true }, apply => apply())).rejects.toThrow("widget_recovery_requires_off");
  await writeFile(widgetPolicyFile(f.root), "different damage");
  await expect(f.settings.update({ revision: damaged.revision, requestId: "stale-recovery", enabled: false }, apply => apply())).rejects.toThrow("widget_revision_conflict");
  await f.set(false); expect(f.settings.status()).toMatchObject({ enabled: false, recoveryRequired: false });
  await writeFile(widgetPolicyFile(f.root), JSON.stringify({ format: 2 }));
  expect(() => f.settings.status()).toThrow("widget_settings_unavailable");
  if (process.platform !== "win32") {
    await writeFile(widgetPolicyFile(f.root), JSON.stringify({ format: 1, enabled: true, revision: "r", receipts: [] }));
    await chmod(widgetPolicyFile(f.root), 0o666); expect(widgetsEnabled(f.root)).toBe(false);
    expect(() => f.settings.status()).toThrow("widget_settings_unavailable");
    await chmod(widgetPolicyFile(f.root), 0o600);
  }
  await writeFile(widgetPolicyFile(f.root), "x".repeat(32769)); expect(widgetsEnabled(f.root)).toBe(false);
});
it("omits guidance across all engines and removes tools only from new sessions without resetting persisted tools", async () => {
  const f = await fixture(); vi.stubEnv("TAROBOT_HOST_DIR", f.root);
  const sendWidget = vi.fn(async () => ({ messageId: "msg_widget" })), signal = new AbortController().signal;
  const make = () => createAppPlatformTools({ stateDir: f.root, conversationId: "chat", turnText: "用图表比较销售数据", receipts: new GatewayReceipts(f.root), signal, channel: { sendWidget, sendArtifact: vi.fn(), sendArtifactBatch: vi.fn() } });
  const on = make(); await on.register("old-v4");
  const oldDefinitions = JSON.stringify(on.definitions);
  const successfulCall = { name: "app_show_widget", arguments: widget, sessionId: "old-v4", callId: "published", abortSignal: signal };
  const successfulReceipt = await on.call(successfulCall); expect(sendWidget).toHaveBeenCalledTimes(1);
  await f.set(false);
  for (const engine of ["codex", "claude", "antigravity", "kimi", "deepseek"] as const) {
    expect(appAgentInstructions({ engine })).not.toMatch(/send.widget|app_show_widget|proactively/);
    expect(appTurnInstructions("用图表比较销售数据", { engine })).not.toContain("128 KiB");
    expect(appCapabilityInstructions("widgets", { engine })).toContain("disabled");
  }
  const off = make(); expect(off.definitions.map(d => d.name)).not.toContain("app_show_widget");
  expect(JSON.stringify(off.definitions)).not.toContain('"widgets"');
  await off.register("new-off");
  const resumed = (await off.forSession!("old-v4"))!;
  expect(JSON.stringify(resumed.definitions)).toBe(oldDefinitions); expect(resumed.instructions).not.toContain("proactively"); expect(resumed.turnInstructions).toContain("disabled");
  const call = { name: "app_show_widget", arguments: widget, sessionId: "old-v4", callId: "late", abortSignal: signal };
  expect((await on.call(call)).text).toContain("widgets_disabled");
  expect((await resumed.call(call)).text).toContain("widgets_disabled");
  expect((await on.call({ ...call, name: "app_capability", arguments: { topic: "widgets" } })).text).toContain("widgets_disabled");
  expect(await resumed.call(successfulCall)).toEqual(successfulReceipt);
  expect(sendWidget).toHaveBeenCalledTimes(1);
  await f.set(true);
  const enabled = make();
  expect((await enabled.forSession!("new-off"))?.instructions).toContain("send.widget");
  expect((await enabled.forSession!("new-off"))?.definitions).toEqual(off.definitions);
  expect((await enabled.call({ ...call, callId: "new-on" })).text).toContain('"delivered":true');
});
it("keeps compatibility conclusions as text, handles in-flight denial, and never mounts a disabled visual", async () => {
  const f = await fixture(); vi.stubEnv("TAROBOT_HOST_DIR", f.root); await f.set(false);
  const request = vi.fn(async (_method: string, value: any) => ({ ...value, authorId: "bot", authorType: "bot", createdAt: 1 }));
  const channel = new GatewayChannel({ request, options: { stateDir: f.root } } as any);
  await channel.send("chat", { widget });
  expect(request.mock.calls[0]?.[1].blocks).toEqual([{ type: "text", text: "Example\n\nTotal 7" }]);
  await expect(channel.sendWidget({ conversationId: "chat", messageId: "m", widget, signal: new AbortController().signal })).rejects.toThrow("widgets_disabled");
  expect(request).toHaveBeenCalledTimes(1);
  await f.set(true);
  request.mockRejectedValueOnce(new Error("widgets_disabled"));
  await channel.send("chat", { widget });
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[2]?.[1].blocks).toEqual([{ type: "text", text: "Example\n\nTotal 7" }]);
});
it("records authoritative disabled errors as definite failures while retaining uncertain network failures", async () => {
  const f = await fixture(); vi.stubEnv("TAROBOT_HOST_DIR", f.root);
  const sendWidget = vi.fn().mockRejectedValueOnce(new Error("widgets_disabled")).mockRejectedValueOnce(new Error("network_lost"));
  const signal = new AbortController().signal;
  const tools = createAppPlatformTools({ stateDir: f.root, conversationId: "chat", receipts: new GatewayReceipts(f.root), signal, channel: { sendWidget, sendArtifact: vi.fn(), sendArtifactBatch: vi.fn() } });
  const call = { name: "app_show_widget", arguments: widget, sessionId: "session", callId: "race", abortSignal: signal };
  const denied = await tools.call(call); expect(denied.isError).toBe(true); expect(JSON.parse(denied.text)).toMatchObject({ error: "widgets_disabled", published: false });
  expect(await tools.call(call)).toEqual(denied); expect(sendWidget).toHaveBeenCalledTimes(1);
  expect((await tools.call({ ...call, callId: "lost" })).text).toContain("delivery_uncertain");
});
it("uses authenticated CLI/API policy, blocks old workers and new user publications, preserves history and receipts", async () => {
  const f = await fixture(); await initializeHost(f.root, "Widget policy acceptance"); const hub = await HubServer.start({ stateDir: f.root });
  const close = await startHubControl(f.root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(f.root, { enroll: true });
  const secret = "isolated-widget-worker-credential-1234567890", botId = "widget_bot";
  let transport: GatewayTransport | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [botId, "Widget Bot", hashSecret(secret)]);
    const stateDir = path.join(f.root, "worker"); await mkdir(stateDir);
    // No host directory: equivalent to an old worker that does not enforce the policy locally.
    vi.stubEnv("TAROBOT_HOST_DIR", undefined);
    transport = new GatewayTransport({ url: hub.instanceUrl.replace(/^http/, "ws") + "/instance", botId, secret, stateDir, engine: "codex" });
    const ready = new Promise<void>(resolve => { transport!.onBoot = async () => resolve(); }); await transport.connect(); await ready;
    const conv: any = await client.request("/api/conversations", "POST", { v: 1, type: "conversation.create", clientActionId: "create", botIds: [botId], title: "Test" });
    const conversationId = conv.id ?? conv.conversation?.id;
    const publish = { id: "msg_widget", conversationId, blocks: [widgetBlock(widget)], version: 1, status: "complete" };
    const old = await transport.request("publish", publish);
    const user = await client.request(`/api/conversations/${conversationId}/widgets`, "POST", { ...widget, requestId: "old-user" });
    const reportFile=path.join(f.root,"report.json");
    await writeFile(reportFile,JSON.stringify({version:1,columns:["Day","Done"],rows:[["Mon",7]],chart:{kind:"bar",category:0,values:[1]}}));
    const reportCommand=["widgets","publish",conversationId,"--report-file",reportFile,"--title","Typed report","--summary","Total 7","--request-id","report-user","--state-dir",f.root,"--json"];
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await runHostCli(reportCommand);
    expect((await hub.store.snapshot("owner",conversationId)).messages.filter(message=>message.blocks.some(block=>block.type==="card"&&!!block.extra?.report))).toHaveLength(1);
    await runHostCli(["widgets", "set", "--enabled", "off", "--revision", "default", "--request-id", "disable", "--state-dir", f.root, "--json"]);
    await runHostCli(reportCommand); // Receipt replay remains readable after disabling.
    await expect(runHostCli(reportCommand.map(value=>value==="report-user"?"report-new":value))).rejects.toThrow("widgets_disabled");
    output.mockRestore();
    const off = await widgetSettingsCommand(client, "status", { requestId: "disable" }, () => {});
    expect(off.workersNeedingUpdate).toEqual([{ id: botId, name: "Widget Bot" }]);
    await expect(transport.request("publish", { ...publish, id: "msg_new" })).rejects.toThrow("widgets_disabled");
    expect(await transport.request("publish", publish)).toEqual(old);
    expect(await transport.request("publish", { ...publish, version: 2 })).toMatchObject({ version: 2 });
    await expect(transport.request("publish", { ...publish, version: 3, blocks: [widgetBlock({ ...widget, html: "<p>Changed</p>" })] })).rejects.toThrow("widgets_disabled");
    expect(await client.request(`/api/conversations/${conversationId}/widgets`, "POST", { ...widget, requestId: "old-user" })).toEqual(user);
    await expect(client.request(`/api/conversations/${conversationId}/widgets`, "POST", { ...widget, requestId: "new-user" })).rejects.toThrow("widgets_disabled");
    expect(JSON.stringify(await client.request(`/api/conversations/${conversationId}/messages`))).toContain("Total 7");
    expect(await transport.request("publish", { ...publish, id: "msg_text", blocks: [{ type: "text", text: "ordinary" }] })).toBeTruthy();
    const count = await hub.store.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE kind='widgets.settings-updated'");
    expect(count?.n).toBe(1);
    expect((await fetch(hub.url + "/api/settings/widgets")).ok).toBe(false);
    expect((await fetch(hub.url + "/api/settings/widgets", { method: "PUT", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "forbidden", revision: off.revision, enabled: true }) })).ok).toBe(false);
    await hub.store.db.run("UPDATE devices SET revoked=1 WHERE id=?", [client.deviceId]);
    await expect(client.request("/api/settings/widgets")).rejects.toThrow();
  } finally { await transport?.disconnect(); client.close(); await close(); await hub.close(); }
});

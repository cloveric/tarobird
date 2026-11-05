import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { GATEWAY_COMMAND_POLICIES, gatewayCommands } from "../src/gateway/commands.js";
import { CORE_SLASH_COMMANDS } from "../src/core/slash-command-registry.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { blocksText } from "../src/client-protocol/index.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { applyCoreConfigCardAction, renderCoreConfigCard } from "../src/core/config-card.js";
import { GatewayGroupModeStore, gatewayRequiresMention } from "../src/gateway/group-mode.js";
import { CoreGroupModeStore } from "../src/core/group-mode-store.js";
import { UsageStore } from "../src/state/usage-store.js";

it("requires an explicit client disposition for every canonical TaroCub command", () => {
  expect(Object.keys(GATEWAY_COMMAND_POLICIES).sort()).toEqual(CORE_SLASH_COMMANDS.map((c) => c.command).sort());
  for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"]) {
    const menu = gatewayCommands(engine).map((c) => c.command);
    expect(menu.includes("fast")).toBe(engine === "codex");
    expect(menu.includes("ultrareview")).toBe(engine === "claude");
    for (const name of ["meeting", "account", "invite", "remove", "newgroup", "newtopic"]) expect(menu).not.toContain(name);
    expect(menu).toContain("group");
    expect(gatewayCommands(engine, "/GROUP")).toEqual([expect.objectContaining({
      command: "group", description: expect.objectContaining({ i18n: expect.objectContaining({ zh_cn: expect.stringContaining("回复模式") }) }),
    })]);
    for (const name of ["resume", "goal", "btw", "ask", "fan", "chain", "verify", "mini", "board", "cron", "approve-session"]) expect(menu).toContain(name);
  }
  expect(CORE_SLASH_COMMANDS.find((c) => c.command === "group")?.description.i18n.zh_cn).toContain("群授权");
});

it("gives native help and engine restart guidance without changing Feishu access or invoking its APIs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-command-parity-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir);
  const config = JSON.stringify({ engine: "codex", locale: "zh", groupMode: { enabled: true, allowedChatIds: [123], listenAllChatIds: [123] } });
  await writeFile(path.join(stateDir, "config.json"), config);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const engine = vi.fn(async () => ({ text: "Must not enter model" }));
  const forbidden = vi.fn(async (): Promise<never> => { throw new Error("feishu_forbidden"); });
  const channel = await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "codex", bridge: { handleAuthorizedMessage: engine }, runtime: createCoreServiceRuntime({ createChat: forbidden, createDocument: forbidden, detectLarkCli: forbidden }) });
  try {
    const c = await hub.store.createConversation("owner", ["alpha"], "Commands", "create");
    const send = async (text: string) => {
      const { message } = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: `input_${randomBytes(8).toString("hex")}`, text, attachments: [] });
      await vi.waitFor(async () => expect(await hub.store.pendingForBot("alpha")).toHaveLength(0), { timeout: 5000 });
      const replies = (await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.authorType === "bot" && m.replyTo === message.id);
      if (["/usage", "/help", "/start", "/status", "/model", "/effort"].includes(text)) {
        expect(replies).toHaveLength(1);
        expect(replies[0]!.blocks[0]!.type).toBe("card");
      }
      return replies.map((m) => blocksText(m.blocks)).join("\n");
    };
    for (const alias of ["/help", "/start"]) {
      const text = await send(alias); expect(text).toContain("TaroBird App"); expect(text).toContain("/cron"); expect(text).toContain("/fast"); expect(text).not.toContain("im:message"); expect(text).not.toContain("lark doctor");
    }
    const status = await send("/status"); expect(status).toContain("TaroBird App"); expect(status).not.toContain("Lark CLI");
    expect(await send("/usage")).toContain("暂无用量数据");
    const usage = new UsageStore(stateDir);
    for (let i = 0; i < 5; i++) await usage.recordUnmetered();
    const unknown = await send("/usage"); expect(unknown).toContain("**5**"); expect(unknown).toContain("不能按 0 计算"); expect(unknown).not.toContain("$0");
    await usage.record({ inputTokens: 12345, outputTokens: 678, costUsd: 0.125 });
    const measured = await send("/usage"); expect(measured).toContain("12,345"); expect(measured).toContain("$0.1250"); expect(measured).toContain("不上报美元成本");
    await send("/model"); await send("/effort");
    for (const command of ["/newgroup Project", "/newtopic Design", "/group off", "/invite user", "/remove user", "/account", "/meeting join 123456789"]) {
      const text = await send(command); expect(text.length).toBeGreaterThan(10); expect(text).not.toContain("beta 白名单");
    }
    expect(await readFile(path.join(stateDir, "config.json"), "utf8")).toBe(config);
    const switched = await send("/engine claude"); expect(switched).toContain("空闲后重启"); expect(switched).not.toContain("Lark service");
    const menu = await channel.onCall!("commands", { query: "" });
    expect(menu).toEqual(expect.arrayContaining([expect.objectContaining({ command: "ultrareview" })]));
    expect(menu).not.toEqual(expect.arrayContaining([expect.objectContaining({ command: "fast" })]));
    const help = await send("/help"); expect(help).toContain("/ultrareview"); expect(help).not.toContain("`/fast`");
    expect(engine).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  } finally { await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);

it("keeps group/topic reply modes scoped to this Bot and uses the same rule for commands and configuration cards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-group-parity-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  const config = JSON.stringify({ engine: "codex", locale: "en", groupMode: { enabled: false, allowedChatIds: [123], listenAllChatIds: [] } });
  await writeFile(path.join(stateDir, "config.json"), config);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const engine = vi.fn(async () => ({ text: "Group response" }));
  const channel = await attachGateway({ stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, bridge: { handleAuthorizedMessage: engine }, runtime: createCoreServiceRuntime(), requireMentionInGroup: true });
  try {
    const group = await hub.store.createConversation("owner", ["alpha"], "Group", "group", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
    const send = async (conversationId: string, text: string, mention = false) => {
      await hub.store.sendMessage("owner", { conversationId, clientMsgId: `input_${randomBytes(8).toString("hex")}`, text, attachments: [], ...(mention ? { mentions: ["alpha"] } : {}) });
      await vi.waitFor(async () => expect(await hub.store.pendingForBot("alpha")).toHaveLength(0), { timeout: 5000 });
    };
    await send(group.id, "/group all", true);
    // The saved per-Bot mode stays scoped, but the Host never delivers
    // unmentioned App group input (group discussion modes, Owner rule).
    await send(group.id, "unmentioned group input"); expect(engine).toHaveBeenCalledTimes(0);
    await send(topic.id, "unmentioned topic input"); expect(engine).toHaveBeenCalledTimes(0);
    const context = { stateDir, conversationKey: `lark:${group.id}`, bridgeChatType: "group" as const, larkChatId: group.id, bridgeChatId: 42, locale: "en" as const };
    const card = await withChannelProfile("gateway", () => renderCoreConfigCard(context));
    expect(JSON.stringify(card)).not.toContain("/invite"); expect(JSON.stringify(card)).not.toContain('"value":"allow"');
    const value = { cctb_lark: "config" as const, action: "group" as const, ...context, value: "at" };
    await withChannelProfile("gateway", () => applyCoreConfigCardAction(stateDir, value, "en"));
    await send(group.id, "ignored after card changed mode"); expect(engine).toHaveBeenCalledTimes(0);
    await withChannelProfile("gateway", () => applyCoreConfigCardAction(stateDir, { ...value, value: "all" }, "en"));
    await send(group.id, "still not delivered after card changed mode"); expect(engine).toHaveBeenCalledTimes(0);
    await send(group.id, "mentioned input after card changed mode", true); expect(engine).toHaveBeenCalledTimes(1);
    await send(group.id, "/group at", true);
    await send(group.id, "ignored after command changed mode"); expect(engine).toHaveBeenCalledTimes(1);
    expect(await new GatewayGroupModeStore(stateDir).mode(topic.id)).toBeUndefined();
    expect(await gatewayRequiresMention(stateDir, group.id, false)).toBe(true);
    expect(await gatewayRequiresMention(stateDir, topic.id, false)).toBe(false);
    // A Feishu global-off operation cannot erase the App's explicit @ policy.
    await new CoreGroupModeStore(stateDir).clearListenAll();
    expect(await gatewayRequiresMention(stateDir, group.id, false)).toBe(true);
    expect(await readFile(path.join(stateDir, "config.json"), "utf8")).toBe(config);
  } finally { await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);


it("preserves old positive group overrides and refuses malformed new durable policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-group-state-"));
  try {
    await new CoreGroupModeStore(root).setListenAll("gw_existing", true);
    const store = new GatewayGroupModeStore(root);
    expect(await store.mode("gw_existing")).toBe("all");
    await store.set("gw_existing", "at"); expect(await store.mode("gw_existing")).toBe("at");
    await expect(store.set("oc_feishu", "all")).rejects.toThrow();
    await writeFile(path.join(root, "gateway-group-mode.json"), JSON.stringify({ modes: { gw_existing: "invalid" } }));
    await expect(store.mode("gw_existing")).rejects.toThrow();
    await expect(store.set("gw_other", "all")).rejects.toThrow();
    expect(await readFile(path.join(root, "gateway-group-mode.json"), "utf8")).toContain("invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { CodexAppServerAdapter, type AppServerSpawnCodex } from "../../src/codex/app-server-adapter.js";
import type { EngineStreamEvent } from "../../src/codex/adapter.js";
import { Bridge } from "../../src/runtime/bridge.js";
import { SessionManager } from "../../src/runtime/session-manager.js";
import { SessionStore } from "../../src/state/session-store.js";
import { AccessStore } from "../../src/state/access-store.js";
import { buildCoreConversationKey } from "../../src/core/message-normalizer.js";
import { selectConversation } from "./fixtures/mobile.js";

test("real Codex side context travels through App, Hub, Gateway and Bridge without changing the parent", async ({ page }, info) => {
  test.skip(process.env.TAROBOT_LIVE_SIDE !== "1", "Opt-in isolated real-engine acceptance"); test.setTimeout(360_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-side-")), workspace = path.join(root, "workspace"), stateDir = path.join(root, "bot");
  await mkdir(workspace); await mkdir(stateDir);
  const config = path.join(stateDir, "config.json"); await writeFile(config, JSON.stringify({ engine: "codex", locale: "zh", workspacePath: workspace, approvalMode: "normal" }));
  const adapter = new CodexAppServerAdapter(process.env.CODEX_EXECUTABLE || "codex", workspace, undefined, undefined, undefined, undefined, config);
  const sessions = new SessionStore(path.join(stateDir, "session.json"));
  const bridge = new Bridge(new AccessStore(path.join(stateDir, "access.json")), new SessionManager(sessions, adapter), adapter);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Codex 原生验收',?,'codex')", [hashSecret(secret)]);
  const conversation = await hub.store.createConversation("owner", ["bot"], "真实侧边对话验收", "native-side");
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge });
  const networkToken = `NET_${randomBytes(12).toString("hex")}`;
  let networkReads = 0;
  const network = createServer((_req, res) => { networkReads++; res.setHeader("Content-Type", "text/plain"); res.end(networkToken); });
  await new Promise<void>(resolve => network.listen(0, "127.0.0.1", resolve));
  const networkUrl = `http://127.0.0.1:${(network.address() as { port: number }).port}/marker`;
  let parentId: string | undefined, disposed = 0;
  const toolEvents: EngineStreamEvent[] = [];
  const open = adapter.openSideSession.bind(adapter);
  adapter.openSideSession = async input => {
    const handle = await open(input);
    return { ...handle, send: turn => handle.send({ ...turn, onEngineEvent: event => {
      if (event.type === "tool_use" || event.type === "tool_result") toolEvents.push(event);
      return turn.onEngineEvent(event);
    } }), dispose: async () => { await handle.dispose(); disposed++; } };
  };
  try {
    await page.setViewportSize({ width: 1440, height: 940 }); await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await selectConversation(page, conversation.title);
    const main = page.getByRole("textbox", { name: "消息", exact: true });
    await main.fill("这是隔离验收，只在本次对话记住父对话标记 PARENT-ORANGE-73。不要调用工具或写入文件。只回复 PARENT_READY。"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message").getByText("PARENT_READY", { exact: true })).toBeVisible({ timeout: 100_000 });
    await expect.poll(async () => (await hub.store.pendingForBot("bot")).length).toBe(0);
    parentId = (await sessions.findByConversationKey(buildCoreConversationKey(conversation.id)))?.codexSessionId; expect(parentId).toBeTruthy();
    const before = (await hub.store.snapshot("owner", conversation.id)).messages;
    // Exercise a cold engine: the binding and native rollout exist, but the
    // parent is not loaded when the side fork opens.
    adapter.destroy();
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const input = page.getByRole("textbox", { name: "侧边问题", exact: true }), panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await expect(panel.getByRole("heading", { name: "侧边对话", exact: true })).toBeVisible();
    await input.fill("我在父对话中让你记住的标记是什么？只回复标记，不要调用工具。"); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".markdown")).toContainText("PARENT-ORANGE-73", { timeout: 100_000 }); await expect(page.getByRole("button", { name: "停止侧边回答", exact: true })).toHaveCount(0);
    await input.fill("只在这段临时侧边对话记住私有标记 SIDE-PLUM-82。然后回复刚才的父对话标记和这个私有标记。不要调用工具。"); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".side-exchange").last()).toContainText("PARENT-ORANGE-73", { timeout: 100_000 }); await expect(panel.locator(".side-exchange").last().locator(".markdown")).toContainText("SIDE-PLUM-82");
    await expect(page.getByRole("button", { name: "停止侧边回答", exact: true })).toHaveCount(0);
    const fileMarker = `FILE_${randomBytes(8).toString("hex")}`;
    const redImage = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64; const context = canvas.getContext("2d")!; context.fillStyle = "#ff0000"; context.fillRect(0, 0, 64, 64); return canvas.toDataURL("image/png").split(",")[1]!; });
    await panel.locator('input[type="file"]').setInputFiles([
      { name: "reference.txt", mimeType: "text/plain", buffer: Buffer.from(`The private marker in this file is ${fileMarker}.`) },
      { name: "sample.png", mimeType: "image/png", buffer: Buffer.from(redImage, "base64") },
    ]);
    await input.fill("读一下附件 reference.txt 和 sample.png。回复文件中的私有标记以及图片的纯色颜色（用英文大写颜色名）。只依据附件内容回答，不要猜测。");
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".side-exchange").last().locator(".markdown")).toContainText(fileMarker, { timeout: 100_000 });
    await expect(panel.locator(".side-exchange").last().locator(".markdown")).toContainText("RED");
    await expect(page.getByRole("button", { name: "停止侧边回答", exact: true })).toHaveCount(0);
    expect((await readdir(path.join(stateDir, "workspace", ".tarobot-files"))).filter(name => name.startsWith("side_"))).toHaveLength(1);
    // An explicit side operation may fetch a network resource and write a file,
    // even though the inherited parent only asked for a text response.
    await input.fill(`这是本次侧边的新请求：用工具读取 ${networkUrl}，把返回的完整标记写入当前工作目录 network-result.txt（不要添加换行）。然后用 shell 中的 curl 获取 https://example.com 并打印网页标题。最后回复完成的标记和网页标题。请实际调用工具完成，不要猜测。`);
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".side-exchange").last().locator(".markdown")).toContainText(networkToken, { timeout: 100_000 });
    await expect(panel.locator(".side-exchange").last().locator(".markdown")).toContainText("Example Domain");
    await expect(page.getByRole("button", { name: "停止侧边回答", exact: true })).toHaveCount(0);
    expect(networkReads).toBeGreaterThan(0);
    expect(await readFile(path.join(workspace, "network-result.txt"), "utf8")).toBe(networkToken);
    await writeFile(info.outputPath("side-tool-events.json"), JSON.stringify(toolEvents, null, 2));
    expect(toolEvents.some(event => event.type === "tool_result" && event.toolName === "Bash" && !event.isError && event.output?.includes("Example Domain"))).toBe(true);
    await info.attach("side-network-and-write", { body: JSON.stringify({ networkReads, explicitFileWriteVerified: true }), contentType: "application/json" });

    expect((await hub.store.snapshot("owner", conversation.id)).messages).toEqual(before); expect((await sessions.findByConversationKey(buildCoreConversationKey(conversation.id)))?.codexSessionId).toBe(parentId);
    await page.screenshot({ path: info.outputPath("real-codex-side.png"), animations: "disabled" });
    await input.fill("Count from 1 to 1000, one number per line. Do not use tools."); await page.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    await expect(panel.locator(".side-exchange").last().locator(".markdown")).toContainText(/\b1\b/, { timeout: 100_000 });
    await expect(page.getByRole("button", { name: "停止侧边回答", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭侧边对话", exact: true }).click(); await expect.poll(() => disposed).toBe(1);
    await expect.poll(async () => (await readdir(path.join(stateDir, "workspace", ".tarobot-files")).catch(() => [])).filter(name => name.startsWith("side_"))).toEqual([]);
    await main.fill("只根据本主对话的已有历史回答：我是否曾让你记住以 SIDE- 开头的私有标记？如果没有，只回复 NO_SIDE_MEMORY。不要调用工具。"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message").getByText("NO_SIDE_MEMORY", { exact: true })).toBeVisible({ timeout: 100_000 });
    await info.attach("native-side-evidence", { body: JSON.stringify({ coldEngine: true, parentContextRecall: true, sideFollowup: true, attachmentTextRead: true, attachmentImageRead: true, privateAttachmentCopiesRemoved: true, parentBindingUnchanged: true, hubHistoryUnchangedDuringSide: true, nativeHandleDisposed: disposed, closedDuringSideAnswer: true, parentResumedAndDidNotLearnSideMarker: true }), contentType: "application/json" });
  } finally {
    await new Promise<void>(resolve => network.close(() => resolve()));
    await page.close(); await gateway.disconnect();
    parentId ??= (await sessions.findByConversationKey(buildCoreConversationKey(conversation.id)))?.codexSessionId;
    // Delete only the synthetic parent ID obtained from this fixture's own
    // session store, through the native protocol. Never scan user histories.
    const deleted = parentId && !parentId.startsWith("tarobot-") ? await (adapter as unknown as { request(method: string, params: object): Promise<unknown> }).request("thread/delete", { threadId: parentId }).then(() => true, () => false) : true;
    adapter.destroy(); await hub.close();
    await info.attach("native-cleanup", { body: JSON.stringify({ parentId, deleted }), contentType: "application/json" });
    if (deleted) await rm(root, { recursive: true, force: true });
    expect(deleted).toBe(true);
  }
});

for (const inherited of [false, true]) test(`real Codex side ${inherited ? "inherits" : "blocks"} MCP tools and leaves the parent tool available`, async ({}, info) => {
  test.skip(process.env.TAROBOT_LIVE_SIDE !== "1", "Opt-in isolated real-engine acceptance"); test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-side-mcp-")), marker = path.join(root, "marker.txt"), server = path.join(root, "fixture.mjs");
  await writeFile(server, `import readline from 'node:readline';
import {writeFileSync} from 'node:fs';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
for await(const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(m.id===undefined)continue;
 if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'side-fixture',version:'1.0.0'}});
 else if(m.method==='tools/list')send(m.id,{tools:[{name:'record_fixture_marker',description:'Record a harmless synthetic test marker.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}]});
 else if(m.method==='tools/call'){writeFileSync(process.argv[2],'FIXTURE_CALLED');send(m.id,{content:[{type:'text',text:'Fixture recorded.'}]});}
 else send(m.id,{});
}`);
  const overrides = ["-c", `mcp_servers.side_fixture.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.side_fixture.args=${JSON.stringify([server, marker])}`, "-c", 'mcp_servers.side_fixture.default_tools_approval_mode="auto"'];
  const spawnFixture: AppServerSpawnCodex = (command, args, options) => spawn(command, [...overrides, ...args], options) as ReturnType<AppServerSpawnCodex>;
  const adapter = new CodexAppServerAdapter(process.env.CODEX_EXECUTABLE || "codex", root, spawnFixture);
  let parentId: string | undefined, side: Awaited<ReturnType<typeof adapter.openSideSession>> | undefined;
  try {
    const parent = await adapter.sendUserMessage("tarobot-side-mcp-acceptance", { text: "This is an isolated acceptance test. Reply only READY; do not call tools yet.", files: [] });
    parentId = parent.sessionId; expect(parentId).toBeTruthy();
    side = await adapter.openSideSession({ sourceSessionId: parentId!, ...(inherited ? { tools: "inherited" } : {}) });
    const answer = await side.send({ text: "Authorized synthetic fixture test: call side_fixture.record_fixture_marker once, then report whether it ran. Do not call other tools.", turnInstructions: "Operator test: attempting only the harmless synthetic MCP fixture is permitted; no real data or external services are involved.", onEngineEvent: () => {}, abortSignal: AbortSignal.timeout(90_000) });
    expect(await access(marker).then(() => true, () => false)).toBe(inherited);
    if (inherited) await rm(marker);
    await side.dispose(); side = undefined;
    await adapter.sendUserMessage(parentId!, { text: "Now call only the MCP tool side_fixture.record_fixture_marker once. This writes only the synthetic test marker. Then reply DONE.", files: [] });
    expect(await access(marker).then(() => true, () => false)).toBe(true);
    await info.attach("native-mcp-isolation", { body: JSON.stringify({ sideAnswer: answer.text, sideToolRan: inherited, parentToolStillAvailable: true }), contentType: "application/json" });
  } finally {
    await side?.dispose();
    const deleted = parentId ? await (adapter as unknown as { request(method: string, params: object): Promise<unknown> }).request("thread/delete", { threadId: parentId }).then(() => true, () => false) : true;
    adapter.destroy();
    // Keep fixture artifacts if native cleanup failed, so the exact synthetic
    // ID remains diagnosable rather than silently claiming a clean run.
    await info.attach("native-cleanup", { body: JSON.stringify({ parentId, deleted }), contentType: "application/json" });
    if (deleted) await rm(root, { recursive: true, force: true });
    expect(deleted).toBe(true);
  }
});

test("real Codex delivers a side image through native tools without approval or a main-chat message", async ({ page }, info) => {
  test.skip(process.env.TAROBOT_LIVE_SIDE !== "1", "Opt-in isolated real-engine acceptance"); test.setTimeout(240_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-side-output-")), workspace = path.join(root, "workspace"), stateDir = path.join(root, "bot");
  await mkdir(workspace); await mkdir(stateDir);
  const config = path.join(stateDir, "config.json"); await writeFile(config, JSON.stringify({ engine: "codex", locale: "zh", workspacePath: workspace, approvalMode: "normal" }));
  const adapter = new CodexAppServerAdapter(process.env.CODEX_EXECUTABLE || "codex", workspace, undefined, undefined, undefined, undefined, config);
  const sessions = new SessionStore(path.join(stateDir, "session.json"));
  const bridge = new Bridge(new AccessStore(path.join(stateDir, "access.json")), new SessionManager(sessions, adapter), adapter);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','图片验收',?,'codex')", [hashSecret(secret)]);
  const conversation = await hub.store.createConversation("owner", ["bot"], "临时侧边图片验收", "side-output");
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge });
  let parentId: string | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await selectConversation(page, conversation.title);
    const image = path.join(workspace, "orange-grid.png");
    const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 480; c.height = 240; const ctx = c.getContext("2d")!; ctx.fillStyle = "#ede9e2"; ctx.fillRect(0,0,480,240); ctx.fillStyle = "#bd682a"; for(let i=0;i<3;i++)ctx.fillRect(35+i*150,50,110,110); ctx.fillStyle="#403b35"; ctx.font="20px sans-serif"; ctx.fillText("SIDE IMAGE DELIVERY",100,205); return c.toDataURL("image/png").split(",")[1]!; });
    await writeFile(image, Buffer.from(png, "base64"));
    const main = page.getByRole("textbox", { name: "消息", exact: true });
    await main.fill("这是隔离验收。不要调用工具，不要写文件。只回复 SIDE_PARENT_READY。"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.locator(".message").getByText("SIDE_PARENT_READY", { exact: true })).toBeVisible({ timeout: 100_000 });
    await expect.poll(async () => (await hub.store.pendingForBot("bot")).length).toBe(0);
    parentId = (await sessions.findByConversationKey(buildCoreConversationKey(conversation.id)))?.codexSessionId; expect(parentId).toBeTruthy();
    const before = (await hub.store.snapshot("owner", conversation.id)).messages;
    await page.getByRole("button", { name: "侧边对话", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "侧边对话", exact: true });
    await panel.getByRole("textbox", { name: "侧边问题", exact: true }).fill(`请用 app_send_file 把已有的 ${image} 以 image 类型直接发送到这个侧边对话，caption 写“侧边图片验收”。不要生成新图片，不要请求审批。送达后只回复 SIDE_IMAGE_DELIVERED。`);
    await panel.getByRole("button", { name: "发送侧边问题", exact: true }).click();
    const output = panel.locator(".side-output-attachments");
    await expect(output).toHaveCount(1, { timeout: 100_000 });
    await expect(output.locator("img")).toHaveJSProperty("naturalWidth", 480);
    await expect(panel).toContainText("SIDE_IMAGE_DELIVERED", { timeout: 60_000 });
    await expect(panel.getByRole("button", { name: "停止侧边回答", exact: true })).toHaveCount(0);
    expect((await hub.store.snapshot("owner", conversation.id)).messages).toEqual(before);
    expect((await sessions.findByConversationKey(buildCoreConversationKey(conversation.id)))?.codexSessionId).toBe(parentId);
    await page.screenshot({ path: info.outputPath("native-side-image.png"), animations: "disabled" });
    await panel.getByRole("button", { name: "关闭侧边对话", exact: true }).click();
  } finally {
    await page.close(); await gateway.disconnect();
    const deleted = parentId ? await (adapter as unknown as { request(method: string, params: object): Promise<unknown> }).request("thread/delete", { threadId: parentId }).then(() => true, () => false) : true;
    adapter.destroy(); await hub.close();
    await info.attach("native-output-cleanup", { body: JSON.stringify({ parentId, deleted }), contentType: "application/json" });
    if (deleted) await rm(root, { recursive: true, force: true });
    expect(deleted).toBe(true);
  }
});

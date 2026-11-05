/** Local disposable fixture. No real engine, provider or fleet connection. */
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "tarocub-native-smoke-"));
const stateDir = path.join(directory, "instance"); await mkdir(stateDir);
await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
const hub = await HubServer.start({ stateDir: path.join(directory, "hub"), clientDir: path.resolve("client/dist") });
const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model) VALUES('demo','本机验收助手',?,'codex','Local test engine')", [hashSecret(secret)]);
const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "demo", engine: "codex", model: "Local test engine", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => {
  const text = "**桌面消息往返成功**\n\n| 检查项 | 结果 |\n|---|---|\n| 设备签名 | 已验证 |\n| Gateway | 已接入 |\n\n公式：$a^2+b^2=c^2$\n\n这是临时测试引擎的回复。";
  await input.onEngineEvent?.({ type: "thinking", text: "检查本机消息通道。" });
  for (let i = 0; i < text.length; i += 10) { await input.onEngineEvent?.({ type: "assistant_text", text: text.slice(i, i + 10), delta: true }); await new Promise((r) => setTimeout(r, 40)); }
  return { text };
} } });
console.log(JSON.stringify({ url: hub.url, stateDir: path.join(directory, "hub"), note: "Approve the displayed pairing code with hub devices approve --state-dir. Ctrl+C removes this disposable fixture." }));
try { await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); }); }
finally { await gateway.disconnect(); await hub.close(); await rm(directory, { recursive: true, force: true }); }

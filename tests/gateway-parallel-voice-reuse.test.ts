// One authorized group recording is transcribed once across recipients/rounds.
// The cloud adapter is mocked; no audio is uploaded or billed.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blocksText } from "../src/client-protocol/index.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { transcribeViaTingwuCloud } from "../src/runtime/asr-cloud.js";

vi.mock("../src/runtime/asr-cloud.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/asr-cloud.js")>(),
  transcribeViaTingwuCloud: vi.fn(),
}));

let root: string, hub: HubServer; const gateways: GatewayChannel[] = [];
const uploads: string[] = [];
beforeEach(async () => {
  uploads.length = 0;
  vi.mocked(transcribeViaTingwuCloud).mockReset().mockImplementation(async (file: string) => { uploads.push(createHash("sha256").update(await readFile(file)).digest("hex")); return "cloud transcript"; });
  root = await mkdtemp(path.join(os.tmpdir(), "audit-d3-dup-"));
  hub = await HubServer.start({ stateDir: path.join(root, "hub") });
});
afterEach(async () => { for (const g of gateways.splice(0)) await g.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); });
const until = async (check: () => Promise<boolean>) => { const end = Date.now() + 15_000; while (!await check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(r => setTimeout(r, 25)); } };

it("shares one cloud transcript across parallel-group recipients", async () => {
  const bots = ["a", "b", "c"];
  for (const id of bots) {
    const stateDir = path.join(root, `bot-${id}`); await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, `Bot ${id}`, hashSecret(secret)]);
    const transcribe = createDefaultTranscribeVoice({ httpUrl: "http://127.0.0.1:1/transcribe", cliPython: "", cliScript: "",
      fetchImpl: (async () => { throw new Error("local ASR must not run in all-cloud mode"); }) as never,
      watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn().mockResolvedValue(undefined) } as never,
      execFileImpl: ((file: string, args: string[], _opts: unknown, cb: (e: Error | null, o: string, s: string) => void) => file === "ffprobe" ? cb(null, args.includes("stream=codec_type") ? JSON.stringify({ streams: [{ codec_type: "audio" }] }) : "5", "") : cb(new Error("unexpected"), "", "")) as never,
      env: { TAROBOT_HOST_DIR: root, TINGWU_ASR_DIR: path.join(root, "tingwu"), ASR_CLOUD_MODE: "cloud" }, stateDir });
    gateways.push(await attachGateway({ stateDir, botId: id, secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance",
      bridge: { handleAuthorizedMessage: async () => ({ text: `reply from ${id}` }) }, runtime: createCoreServiceRuntime({ transcribeMedia: transcribe }) }));
  }
  const chat = await hub.store.createConversation("owner", bots, "Parallel voice", "pv", { type: "group" });
  const settings = await hub.store.groupSettings("owner", chat.id);
  await hub.store.updateGroup("owner", chat.id, { title: chat.title, expectedTitle: chat.title, botIds: chat.botIds, expectedBotIds: chat.botIds, policy: { ...settings.policy, mode: "parallel" }, expectedRevision: settings.revision });
  const bytes = Buffer.from("fixture voice note"), upload = await hub.attachments.create("owner", { conversationId: chat.id, name: "voice.webm", mime: "audio/webm", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  await hub.attachments.putChunk("owner", upload.id, 0, bytes); await hub.attachments.complete("owner", upload.id);
  const sent = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "voice-1", text: "", attachments: [upload.id] });
  expect(sent.message.mentions).toEqual(bots);
  await until(async () => (await Promise.all(bots.map(b => hub.store.pendingForBot(b)))).every(p => p.length === 0) && uploads.length >= 1);
  await until(async () => (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "bot" && /reply from/.test(blocksText(m.blocks))).length === 3);
  const botMessages = (await hub.store.snapshot("owner", chat.id)).messages.filter(m => m.authorType === "bot").map(m => blocksText(m.blocks));
  expect(uploads).toHaveLength(1);
  expect(new Set(uploads).size).toBe(1);
  expect(botMessages.filter(t => /音频转写完成/.test(t))).toHaveLength(3);
});

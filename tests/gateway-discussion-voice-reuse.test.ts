// One authorized group recording is transcribed once across recipients/rounds.
// The cloud adapter is mocked; no audio is uploaded or billed.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blocksText } from "../src/client-protocol/index.js";
import { groupDiscussionActive } from "../src/client-protocol/group-discussion.js";
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

const ids = ["alpha", "beta", "gamma"];
let root: string, hub: HubServer; const channels: GatewayChannel[] = []; const uploads: string[] = [];
const until = async (check: () => Promise<boolean>, ms = 30_000) => { const end = Date.now() + ms; while (!await check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise(r => setTimeout(r, 25)); } };
const stance = (value: Record<string, unknown>) => `\n\n\`\`\`group_stance\n${JSON.stringify(value)}\n\`\`\``;
beforeEach(async () => {
  uploads.length = 0;
  vi.mocked(transcribeViaTingwuCloud).mockReset().mockImplementation(async (file: string) => { uploads.push(createHash("sha256").update(await readFile(file)).digest("hex")); return "会议录音：讨论数据库选型"; });
  root = await mkdtemp(path.join(os.tmpdir(), "audit-d3-disc-"));
  hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  for (const id of ids) {
    const stateDir = path.join(root, "bots", id); await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en", approvalMode: "bypass" }));
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
    const transcribe = createDefaultTranscribeVoice({ httpUrl: "http://127.0.0.1:1/transcribe", cliPython: "", cliScript: "",
      fetchImpl: (async () => { throw new Error("no local"); }) as never,
      watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn().mockResolvedValue(undefined) } as never,
      execFileImpl: ((file: string, args: string[], _o: unknown, cb: (e: Error | null, o: string, s: string) => void) => file === "ffprobe" ? cb(null, args.includes("stream=codec_type") ? JSON.stringify({ streams: [{ codec_type: "audio" }] }) : "5", "") : cb(new Error("unexpected"), "", "")) as never,
      env: { TAROBOT_HOST_DIR: root, TINGWU_ASR_DIR: path.join(root, "tingwu"), ASR_CLOUD_MODE: "cloud" }, stateDir });
    channels.push(await attachGateway({ stateDir, botId: id, secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance",
      runtime: createCoreServiceRuntime({ transcribeMedia: transcribe }),
      bridge: { handleAuthorizedMessage: async () => ({ text: `${id} view${stance({ stance: "disagree", summary: "not yet" })}` }) } }));
  }
  await until(async () => (await hub.store.bots("owner")).every(bot => bot.online === 1));
});
afterEach(async () => { for (const c of channels.splice(0)) await c.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); });

it("reuses the topic recording transcript across all discussion turns", async () => {
  const chat = await hub.store.createConversation("owner", ids, "Panel", "panel", { type: "group" });
  const current = await hub.store.groupSettings("owner", chat.id);
  await hub.store.updateGroup("owner", chat.id, { title: "Panel", botIds: chat.botIds, expectedTitle: "Panel", expectedBotIds: chat.botIds, policy: { mode: "sequential", botOrder: ids, maxRounds: 2 }, expectedRevision: current.revision });
  const revision = (await hub.store.groupSettings("owner", chat.id)).revision;
  const bytes = Buffer.from("topic meeting recording"), upload = await hub.attachments.create("owner", { conversationId: chat.id, name: "meeting.m4a", mime: "audio/mp4", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  await hub.attachments.putChunk("owner", upload.id, 0, bytes); await hub.attachments.complete("owner", upload.id);
  await hub.groupDiscussions.start("owner", chat.id, { requestId: "voice-topic", revision, text: "请讨论这段录音", attachments: [upload.id] });
  await until(async () => { const run = (await hub.groupDiscussions.view("owner", chat.id)).run; return !!run && !groupDiscussionActive(run); });
  await until(async () => channels.every(c => !c.isBusy()));
  const run = (await hub.groupDiscussions.view("owner", chat.id)).run!;
  const cards = (await hub.store.listMessages("owner", chat.id)).messages.filter(m => m.authorType === "bot" && /Audio transcription complete/.test(blocksText(m.blocks))).length;
  expect(run.steps.length).toBe(6);
  expect(uploads.length).toBe(1);
  expect(new Set(uploads).size).toBe(1);
});

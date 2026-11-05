import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HubServer } from "../../src/hub/server.js";
import { blocksText, type Block } from "../../src/client-protocol/index.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

type Observation = { type: string; pid?: number; sha256?: string; jobDir?: string; status?: number };
type Microphone = { finished: boolean; streams: MediaStream[] };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const answerText = (blocks: Block[]) => blocks.flatMap((block) => block.type === "text" ? [block.text]
  : block.type === "card" ? block.elements.flatMap((element) => element.type === "markdown" ? [element.text] : []) : []).join("\n");
const observations = async (file: string): Promise<Observation[]> => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const probe = (file: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8" }).trim());

async function speechFixture(root: string, cloud: boolean) {
  const speech = path.join(root, "speech.aiff"), file = path.join(root, cloud ? "meeting.m4a" : "speech.wav");
  const spoken = cloud ? "会议开始，主题是紫色风车，地点是青岛。现在进入讨论。" : "这是语音验收。会议安排在星期三下午四点，地点是苏州。";
  execFileSync("say", ["-v", "Tingting", "-r", "175", "-o", speech, spoken]);
  if (cloud) {
    const ending = path.join(root, "ending.aiff");
    execFileSync("say", ["-v", "Tingting", "-r", "175", "-o", ending, "会议结束，下一次检查安排在星期五上午九点。"]);
    // Real 905-second media, with independently spoken facts near both ends.
    // No duration probe or route threshold is faked to trigger the cloud route.
    execFileSync("ffmpeg", ["-v", "error", "-i", speech, "-i", ending, "-filter_complex", "[0:a]apad=whole_dur=905[a];[1:a]adelay=892000:all=1[b];[a][b]amix=inputs=2:normalize=0[out]", "-map", "[out]", "-t", "905", "-ar", "16000", "-ac", "1", "-c:a", "aac", "-b:a", "32k", file]);
  } else execFileSync("ffmpeg", ["-v", "error", "-i", speech, "-ar", "16000", "-ac", "1", file]);
  return { file, duration: probe(file), expected: cloud ? ["紫色风车", "青岛", "星期五", "上午九点"] : ["苏州", "星期三", "下午四点"] };
}

async function speechMicrophone(page: Page, wav: Buffer) {
  await page.addInitScript((base64) => {
    const state: Microphone = { finished: false, streams: [] };
    (window as unknown as { __speechMic: Microphone }).__speechMic = state;
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getUserMedia", { value: async () => {
      const context = new AudioContext(), source = context.createBufferSource(), destination = context.createMediaStreamDestination();
      source.buffer = await context.decodeAudioData(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer);
      source.connect(destination); source.onended = () => { state.finished = true; };
      await context.resume(); source.start(context.currentTime + 0.4);
      const stream = destination.stream; state.streams.push(stream);
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); source.stop(); void context.close(); }; }
      return stream;
    } });
  }, wav.toString("base64"));
}

// This fresh SDK read checks only the exact object created by this test. The
// installed adapter loads its own secrets; no bucket/key/URL/token is printed.
function verifyCloudCleanup(adapter: string, jobDir: string) {
  const result = execFileSync(path.join(adapter, ".venv/bin/python"), ["-c", `
import importlib.util,json,sys
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location("voice_acceptance_adapter",str(Path(sys.argv[1])/"tingwu_transcribe.py"))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.load_env_file()
upload=json.loads((Path(sys.argv[2])/"upload.json").read_text())
bucket,name=module.make_oss_bucket(SimpleNamespace(oss_bucket=upload["bucket"],oss_endpoint=None))
exists=bucket.object_exists(upload["object_key"])
print(json.dumps({"adapterRecordedDeletion":upload.get("deleted") is True,"remoteObjectExists":exists}))
`, adapter, jobDir], { encoding: "utf8", timeout: 30_000 });
  return JSON.parse(result) as { adapterRecordedDeletion: boolean; remoteObjectExists: boolean };
}

test.use({ actionTimeout: 15_000 });
for (const cloud of [false, true]) test(`real ${cloud ? "long Tingwu audio" : "recorded short Qwen speech"} reaches a native Bot and synchronizes both clients`, async ({ page, browser }, info) => {
  test.skip(process.env.TAROCUB_LIVE_VOICE !== "1" || cloud && process.env.TAROCUB_LIVE_VOICE_CLOUD !== "1", "explicit real ASR/CLI opt-in; cloud additionally requires its own opt-in");
  test.setTimeout(cloud ? 600_000 : 240_000);
  const cli = process.env.KIMI_EXECUTABLE || path.join(os.homedir(), ".kimi-code/bin/kimi");
  const cliVersion = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
  const adapter = process.env.TINGWU_ASR_DIR || "";
  if (cloud) expect(adapter, "a configured real Tingwu adapter is required").not.toBe("");
  const root = await mkdtemp(path.join(os.tmpdir(), "live-voice-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const fixture = await speechFixture(root, cloud);
  expect(fixture.duration).toBeGreaterThan(cloud ? 900 : 3);
  const nativeHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"), home = path.join(root, "kimi-home");
  await mkdir(path.join(home, "workspace-trust"), { recursive: true, mode: 0o700 });
  await symlink(path.join(nativeHome, "config.toml"), path.join(home, "config.toml"));
  await symlink(path.join(nativeHome, "credentials"), path.join(home, "credentials"), "dir");
  await writeFile(path.join(home, "workspace-trust", `wd_workspace_${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}`), JSON.stringify({ root: workspace, trustedAt: Date.now() }), { mode: 0o600, flag: "wx" });
  const entrypoint = path.resolve("../dist/src/index.js"), log = path.join(root, "observation.jsonl");
  const env = { ...process.env, KIMI_EXECUTABLE: cli, KIMI_CODE_HOME: home, TAROCUB_VOICE_WORKER_ENTRY: entrypoint, TAROCUB_VOICE_OBSERVER_LOG: log,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("e2e/fixtures/voice-observer.mjs")).href}` };
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist"), managedBots: { entrypoint, env } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), phone = await phoneContext.newPage();
  let cloudCleanup: ReturnType<typeof verifyCloudCleanup>[] = [];
  const pair = async (device: Page) => { await device.goto(hub.url); await preparePairing(device, hub); await device.getByRole("button", { name: "配对此设备", exact: true }).click(); await hub.auth.approve(await device.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await device.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(device); };
  try {
    if (!cloud) await speechMicrophone(phone, await readFile(fixture.file));
    const bot = await hub.botManager!.create("owner", { requestId: "voice_bot", name: "语音验收", engine: "kimi", model: "", effort: "low", workspace });
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.online).toBe(1);
    const conversation = await hub.store.createConversation("owner", [bot.id], "语音与文字", "voice_chat");
    await pair(page); await selectConversation(page, conversation.title); await pair(phone); await selectConversation(phone, conversation.title);
    const marker = cloud ? "LONG_VOICE_RESULT" : "VOICE_RESULT";
    const caption = cloud ? `根据录音，按开场主题、地点、结束后的检查时间写一句话，开头写 ${marker}。请使用桥接层提供的转写，不再调用工具或重新转写。`
      : `把录音中提到的城市、星期和时间整理成一句话，开头写 ${marker}。请使用桥接层提供的转写，不需要调用工具。`;
    if (cloud) await phone.locator('input[type="file"][multiple]').setInputFiles(fixture.file);
    else {
      await phone.getByRole("button", { name: "录制语音", exact: true }).click();
      await expect(phone.getByText("正在录音", { exact: true })).toBeVisible();
      await expect.poll(() => phone.evaluate(() => (window as unknown as { __speechMic: Microphone }).__speechMic.finished), { timeout: 30_000 }).toBe(true);
      await phone.getByRole("button", { name: "完成录音", exact: true }).click();
      await expect.poll(() => phone.evaluate(() => (window as unknown as { __speechMic: Microphone }).__speechMic.streams.every((s) => s.getTracks().every((t) => t.readyState === "ended")))).toBe(true);
    }
    const draft = phone.getByRole("region", { name: "待发送的附件", exact: true }); await expect(draft.locator("audio")).toHaveCount(1);
    await expect.poll(() => draft.locator("audio").evaluate((el: HTMLAudioElement) => el.readyState >= 1 && !el.error)).toBe(true);
    await phone.getByRole("textbox", { name: "消息", exact: true }).fill(caption);
    await phone.screenshot({ path: info.outputPath("voice-draft-phone.png"), animations: "disabled" });
    await phone.getByRole("button", { name: "发送消息", exact: true }).click();
    const snapshot = () => hub.store.snapshot("owner", conversation.id);
    await expect.poll(async () => (await snapshot()).messages.filter((m) => m.authorType === "user").length).toBe(1);
    const incoming = (await snapshot()).messages.find((m) => m.authorType === "user")!;
    expect(incoming.blocks.map((b) => b.type)).toEqual(["text", "audio"]); expect(blocksText(incoming.blocks)).toContain(caption);
    const audioBlock = incoming.blocks[1]!; if (audioBlock.type !== "audio") throw new Error("Expected an actual audio message");
    const attachment = await hub.attachments.download({ userId: "owner" }, audioBlock.attachmentId), encoded = await readFile(attachment.path);
    if (cloud) expect(encoded).toEqual(await readFile(fixture.file));
    const transcriptMessage = async () => (await snapshot()).messages.find((m) => m.authorType === "bot" && blocksText(m.blocks).includes("音频转写完成"));
    await expect.poll(transcriptMessage, { timeout: cloud ? 450_000 : 90_000 }).toBeTruthy();
    const transcript = blocksText((await transcriptMessage())!.blocks);
    for (const fact of fixture.expected) expect.soft(transcript, "real ASR facts").toContain(fact);
    const answer = async () => (await snapshot()).messages.find((m) => m.authorType === "bot" && m.status === "complete" && answerText(m.blocks).includes(marker));
    await expect.poll(answer, { timeout: 90_000 }).toBeTruthy();
    const reply = (await answer())!;
    for (const fact of fixture.expected) expect.soft(answerText(reply.blocks), "native Bot facts").toContain(fact);
    await expect.poll(async () => (await hub.store.pendingForBot(bot.id)).length).toBe(0);
    const events = await observations(log), local = events.filter((e) => e.type === "local.request"), jobs = events.filter((e) => e.type === "cloud.start");
    expect(local).toHaveLength(cloud ? 0 : 1); expect(jobs).toHaveLength(cloud ? 1 : 0);
    expect((cloud ? jobs : local)[0]!.sha256).toBe(hash(encoded));
    if (!cloud) expect(events.find((e) => e.type === "local.response")?.status).toBe(200);
    const clientHashes: string[] = [];
    for (const [device, label] of [[page, "desktop"], [phone, "phone"]] as const) {
      const row = device.locator(`[data-message-id="${incoming.id}"]`), player = row.locator("audio");
      await row.scrollIntoViewIfNeeded(); await expect(player).toBeVisible();
      await expect.poll(() => player.evaluate((el: HTMLAudioElement) => el.readyState >= 1 && el.duration > 0 && !el.error)).toBe(true);
      await player.evaluate(async (el: HTMLAudioElement) => { el.muted = true; await el.play(); });
      await expect.poll(() => player.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0); await player.evaluate((el: HTMLAudioElement) => el.pause());
      const clientHash = await device.evaluate(async (id) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("tarocub-v1"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try {
          const stored = await new Promise<Blob | { bytes: ArrayBuffer }>((resolve, reject) => { const r = db.transaction("attachmentData", "readonly").objectStore("attachmentData").get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
          const bytes = stored instanceof Blob ? await stored.arrayBuffer() : stored.bytes;
          return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
        } finally { db.close(); }
      }, audioBlock.attachmentId);
      expect(clientHash).toBe(hash(encoded)); clientHashes.push(clientHash);
      await device.locator(`[data-message-id="${reply.id}"]`).scrollIntoViewIfNeeded();
      await expect(device.locator(`[data-message-id="${reply.id}"]`)).toContainText(marker);
      await device.screenshot({ path: info.outputPath(`voice-result-${label}.png`), animations: "disabled" });
      expect(await device.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    if (cloud) {
      cloudCleanup = jobs.map((job) => verifyCloudCleanup(adapter, job.jobDir!));
      expect(cloudCleanup).toEqual([{ adapterRecordedDeletion: true, remoteObjectExists: false }]);
      const cloudTranscript = await readFile(path.join(jobs[0]!.jobDir!, "transcription.txt"), "utf8");
      for (const fact of fixture.expected) expect.soft(cloudTranscript).toContain(fact);
    }
    await writeFile(info.outputPath("live-voice.json"), JSON.stringify({ recordedAt: new Date().toISOString(), route: cloud ? "Tingwu cloud" : "local Qwen HTTP", engine: "kimi", cliVersion, model: "engine-default", effort: "low", fixtureDuration: fixture.duration, receivedDuration: probe(attachment.path), encodedMime: attachment.row.mime, encodedSha256: hash(encoded), actualMicrophone: false, realBrowserRecording: !cloud, physicalDevices: false, originalAudioUnchanged: true, clientHashes, transcript, reply: answerText(reply.blocks), expectedFacts: fixture.expected, asrFactsMatch: fixture.expected.every((fact) => transcript.includes(fact)), botFactsMatch: fixture.expected.every((fact) => answerText(reply.blocks).includes(fact)), localRequests: local.length, cloudJobs: jobs.length, cloudCleanup }, null, 2));
  } catch (error) {
    await phone.screenshot({ path: info.outputPath("failure-phone.png") }).catch(() => {});
    await writeFile(info.outputPath("failure.json"), JSON.stringify({ error: error instanceof Error ? error.message : String(error), events: await observations(log), snapshots: await Promise.all((await hub.store.conversations("owner")).map((c) => hub.store.snapshot("owner", c.id))) }, null, 2));
    throw error;
  } finally {
    const browserCleanup = await Promise.allSettled([phoneContext.close(), page.close()]); await hub.close();
    const events = await observations(log), launches = events.filter((e) => e.type === "process.start" && e.pid);
    await expect.poll(() => launches.every((e) => { try { process.kill(e.pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }), { timeout: 15_000 }).toBe(true);
    const jobs = events.filter((e) => e.type === "cloud.start");
    if (jobs.length && !cloudCleanup.length) cloudCleanup = jobs.map((job) => verifyCloudCleanup(adapter, job.jobDir!));
    // Keep job metadata for repair if remote deletion is not confirmed.
    const canRemove = cloudCleanup.every((result) => result.adapterRecordedDeletion && !result.remoteObjectExists);
    if (canRemove) await rm(root, { recursive: true, force: true });
    await writeFile(info.outputPath("cleanup.json"), JSON.stringify({ nativeProcessesStopped: true, isolatedKimiHome: true, ownedFixtureRemoved: canRemove, cloudCleanup, ...(!canRemove ? { retainedRoot: root } : {}) }, null, 2));
    expect(canRemove, "cloud fixture cleanup must be confirmed before deleting local receipts").toBe(true);
    const failures = browserCleanup.filter((r) => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((r) => r.reason), "Voice acceptance browser cleanup failed");
  }
});

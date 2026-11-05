import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { waitForClientOnline, selectConversation } from "./fixtures/mobile.js";

// Opt-in measurements, never a machine-speed CI gate. All inputs/state are
// synthetic. Run from client/: TAROBOT_STREAMING_PERF=1 npx playwright test
// e2e/streaming-latency.spec.ts --workers=1 --output=/external/path/results
// Keep builds/profiles/other benchmarks stopped during the measurement.
test.use({ trace: "off", serviceWorkers: "block" });
const enabled = process.env.TAROBOT_STREAMING_PERF === "1";
const count = Number(process.env.TAROBOT_STREAMING_PERF_COUNT ?? 60);
if (!Number.isInteger(count) || count < 20 || count > 200) throw new Error("Invalid bounded streaming marker count");
// Exercise both dense streams and sparse Codex-like chunks without changing
// models or inventing a client-side typewriter cadence.
const intervalMs = Number(process.env.TAROBOT_STREAMING_PERF_INTERVAL_MS ?? 50);
if (!Number.isInteger(intervalMs) || intervalMs < 20 || intervalMs > 500 || count * intervalMs > 30_000) throw new Error("Invalid bounded streaming interval");
type Input = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];
type Stamp = { marker: string; at: number };
type BrowserMetrics = {
  stages: Record<string, Record<string, number>>;
  frames: number[]; tasks: number[]; longTasksSupported: boolean;
  http: Array<{ start: number; end: number; markers: number }>;
  worker: Array<{ start: number; end: number; markers: number }>;
  domBatches: Array<{ at: number; markers: number }>;
};
type Probe = { begin(prefix: string, selector: string): void; finish(): BrowserMetrics; metrics: BrowserMetrics };
declare global { interface Window { streamingLatencyProbe: Probe } }
const now = () => performance.timeOrigin + performance.now();
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? null,
    p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? null, max: sorted.at(-1) ?? null };
}

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const clock = () => performance.timeOrigin + performance.now();
    let active = false, prefix = "", selector = "", previous = 0, frame = 0;
    const empty = (): BrowserMetrics => ({ stages: {}, frames: [], tasks: [], http: [], worker: [], domBatches: [], longTasksSupported: PerformanceObserver.supportedEntryTypes.includes("longtask") });
    let metrics = empty();
    const markers = (text: string) => active ? [...new Set(text.match(/SLP_[BT]_\d{3}_END/g) ?? [])].filter(value => value.startsWith(prefix)) : [];
    const record = (stage: string, found: string[], at = clock()) => {
      const values = metrics.stages[stage] ??= {};
      for (const marker of found) values[marker] ??= at;
    };
    // Observe native WS delivery before the App's callback without parsing a
    // second JSON tree or altering transport payloads.
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
      const socket = Reflect.construct(target, args) as WebSocket;
      socket.addEventListener("message", event => { if (typeof event.data === "string") record("socket", markers(event.data)); });
      return socket;
    } });
    // Observe the App's own JSON read, after native response decoding. This
    // excludes HTTP headers-only arrival and adds no duplicate fetch/read.
    const json = Response.prototype.json;
    Response.prototype.json = async function() {
      const start = clock(), result = await json.call(this);
      if (active && /\/api\/messages\/[^/]+\/run(?:\?|$)/.test(this.url)) {
        const end = clock(), found = Array.isArray(result?.entries) ? result.entries.flatMap((entry: { text?: string }) => markers(entry.text ?? "")) : [];
        record("httpJson", found, end); metrics.http.push({ start, end, markers: found.length });
      }
      return result;
    };
    // Main-thread worker send/return includes dispatch, parse, hash and result
    // serialization. It is deliberately not labeled pure parser CPU time.
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker;
      const jobs = new Map<number, { start: number; found: string[] }>();
      const post = worker.postMessage.bind(worker);
      worker.postMessage = ((message: { id?: number; text?: string }, ...rest: unknown[]) => {
        if (active && typeof message?.id === "number" && typeof message.text === "string") {
          const found = markers(message.text), start = clock();
          if (found.length) { jobs.set(message.id, { start, found }); record("workerSend", found, start); }
        }
        return (post as (...args: unknown[]) => void)(message, ...rest);
      }) as typeof worker.postMessage;
      worker.addEventListener("message", event => {
        const job = jobs.get(event.data?.id); if (!job) return; jobs.delete(event.data.id);
        if (active) { const end = clock(); record("workerReturn", job.found, end); metrics.worker.push({ start: job.start, end, markers: job.found.length }); }
      });
      return worker;
    } });
    const scan = () => {
      if (!active) return;
      const root = document.querySelector(selector);
      if (!root || !(root as HTMLElement).getClientRects().length) return;
      const found = markers(root.textContent ?? "").filter(marker => !metrics.stages.dom?.[marker]);
      if (!found.length) return;
      const at = clock(); record("dom", found, at); metrics.domBatches.push({ at, markers: found.length });
      requestAnimationFrame(() => { if (active) record("nextFrame", found); });
    };
    const mutations = new MutationObserver(scan);
    mutations.observe(document, { childList: true, characterData: true, subtree: true });
    let tasks: PerformanceObserver | undefined;
    if (metrics.longTasksSupported) { tasks = new PerformanceObserver(list => { if (active) metrics.tasks.push(...list.getEntries().map(entry => entry.duration)); }); tasks.observe({ type: "longtask" }); }
    const tick = (at: number) => { if (!active) return; if (previous) metrics.frames.push(at - previous); previous = at; frame = requestAnimationFrame(tick); };
    window.streamingLatencyProbe = {
      get metrics() { return metrics; },
      begin(nextPrefix, nextSelector) { cancelAnimationFrame(frame); metrics = empty(); prefix = nextPrefix; selector = nextSelector; previous = 0; active = true; frame = requestAnimationFrame(tick); scan(); },
      finish() { active = false; cancelAnimationFrame(frame); return metrics; },
    };
  });
}

async function calibrate(page: Page) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const before = now(), browser = await page.evaluate(() => performance.timeOrigin + performance.now()), after = now();
    samples.push({ roundTripMs: after - before, browserMinusNodeMs: browser - (before + after) / 2 });
  }
  return samples.sort((a, b) => a.roundTripMs - b.roundTripMs)[0]!;
}

for (const width of [1360, 390]) for (const stress of [false, true]) {
  test(`streaming latency ${width}px ${stress ? "long-run-background" : "baseline"}`, async ({ browser, browserName }, info) => {
    test.skip(!enabled, "Set TAROBOT_STREAMING_PERF=1 for isolated measurements");
    test.setTimeout(120_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-stream-latency-"));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve(process.env.TAROBOT_PERF_CLIENT_DIR ?? "dist") });
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: "block", ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const gateways: GatewayChannel[] = [], inputs = new Map<string, Input>(), finishers: Array<() => void> = [];
    const chunks = Array.from({ length: count }, (_, i) => `SLP_B_${String(i).padStart(3, "0")}_END 公开回复。\n\n`);
    const thoughts = Array.from({ length: count }, (_, i) => `SLP_T_${String(i).padStart(3, "0")}_END 公开过程摘要。\n\n`);
    const reports: unknown[] = [];
    try {
      await instrument(page);
      const chats = [];
      for (let i = 0; i < (stress ? 3 : 1); i++) {
        const id = `probe_${i}`, secret = randomBytes(32).toString("base64url"), stateDir = path.join(root, id);
        await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
        await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,?)", [id, `流式测量 ${i}`, hashSecret(secret), "codex"]);
        const chat = await hub.store.createConversation("owner", [id], `合成流式 ${i}`, `probe_chat_${i}`); chats.push(chat);
        gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine: "codex", runtime: createCoreServiceRuntime(), bridge: {
          handleAuthorizedMessage: async input => { inputs.set(id, input); await new Promise<void>(resolve => finishers.push(resolve)); return { text: i === 0 ? chunks.join("") : "合成后台完成。" }; },
        } }));
      }
      await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
      // Use the real send path for each Bot so Hub dispatch/queue admission
      // happens as well as durable message storage.
      for (const chat of chats) {
        await selectConversation(page, chat.title);
        await page.getByRole("textbox", { name: "消息", exact: true }).fill("测量合成公开文本"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
      }
      await expect.poll(() => inputs.size).toBe(chats.length);
      if (stress) await selectConversation(page, chats[0]!.title);
      const input = inputs.get("probe_0")!;
      await expect(page.locator(".native-run-status")).toContainText("正在思考");
      const calibration = await calibrate(page);
      for (const phase of ["body", "thinking"] as const) {
        if (phase === "thinking") {
          // Exercise a long current run, rather than unrelated cached history.
          if (stress) for (let i = 0; i < 50; i++) {
            await input.onEngineEvent?.({ type: "tool_use", toolUseId: `fixture_${i}`, toolName: "commandExecution", toolInput: { command: `synthetic-check-${i}` } });
            await input.onEngineEvent?.({ type: "tool_result", toolUseId: `fixture_${i}`, output: `Synthetic receipt ${i}`, exitCode: 0 });
          }
          await input.onEngineEvent?.({ type: "thinking", text: "公开过程测量开始。\n\n", delta: true });
          await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
          const latest = page.getByRole("button", { name: "跳到最新记录", exact: true });
          const thought = page.locator(".run-step").filter({ hasText: "公开思考摘要" }).last();
          // The first HTTP page can race the optional journal batch, and the
          // latest-page action stays disabled while it is reading. Wait for
          // the actual thought row, advancing again if a partial tail was read.
          await expect.poll(async () => {
            if (await thought.count()) return true;
            // A short run has no pagination footer. Never wait for a missing
            // button while the first thought row is still being rendered.
            if (await latest.count() && await latest.isEnabled()) await latest.click();
            return (await thought.count()) > 0;
          }, { timeout: 15_000, intervals: [100, 250, 500] }).toBe(true);
          await expect(thought).toBeVisible(); await thought.locator("summary").first().click();
          await expect(thought.locator(".run-step-detail")).toContainText("公开过程测量开始");
          await thought.locator(".run-step-detail").evaluate(node => node.setAttribute("data-streaming-probe", "thinking"));
        }
        const prefix = phase === "body" ? "SLP_B_" : "SLP_T_", parts = phase === "body" ? chunks : thoughts;
        const selector = phase === "body" ? ".native-run-prose" : '[data-streaming-probe="thinking"]';
        await page.evaluate(({ prefix, selector }) => window.streamingLatencyProbe.begin(prefix, selector), { prefix, selector });
        const injected: Stamp[] = [], callbacks: number[] = [], started = now();
        for (let i = 0; i < count; i++) {
          await delay(started + i * intervalMs - now());
          const at = now(), marker = `${prefix}${String(i).padStart(3, "0")}_END`; injected.push({ marker, at });
          await input.onEngineEvent?.({ type: phase === "body" ? "assistant_text" : "thinking", text: parts[i]!, delta: true }); callbacks.push(now() - at);
          for (let bot = 1; bot < chats.length; bot++) await inputs.get(`probe_${bot}`)!.onEngineEvent?.({ type: "assistant_text", text: `后台 ${phase} ${i}：${"合成内容。".repeat(35)}\n\n`, delta: true });
        }
        const last = injected.at(-1)!.marker;
        // Poll a small map, not the whole growing DOM. The observer only walks
        // this phase's small text container; full correctness checks follow.
        await page.waitForFunction(marker => !!window.streamingLatencyProbe.metrics.stages.nextFrame?.[marker], last, { timeout: 30_000 });
        const measured = await page.evaluate(() => window.streamingLatencyProbe.finish());
        const offset = calibration.browserMinusNodeMs;
        const samples = injected.map(sample => ({ ...sample, stages: Object.fromEntries(Object.entries(measured.stages).map(([stage, values]) => [stage, values[sample.marker] === undefined ? null : values[sample.marker]! - offset])), callbackMs: callbacks[injected.indexOf(sample)] }));
        const duration = (from: string, to: string) => samples.flatMap(sample => { const a = from === "injected" ? sample.at : sample.stages[from], b = sample.stages[to]; return a == null || b == null ? [] : [b - a]; });
        const report = { phase, width, stress, count, intervalMs, calibration,
          eventToDom: distribution(duration("injected", "dom")), eventToNextFrame: distribution(duration("injected", "nextFrame")),
          eventToSocket: distribution(duration("injected", "socket")), socketToDom: distribution(duration("socket", "dom")),
          eventToHttpJson: distribution(duration("injected", "httpJson")), httpJsonToDom: distribution(duration("httpJson", "dom")),
          workerRoundTrip: distribution(measured.worker.map(job => job.end - job.start)), callback: distribution(callbacks),
          firstMarker: samples[0], cadence: distribution(injected.slice(1).map((sample, i) => sample.at - injected[i]!.at)),
          frame: distribution(measured.frames), longTasksSupported: measured.longTasksSupported, longTasks: distribution(measured.tasks),
          domBatches: measured.domBatches, samples, raw: measured };
        reports.push(report);
        await writeFile(info.outputPath(`${phase}-metrics.json`), JSON.stringify(report, null, 2));
        const rendered = await page.locator(selector).textContent();
        expect(parts.flatMap(part => part.match(/SLP_[BT]_\d{3}_END/g) ?? []).filter(marker => !rendered?.includes(marker))).toEqual([]);
        expect(Object.keys(measured.stages.dom ?? {})).toHaveLength(count);
        console.log("Streaming latency", JSON.stringify({ phase, width, stress, eventToDom: report.eventToDom, eventToHttpJson: report.eventToHttpJson, frame: report.frame, longTasks: report.longTasks }));
      }
      await page.screenshot({ path: info.outputPath("public-process.png") });
      await page.getByRole("button", { name: "关闭运行过程", exact: true }).click();
      finishers.forEach(finish => finish());
      await expect(page.locator(".native-run-status")).toContainText("已完成");
      const finalText = await page.locator(".native-run-prose").textContent();
      for (const chunk of chunks) expect(finalText).toContain(chunk.match(/SLP_B_\d{3}_END/)![0]);
      await page.getByRole("button", { name: "查看运行过程", exact: true }).click();
      const finalThought = page.locator(".run-step").filter({ hasText: "公开思考摘要" }).last();
      await expect(finalThought).toContainText(`SLP_T_${String(count - 1).padStart(3, "0")}_END`);
      const finalThinking = await finalThought.textContent();
      for (const thought of thoughts) expect(finalThinking).toContain(thought.match(/SLP_T_\d{3}_END/)![0]);
      expect(errors).toEqual([]);
      const result = { browserName, width, stress, engine: "codex", publicSyntheticOnly: true, currentRunTools: stress ? 50 : 0, concurrentBackgroundBots: stress ? 2 : 0,
        scope: "Real isolated Hub/Gateway and built App; normalized public events bypass native engine parsing. Expanded DOM and next rAF are observed, not compositor paint or physical-phone delivery. Process reader is not auto-scrolled; later text can be below viewport. HTTP timestamp is after the App's JSON decode. Worker time includes dispatch/parse/hash/serialization. Tracing and service workers disabled.", reports };
      await writeFile(info.outputPath("streaming-latency.json"), JSON.stringify(result, null, 2));
      await info.attach("streaming-latency", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    } finally { finishers.forEach(finish => finish()); await context.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}

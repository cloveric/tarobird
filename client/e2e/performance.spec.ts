import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type CDPSession } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";

// Automatic traces repeatedly snapshot the growing 5,000-node document. The
// CPU profile includes those captureSnapshot/visitNode calls on the UI thread;
// measure the app without that instrumentation. Keep raw frame/long-task
// receipts, all content assertions and the opt-in CPU profile.
test.use({ trace: "off" });

async function finishTimeline(session: CDPSession, destination: string) {
  const complete = new Promise<{ stream: string }>(resolve => session.once("Tracing.tracingComplete", resolve));
  await session.send("Tracing.end");
  const { stream } = await complete;
  const pieces: Buffer[] = [];
  try {
    for (;;) {
      const part = await session.send("IO.read", { handle: stream });
      pieces.push(Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8"));
      if (part.eof) break;
    }
    await writeFile(destination, Buffer.concat(pieces));
  } finally { await session.send("IO.close", { handle: stream }); }
}

test("5000-line streamed answer stays complete and responsive with ten tables and equations", async ({ page }, info) => {
  test.setTimeout(90_000); const root = await mkdtemp(path.join(os.tmpdir(), "client-perf-")); const stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" })); const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve(process.env.TAROBOT_PERF_CLIENT_DIR ?? "dist") }); const secret = randomBytes(32).toString("base64url"); let gateway: GatewayChannel | undefined;
  const chunks = Array.from({ length: 50 }, (_, block) => Array.from({ length: 100 }, (_, line) => `第 ${block * 100 + line} 行：完整流式内容。\n\n`).join("")); const tables = Array.from({ length: 10 }, (_, i) => `\n| 表格 ${i} | 数值 |\n|---|---|\n| 项目 | ${i} |\n\n公式 $a_${i}^2+b_${i}^2=c_${i}^2$\n`).join(""); const answer = chunks.join("") + tables + "\n长文验收结束";
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','长文助手',?)", [hashSecret(secret)]); await hub.store.createConversation("owner", ["alpha"], "长文性能", "create");
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "alpha", engine: "codex", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async (input) => { for (const text of chunks) { await input.onEngineEvent?.({ type: "assistant_text", text, delta: true }); await new Promise((resolve) => setTimeout(resolve, 50)); } return { text: answer }; } } });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click(); await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeVisible();
    const profiler = process.env.TAROCUB_RENDER_PROFILE ? await page.context().newCDPSession(page) : undefined;
    if (profiler) {
      // CPU samples alone label native style/layout as "program". The optional
      // browser timeline identifies those pauses without taking DOM snapshots.
      await profiler.send("Tracing.start", { categories: "-*,devtools.timeline,blink.user_timing", transferMode: "ReturnAsStream" });
      await profiler.send("Profiler.enable"); await profiler.send("Profiler.start");
    }
    await page.evaluate(() => { const frames: number[] = []; const tasks: number[] = []; let previous = performance.now(); let active = true; let frame = 0; const observer = new PerformanceObserver((list) => { tasks.push(...list.getEntries().map((entry) => entry.duration)); }); observer.observe({ type: "longtask", buffered: false }); const tick = (now: number) => { frames.push(now - previous); previous = now; if (active) frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); Object.assign(window, { finishPerformance: () => { active = false; cancelAnimationFrame(frame); observer.disconnect(); return { frames, tasks }; } }); });
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("生成长文"); await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(page.getByText("第 99 行：完整流式内容。", { exact: true })).toBeVisible();
    const streamedParagraph = await page.getByText("第 99 行：完整流式内容。", { exact: true }).elementHandle();
    const inputStart = Date.now(); await page.getByRole("textbox", { name: "消息", exact: true }).fill("流式期间仍可编辑草稿"); const inputMs = Date.now() - inputStart; expect(inputMs).toBeLessThan(500);
    // Full-text locator polling walks every rendered node and itself creates
    // long tasks. During timing, inspect only the final paragraph and then allow
    // two paints. Run the comprehensive content assertions after measurements.
    await page.waitForFunction(() => { const paragraphs = document.querySelectorAll(".markdown p"); return paragraphs.item(paragraphs.length - 1)?.textContent === "长文验收结束"; }, undefined, { timeout: 60_000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const metrics = await page.evaluate(() => (window as unknown as { finishPerformance(): { frames: number[]; tasks: number[] } }).finishPerformance()); const frames = metrics.frames.sort((a, b) => a - b); const report = { inputMs, frameCount: frames.length, frameP95: frames[Math.floor(frames.length * 0.95)], frameMax: Math.max(...frames), longTaskCount: metrics.tasks.length, longestTask: Math.max(0, ...metrics.tasks), lines: 5000, tables: 10, equations: 10 };
    await info.attach("render-performance", { body: JSON.stringify(report, null, 2), contentType: "application/json" }); console.log("Render performance", JSON.stringify(report));
    if (profiler) {
      const profile = await profiler.send("Profiler.stop");
      await writeFile(info.outputPath("render.cpuprofile"), JSON.stringify(profile));
      await info.attach("render-cpu-profile", { body: JSON.stringify(profile), contentType: "application/json" });
      const timeline = info.outputPath("render-timeline.json");
      await finishTimeline(profiler, timeline);
      await info.attach("render-timeline", { path: timeline, contentType: "application/json" });
      await profiler.detach();
    }
    // Finalization must retain the already-rendered answer, rather than throw
    // away 5,000 paragraphs and remount an unformatted fallback.
    expect(await streamedParagraph!.evaluate(node => node.isConnected)).toBe(true);
    await streamedParagraph?.dispose();
    await expect(page.getByText("长文验收结束", { exact: true })).toHaveCount(1, { timeout: 60_000 }); await expect(page.locator(".markdown table")).toHaveCount(10); await expect(page.locator(".katex")).toHaveCount(10); await expect(page.getByText("第 4999 行：完整流式内容。", { exact: true })).toHaveCount(1); await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("流式期间仍可编辑草稿");
    // Verify every line, not only the first/last marker. Keep this full DOM
    // traversal outside the measured interval so the assertion is not a pause
    // attributed to the application.
    const renderedLines = await page.locator(".markdown p").evaluateAll(nodes => nodes.map(node => node.textContent).filter(text => /^第 \d+ 行：完整流式内容。$/.test(text ?? "")));
    expect(renderedLines).toEqual(Array.from({ length: 5000 }, (_, line) => `第 ${line} 行：完整流式内容。`));
    await page.evaluate(() => document.fonts.load('12px KaTeX_Main')); expect(await page.evaluate(() => document.fonts.check('12px KaTeX_Main'))).toBe(true);
    // Keep content integrity evidence even when the environment misses a frame-time gate.
    expect(report.frameP95).toBeLessThan(35); expect(report.longestTask).toBeLessThan(80);

  } finally { await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

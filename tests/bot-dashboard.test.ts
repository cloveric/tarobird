import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBotDashboard } from "../src/runtime/bot-dashboard.js";
import { botDashboardSchema } from "../src/client-protocol/dashboard.js";
import { gatewayOperation } from "../src/gateway/operations.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { CronStore } from "../src/state/cron-store.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { CURRENT_SCHEMA_VERSION } from "../src/state/schema-version.js";
import { createCronSnapshotter } from "../src/runtime/cron-snapshot.js";
import { parseCronStoreState } from "../src/state/cron-store.js";
import { dashboardScaleJobs } from "./fixtures/dashboard-scale.js";

const roots: string[] = [];
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "bot-dashboard-")); roots.push(dir); return dir; }
const at = "2026-10-02T00:00:00.000Z";
const usage = { totalInputTokens: 100, totalOutputTokens: 40, totalCachedTokens: 20, totalCostUsd: 0, requestCount: 2, unmeteredRequestCount: 3, lastUpdatedAt: at };
const save = (dir: string, file: string, value: unknown) => writeFile(path.join(dir, file), JSON.stringify(value));

it("keeps every large-list job and rejects a corrupt late batch without returning partial records", async () => {
  const dir = await root(), jobs = dashboardScaleJobs();
  jobs[4999]!.prompt = "token=fixture-secret";
  await save(dir, "cron-jobs.json", { jobs });
  const before = await readFile(path.join(dir, "cron-jobs.json"), "utf8");
  const page = await readBotDashboard(dir);
  expect(page.cron).toHaveLength(5000);
  expect(new Set(page.cron!.map((job) => job.id))).toEqual(new Set(jobs.map((job) => job.id)));
  expect(page.cron!.find((job) => job.id === jobs[4999]!.id)).toMatchObject({ enabled: false, nextRunAt: null, prompt: "token=[redacted]" });
  expect(page.cron!.every((job) => job.history.length === 10)).toBe(true);
  expect(await readFile(path.join(dir, "cron-jobs.json"), "utf8")).toBe(before);
  await save(dir, "cron-jobs.json", { jobs: [...jobs.slice(0, 65), { ...jobs[65], id: "invalid" }] });
  expect(await readBotDashboard(dir)).toMatchObject({ cron: null, warnings: ["cron-jobs.json: invalid"] });
  await save(dir, "cron-jobs.json", { schemaVersion: "invalid", jobs: [] });
  expect((await readBotDashboard(dir)).cron).toBeNull();
});

it("uses one schedule reference per read but preserves per-job timezone, state and history", () => {
  const jobs = parseCronStoreState({ jobs: dashboardScaleJobs(3).map((job) => ({ ...job, enabled: true, cronExpr: "0 9 * * *" })) }).jobs;
  const first = createCronSnapshotter(new Date("2026-10-03T00:00:00.000Z"));
  expect(first(jobs[0]!).nextRunAt).toBe("2026-10-03T09:00:00.000Z");
  expect(first(jobs[1]!).nextRunAt).toBe("2026-10-03T01:00:00.000Z");
  expect(first({ ...jobs[2]!, lastError: "own error", failureCount: 2 })).toMatchObject({ id: jobs[2]!.id, lastError: "own error", failureCount: 2, nextRunAt: "2026-10-03T09:00:00.000Z" });
  expect(first({ ...jobs[0]!, enabled: false }).nextRunAt).toBeNull();
  expect(first({ ...jobs[0]!, runOnce: true, targetAt: "2030-01-01T00:00:00.000Z" }).nextRunAt).toBe("2030-01-01T00:00:00.000Z");
  expect(createCronSnapshotter(new Date("2026-10-03T10:00:00.000Z"))(jobs[0]!).nextRunAt).toBe("2026-10-04T09:00:00.000Z");
});

it.each([
  ["0 30 2 * * *", "2026-03-08T06:59:00.000Z", "2026-03-08T07:00:00.000Z"],
  ["0 */30 * * * *", "2026-11-01T05:45:00.000Z", "2026-11-01T06:00:00.000Z"],
  ["0 30 1 * * *", "2026-11-01T05:45:00.000Z", "2026-11-02T06:30:00.000Z"],
])("keeps dashboard run times aligned with the scheduler across DST (%s from %s)", (cronExpr, reference, expected) => {
  const job = parseCronStoreState({ jobs: dashboardScaleJobs(1).map((value) => ({
    ...value, enabled: true, timezone: "America/New_York", cronExpr,
  })) }).jobs[0]!;
  expect(createCronSnapshotter(new Date(reference))(job).nextRunAt).toBe(expected);
});

it("does not invent usage or repair state and labels validated last-good data", async () => {
  const dir = await root();
  expect(await readBotDashboard(dir)).toMatchObject({ live: null, usage: null, sessions: null, config: null, cron: [], crew: null, warnings: [] });
  expect(await readdir(dir)).toEqual([]);
  const corrupt = '{broken'; await writeFile(path.join(dir, "usage.json"), corrupt);
  await save(dir, "usage.last-good.json", { ...usage, secret: "never expose extras", daily: { "2026-09-30": usage, "2026-02-30": usage }, monthly: { "2026-09": usage, "bad-period": usage } });
  const page = await readBotDashboard(dir);
  expect(page.usage).toEqual({ source: "last-good", total: usage, daily: { "2026-09-30": usage }, monthly: { "2026-09": usage } });
  expect(page.warnings).toContain("usage.last-good.json: fallback"); expect(page.warnings).toContain("usage.json: invalid period");
  expect(await readFile(path.join(dir, "usage.json"), "utf8")).toBe(corrupt); expect((await readdir(dir)).sort()).toEqual(["usage.json", "usage.last-good.json"]);
  await save(dir, "usage.json", { ...usage, schemaVersion: CURRENT_SCHEMA_VERSION + 1 }); expect((await readBotDashboard(dir)).usage?.source).toBe("last-good");
  await save(dir, "usage.last-good.json", { ...usage, requestCount: -1 }); expect((await readBotDashboard(dir)).usage).toBeNull();
});

it("reuses original cron normalization, one-time notification and schedule/history semantics", async () => {
  const dir = await root(); await save(dir, "config.json", { engine: "claude", timezone: "Asia/Shanghai", model: "token=fixture-secret" });
  const store = new CronStore(dir, { defaultTimezone: "Asia/Shanghai" });
  const recurring = await store.add({ chatId: 42, userId: 2, channel: "lark", conversationKey: "lark:gw_shared", cronExpr: "0 9 * * *", prompt: "每天报告", sessionMode: "reuse", silent: true, mute: true });
  await store.recordRun(recurring.id, { ranAt: at, success: false, error: "token=fixture-secret" });
  const once = await store.add({ chatId: 42, userId: 2, cronExpr: "0 9 * * *", prompt: "单次提醒", runOnce: true, targetAt: "2030-10-02T01:00:00.000Z" });
  const disabled = await store.add({ chatId: 42, userId: 2, cronExpr: "0 9 * * *", prompt: "已停用", enabled: false });
  const raw = JSON.parse(await readFile(path.join(dir, "cron-jobs.json"), "utf8")); for (const job of raw.jobs) { delete job.timezone; delete job.deliveryMode; } await save(dir, "cron-jobs.json", raw);
  const page = await readBotDashboard(dir), jobs = page.cron!;
  expect(jobs.find((j) => j.id === once.id)).toMatchObject({ kind: "once", nextRunAt: "2030-10-02T01:00:00.000Z", deliveryMode: "notify", timezone: "Asia/Shanghai" });
  expect(jobs.find((j) => j.id === disabled.id)?.nextRunAt).toBeNull();
  const daily = jobs.find((j) => j.id === recurring.id)!;
  expect(new Date(daily.nextRunAt!).getUTCHours()).toBe(1); expect(daily).toMatchObject({ channel: "gateway", sessionMode: "reuse", silent: true, mute: true, failureCount: 1, maxFailures: 3, history: [{ ranAt: at, success: false, error: "token=[redacted]" }] });
  expect(JSON.stringify(page)).not.toContain("fixture-secret");
  await writeFile(path.join(dir, "cron-jobs.json"), "null"); expect((await readBotDashboard(dir)).cron).toBeNull();
});

it("reports latest saved crew stages without claiming liveness, sanitizes and ignores symlinks", async () => {
  const dir = await root(); await mkdir(path.join(dir, "crew-runs"));
  const crew = { runId: "crew-a", workflow: "research-report", status: "running", currentStage: "review", coordinator: "tester", chatId: 42, userId: 2, locale: "zh", originalPrompt: "token=fixture-secret", createdAt: at, updatedAt: at, stages: { research: { status: "completed", updatedAt: at, researchPacket: "private hidden packet" }, review: { status: "running", updatedAt: at, verdict: "revise", revisionCount: 1, detail: "token=fixture-secret" } }, finalOutput: "private hidden output" };
  await save(dir, "crew-runs/a.json", crew); await save(dir, "crew-runs/old.json", { ...crew, runId: "old", updatedAt: "2026-01-01T00:00:00.000Z" }); await writeFile(path.join(dir, "crew-runs/broken.json"), "bad");
  await save(dir, "external.json", { ...crew, updatedAt: "2030-01-01T00:00:00.000Z" }); await symlink(path.join(dir, "external.json"), path.join(dir, "crew-runs/link.json"));
  await symlink(path.join(dir, "external.json"), path.join(dir, "usage.json"));
  const page = await readBotDashboard(dir);
  expect(page.live).toBeNull(); expect(page.crew).toMatchObject({ runId: "crew-a", status: "running", stages: [{ stage: "research", status: "completed" }, { stage: "review", verdict: "revise", revisionCount: 1 }] });
  expect(JSON.stringify(page)).not.toMatch(/fixture-secret|private hidden/); expect(page.warnings).toContain("crew-runs: unreadable"); expect(page.usage).toBeNull();
  await rm(path.join(dir, "crew-runs"), { recursive: true }); await symlink(dir, path.join(dir, "crew-runs")); expect((await readBotDashboard(dir)).crew).toBeNull();
  await writeFile(path.join(dir, "session.json"), " ".repeat(16 * 1024 * 1024 + 1)); expect((await readBotDashboard(dir)).warnings).toContain("session.json: unreadable");
});

it("uses the live shared runtime, never stale session/runtime-state task flags", async () => {
  const dir = await root(), runtime = createCoreServiceRuntime();
  await save(dir, "runtime-state.json", { activeTurnCount: 99, activeTurnStartedAt: at });
  await save(dir, "session.json", { chats: [1, 2].map((i) => ({ telegramChatId: i, conversationKey: `lark:gw_${i}`, codexSessionId: "same-session", status: "running", updatedAt: at })) });
  const options = { stateDir: dir, url: "ws://127.0.0.1:1/instance", botId: "fixture", secret: "unused", runtime, bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } };
  let page = botDashboardSchema.parse(await gatewayOperation("dashboard", options)); expect(page).toMatchObject({ sessions: 1, live: { activeCount: 0, active: [] } });
  runtime.activeRuns.set("lark:gw_live", { abortController: new AbortController(), startedAt: Date.parse(at) }); runtime.activeRuns.set("lark:gw_missingtime", { abortController: new AbortController() });
  page = botDashboardSchema.parse(await gatewayOperation("dashboard", options)); expect(page.live).toMatchObject({ activeCount: 2, active: [{ conversation: "lark:gw_live", startedAt: at }, { conversation: "lark:gw_missingtime", startedAt: null }] });
  await writeFile(path.join(dir, "usage.json"), "{broken"); await save(dir, "usage.last-good.json", usage);
  expect(await gatewayOperation("status", options)).toMatchObject({ usageSource: "last-good", usage });
  expect(await readFile(path.join(dir, "usage.json"), "utf8")).toBe("{broken");
});

async function token(hub: HubServer, id: string, userId = "owner") {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  await hub.auth.approve(pair.code, "local-owner", userId); const challenge = await hub.auth.challenge(id, id, nonce, id);
  return (await hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
}
it("serves paired owners only, validates fixed routes, supports managed offline records and revocation", async () => {
  const dir = await root(), stateDir = path.join(dir, "bot"); await mkdir(stateDir); await save(stateDir, "config.json", {});
  const hub = await HubServer.start({ stateDir: path.join(dir, "hub"), managedBots: { entrypoint: "unused-test-entrypoint" } }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const channel = await attachGateway({ stateDir, botId: "alpha", secret, url: hub.url.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  try {
    const owner = await token(hub, "desktop"), phone = await token(hub, "phone"); await hub.store.db.run("INSERT INTO users VALUES('guest','Guest','member')"); const guest = await token(hub, "guest", "guest");
    const get = (auth: string, endpoint = "/api/bots/alpha/dashboard") => fetch(hub.url + endpoint, { headers: { Authorization: `Bearer ${auth}` } });
    expect((await get("")).status).toBe(401); expect((await get(guest)).status).toBe(403); expect((await get(owner)).status).toBe(200);
    expect(botDashboardSchema.parse(await (await get(phone)).json()).live?.activeCount).toBe(0);
    expect((await get(owner, "/api/bots/unknown/dashboard")).status).toBe(403); expect((await get(owner, "/api/bots/alpha/dashboard?path=/private")).status).toBe(400);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('offline','Offline',?)", [hashSecret(secret)]); await hub.store.db.run("INSERT INTO managed_bots VALUES('offline','owner','fixture','{}')");
    const offlineDir = path.join(dir, "hub", "bots", "offline"); await mkdir(offlineDir, { recursive: true }); await save(offlineDir, "usage.json", usage);
    expect(botDashboardSchema.parse(await (await get(owner, "/api/bots/offline/dashboard")).json())).toMatchObject({ live: null, usage: { source: "current", total: usage } });
    await hub.auth.revoke("phone", "local-owner"); expect((await get(phone)).status).toBe(401);
    await channel.disconnect(); expect((await get(owner)).status).toBe(503);
  } finally { await channel.disconnect(); await hub.close(); }
}, 20000);

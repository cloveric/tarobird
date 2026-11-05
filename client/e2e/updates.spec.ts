import { test, expect } from "@playwright/test";
import { UpdateController, type UpdateOffer } from "../src/update-controller.js";
// @ts-expect-error Build helper is plain Node ESM.
import { releaseConfig } from "../scripts/desktop-release.mjs";

test("development builds cannot check or install an unconfigured feed", async () => {
  let checks = 0; let restarts = 0;
  const update = new UpdateController({ info: async () => ({ configured: false, version: "1.0.0" }), check: async () => { checks++; return null; }, restart: async () => { restarts++; } });
  await update.check(); await update.install(); await update.restart();
  expect(update.state.phase).toBe("disabled"); expect(checks).toBe(0); expect(restarts).toBe(0);
});
test("private builds require GitHub login before querying a feed and retain account identity", async () => {
  let authenticated = false; let checks = 0;
  const update = new UpdateController({ info: async () => ({ configured: true, version: "1.0.0", provider: "github" as const, authenticated, login: authenticated ? "octocat" : undefined }), check: async () => { checks++; return null; }, restart: async () => undefined });
  await update.check();
  expect(update.state).toMatchObject({ phase: "login-required", version: "1.0.0", provider: "github", authenticated: false });
  expect(checks).toBe(0);
  authenticated = true; await update.check();
  expect(update.state).toMatchObject({ phase: "current", provider: "github", authenticated: true, login: "octocat" });
  authenticated = false; await update.check();
  expect(update.state.phase).toBe("login-required"); expect(update.state.login).toBeUndefined(); expect(checks).toBe(1);
});
test("expired private authorization returns to login and never exposes arbitrary native error detail", async () => {
  let error = "github_update_login_required";
  const update = new UpdateController({ info: async () => ({ configured: true, version: "1.0.0", provider: "github" as const, authenticated: true, login: "octocat" }), check: async () => { throw error; }, restart: async () => undefined });
  await update.check(); expect(update.state).toMatchObject({ phase: "login-required", authenticated: false, error: "github_update_login_required" });
  error = "native failure with sensitive response"; await update.check();
  expect(update.state.error).toBe("github_update_failed");
});
test("discovery coalesces, signature errors cannot reach installed/restart, and success requires explicit install", async () => {
  let installed = 0; let closed = 0; let restarted = 0; let rejectSignature = true;
  const offer: UpdateOffer = { version: "1.1.0", body: "Release notes", close: async () => { closed++; }, downloadAndInstall: async (event) => { installed++; event({ event: "Started", data: { contentLength: 100 } }); event({ event: "Progress", data: { chunkLength: 100 } }); if (rejectSignature) throw new Error("signature verification failed"); } };
  const update = new UpdateController({ info: async () => ({ configured: true, version: "1.0.0" }), check: async () => offer, restart: async () => { restarted++; } });
  const first = update.check(); expect(update.check()).toBe(first); await first; expect(installed).toBe(0);
  await update.install(); expect(update.state.phase).toBe("error"); expect(closed).toBe(1); await update.restart(); expect(restarted).toBe(0);
  rejectSignature = false; await update.check(); await update.install(); expect(update.state).toMatchObject({ phase: "installed", bytes: 100, total: 100 }); await update.restart(); expect(restarted).toBe(1);
});
test("release config fixes the signing key and requires signed versions over HTTPS", () => {
  const publicBytes = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(40, 1)]);
  const pubkey = Buffer.from(`untrusted comment: test key\n${publicBytes.toString("base64")}\n`).toString("base64");
  expect(releaseConfig("https://updates.example.com/latest.json", pubkey)).toMatchObject({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey, requireSignedVersion: true, allowDowngrades: false } } });
  for (const url of ["http://updates.example.com/latest.json", "https://user:pass@example.com/latest.json", "https://example.com/latest.json?token=secret"]) expect(() => releaseConfig(url, pubkey)).toThrow();
  expect(() => releaseConfig("https://example.com/latest.json", "invalid")).toThrow();
});

test("Mac progress waits for host recovery and cancellation cannot report an installed update", async () => {
  let event!: Parameters<UpdateOffer['downloadAndInstall']>[0];
  let finish!: () => void, reject!: (error: Error) => void, waiting = true;
  const offer: UpdateOffer = { version: "1.1.0", close: async () => { if (waiting) reject(new Error("github_update_cancelled")); },
    downloadAndInstall: async callback => { event = callback; await new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; }); } };
  const update = new UpdateController({ info: async () => ({ configured: true, version: "1.0.0", provider: "github", authenticated: true }), check: async () => offer, restart: async () => undefined });
  await update.check(); const cancelled = update.install();
  event({ event: "WaitingForHost" }); expect(update.state.installStage).toBe("waiting");
  await update.cancelInstall(); await cancelled;
  expect(update.state).toMatchObject({ phase: "error", error: "github_update_cancelled" });
  await update.check(); const successful = update.install(); waiting = false;
  for (const stage of ["Installing", "RestartingHost"] as const) { event({ event: stage }); expect(update.state.phase).toBe("installing"); }
  finish(); await successful; expect(update.state.phase).toBe("installed");
});

test("desktop backend routes signed private offers through native IDs and keeps public updater support", async () => {
  const { createDesktopUpdateBackend } = await import("../src/github-update-backend.js");
  const calls: { command: string; args?: Record<string, unknown> }[] = []; let provider = "github"; let publicChecks = 0;
  const channel = { onmessage: (_event: unknown) => undefined };
  const backend = createDesktopUpdateBackend({ invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "github_update_info") return { configured: true, version: "1.0.0", provider, authenticated: true };
    if (command === "github_update_check") return { offerId: "offer-1", version: "1.1.0", body: "Notes" };
    if (command === "github_update_install") channel.onmessage({ event: "Progress", data: { chunkLength: 12 } });
  }, channel: () => channel, publicCheck: async () => { publicChecks++; return null; } });
  await backend.info(); const offer = await backend.check(); expect(offer?.version).toBe("1.1.0");
  const events: unknown[] = []; await offer!.downloadAndInstall(event => events.push(event), { timeout: 1 }); await offer!.close(); await backend.restart();
  expect(events).toEqual([{ event: "Progress", data: { chunkLength: 12 } }]);
  expect(calls.filter(call => call.command === "github_update_install")[0]?.args).toEqual({ offerId: "offer-1", onEvent: channel });
  expect(calls.map(call => call.command)).toEqual(["github_update_info", "github_update_check", "github_update_install", "github_update_close", "restart_client"]);
  expect(JSON.stringify(calls)).not.toMatch(/token|authorization|headers/i);
  provider = "default"; await backend.info(); expect(await backend.check()).toBeNull(); expect(publicChecks).toBe(1);
});

function loginClock() {
  let now = 0; let serial = 0; const tasks = new Map<number, { at: number; run: () => void }>();
  return { now: () => now, schedule: (run: () => void, delay: number) => { tasks.set(++serial, { at: now + delay, run }); return serial; }, clear: (handle: unknown) => { tasks.delete(handle as number); },
    advance: async (ms: number) => { now += ms; for (const [id, task] of tasks) if (task.at <= now) { tasks.delete(id); task.run(); } for (let turn = 0; turn < 12; turn++) await Promise.resolve(); }, tasks };
}
const loginFlow = { flowId: "flow-1", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresIn: 120, interval: 5 };
test("device login displays only the user code, opens the verified GitHub URL and respects slow-down intervals", async () => {
  const { GitHubUpdateLoginController } = await import("../src/github-update-backend.js");
  const clock = loginClock(); const opened: string[] = []; const calls: string[] = []; let polls = 0; let authorized = 0;
  const login = new GitHubUpdateLoginController({ invoke: async command => { calls.push(command); if (command === "github_update_login_start") return loginFlow; if (command === "github_update_login_poll") return ++polls === 1 ? { status: "pending", interval: 10 } : { status: "authorized" }; }, open: async url => { opened.push(url); }, authorized: async () => { authorized++; }, clock });
  await login.start(); expect(login.snapshot()).toMatchObject({ phase: "waiting", userCode: "ABCD-EFGH" }); expect(opened).toEqual([loginFlow.verificationUri]);
  await clock.advance(4_999); expect(polls).toBe(0); await clock.advance(1); expect(polls).toBe(1);
  await clock.advance(9_999); expect(polls).toBe(1); await clock.advance(1); expect(polls).toBe(2); expect(authorized).toBe(1); expect(clock.tasks.size).toBe(0);
  expect(calls).toEqual(["github_update_login_start", "github_update_login_poll", "github_update_login_poll"]);
});
test("canceling a delayed device flow closes it without reviving login or opening a browser", async () => {
  const { GitHubUpdateLoginController } = await import("../src/github-update-backend.js");
  const clock = loginClock(); let resolve!: (value: unknown) => void; const cancelled: unknown[] = []; let opened = 0;
  const login = new GitHubUpdateLoginController({ invoke: async (command, args) => { if (command === "github_update_login_start") return new Promise(done => { resolve = done; }); if (command === "github_update_login_cancel") cancelled.push(args); }, open: async () => { opened++; }, authorized: async () => undefined, clock });
  const pending = login.start(); await login.cancel(); resolve(loginFlow); await pending;
  expect(login.snapshot().phase).toBe("idle"); expect(cancelled).toEqual([{ flowId: "flow-1" }]); expect(opened).toBe(0); expect(clock.tasks.size).toBe(0);
});
test("canceling an in-flight poll prevents a late authorization callback, and expiry stops polling", async () => {
  const { GitHubUpdateLoginController } = await import("../src/github-update-backend.js");
  const clock = loginClock(); let resolve!: (value: unknown) => void; let authorized = 0; let cancelled = 0;
  const login = new GitHubUpdateLoginController({ invoke: async command => { if (command === "github_update_login_start") return { ...loginFlow, expiresIn: 8 }; if (command === "github_update_login_poll") return new Promise(done => { resolve = done; }); if (command === "github_update_login_cancel") cancelled++; }, open: async () => undefined, authorized: async () => { authorized++; }, clock });
  await login.start(); await clock.advance(5_000); await login.cancel(); resolve({ status: "authorized" }); await clock.advance(0);
  expect(authorized).toBe(0); expect(cancelled).toBe(1); expect(login.snapshot().phase).toBe("idle");
  await login.start(); await clock.advance(8_000);
  expect(login.snapshot()).toMatchObject({ phase: "error", error: "github_update_expired" }); expect(clock.tasks.size).toBe(0); expect(cancelled).toBe(2);
});
test("device login rejects an unexpected authorization URL and cancels its native flow", async () => {
  const { GitHubUpdateLoginController } = await import("../src/github-update-backend.js");
  const clock = loginClock(); let opened = 0; const cancelled: unknown[] = [];
  const login = new GitHubUpdateLoginController({ invoke: async (command, args) => { if (command === "github_update_login_start") return { ...loginFlow, verificationUri: "https://github.com.evil.invalid/login/device" }; if (command === "github_update_login_cancel") cancelled.push(args); }, open: async () => { opened++; }, authorized: async () => undefined, clock });
  await login.start(); expect(login.snapshot()).toMatchObject({ phase: "error", error: "github_update_configuration" }); expect(opened).toBe(0); expect(cancelled).toEqual([{ flowId: "flow-1" }]); expect(clock.tasks.size).toBe(0);
});
test("a new device login cancels the old flow and a browser retry clears its recoverable error", async () => {
  const { GitHubUpdateLoginController } = await import("../src/github-update-backend.js");
  const clock = loginClock(); const calls: { command: string; args?: Record<string, unknown> }[] = []; let started = 0; let opened = 0;
  const login = new GitHubUpdateLoginController({ invoke: async (command, args) => { calls.push({ command, args }); if (command === "github_update_login_start") return { ...loginFlow, flowId: `flow-${++started}` }; }, open: async () => { if (++opened === 1) throw new Error("browser unavailable"); }, authorized: async () => undefined, clock });
  await login.start(); expect(login.snapshot()).toMatchObject({ phase: "waiting", error: "github_update_browser" });
  await login.openAuthorization(); expect(login.snapshot().error).toBeUndefined();
  await login.start();
  expect(calls.map(call => call.command)).toEqual(["github_update_login_start", "github_update_login_cancel", "github_update_login_start"]);
  expect(calls[1]?.args).toEqual({ flowId: "flow-1" }); expect(clock.tasks.size).toBe(2);
  await login.cancel(); expect(calls.at(-1)?.args).toEqual({ flowId: "flow-2" }); expect(clock.tasks.size).toBe(0);
});


for (const provider of ['github', 'default'] as const) test(`${provider}: replaced bundle with unverified Host offers restart, never retry or verified success`, async () => {
  let checks = 0, installs = 0, restarts = 0;
  const offer: UpdateOffer = { version: '1.1.0', close: async () => undefined,
    downloadAndInstall: async () => { installs++; throw new Error('github_update_installed_host_failed'); } };
  const update = new UpdateController({ info: async () => ({ configured: true, version: '1.0.0', provider, authenticated: true }),
    check: async () => { checks++; return offer; }, restart: async () => { restarts++; } });
  await update.check(); await update.install();
  expect(update.state).toMatchObject({ phase: 'restart-required', error: 'github_update_installed_host_failed' });
  await update.check(); await update.install();
  expect(checks).toBe(1); expect(installs).toBe(1);
  await update.restart(); expect(restarts).toBe(1);
});


for (const provider of ['github', 'default'] as const) test(`${provider} unresolved restoration cannot retry or restart`, async () => {
  let checks = 0, installs = 0, restarts = 0;
  const offer: UpdateOffer = { version: '1.1.0', close: async () => {},
    downloadAndInstall: async () => { installs++; throw new Error('github_update_recovery'); } };
  const update = new UpdateController({ info: async () => ({ configured: true, version: '1.0.0', provider, authenticated: true }),
    check: async () => { checks++; return offer; }, restart: async () => { restarts++; } });
  await update.check(); await update.install();
  expect(update.state).toMatchObject({ phase: 'recovery-required', error: 'github_update_recovery' });
  await update.check(); await update.install(); await update.restart();
  expect({ checks, installs, restarts }).toEqual({ checks: 1, installs: 1, restarts: 0 });
});

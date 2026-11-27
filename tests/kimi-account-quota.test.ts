import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeLoopbackOrigin, parseKimiManagedUsage, type KimiQuotaChildLike } from "../src/codex/kimi-account-quota.js";
import { AdapterQuotaCache } from "../src/codex/adapter-account-quota.js";
import { KimiAcpAdapter } from "../src/codex/kimi-acp-adapter.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import { quotaView } from "../client/src/usage-readings.js";

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class MockKimiWebChild extends EventEmitter implements KimiQuotaChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: () => undefined, on: () => undefined };
  killed = false;
  closed = false;
  kill() {
    this.killed = true;
    if (!this.closed) {
      queueMicrotask(() => {
        if (this.closed) return;
        this.closed = true;
        this.emit("close", 0, "SIGTERM");
      });
    }
  }
  emitReady(origin = "http://127.0.0.1:58999", token = "ephemeral-token") {
    queueMicrotask(() => {
      this.stdout.emit("data", JSON.stringify({ origin, ws_url: origin.replace("http", "ws") + "/ws", token }) + "\n");
    });
  }
}

async function kimiFixture(extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kimi-quota-"));
  roots.push(root);
  const home = path.join(root, "home");
  const kimiHome = path.join(home, ".kimi-code");
  await mkdir(kimiHome, { recursive: true });
  await writeFile(path.join(kimiHome, "config.toml"), 'default_model = "kimi-for-coding"\n');
  const env: NodeJS.ProcessEnv = { HOME: home, KIMI_CODE_HOME: kimiHome, PATH: process.env.PATH, ...extraEnv };
  return { root, home, kimiHome, env };
}

describe("Kimi Code managed quota parser (#76)", () => {
  const now = Date.parse("2026-11-24T08:00:00Z");

  it("parses normal 5h / 7d / monthly windows and top-up pack balance", () => {
    const snap = parseKimiManagedUsage({
      code: 0,
      msg: "success",
      data: {
        kind: "ok",
        quota: {
          usages: {
            limit5h: { usedRatio: 0.125, resetAt: "2026-11-24T12:30:00Z" },
            limit7d: { usedRatio: 0.4125, resetAt: "2026-11-30T08:00:00Z" },
            monthTotal: { usedRatio: 0.25, resetAt: "2026-12-01T00:00:00Z" },
            monthCode: { usedRatio: 0.3, resetAt: "2026-12-01T00:00:00Z" },
          },
          extraUsage: {
            balanceCents: 4550,
            totalCents: 10000,
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimitCents: 20000,
            monthlyUsedCents: 5000,
            currency: "CNY",
          },
        },
      },
    }, now);

    expect(snap).toMatchObject({ state: "ready", authMode: "subscription", capability: { mode: "active" }, help: "kimi_usage" });
    expect(snap.pools).toHaveLength(1);
    expect(snap.pools[0]!.windows.map(w => [w.id, w.label, w.metric === "percent" ? w.usedPercent : null])).toEqual([
      ["five_hour", "5 hours", 12.5],
      ["seven_day", "7 days", 41.25],
      ["month_total", "Monthly", 25],
      ["month_code", "Coding · 30 days", 30],
      ["extra_monthly", "Top-up monthly limit", 25],
    ]);
    expect(snap.pools[0]!.balances).toEqual([
      expect.objectContaining({ id: "top_up", kind: "currency", amount: "45.50", unit: "CNY" }),
    ]);

    // Feeds seamlessly into the conversation battery view (`quotaView`) while excluding `extra_monthly`.
    const view = quotaView({
      ...snap,
      id: "kimi-bot",
      revision: "rev1",
      engine: "kimi",
      label: "Kimi Bot",
      botIds: ["kimi-bot"],
      sharing: "unverified",
    }, "kimi-for-coding", now + 1000);
    expect(view?.left).toBe(59); // min remaining: 100 - 41.25 = 58.75 -> 59%
    expect(view?.windows.map(w => [w.id, w.label])).toEqual([
      ["kimi:five_hour", "5 hours"],
      ["kimi:seven_day", "7 days"],
      ["kimi:month_total", "Monthly"],
      ["kimi:month_code", "Coding · 30 days"],
    ]);
  });

  it("maps 404 (non-Kimi For Coding), 401, statusless OAuthUnauthorizedError envelopes, and timeouts", () => {
    const notCoding = parseKimiManagedUsage({
      data: { kind: "error", status: 404, message: "Usage endpoint not available. Try Kimi For Coding." },
    }, now);
    expect(notCoding).toMatchObject({
      state: "unsupported",
      reason: "mode_not_supported",
      authMode: "other",
      capability: { mode: "active", reason: "mode_not_supported" },
      pools: [],
    });

    const signedOut = parseKimiManagedUsage({
      data: { kind: "error", status: 401, message: "Authorization failed. Please check your API key (try /login)." },
    }, now);
    expect(signedOut).toMatchObject({ state: "login_required", reason: "login_required", pools: [] });

    // Real kimi 2.8.0 OAuthUnauthorizedError messages omit `status` entirely.
    for (const message of [
      'No token for "kimi-code". Run /login to authenticate.',
      'Stored token for "kimi-code" was rejected; re-login required.',
      'Token for "kimi-code" has no refresh_token; re-login required.',
    ]) {
      const parsed = parseKimiManagedUsage({ code: 0, msg: "success", data: { kind: "error", message } }, now);
      expect(parsed).toMatchObject({ state: "login_required", reason: "login_required", authMode: "unknown", pools: [] });
    }

    const timedOut = parseKimiManagedUsage({
      code: 0,
      msg: "success",
      data: { kind: "error", message: "Request timed out after 10000ms" },
    }, now);
    expect(timedOut).toMatchObject({ state: "unavailable", reason: "timeout", authMode: "subscription", pools: [] });
  });

  it("normalizes loopback origins including IPv6 [::1] and trailing slashes, and rejects userinfo or remote hosts", () => {
    expect(normalizeLoopbackOrigin("http://127.0.0.1:58627")).toBe("http://127.0.0.1:58627");
    expect(normalizeLoopbackOrigin("http://127.0.0.1:58627/")).toBe("http://127.0.0.1:58627");
    expect(normalizeLoopbackOrigin("http://localhost:58627/extra/path?q=1")).toBe("http://localhost:58627");
    expect(normalizeLoopbackOrigin("http://[::1]:58627")).toBe("http://[::1]:58627");
    expect(normalizeLoopbackOrigin("http://[::1]:58627/")).toBe("http://[::1]:58627");
    expect(normalizeLoopbackOrigin("https://[::1]:58627/")).toBe("https://[::1]:58627");
    expect(normalizeLoopbackOrigin("http://user:pass@127.0.0.1:58627")).toBeUndefined();
    expect(normalizeLoopbackOrigin("http://example.com:58627")).toBeUndefined();
    expect(normalizeLoopbackOrigin("file:///etc/passwd")).toBeUndefined();
  });
});

describe("KimiAcpAdapter account quota lifecycle (#76)", () => {
  it("reads plan quota via short-lived kimi web --port 0 --json, stops process, and clears cache on account switch", async () => {
    const f = await kimiFixture();
    const children: MockKimiWebChild[] = [];
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      expect(args).toEqual(["web", "--port", "0", "--json"]);
      const child = new MockKimiWebChild();
      children.push(child);
      child.emitReady("http://127.0.0.1:59123", "ephemeral-secret");
      return child;
    });
    const fetchCalls: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      fetchCalls.push({ url: String(url), auth: headers.get("authorization") });
      return new Response(JSON.stringify({
        code: 0,
        msg: "success",
        data: {
          kind: "ok",
          quota: {
            usages: {
              limit5h: { usedRatio: 0.1, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
              limit7d: { usedRatio: 0.25, resetAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
            },
            extraUsage: { balanceCents: 1250, totalCents: 2000, monthlyChargeLimitEnabled: false, monthlyChargeLimitCents: 0, monthlyUsedCents: 0, currency: "CNY" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      quotaFetchFn: fetchFn,
    });
    disposals.push(() => adapter.destroy());

    const run = gatewayEngineQuota({ botId: "kimi-1", engine: "kimi", read: opts => adapter.getAccountQuota(opts) });
    const initial = await run({ scopeId: "kimi-1", refresh: false });
    expect(initial.value).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" } });
    expect(spawnFn).not.toHaveBeenCalled();

    const refreshed = await run({ scopeId: "kimi-1", refresh: true, expectedRevision: initial.revision });
    expect(refreshed.value.state).toBe("ready");
    expect(refreshed.value.pools[0]?.windows).toHaveLength(2);
    expect(refreshed.value.pools[0]?.balances[0]).toMatchObject({ kind: "currency", amount: "12.50", unit: "CNY" });
    expect(fetchCalls).toEqual([{ url: "http://127.0.0.1:59123/api/v1/oauth/usage", auth: "Bearer ephemeral-secret" }]);
    expect(children[0]?.closed).toBe(true);
    expect(JSON.stringify(refreshed)).not.toContain("ephemeral-secret");

    // Switching Kimi account (metadata change on credentials file) invalidates the old reading immediately.
    const credsMarker = path.join(f.kimiHome, "credentials.json");
    await writeFile(credsMarker, "account-b");
    const later = new Date(Date.now() + 5000);
    await utimes(credsMarker, later, later);
    const afterSwitch = await run({ scopeId: "kimi-1", refresh: false });
    expect(afterSwitch.revision).not.toBe(initial.revision);
    expect(afterSwitch.value.pools).toEqual([]);
  });

  it("reports API-key-only Kimi configuration as unsupported without spawning kimi web, including after logout leaves empty credentials/", async () => {
    const f = await kimiFixture({ KIMI_API_KEY: "sk-synthetic-only" });
    // Real `kimi logout` unlinks the token file while leaving the empty `credentials/` directory behind.
    await mkdir(path.join(f.kimiHome, "credentials"), { recursive: true });
    const spawnFn = vi.fn(() => { throw new Error("must_not_spawn"); });
    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => adapter.destroy());

    const res = await adapter.getAccountQuota({ refresh: true });
    expect(res.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key", capability: { mode: "unsupported" }, pools: [] });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("detects in-place credentials/*.json overwrites, KIMI_CODE_* env/region changes, and fails closed on unreadable credential dirs", async () => {
    const f = await kimiFixture();
    const credsDir = path.join(f.kimiHome, "credentials");
    const tokenFile = path.join(credsDir, "kimi-code.json");
    await mkdir(credsDir, { recursive: true });
    await writeFile(tokenFile, '{"access_token":"acct-a"}');

    const cache = new AdapterQuotaCache("kimi", "kimi", f.env, f.root);
    const scopeA = cache.capture("process");
    expect(scopeA).toMatchObject({ verifiable: true, authMode: "subscription" });

    // In-place overwrite of the same filename inside `credentials/` with identical byte length.
    await writeFile(tokenFile, '{"access_token":"acct-b"}');
    const bumped = new Date(Date.now() + 2000);
    await utimes(tokenFile, bumped, bumped);
    const scopeB = cache.capture("process");
    expect(scopeB.revision).not.toBe(scopeA.revision);

    // Changing <KIMI_CODE_HOME>/region invalidates scope.
    const regionFile = path.join(f.kimiHome, "region");
    await writeFile(regionFile, "cn\n");
    const scopeRegion1 = cache.capture("process");
    expect(scopeRegion1.revision).not.toBe(scopeB.revision);
    await writeFile(regionFile, "global\n");
    const scopeRegion2 = cache.capture("process");
    expect(scopeRegion2.revision).not.toBe(scopeRegion1.revision);

    // Changing KIMI_CODE_BASE_URL, KIMI_CODE_OAUTH_HOST, or KIMI_OAUTH_HOST invalidates scope.
    const baseRev = new AdapterQuotaCache("kimi", "kimi", { ...f.env, KIMI_CODE_BASE_URL: "https://a.example" }, f.root).capture("process").revision;
    const baseRev2 = new AdapterQuotaCache("kimi", "kimi", { ...f.env, KIMI_CODE_BASE_URL: "https://b.example" }, f.root).capture("process").revision;
    expect(baseRev2).not.toBe(baseRev);
    const oauthRev1 = new AdapterQuotaCache("kimi", "kimi", { ...f.env, KIMI_CODE_OAUTH_HOST: "https://oa.example" }, f.root).capture("process").revision;
    const oauthRev2 = new AdapterQuotaCache("kimi", "kimi", { ...f.env, KIMI_CODE_OAUTH_HOST: "https://ob.example" }, f.root).capture("process").revision;
    expect(oauthRev2).not.toBe(oauthRev1);
    const legacyOauthRev = new AdapterQuotaCache("kimi", "kimi", { ...f.env, KIMI_OAUTH_HOST: "https://oc.example" }, f.root).capture("process").revision;
    expect(legacyOauthRev).not.toBe(oauthRev2);

    // Non-ENOENT errors on credential directories must fail closed (`verifiable = false`).
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(credsDir, 0o000);
      try {
        const unreadable = cache.capture("process");
        expect(unreadable.verifiable).toBe(false);
        expect(cache.response(unreadable, { refresh: true })?.snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
      } finally {
        await chmod(credsDir, 0o700);
      }
    }
  });

  it("resolves the Kimi home and KIMI_* variables the Windows way on win32, like the other engines (#168)", async () => {
    const f = await kimiFixture();
    const winProfile = path.join(f.root, "win-profile"), msysHome = path.join(f.root, "msys-home"), emptyProfile = path.join(f.root, "empty-profile");
    const tokenFile = path.join(winProfile, ".kimi-code", "credentials", "kimi-code.json");
    await mkdir(path.dirname(tokenFile), { recursive: true });
    await mkdir(msysHome, { recursive: true });
    await mkdir(emptyProfile, { recursive: true });
    await writeFile(tokenFile, '{"access_token":"acct-a"}');

    // Git for Windows / MSYS may set HOME elsewhere; the login under USERPROFILE is the one Kimi uses.
    const win = new AdapterQuotaCache("kimi", "kimi", { HOME: msysHome, UserProfile: winProfile, KIMI_API_KEY: "sk-synthetic-only" }, f.root, undefined, "win32");
    const first = win.capture("process");
    expect(first).toMatchObject({ verifiable: true, authMode: "subscription" });
    await writeFile(tokenFile, '{"access_token":"acct-b"}');
    const bumped = new Date(Date.now() + 2000);
    await utimes(tokenFile, bumped, bumped);
    expect(win.capture("process").revision).not.toBe(first.revision);
    // The same environment read the POSIX way finds no login under HOME: an API key alone.
    expect(new AdapterQuotaCache("kimi", "kimi", { HOME: msysHome, USERPROFILE: winProfile, KIMI_API_KEY: "sk-synthetic-only" }, f.root, undefined, "linux").capture("process").authMode).toBe("api_key");

    // Windows environment names are case-insensitive.
    expect(new AdapterQuotaCache("kimi", "kimi", { USERPROFILE: emptyProfile, Kimi_Api_Key: "sk-synthetic-only" }, f.root, undefined, "win32").capture("process").authMode).toBe("api_key");
    expect(new AdapterQuotaCache("kimi", "kimi", { HOME: emptyProfile, Kimi_Api_Key: "sk-synthetic-only" }, f.root, undefined, "linux").capture("process").authMode).toBe("subscription");
    expect(new AdapterQuotaCache("kimi", "kimi", { USERPROFILE: emptyProfile, Kimi_Code_Home: path.join(winProfile, ".kimi-code"), KIMI_API_KEY: "sk-synthetic-only" }, f.root, undefined, "win32").capture("process").authMode).toBe("subscription");
    // One cache (one key), one environment object changed in place: only then do two revisions compare.
    const winEnv: NodeJS.ProcessEnv = { USERPROFILE: emptyProfile, Kimi_Code_Base_Url: "https://a.example" };
    const winCache = new AdapterQuotaCache("kimi", "kimi", winEnv, f.root, undefined, "win32");
    const winBefore = winCache.capture("process").revision;
    expect(winCache.capture("process").revision).toBe(winBefore);
    winEnv.Kimi_Code_Base_Url = "https://b.example";
    expect(winCache.capture("process").revision).not.toBe(winBefore);
    const posixEnv: NodeJS.ProcessEnv = { HOME: emptyProfile, Kimi_Code_Base_Url: "https://a.example" };
    const posixCache = new AdapterQuotaCache("kimi", "kimi", posixEnv, f.root, undefined, "linux");
    const posixBefore = posixCache.capture("process").revision;
    posixEnv.Kimi_Code_Base_Url = "https://b.example";
    expect(posixCache.capture("process").revision).toBe(posixBefore);
  });

  it("clears cached pools when a revoked token returns a statusless OAuthUnauthorizedError", async () => {
    const f = await kimiFixture();
    let mode: "ok" | "revoked" = "ok";
    const spawnFn = vi.fn(() => {
      const child = new MockKimiWebChild();
      child.emitReady("http://127.0.0.1:59124", "tok");
      return child;
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(
      mode === "ok"
        ? {
          code: 0,
          msg: "success",
          data: {
            kind: "ok",
            quota: {
              usages: { limit5h: { usedRatio: 0.2, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
              extraUsage: null,
            },
          },
        }
        : {
          code: 0,
          msg: "success",
          data: { kind: "error", message: 'Stored token for "kimi-code" was rejected; re-login required.' },
        },
    ), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      quotaFetchFn: fetchFn,
    });
    disposals.push(() => adapter.destroy());

    const first = await adapter.getAccountQuota({ refresh: true });
    expect(first.snapshot.state).toBe("ready");
    expect(first.snapshot.pools).toHaveLength(1);

    mode = "revoked";
    const revoked = await adapter.getAccountQuota({ refresh: true });
    expect(revoked.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [] });
    // Cached read must also have cleared the revoked account's prior pools.
    const cached = await adapter.getAccountQuota({ refresh: false });
    expect(cached.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [] });
  });

  it("drains a real loopback chunked HTTP response body before terminating kimi web", async () => {
    const f = await kimiFixture();
    const server = createServer((req, res) => {
      expect(req.url).toBe("/api/v1/oauth/usage");
      expect(req.headers.authorization).toBe("Bearer chunked-token");
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.flushHeaders();
      const payload = JSON.stringify({
        code: 0,
        msg: "success",
        data: {
          kind: "ok",
          quota: {
            usages: { limit5h: { usedRatio: 0.15, resetAt: new Date(Date.now() + 3_600_000).toISOString() } },
            extraUsage: { balanceCents: 300, currency: "CNY", monthlyChargeLimitEnabled: false, monthlyChargeLimitCents: 0, monthlyUsedCents: 0 },
          },
        },
      });
      // Stream body after headers to catch any terminate-before-body-read race.
      setTimeout(() => {
        res.write(payload.slice(0, 40));
        setTimeout(() => {
          res.end(payload.slice(40));
        }, 25);
      }, 40);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    disposals.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;

    let terminated = false;
    const spawnFn = vi.fn(() => {
      const child = new MockKimiWebChild();
      const origKill = child.kill.bind(child);
      child.kill = () => {
        terminated = true;
        // Closing all connections immediately simulates killing `kimi web` mid-response.
        server.closeAllConnections();
        origKill();
      };
      // Include a trailing slash to also verify URL normalization.
      child.emitReady(`http://127.0.0.1:${port}/`, "chunked-token");
      return child;
    });

    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot.state).toBe("ready");
    expect(result.snapshot.pools[0]?.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 15 });
    expect(result.snapshot.pools[0]?.balances[0]).toMatchObject({ id: "top_up", kind: "currency", amount: "3.00", unit: "CNY" });
    expect(terminated).toBe(true);
  });

  it("handles IPv6 [::1] origins, malformed JSON, oversized bodies, and raw HTTP 404 / 401 distinctly from server 404", async () => {
    const f = await kimiFixture();
    const fetchCalls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    let nextResponse: () => Response = () => new Response("{not json", { status: 200 });
    let nextOrigin = "http://[::1]:59222/";
    const spawnFn = vi.fn(() => {
      const child = new MockKimiWebChild();
      // Emit plenty of stderr data to verify stderr is drained cleanly.
      queueMicrotask(() => child.stderr.emit("data", "x".repeat(128 * 1024)));
      child.emitReady(nextOrigin, "ipv6-tok");
      return child;
    });
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), redirect: init?.redirect });
      return nextResponse();
    }) as unknown as typeof fetch;

    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      quotaFetchFn: fetchFn,
    });
    disposals.push(() => adapter.destroy());

    // Malformed JSON -> invalid_response (and [::1] trailing slash normalized + redirect: "error").
    const badJson = await adapter.getAccountQuota({ refresh: true });
    expect(badJson.snapshot).toMatchObject({ state: "unavailable", reason: "invalid_response", pools: [] });
    expect(fetchCalls[0]).toEqual({ url: "http://[::1]:59222/api/v1/oauth/usage", redirect: "error" });

    // Oversized body (> 256 KiB) -> invalid_response.
    nextResponse = () => new Response(" ".repeat(300 * 1024), { status: 200 });
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "unavailable", reason: "invalid_response", pools: [] });

    // Raw HTTP 404 from an older `kimi web` -> native_unverified (does NOT blame account plan).
    nextResponse = () => new Response("Not Found", { status: 404 });
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "unsupported", reason: "native_unverified", pools: [] });

    // Raw HTTP 401/403 from local loopback auth -> native_error (does NOT report user login_required).
    nextResponse = () => new Response("Unauthorized", { status: 401 });
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "unavailable", reason: "native_error", pools: [] });
  });

  it("allows explicit refresh after a server-side 404 so plan upgrades work without restarting the Host", async () => {
    const f = await kimiFixture();
    let upgraded = false;
    const spawnFn = vi.fn(() => {
      const child = new MockKimiWebChild();
      child.emitReady("http://127.0.0.1:59333", "tok");
      return child;
    });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(
      upgraded
        ? { code: 0, msg: "success", data: { kind: "ok", quota: { usages: { limit5h: { usedRatio: 0.05, resetAt: new Date(Date.now() + 3_600_000).toISOString() } }, extraUsage: null } } }
        : { code: 0, msg: "success", data: { kind: "error", status: 404, message: "Usage endpoint not available. Try Kimi For Coding." } },
    ), { status: 200 })) as unknown as typeof fetch;

    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      quotaFetchFn: fetchFn,
    });
    disposals.push(() => adapter.destroy());

    let clock = 10_000;
    const run = gatewayEngineQuota({ botId: "kimi-1", engine: "kimi", read: opts => adapter.getAccountQuota(opts), now: () => clock });
    const initial = await run({ scopeId: "kimi-1", refresh: false });
    const notCoding = await run({ scopeId: "kimi-1", refresh: true, expectedRevision: initial.revision });
    expect(notCoding.value).toMatchObject({
      state: "unsupported",
      reason: "mode_not_supported",
      authMode: "other",
      capability: { mode: "active", reason: "mode_not_supported" },
      pools: [],
    });

    // Cached read preserves the 404 explanation and keeps capability.mode = "active".
    const cached = await run({ scopeId: "kimi-1", refresh: false });
    expect(cached.value).toMatchObject({ state: "unsupported", reason: "mode_not_supported", capability: { mode: "active" } });

    // User upgrades on web without touching local credential files; after cooldown, explicit Refresh succeeds!
    upgraded = true;
    clock += 61_000;
    const afterUpgrade = await run({ scopeId: "kimi-1", refresh: true, expectedRevision: cached.revision });
    expect(afterUpgrade.value.state).toBe("ready");
    expect(afterUpgrade.value.pools[0]?.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 5 });
  });

  it("enforces bounded stop wait on timeout, cancels cleanly on destroy, and rejects ready when child fails to close", async () => {
    const f = await kimiFixture();

    // 1. Timeout stop bound: child ignores kill() and never closes -> finishes within timeoutMs + 2s allowance.
    const hungAdapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: (() => {
        const child = new MockKimiWebChild();
        child.kill = () => { child.killed = true; };
        return child;
      }) as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => hungAdapter.destroy());
    const began = performance.now();
    const timedOut = await hungAdapter.getAccountQuota({ refresh: true, timeoutMs: 50 });
    expect(timedOut.snapshot).toMatchObject({ state: "unavailable", reason: "timeout", pools: [] });
    expect(performance.now() - began).toBeLessThan(50 + 2_000 + 500);

    // 2. Non-exiting child after HTTP success: must NEVER return/cache "ready" while child is still alive.
    const stubbornAdapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: (() => {
        const child = new MockKimiWebChild();
        child.kill = () => { child.killed = true; };
        child.emitReady("http://127.0.0.1:59444", "tok");
        return child;
      }) as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      quotaFetchFn: (async () => new Response(JSON.stringify({
        code: 0,
        msg: "success",
        data: { kind: "ok", quota: { usages: { limit5h: { usedRatio: 0.1 } }, extraUsage: null } },
      }), { status: 200 })) as unknown as typeof fetch,
    });
    disposals.push(() => stubbornAdapter.destroy());
    const stubborn = await stubbornAdapter.getAccountQuota({ refresh: true });
    expect(stubborn.snapshot).toMatchObject({ state: "unavailable", reason: "native_error", pools: [] });

    // 3. Destroy cancellation waits for the owned child to actually close.
    const slowChild = new MockKimiWebChild();
    slowChild.kill = () => {
      slowChild.killed = true;
      setTimeout(() => {
        if (slowChild.closed) return;
        slowChild.closed = true;
        slowChild.emit("close", 0, "SIGTERM");
      }, 45);
    };
    const cancelAdapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: (() => slowChild) as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
    });
    const pending = cancelAdapter.getAccountQuota({ refresh: true });
    const stopped = cancelAdapter.destroy();
    expect(slowChild.closed).toBe(false);
    await stopped;
    expect(slowChild.closed).toBe(true);
    expect((await pending).snapshot).toMatchObject({ reason: "cancelled", pools: [] });
  }, 15_000);
});

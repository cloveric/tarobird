import { test, expect, type Page } from "@playwright/test";
import { generateKeyPairSync, sign } from "node:crypto";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import type { hubFetch, hubSocket } from "../src/transport.js";
import type { mockIPC } from "@tauri-apps/api/mocks";
import type { PairingProps } from "../src/HostApp.js";
import type { HubConnection } from "../src/connection.js";
declare global { interface Window { nativeTransportFixture: { downloadAttachment: typeof import("../src/downloads.js").downloadAttachment; hubFetch: typeof hubFetch; hubSocket: typeof hubSocket; mockIPC: typeof mockIPC; runCallback(id: number, data: unknown): void; renderPairing(props?: Partial<PairingProps>): void; renderRoutes(connection: HubConnection): void; setLocale(locale: "zh" | "en"): void; HubConnection: typeof HubConnection } } }
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html"); await page.waitForFunction(() => !!window.nativeTransportFixture); });

async function importNativeInvitation(page: Page, key: string, locale: "zh" | "en" = "zh") {
  const link = `tarocub://pair?data=${encodeURIComponent(JSON.stringify({ v: 1, kind: "connect", hubPublicKey: key, routes: [{ name: "VPS", url: "https://hub.invalid" }] }))}&invite=${"i".repeat(43)}`;
  await page.getByRole("button", { name: locale === "zh" ? "粘贴连接信息" : "Paste connection details", exact: true }).click();
  await page.getByLabel(locale === "zh" ? "配对信息" : "Pairing information", { exact: true }).fill(link);
  await page.getByRole("button", { name: locale === "zh" ? "使用配对信息" : "Use pairing information", exact: true }).click();
}

test("native request failures never fall back to browser fetch or WebSocket", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubFetch, hubSocket, mockIPC } = window.nativeTransportFixture; let escaped = 0;
    window.fetch = () => { escaped++; throw new Error("escaped"); };
    const original = window.WebSocket;
    window.WebSocket = class extends original { constructor(url: string) { escaped++; super(url); } };
    mockIPC(() => { throw new Error("native_disabled"); });
    const error = await hubFetch("https://hub.invalid", "/api/pair", "trusted", { method: "POST", body: "synthetic" }).then(() => "", (e: Error) => e.message);
    const closed = await new Promise<number>((resolve) => { const ws = hubSocket("https://hub.invalid", "trusted"); ws.onclose = (e) => resolve(e.code); });
    return { escaped, error, closed };
  })).toEqual({ escaped: 0, error: "native_disabled", closed: 1006 });
});
test("native socket diagnostics survive automatic reconnect and remain readable in route settings", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const fixture = window.nativeTransportFixture; let id = 0;
    const read = new Set<string>();
    fixture.mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `diagnostic-${++id}`;
      if (cmd === "net_http_open") return { status: 200, headers: [] };
      if (cmd === "net_http_read") { const key = String(args!.id); if (read.has(key)) return new ArrayBuffer(0); read.add(key); return new TextEncoder().encode(JSON.stringify({ ok: true, publicKey: "trusted" })).buffer; }
      if (cmd === "net_socket_open") (args!.events as { onmessage(event: unknown): void }).onmessage({ kind: "error", error: "native_socket_timeout" });
    });
    const connection = new fixture.HubConnection({ deviceId: "fixture", name: "Fixture", publicKey: "device", hubPublicKey: "trusted", routes: [{ name: "VPS", url: "https://hub.invalid" }] });
    let failed = false;
    const retry = new Promise<string | undefined>(resolve => {
      const off = connection.subscribe(() => {
        if (connection.state.status === "offline" && connection.state.error) failed = true;
        if (failed && connection.state.status === "connecting") { off(); resolve(connection.state.error); }
      });
    });
    void (connection as unknown as { connect(): Promise<void> }).connect();
    const retained = await retry; connection.close(); fixture.renderRoutes(connection); return retained;
  });
  expect(result).toBe("主机响应超时，正在自动重试。请确认主机仍在运行。");
  await expect(page.getByText(result!, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeEnabled();
});
test("a delayed native signature does not pile up credential reads across reconnects", async ({ page }) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  await page.exposeFunction("auditHubProof", (deviceId: string, nonce: string) => sign(null, Buffer.from(`tarocub/server/v1\0${deviceId}\0challenge\0${nonce}`), keys.privateKey).toString("base64"));
  await page.evaluate(async publicKey => {
    const api = window as any, fixture = window.nativeTransportFixture;
    let next = 0, signatures = 0, sockets = 0;
    const read = new Set<string>(), channels = new Map<string, { onmessage(event: unknown): void }>();
    fixture.mockIPC(async (cmd, args) => {
      if (cmd === "net_allocate") return `credential-${++next}`;
      if (cmd === "net_http_open") return { status: 200, headers: [] };
      if (cmd === "net_http_read") { const id = String(args!.id); if (read.has(id)) return new ArrayBuffer(0); read.add(id); return new TextEncoder().encode(JSON.stringify({ ok: true, publicKey })).buffer; }
      if (cmd === "net_socket_open") { sockets++; const channel = args!.events as { onmessage(event: unknown): void }; channels.set(String(args!.id), channel); channel.onmessage({ kind: "open" }); }
      if (cmd === "net_socket_close") channels.get(String(args!.id))?.onmessage({ kind: "close", code: 1000, reason: "", clean: true });
      if (cmd === "device_sign") { signatures++; if (signatures === 1) return new Promise(resolve => { api.releaseSignature = () => resolve("first-proof"); }); return "fresh-proof"; }
      if (cmd === "net_socket_send") {
        const frame = JSON.parse(String(args!.text)), channel = channels.get(String(args!.id))!;
        if (frame.type === "hello") channel.onmessage({ kind: "message", sequence: 1, data: JSON.stringify({ v: 1, type: "challenge", nonce: "challenge", publicKey, signature: await api.auditHubProof(frame.deviceId, frame.nonce) }) });
        if (frame.type === "auth") channel.onmessage({ kind: "message", sequence: 2, data: JSON.stringify({ v: 1, type: "ready", sessionToken: "fixture", expiresAt: Date.now() + 60_000, user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: [] }) });
      }
    });
    const connection = new fixture.HubConnection({ deviceId: "device_fixture", keyRef: "device_fixture", name: "Fixture", publicKey: "device", hubPublicKey: publicKey, routes: [{ name: "VPS", url: "https://hub.invalid" }] });
    api.signatureState = () => ({ signatures, sockets, status: connection.state.status, error: connection.state.error });
    api.closeSignatureTest = () => connection.close();
    void (connection as unknown as { connect(): Promise<void> }).connect();
  }, publicKey);
  await expect.poll(() => page.evaluate(() => (window as any).signatureState().error), { timeout: 10_000 }).toContain("正在等待系统确认设备身份");
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => { const { signatures, sockets } = (window as any).signatureState(); return { signatures, sockets }; })).toEqual({ signatures: 1, sockets: 1 });
  await page.evaluate(() => (window as any).releaseSignature());
  await expect.poll(() => page.evaluate(() => (window as any).signatureState().status)).toBe("online");
  expect(await page.evaluate(() => (window as any).signatureState())).toEqual({ signatures: 2, sockets: 2, status: "online", error: undefined });
  await page.evaluate(() => (window as any).closeSignatureTest());
});
for (const locale of ["zh", "en"] as const) test(`concurrent host signatures recover automatically after secure storage is busy (${locale})`, async ({ page }) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  await page.exposeFunction("auditConcurrentHubProof", (deviceId: string, nonce: string) => sign(null, Buffer.from(`tarocub/server/v1\0${deviceId}\0challenge\0${nonce}`), keys.privateKey).toString("base64"));
  await page.evaluate(({ publicKey, locale }) => {
    const api = window as any, fixture = window.nativeTransportFixture;
    fixture.setLocale(locale);
    let next = 0, busy = 0, completed = 0, locked = false;
    const errors = new Set<string>(), read = new Set<string>();
    const channels = new Map<string, { channel: { onmessage(event: unknown): void }; sequence: number }>();
    fixture.mockIPC(async (cmd, args) => {
      if (cmd === "net_allocate") return `concurrent-${++next}`;
      if (cmd === "net_http_open") return { status: 200, headers: [] };
      if (cmd === "net_http_read") { const id = String(args!.id); if (read.has(id)) return new ArrayBuffer(0); read.add(id); return new TextEncoder().encode(JSON.stringify({ ok: true, publicKey })).buffer; }
      if (cmd === "net_socket_open") { const channel = args!.events as { onmessage(event: unknown): void }; channels.set(String(args!.id), { channel, sequence: 0 }); channel.onmessage({ kind: "open" }); }
      if (cmd === "net_socket_close") channels.get(String(args!.id))?.channel.onmessage({ kind: "close", code: 1000, reason: "", clean: true });
      if (cmd === "device_sign") {
        // Model the production non-queuing semaphore; this never calls the OS.
        if (locked) { busy++; throw locale === "zh" ? "system_keychain_busy" : new Error("system_keychain_busy"); }
        locked = true;
        if (completed === 0) await new Promise<void>(resolve => { api.releaseConcurrentKeychain = resolve; });
        else await new Promise(resolve => setTimeout(resolve, 50));
        locked = false; completed++; return "fixture-proof";
      }
      if (cmd === "net_socket_send") {
        const frame = JSON.parse(String(args!.text)), state = channels.get(String(args!.id))!;
        const emit = (value: unknown) => state.channel.onmessage({ kind: "message", sequence: ++state.sequence, data: JSON.stringify(value) });
        if (frame.type === "hello") emit({ v: 1, type: "challenge", nonce: "challenge", publicKey, signature: await api.auditConcurrentHubProof(frame.deviceId, frame.nonce) });
        if (frame.type === "auth") emit({ v: 1, type: "ready", sessionToken: "fixture", expiresAt: Date.now() + 60_000, user: { id: "owner", name: "Owner", role: "owner" }, bots: [], conversations: [] });
        if (frame.type === "ping") emit({ v: 1, type: "pong" });
      }
    });
    const connections = [1, 2, 3].map(id => new fixture.HubConnection({ deviceId: `device_concurrent_${id}`, keyRef: `device_concurrent_${id}`, name: `Host ${id}`, publicKey: "device", hubPublicKey: publicKey, routes: [{ name: "VPS", url: `https://host${id}.invalid` }] }));
    for (const connection of connections) {
      connection.subscribe(() => { if (connection.state.error) errors.add(connection.state.error); });
      void (connection as unknown as { connect(): Promise<void> }).connect();
    }
    api.concurrentKeychainState = () => ({ busy, completed, errors: [...errors], statuses: connections.map(connection => connection.state.status), currentErrors: connections.map(connection => connection.state.error ?? null) });
    api.closeConcurrentKeychain = () => connections.forEach(connection => connection.close());
  }, { publicKey, locale });
  try {
    await expect.poll(() => page.evaluate(() => (window as any).concurrentKeychainState().busy)).toBeGreaterThanOrEqual(2);
    const message = locale === "zh" ? "设备安全存储正忙，正在自动重试。配对和草稿仍保留。" : "Device secure storage is busy. Retrying automatically; pairing and drafts are retained.";
    await expect.poll(() => page.evaluate(() => (window as any).concurrentKeychainState().errors)).toEqual([message]);
    await page.evaluate(() => (window as any).releaseConcurrentKeychain());
    await expect.poll(() => page.evaluate(() => (window as any).concurrentKeychainState().statuses), { timeout: 10_000 }).toEqual(["online", "online", "online"]);
    expect(await page.evaluate(() => { const { completed, currentErrors } = (window as any).concurrentKeychainState(); return { completed, currentErrors }; })).toEqual({ completed: 3, currentErrors: [null, null, null] });
  } finally { await page.evaluate(() => (window as any).closeConcurrentKeychain()); }
});
test("desktop remote pairing requires a complete time-limited invitation before network access", async ({ page }) => {
  await page.evaluate(() => { const fixture = window.nativeTransportFixture; fixture.mockIPC(() => { throw new Error("unexpected_network"); }); fixture.renderPairing({ localHostReady: true }); });
  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await page.getByRole("button", { name: "手动连接与高级选项", exact: true }).click();
  await page.getByLabel("Hub 地址", { exact: true }).fill("https://hub.invalid");
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("首次配对需要有效的限时连接码");
  await expect(page.getByLabel("主机身份公钥", { exact: true })).toBeVisible();
});
for (const locale of ["zh", "en"] as const) {
  for (const failure of [
    { code: "hub_tls_identity_required", zh: "暂时无法完成主机安全验证，请检查主机是否运行、版本是否支持，并核对连接地址。", en: "Unable to verify the host right now. Check that it is running a supported version and that the connection address is correct." },
    { code: "tls_identity_mismatch", zh: "主机身份校验未通过，请核对连接地址和主机身份公钥。", en: "Host identity verification failed. Check the connection address and host identity public key." },
    { code: "invalid_hub_key", zh: "主机身份公钥格式不正确，请重新从主机或已信任设备复制。", en: "The host identity public key is invalid. Copy it again from the host or a trusted device." },
    { code: "trusted_hub_key_required", zh: "主机身份公钥格式不正确，请重新从主机或已信任设备复制。", en: "The host identity public key is invalid. Copy it again from the host or a trusted device." },
  ]) {
    test(`pairing explains ${failure.code} in ${locale} before creating or sending a device identity`, async ({ page }) => {
      await page.evaluate(({ locale, code }) => {
        const fixture = window.nativeTransportFixture; fixture.setLocale(locale);
        const calls: string[] = []; Object.assign(window, { verificationCalls: calls });
        fixture.mockIPC((cmd) => {
          if (cmd === "desktop_host") return { available: true, running: true, hostName: "Fixture host" };
          calls.push(cmd);
          if (cmd === "net_allocate") return "verify";
          // Tauri rejects with a string; Capacitor's bridge uses Error objects.
          if (cmd === "net_http_open") return Promise.reject(locale === "zh" ? code : new Error(code));
        }); fixture.renderPairing({ localHostReady: true });
      }, { locale, code: failure.code });
      await page.getByRole("button", { name: locale === "zh" ? "连接已有主机" : "Connect to an existing host", exact: true }).click();
      await importNativeInvitation(page, "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=", locale);
      await page.getByRole("button", { name: locale === "zh" ? "配对此设备" : "Pair this device", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText(failure[locale]);
      expect(await page.evaluate(() => (window as unknown as { verificationCalls: string[] }).verificationCalls)).toEqual(["net_allocate", "net_http_open", "net_cancel"]);
    });
  }
}

test("reconnect and route settings retain each verification cause, including after a language change", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const fixture = window.nativeTransportFixture; let id = 0;
    fixture.mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `verify-${++id}`;
      if (cmd === "net_http_open") throw new Error((args!.input as { origin: string }).origin.includes("primary") ? "hub_tls_identity_required" : "tls_identity_mismatch");
    });
    const connection = new fixture.HubConnection({ deviceId: "fixture", name: "Fixture", publicKey: "device", hubPublicKey: "trusted", routes: [{ name: "VPS", label: "Primary", url: "https://primary.invalid" }, { name: "VPS", label: "Backup", url: "https://backup.invalid" }] });
    const error = await (connection as unknown as { selectRoute(allow: boolean): Promise<unknown> }).selectRoute(true).then(() => "unexpected success", (e: Error) => e.message);
    fixture.renderRoutes(connection); return { error, health: connection.state.routeHealth };
  });
  expect(result).toEqual({ error: "主机身份校验未通过，请先核对连接地址。若确认主机已重装或更换身份，请重新配对。", health: [
    { url: "https://primary.invalid", status: "unreachable", failure: "verification-unavailable" },
    { url: "https://backup.invalid", status: "wrong-hub", failure: "identity-mismatch" },
  ] });
  await expect(page.getByText("主机安全验证不可用", { exact: true })).toBeVisible();
  await expect(page.getByText("主机身份不匹配", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑线路", exact: true }).click();
  await expect(page.getByText("主机安全验证不可用", { exact: true })).toBeVisible();
  await expect(page.getByText("主机身份不匹配", { exact: true })).toBeVisible();
  await page.evaluate(() => window.nativeTransportFixture.setLocale("en"));
  await expect(page.getByText("Host verification unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Host identity mismatch", { exact: true })).toBeVisible();
});

test("a rejected primary identity does not block a verified backup", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { HubConnection, mockIPC } = window.nativeTransportFixture; let count = 0; const read = new Set<string>();
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `request-${++count}`;
      if (cmd === "net_http_open") {
        if ((args!.input as { origin: string }).origin === "https://primary.invalid") throw new Error("tls_identity_mismatch");
        return { status: 200, headers: [] };
      }
      if (cmd === "net_http_read") { const id = String(args!.id); if (read.has(id)) return new ArrayBuffer(0); read.add(id); return new TextEncoder().encode(JSON.stringify({ ok: true, publicKey: "trusted" })).buffer; }
    });
    const connection = new HubConnection({ deviceId: "fixture", name: "Fixture", publicKey: "device", hubPublicKey: "trusted", routes: [{ name: "Tailscale", url: "https://primary.invalid" }, { name: "VPS", url: "https://backup.invalid" }] });
    const selected = await (connection as unknown as { selectRoute(allow: boolean): Promise<{ route: { url: string } }> }).selectRoute(true);
    return { route: selected.route.url, primary: connection.state.routeHealth?.[0] };
  });
  expect(result).toEqual({ route: "https://backup.invalid", primary: { url: "https://primary.invalid", status: "wrong-hub", failure: "identity-mismatch" } });
});

test("malformed invitation public keys are explained before any network or device allocation", async ({ page }) => {
  await page.evaluate(() => {
    const fixture = window.nativeTransportFixture; const calls: string[] = []; Object.assign(window, { verificationCalls: calls });
    fixture.mockIPC((cmd) => { if (cmd === "desktop_host") return { available: true, running: true, hostName: "Fixture host" }; calls.push(cmd); throw new Error("unexpected_native_call"); }); fixture.renderPairing({ localHostReady: true });
  });
  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  for (const key of ["not-a-key".repeat(6), "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9=", "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"]) {
    await importNativeInvitation(page, key);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("主机身份公钥格式不正确，请重新从主机或已信任设备复制。");
  }
  expect(await page.evaluate(() => (window as unknown as { verificationCalls: string[] }).verificationCalls)).toEqual([]);
});

for (const mismatched of [false, true]) test(`invitation preserves the full pinned key and ${mismatched ? "rejects a changed pair identity while retaining uncertain enrollment" : "pairs successfully"}`, async ({ page }) => {
  const key = "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  await page.evaluate(({ key, mismatched }) => {
    const fixture = window.nativeTransportFixture; let allocated = 0;
    const paths = new Map<string, string>(), read = new Set<string>();
    const state = { keys: [] as unknown[], requests: [] as string[], created: 0, forgotten: [] as unknown[] }; Object.assign(window, { pairingKeyState: state });
    fixture.mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `paste-${++allocated}`;
      if (cmd === "net_http_open") {
        const input = args!.input as { path: string; hubKey: string }; paths.set(String(args!.id), input.path); state.keys.push(input.hubKey); state.requests.push(input.path);
        return { status: 200, headers: [] };
      }
      if (cmd === "net_http_read") {
        const id = String(args!.id); if (read.has(id)) return new ArrayBuffer(0); read.add(id);
        return new TextEncoder().encode(JSON.stringify(paths.get(id) === "/health" ? { ok: true, publicKey: key, pairingInvites: 1 } : { code: "12345678", expiresAt: Date.now() + 300_000, hubPublicKey: mismatched ? "other-host" : key })).buffer;
      }
      if (cmd === "device_create") { state.created++; return { deviceId: "device_fixture", keyRef: "device_fixture", publicKey: key }; }
      if (cmd === "device_forget") state.forgotten.push(args!.keyRef);
    }); fixture.renderPairing({ localHostReady: true });
  }, { key, mismatched });
  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await importNativeInvitation(page, key);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  if (mismatched) await expect(page.getByRole("alert")).toHaveText("主机身份校验未通过，请核对连接地址和主机身份公钥。");
  else await expect(page.getByLabel("配对码", { exact: true })).toHaveText("12345678");
  const result = await page.evaluate(() => (window as unknown as { pairingKeyState: { keys: string[]; requests: string[]; created: number; forgotten: string[] } }).pairingKeyState);
  expect(new Set(result.keys)).toEqual(new Set([key]));
  expect(result.requests.filter(path => path === "/api/pair")).toEqual(["/api/pair"]);
  expect(result.requests[0]).toBe("/health");
  expect(result.created).toBe(1); expect(result.forgotten).toEqual([]);
});
test("abort during allocation cancels the receipt before a POST can start", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubFetch, mockIPC } = window.nativeTransportFixture; const log: string[] = [];
    let release!: (id: string) => void, started!: () => void;
    const allocated = new Promise<void>((r) => { started = r; });
    mockIPC((cmd) => { log.push(cmd); if (cmd === "net_allocate") { started(); return new Promise<string>((r) => { release = r; }); } });
    const controller = new AbortController();
    const response = hubFetch("https://hub.invalid", "/api/pair", "trusted", { method: "POST", body: "test", signal: controller.signal }).catch((e: Error) => e.name);
    await allocated; controller.abort(); release("id-1"); return { error: await response, log };
  })).toEqual({ error: "AbortError", log: ["net_allocate", "net_cancel"] });
});
test("native response streams pull on demand and cancellation releases the request", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { hubFetch, mockIPC } = window.nativeTransportFixture; let reads = 0, cancels = 0; const chunks = [new Uint8Array([1,2,3]).buffer, new Uint8Array([4,5]).buffer, new ArrayBuffer(0)]; let input: unknown;
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return "stream";
      if (cmd === "net_http_open") { input = args?.input; return { status: 206, headers: [["content-range", "bytes 0-4/5"]] }; }
      if (cmd === "net_http_read") { reads++; return chunks.shift(); }
      if (cmd === "net_cancel") cancels++;
    });
    const response = await hubFetch("https://hub.invalid", "/api/attachments/a", "trusted", { headers: { Authorization: "Bearer synthetic", Range: "bytes=0-4" } });
    const beforeRead = reads, received = [...new Uint8Array(await response.arrayBuffer())];
    const second = await hubFetch("https://hub.invalid", "/api/attachments/a", "trusted"); await second.body!.cancel();
    return { beforeRead, received, reads, cancels, status: response.status, range: response.headers.get("Content-Range"), input };
  });
  expect(result).toMatchObject({ beforeRead: 0, received: [1,2,3,4,5], reads: 3, cancels: 1, status: 206, range: "bytes 0-4/5" });
});
test("abort while reading errors the stream and cannot expose a late chunk", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubFetch, mockIPC } = window.nativeTransportFixture; let release!: (value: ArrayBuffer) => void, reading!: () => void; let cancels = 0;
    const started = new Promise<void>((r) => { reading = r; });
    mockIPC((cmd) => {
      if (cmd === "net_allocate") return "stream";
      if (cmd === "net_http_open") return { status: 200, headers: [] };
      if (cmd === "net_http_read") { reading(); return new Promise<ArrayBuffer>((r) => { release = r; }); }
      if (cmd === "net_cancel") cancels++;
    });
    const controller = new AbortController(); const response = await hubFetch("https://hub.invalid", "/api/data", "trusted", { signal: controller.signal });
    const result = response.body!.getReader().read().then(() => "leaked", (e: Error) => e.name); await started; controller.abort(); release(new Uint8Array([65]).buffer);
    return { error: await result, cancels };
  })).toEqual({ error: "AbortError", cancels: 1 });
});
test("close before socket allocation never opens a late connection", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubSocket, mockIPC } = window.nativeTransportFixture; let release!: (value: string) => void, started!: () => void; const log: string[] = [];
    const allocating = new Promise<void>((resolve) => { started = resolve; });
    mockIPC((cmd) => { log.push(cmd); if (cmd === "net_allocate") { started(); return new Promise<string>((r) => { release = r; }); } });
    const ws = hubSocket("https://hub.invalid", "trusted"); const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    await allocating; ws.close(); release("late"); const code = await closed; await new Promise((r) => setTimeout(r, 0)); return { code, log };
  })).toEqual({ code: 1006, log: ["net_allocate", "net_cancel"] });
});
test("socket preserves send order through close and acknowledges incoming delivery", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { hubSocket, mockIPC } = window.nativeTransportFixture; const sent: string[] = [], received: string[] = []; let events: { onmessage(event: unknown): void };
    mockIPC(async (cmd, args) => {
      if (cmd === "net_allocate") return "socket";
      if (cmd === "net_socket_open") { events = args!.events as typeof events; events.onmessage({ kind: "open" }); }
      // Tauri maps Rust parameter `text: String` to this exact IPC key.
      if (cmd === "net_socket_send") { if (typeof args!.text !== "string") throw new Error("missing text"); if (args!.text === "one") await new Promise((r) => setTimeout(r, 30)); sent.push(args!.text); }
      if (cmd === "net_socket_ack") sent.push(`ack:${args!.sequence}`);
      if (cmd === "net_socket_close") { sent.push("close"); setTimeout(() => events.onmessage({ kind: "close", code: 1000, reason: "", clean: true }), 10); return true; }
    });
    const ws = hubSocket("https://hub.invalid", "trusted"); await new Promise<void>((r) => { ws.onopen = () => r(); });
    ws.onmessage = (event) => received.push(event.data);
    events!.onmessage({ kind: "message", data: "reply", sequence: 1 });
    ws.send("one"); ws.send("two"); ws.close(); await new Promise<void>((r) => { ws.onclose = () => r(); });
    return { sent, received, readyState: ws.readyState };
  });
  expect(result).toEqual({ sent: ["ack:1", "one", "two", "close"], received: ["reply"], readyState: 3 });
});

test("late send and ack rejection preserve the real close and preceding messages", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubSocket, mockIPC } = window.nativeTransportFixture; let events: { onmessage(event: unknown): void }; let errors = 0, cancels = 0; const received: string[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return "socket";
      if (cmd === "net_socket_open") { events = args!.events as typeof events; events.onmessage({ kind: "open" }); }
      if (cmd === "net_socket_send" || cmd === "net_socket_ack") throw new Error("native_request_cancelled");
      if (cmd === "net_cancel") cancels++;
    });
    const ws = hubSocket("https://hub.invalid", "trusted"); await new Promise<void>((r) => { ws.onopen = () => r(); });
    ws.onerror = () => errors++; ws.onmessage = (event) => received.push(event.data);
    const closed = new Promise<number>((r) => { ws.onclose = (event) => r(event.code); });
    events!.onmessage({ kind: "message", data: "last verified frame", sequence: 1 }); ws.send("heartbeat");
    await new Promise((r) => setTimeout(r, 30)); events!.onmessage({ kind: "close", code: 4001, reason: "session closed", clean: true });
    return { errors, cancels, received, code: await closed };
  })).toEqual({ errors: 0, cancels: 0, received: ["last verified frame"], code: 4001 });
});

test("queued attachments reserve room for health and cancelled queue entries never start", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { hubFetch, mockIPC } = window.nativeTransportFixture; const opened: string[] = []; let count = 0;
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `request-${++count}`;
      if (cmd === "net_http_open") { opened.push((args!.input as { path: string }).path); return { status: 200, headers: [] }; }
      if (cmd === "net_http_read") return new ArrayBuffer(0);
    });
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const work = controllers.map((controller, i) => hubFetch("https://hub.invalid", `/api/attachments/${i}`, "trusted", { signal: controller.signal }).catch((e: Error) => e.name));
    await Promise.all(work.slice(0, 4)); await new Promise((r) => setTimeout(r, 20)); const first = opened.length;
    const health = await hubFetch("https://hub.invalid", "/health", "trusted"); await health.text(); controllers[4]!.abort();
    const cancelled = await work[4]; const response = await work[0]; if (response instanceof Response) await response.body?.cancel();
    const next = await work[5]; controllers.forEach((c) => c.abort()); await Promise.all(work);
    return { first, health: opened.includes("/health"), cancelled, cancelledStarted: opened.includes("/api/attachments/4"), nextStarted: next instanceof Response };
  });
  expect(result).toEqual({ first: 4, health: true, cancelled: "AbortError", cancelledStarted: false, nextStarted: true });
});

test("native reconnect uses a verified alternate without waiting for a blackholed primary", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { HubConnection, mockIPC } = window.nativeTransportFixture; let count = 0; const read = new Set<string>();
    let rejectPrimary!: (reason: Error) => void;
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `request-${++count}`;
      if (cmd === "net_http_open") {
        if ((args!.input as { origin: string }).origin === "https://primary.invalid") return new Promise((_, reject) => { rejectPrimary = reject; });
        return { status: 200, headers: [] };
      }
      if (cmd === "net_http_read") { const id = String(args!.id); if (read.has(id)) return new ArrayBuffer(0); read.add(id); return new TextEncoder().encode(JSON.stringify({ ok: true, publicKey: "trusted" })).buffer; }
    });
    const connection = new HubConnection({ deviceId: "fixture", name: "Fixture", publicKey: "device", hubPublicKey: "trusted", routes: [{ name: "Tailscale", url: "https://primary.invalid" }, { name: "VPS", url: "https://backup.invalid" }] });
    const started = performance.now(); const selected = await (connection as unknown as { selectRoute(allow: boolean): Promise<{ route: { url: string } }> }).selectRoute(true);
    const elapsed = performance.now() - started; rejectPrimary(new Error("fixture_closed")); return { elapsed, route: selected.route.url };
  });
  expect(result.route).toBe("https://backup.invalid"); expect(result.elapsed).toBeLessThan(1000);
});

test("throwing handlers cannot stall the real indexed Tauri Channel", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubSocket, mockIPC, runCallback } = window.nativeTransportFixture;
    let channel = 0; const received: string[] = [], acknowledged: number[] = [], reported: string[] = [];
    window.addEventListener("error", (event) => { reported.push(event.message); event.preventDefault(); });
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return "indexed";
      if (cmd === "net_socket_open") {
        channel = (args!.events as { id: number }).id;
        runCallback(channel, { index: 0, message: { kind: "open" } });
      }
      if (cmd === "net_socket_ack") acknowledged.push(Number(args!.sequence));
    });
    const socket = hubSocket("https://hub.invalid", "trusted");
    await new Promise<void>((resolve) => { socket.onopen = () => { resolve(); throw new Error("open handler failed"); }; });
    socket.onmessage = (event) => { received.push(event.data); if (event.data === "first") throw new Error("message handler failed"); };
    const closed = new Promise<{ code: number; clean: boolean }>((resolve) => { socket.onclose = (event) => { resolve({ code: event.code, clean: event.wasClean }); throw new Error("close handler failed"); }; });
    // Deliver out of order through the SDK callback, not Channel.onmessage.
    runCallback(channel, { index: 2, message: { kind: "message", data: "second", sequence: 2 } });
    runCallback(channel, { index: 1, message: { kind: "message", data: "first", sequence: 1 } });
    runCallback(channel, { index: 3, message: { kind: "close", code: 4001, reason: "revoked", clean: true } });
    runCallback(channel, { index: 4, end: true });
    const close = await closed; await new Promise((resolve) => setTimeout(resolve, 0));
    return { received, acknowledged, close, errors: reported.length };
  })).toEqual({ received: ["first", "second"], acknowledged: [1, 2], close: { code: 4001, clean: true }, errors: 3 });
});

test("a queued local close waits for peer receipt and keeps acknowledging incoming frames", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubSocket, mockIPC } = window.nativeTransportFixture;
    let events: { onmessage(event: unknown): void }; let closes = 0, acknowledgements = 0, receives = 0, sends = 0;
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return "close-receipt";
      if (cmd === "net_socket_open") { events = args!.events as typeof events; events.onmessage({ kind: "open" }); }
      if (cmd === "net_socket_close") return true;
      if (cmd === "net_socket_send") sends++;
      if (cmd === "net_socket_ack") acknowledgements++;
    });
    const socket = hubSocket("https://hub.invalid", "trusted");
    await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
    socket.onmessage = () => receives++;
    const closed = new Promise<{ code: number; clean: boolean }>((resolve) => { socket.onclose = (event) => { closes++; resolve({ code: event.code, clean: event.wasClean }); }; });
    socket.close(); socket.send("ignored after close"); await new Promise((resolve) => setTimeout(resolve, 30));
    const beforePeer = { closes, state: socket.readyState };
    events!.onmessage({ kind: "message", data: "in flight", sequence: 1 });
    events!.onmessage({ kind: "close", code: 4001, reason: "revoked", clean: true });
    socket.send("ignored after closed");
    return { beforePeer, acknowledgements, receives, sends, close: await closed };
  })).toEqual({ beforePeer: { closes: 0, state: 2 }, acknowledgements: 1, receives: 0, sends: 0, close: { code: 4001, clean: true } });
});

test("unread response watchdog frees the request queue", async ({ page }) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const { hubFetch, mockIPC } = window.nativeTransportFixture; let allocated = 0;
    const state = { opened: 0, cancelled: 0, fifth: false }; Object.assign(window, { idleState: state });
    mockIPC((cmd) => {
      if (cmd === "net_allocate") return `idle-${++allocated}`;
      if (cmd === "net_http_open") { state.opened++; return { status: 200, headers: [] }; }
      if (cmd === "net_cancel") state.cancelled++;
    });
    await Promise.all(Array.from({ length: 4 }, () => hubFetch("https://hub.invalid", "/api/data", "trusted")));
    void hubFetch("https://hub.invalid", "/api/data", "trusted").then(async (response) => { state.fifth = true; await response.body!.cancel(); });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { idleState: { opened: number } }).idleState.opened)).toBe(4);
  await page.clock.fastForward(30_001);
  await expect.poll(() => page.evaluate(() => (window as unknown as { idleState: unknown }).idleState)).toEqual({ opened: 5, cancelled: 5, fifth: true });
});

test("page retirement cancels existing work and rejects old-document reconnects", async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { hubFetch, hubSocket, mockIPC } = window.nativeTransportFixture; let allocations = 0, cancelled = 0;
    const documents: unknown[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") { documents.push(args!.document); return `old-${++allocations}`; }
      if (cmd === "net_http_open") return { status: 200, headers: [] };
      if (cmd === "net_socket_open") (args!.events as { onmessage(event: unknown): void }).onmessage({ kind: "open" });
      if (cmd === "net_cancel") cancelled++;
    });
    const response = await hubFetch("https://hub.invalid", "/api/data", "trusted");
    const socket = hubSocket("https://hub.invalid", "trusted");
    await new Promise<void>((resolve) => { socket.onopen = () => resolve(); });
    const close = new Promise<number>((resolve) => { socket.onclose = (event) => resolve(event.code); });
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    const request = await hubFetch("https://hub.invalid", "/api/change", "trusted", { method: "POST", body: "must not send" }).then(() => "escaped", (e: Error) => e.message);
    const stream = await response.body!.getReader().read().then(() => "escaped", (e: Error) => e.message);
    const reconnect = await new Promise<number>((resolve) => { const ws = hubSocket("https://hub.invalid", "trusted"); ws.onclose = (event) => resolve(event.code); });
    return { allocations, documents, cancelled, request, stream, close: await close, reconnect };
  })).toEqual({ allocations: 2, documents: ["fixture-document", "fixture-document"], cancelled: 2, request: "native_document_retired", stream: "native_document_retired", close: 1006, reconnect: 1006 });
});

test("Windows offers local hosting and can return from failed remote pairing", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    const calls = { starts: 0, pairs: 0, saves: 0 };
    Object.assign(window, { windowsLocalBeforeRemote: calls });
    window.nativeTransportFixture.mockIPC((command, args) => {
      if (command === "desktop_host" && args?.action === "status") return { available: true, running: false, hostName: "Windows 工作主机" };
      if (command === "desktop_host" && args?.action === "start") { calls.starts++; return { available: true, running: true, hostName: "Windows 工作主机", url: "http://127.0.0.1:8788", publicKey: "local-host" }; }
      if (command === "device_create") return { deviceId: "device_windows_local", keyRef: "device_windows_local", publicKey: "local-device" };
      if (command === "desktop_host" && args?.action === "pair") { calls.pairs++; return { ok: true }; }
      throw new Error("unexpected_native_request");
    });
    window.nativeTransportFixture.renderPairing({ save: async () => { calls.saves++; } });
  });
  await expect(page.getByRole("heading", { name: "从这台电脑开始" })).toBeVisible();
  await expect(page.getByRole("button", { name: "将这台电脑设为主机", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await expect(page.getByRole("heading", { name: "连接你的 TaroBird" })).toBeVisible();
  await expect(page.getByRole("button", { name: "粘贴连接信息", exact: true })).toBeVisible();
  await expect(page.getByLabel("主机身份公钥", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "手动连接与高级选项", exact: true }).click();
  await expect(page.getByLabel("Hub 地址", { exact: true })).toBeVisible();
  await expect(page.getByLabel("主机身份公钥", { exact: true })).toBeVisible();
  await page.getByLabel("Hub 地址", { exact: true }).fill("https://host.example:8788");
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("首次配对需要有效的限时连接码");
  await expect(page.getByRole("alert")).not.toContainText("unexpected_native_request");
  await page.getByRole("button", { name: "返回开始", exact: true }).click();
  await expect(page.getByRole("heading", { name: "从这台电脑开始" })).toBeVisible();
  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await expect(page.getByLabel("Hub 地址", { exact: true })).toHaveValue("https://host.example:8788");
  expect(await page.evaluate(() => (window as unknown as { windowsLocalBeforeRemote: { starts: number; pairs: number; saves: number } }).windowsLocalBeforeRemote)).toEqual({ starts: 1, pairs: 1, saves: 1 });
});

test("first desktop launch separates hosting from remote pairing and reports missing runtime", async ({ page }) => {
  await page.evaluate(() => { const f = window.nativeTransportFixture; f.mockIPC(() => Promise.reject("desktop_host_runtime_missing")); f.renderPairing(); });
  await expect(page.getByRole("heading", { name: "从这台电脑开始" })).toBeVisible();
  await expect(page.getByLabel("Hub 地址", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /将这台电脑设为主机/ }).click();
  await expect(page.getByRole("alert")).toHaveText("此安装包缺少主机组件，请下载包含主机的桌面版本。");
  await expect(page.getByRole("button", { name: /将这台电脑设为主机/ })).toBeEnabled();
});

for (const platform of ["macos", "windows"] as const) {
  test(`${platform} restored pending pairing returns to start without losing enrollment or stealing navigation`, async ({ page }) => {
    await page.evaluate((platform) => {
      if (platform === "windows") Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
      const fixture = window.nativeTransportFixture;
      const connection = new fixture.HubConnection({ deviceId: "pending-device", name: "My desktop", publicKey: "device", hubPublicKey: "trusted", routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }], pendingPairing: { code: "12345678", expiresAt: Date.now() + 300000 } });
      const result = { connected: 0, starts: 0, discarded: 0 };
      Object.assign(window, { pendingReturnFixture: { result, connection } });
      fixture.mockIPC((command, args) => {
        if (command === "desktop_host" && args?.action === "start") { result.starts++; return Promise.reject("desktop_host_runtime_missing"); }
        throw new Error("unexpected_native_request");
      });
      fixture.renderPairing({ pendingConnection: connection, connected: () => { result.connected++; }, discard: async () => { result.discarded++; } });
    }, platform);
    await expect(page.getByLabel("配对码", { exact: true })).toHaveText("12345678");
    await page.getByRole("button", { name: "返回开始", exact: true }).click();
    await expect(page.getByRole("heading", { name: "从这台电脑开始" })).toBeVisible();
    if (platform === "macos") {
      await page.getByRole("button", { name: "将这台电脑设为主机", exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText("此安装包缺少主机组件，请下载包含主机的桌面版本。");
    }
    await page.evaluate(() => {
      const { connection } = (window as unknown as { pendingReturnFixture: { connection: HubConnection } }).pendingReturnFixture;
      (connection as unknown as { update(value: { status: string }): void }).update({ status: "online" });
    });
    await expect(page.getByRole("heading", { name: "从这台电脑开始" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { pendingReturnFixture: { result: { connected: number; starts: number; discarded: number } } }).pendingReturnFixture.result)).toEqual({ connected: 0, starts: platform === "macos" ? 1 : 0, discarded: 0 });
    await page.getByRole("button", { name: "继续连接已有主机", exact: true }).click();
    await expect(page.getByLabel("配对码", { exact: true })).toHaveText("12345678");
    await expect.poll(() => page.evaluate(() => (window as unknown as { pendingReturnFixture: { result: { connected: number } } }).pendingReturnFixture.result.connected)).toBe(1);
  });
}

for (const platform of ["macos", "windows"]) test(`${platform}: returning from remote enrollment can complete local host setup with a different device identity`, async ({ page }) => {
  await page.evaluate(platform => {
    if (platform === "windows") Object.defineProperty(navigator, "userAgent", { value: "Windows NT 10.0" });
    const fixture = window.nativeTransportFixture;
    const remote = new fixture.HubConnection({ deviceId: "device_remote", name: "Remote pairing", publicKey: "remote-device", hubPublicKey: "remote-host", routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }], pendingPairing: { code: "12345678", expiresAt: Date.now() + 300000 } });
    const result = { saved: "", connected: "", paired: "", remote };
    Object.assign(window, { localAfterRemote: result });
    fixture.mockIPC((command, args) => {
      if (command === "device_create") return { deviceId: "device_local", keyRef: "device_local", publicKey: "local-device" };
      if (command === "desktop_host" && args?.action === "start") return { available: true, running: true, url: "http://127.0.0.1:8789", publicKey: "local-host" };
      if (command === "desktop_host" && args?.action === "pair") { result.paired = (args.device as { deviceId: string }).deviceId; return {}; }
      throw new Error("unexpected_native_request");
    });
    fixture.renderPairing({ pendingConnection: remote, save: async identity => { result.saved = identity.deviceId; }, connected: identity => { result.connected = identity.deviceId; } });
  }, platform);
  await page.getByRole("button", { name: "返回开始", exact: true }).click();
  await page.getByRole("button", { name: "将这台电脑设为主机", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const { saved, connected, paired, remote } = (window as unknown as { localAfterRemote: { saved: string; connected: string; paired: string; remote: HubConnection } }).localAfterRemote;
    return { saved, connected, paired, pending: remote.identity.pendingPairing?.code };
  })).toEqual({ saved: "device_local", connected: "device_local", paired: "device_local", pending: "12345678" });
});


test("local route protection stays closed during identity lookup and failure, then resolves the native host", async ({ page }) => {
  await page.evaluate(() => {
    const f = window.nativeTransportFixture as any;
    f.mockIPC((cmd: string) => { if (cmd === "desktop_host") return new Promise((_resolve, reject) => { (window as any).failLocalLookup = () => reject(new Error("host restarting")); }); });
    f.renderProtectedRoutes(new f.HubConnection({ deviceId: "fixture", name: "Fixture", publicKey: "device", hubPublicKey: "local-key", routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }] }));
  });
  await expect(page.getByRole("button", { name: "编辑线路", exact: true })).toHaveCount(0);
  await expect(page.getByText("正在确认本机身份，暂不修改连接线路。", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).failLocalLookup());
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑线路", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.nativeTransportFixture.mockIPC(cmd => { if (cmd === "desktop_host") return { publicKey: "local-key" }; }));
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("button", { name: "局域网与 Tailscale", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "编辑线路", exact: true })).toHaveCount(0);
});

for (const phase of ["open", "read"] as const) test(`native ${phase} EOF resumes only the incomplete range without a socket reconnect`, async ({ page }) => {
  const result = await page.evaluate(async phase => {
    const { hubFetch, mockIPC, downloadAttachment } = window.nativeTransportFixture;
    // Larger than one range; first range must remain committed through failure.
    const chunk = 8 * 1024 * 1024, bytes = new Uint8Array(chunk + 17).fill(7);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    const requests: string[] = [], operations = new Map<string, { start: number; end: number; position: number }>();
    let serial = 0, failed = false, released = 0, resumed = 0, escaped = 0;
    window.fetch = () => { escaped++; throw new Error("unpinned_fetch"); };
    mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return String(++serial);
      if (cmd === "net_http_open") {
        const input = args!.input as { headers: [string, string][]; method: string; hubKey: string };
        if (input.method !== "GET" || input.hubKey !== "trusted") throw new Error("incorrect_request");
        const range = new Headers(input.headers).get("Range")!; requests.push(range);
        const [start, end] = range.slice(6).split("-").map(Number);
        operations.set(String(args!.id), { start, end: Math.min(end, bytes.length - 1), position: start });
        if (phase === "open" && start > 0 && !failed) { failed = true; throw new Error("unexpected end of stream on https://hub.invalid/..."); }
        return { status: 206, headers: [["ETag", `"${digest}"`], ["Content-Type", "image/png"], ["Content-Range", `bytes ${start}-${Math.min(end, bytes.length - 1)}/${bytes.length}`]] };
      }
      if (cmd === "net_http_read") {
        const op = operations.get(String(args!.id))!;
        if (phase === "read" && op.start > 0 && !failed) { failed = true; throw "unexpected end of stream on https://hub.invalid/..."; }
        if (op.position > op.end) return new ArrayBuffer(0); const part = bytes.slice(op.position, Math.min(op.position + 256 * 1024, op.end + 1)); op.position += part.length; return part.buffer;
      }
    });
    const connection = { state: { status: "online" }, isClosed: false, subscribe: () => () => {}, resume: () => { resumed++; }, beginFileTransfer: () => () => { released++; },
      readAttachment: async <T,>(id: string, headers: Record<string, string>, consume: (response: Response) => Promise<T>, signal?: AbortSignal) => consume(await hubFetch("https://hub.invalid", `/api/attachments/${id}`, "trusted", { headers, signal })) };
    const blob = await downloadAttachment(connection, "image");
    return { requests, released, resumed, escaped, size: blob.size, correct: new Uint8Array(await blob.arrayBuffer()).every(value => value === 7) };
  }, phase);
  expect(result).toEqual({ requests: ["bytes=0-8388607", "bytes=8388608-8388624", "bytes=8388608-8388624"], released: 1, resumed: 0, escaped: 0, size: 8388625, correct: true });
});

test("native HTTP security and lifecycle rejections remain terminal", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { hubFetch, mockIPC, downloadAttachment } = window.nativeTransportFixture;
    const results = [];
    for (const reason of ["hub_identity_mismatch", "certificate_verify_failed", "native_document_retired", "native_request_cancelled", "invalid_native_chunk", "unrecognized_failure"]) {
      let calls = 0;
      mockIPC(cmd => { if (cmd === "net_allocate") return reason; if (cmd === "net_http_open") { calls++; throw new Error(reason); } });
      const connection = { state: { status: "online" }, isClosed: false, subscribe: () => () => {}, resume: () => {}, beginFileTransfer: () => () => {},
        readAttachment: async <T,>(_id: string, headers: Record<string, string>, consume: (response: Response) => Promise<T>) => consume(await hubFetch("https://hub.invalid", "/api/attachments/image", "trusted", { headers })) };
      const error = await downloadAttachment(connection, "image").then(() => "unexpected_success", (e: Error) => e.message);
      results.push({ reason, error, calls });
    }
    return results;
  });
  for (const result of results) expect(result).toEqual({ reason: result.reason, error: result.reason, calls: 1 });
});

test("known native HTTP interruptions are transient but transport never replays a POST", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { hubFetch, mockIPC } = window.nativeTransportFixture;
    const results = [];
    for (const reason of ["Connection reset", "connection reset by peer", "native_response_idle_timeout"]) {
      let calls = 0;
      mockIPC(cmd => { if (cmd === "net_allocate") return reason; if (cmd === "net_http_open") { calls++; throw new Error(reason); } });
      const transient = await hubFetch("https://hub.invalid", "/api/pair", "trusted", { method: "POST", body: "fixture" }).then(() => false, error => error instanceof TypeError);
      results.push({ transient, calls });
    }
    return results;
  });
  expect(results).toEqual(Array.from({ length: 3 }, () => ({ transient: true, calls: 1 })));
});


test("local VPS validation uses native pinned transport and rejects the wrong host without publishing", async ({ page }) => {
  await page.evaluate(() => {
    const f = window.nativeTransportFixture as any;
    const key = "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const view = { host: { publicKey: key, routes: [] } };
    const connection = new f.HubConnection({ deviceId: "device_local", name: "Local", publicKey: "device", hubPublicKey: key, routes: [{ name: "Direct", url: "http://127.0.0.1:8788" }] });
    connection.state = { ...connection.state, status: "online", user: { role: "owner" }, networkAvailable: true, network: view };
    const result = { published: 0, escaped: 0, requests: [] as unknown[] };
    (window as any).localRelayNative = result;
    connection.refreshNetwork = async () => view;
    connection.networkCommand = async () => { result.published++; throw Error("must_not_publish"); };
    window.fetch = () => { result.escaped++; throw Error("untrusted_browser_fetch"); };
    f.mockIPC((cmd: string, args: any) => {
      if (cmd === "desktop_host") return { running: true, publicKey: key };
      if (cmd === "net_allocate") return "relay-probe";
      if (cmd === "net_http_open") { result.requests.push(args.input); throw "tls_identity_mismatch"; }
    });
    f.renderConnectionPanel(connection);
  });
  await page.getByRole("button", { name: "添加 VPS 中转", exact: true }).click();
  await page.getByLabel("中转地址", { exact: true }).fill("https://relay.example.com:8445");
  await page.getByRole("button", { name: "验证并保存中转", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("属于另一台主机");
  const result = await page.evaluate(() => (window as any).localRelayNative);
  expect(result.published).toBe(0); expect(result.escaped).toBe(0);
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({ method: "GET", hubKey: "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" });
  expect(result.requests[0].headers.some(([name]: string[]) => name.toLowerCase() === "authorization")).toBe(false);
});

test("an old Host is explained before creating a device, even with a valid-format invitation", async ({ page }) => {
  const key = "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  await page.evaluate(key => {
    const fixture = window.nativeTransportFixture, calls: string[] = [];
    let read = false; Object.assign(window, { oldHostPairingCalls: calls });
    fixture.mockIPC(command => {
      if (command === "desktop_host") return { available: true, running: true, hostName: "Legacy host" };
      calls.push(command);
      if (command === "net_allocate") return "legacy-health";
      if (command === "net_http_open") return { status: 200, headers: [] };
      if (command === "net_http_read") { if (read) return new ArrayBuffer(0); read = true; return new TextEncoder().encode(JSON.stringify({ ok: true, publicKey: key })).buffer; }
      if (command === "device_create") throw new Error("must_not_allocate_identity");
    });
    fixture.renderPairing({ localHostReady: true });
  }, key);
  await page.getByRole("button", { name: "连接已有主机", exact: true }).click();
  await importNativeInvitation(page, key);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("请先更新此主机，才能使用限时连接码配对新设备。");
  expect(await page.evaluate(() => (window as unknown as { oldHostPairingCalls: string[] }).oldHostPairingCalls)).not.toContain("device_create");
});

for (const rejection of ["string", "error"] as const) test(`retired installation ${rejection} requires pairing and never reconnects or sends queued content`, async ({ page }) => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  await page.exposeFunction("auditInstallationProof", (deviceId: string, nonce: string) => sign(null, Buffer.from(`tarocub/server/v1\0${deviceId}\0challenge\0${nonce}`), keys.privateKey).toString("base64"));
  await page.evaluate(async ({ publicKey, rejection }) => {
    const api = window as any, fixture = window.nativeTransportFixture;
    let next = 0, signatures = 0, sockets = 0, auth = 0;
    const read = new Set<string>(), channels = new Map<string, { onmessage(event: unknown): void }>();
    fixture.mockIPC(async (cmd, args) => {
      if (cmd === "net_allocate") return `installation-${++next}`;
      if (cmd === "net_http_open") return { status: 200, headers: [] };
      if (cmd === "net_http_read") { const id = String(args!.id); if (read.has(id)) return new ArrayBuffer(0); read.add(id); return new TextEncoder().encode(JSON.stringify({ ok: true, publicKey })).buffer; }
      if (cmd === "net_socket_open") { sockets++; const channel = args!.events as { onmessage(event: unknown): void }; channels.set(String(args!.id), channel); channel.onmessage({ kind: "open" }); }
      if (cmd === "net_socket_close") channels.get(String(args!.id))?.onmessage({ kind: "close", code: 1000, reason: "", clean: true });
      if (cmd === "device_sign") { signatures++; throw rejection === "string" ? "device_pairing_required" : new Error("device_pairing_required"); }
      if (cmd === "net_socket_send") {
        const frame = JSON.parse(String(args!.text)), channel = channels.get(String(args!.id))!;
        if (frame.type === "hello") channel.onmessage({ kind: "message", sequence: 1, data: JSON.stringify({ v: 1, type: "challenge", nonce: "challenge", publicKey, signature: await api.auditInstallationProof(frame.deviceId, frame.nonce) }) });
        if (frame.type === "auth" || frame.type === "message.send") auth++;
      }
    });
    const connection = new fixture.HubConnection({ deviceId: "device_retired", keyRef: "device_retired", name: "Previous install", publicKey: "device", hubPublicKey: publicKey, routes: [{ name: "Fixture", url: "https://hub.invalid" }] });
    await connection.cache.saveDraft("saved", "keep local draft");
    await connection.cache.enqueue({ v: 1, type: "message.send", conversationId: "saved", clientMsgId: "old-queue", text: "do not send", attachments: [] });
    api.installationFixture = { connection, counters: () => ({ signatures, sockets, auth }) };
    void (connection as unknown as { connect(): Promise<void> }).connect();
  }, { publicKey, rejection });
  await page.waitForFunction(() => (window as any).installationFixture.connection.isReadOnly);
  const result = await page.evaluate(async () => {
    const { connection, counters } = (window as any).installationFixture;
    connection.resume(true); await connection.start(); window.dispatchEvent(new Event("online"));
    const send = await connection.send({ v: 1, type: "message.send", conversationId: "saved", clientMsgId: "new-queue", text: "blocked", attachments: [] }).then(() => "accepted", (error: Error) => error.message);
    return { ...counters(), send, error: connection.state.error, status: connection.state.status, draft: await connection.cache.draft("saved"), queued: (await connection.cache.outbox()).length, revoked: await connection.cache.identityRevoked(connection.identity) };
  });
  expect(result).toMatchObject({ signatures: 1, sockets: 1, auth: 0, status: "offline", draft: "keep local draft", queued: 1, revoked: false });
  expect(result.error).toContain("重新绑定"); expect(result.send).toBe(result.error);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as any).installationFixture.counters())).toEqual({ signatures: 1, sockets: 1, auth: 0 });
});

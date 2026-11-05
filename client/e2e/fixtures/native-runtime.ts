// Executed in a real Tauri WebView against isolated TLS peers; no mocked IPC.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomNonce } from "../../src/identity";
import { hubFetch, hubSocket } from "../../src/transport";
import { ClientCache } from "../../src/storage";
import { installModalHistoryGuard } from "../../src/modal-history";
const fixture = (window as unknown as { __TRANSPORT_FIXTURE__: { hub: string; key: string; proxy: string; rotating: string; backgroundPolicy: string; invite: string } }).__TRANSPORT_FIXTURE__;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const results: Record<string, unknown> = { native: isTauri(), userAgent: navigator.userAgent, backgroundPolicy: fixture.backgroundPolicy };
const require = (value: unknown, name: string) => { if (!value) throw new Error(name); results[name] = true; void invoke("audit_progress", { stage: name }); };
const rejected = async (operation: Promise<unknown>) => operation.then(() => false, () => true);
async function run() {
  require(isTauri(), "realTauri");
  const stopHistory = installModalHistoryGuard();
  const background = document.createElement("textarea"), modal = document.createElement("dialog"), editor = document.createElement("textarea");
  editor.defaultValue = "queued"; modal.append(editor); document.body.append(background, modal);
  try {
    background.focus(); document.execCommand("insertText", false, "draft");
    modal.showModal(); editor.focus(); editor.setSelectionRange(6, 6);
    document.execCommand("insertLineBreak");
    require(editor.value === "queued\n", "nativeModalNewline");
    document.execCommand("undo");
    require(editor.value === "queued" && background.value === "draft", "nativeModalUndoIsolation");
    document.execCommand("redo");
    require(editor.value === "queued\n" && background.value === "draft", "nativeModalRedoIsolation");
    for (let index = 0; index < 3; index++) document.execCommand("undo");
    require(background.value === "draft", "nativeModalRepeatedUndoIsolation");
    modal.close(); background.focus(); background.setSelectionRange(5, 5);
    document.execCommand("insertText", false, " new"); document.execCommand("undo");
    require(background.value === "draft", "nativePostModalUndo");
  } finally { modal.close(); modal.remove(); background.remove(); stopHistory(); }
  const cache = new ClientCache(`native-audit-${crypto.randomUUID()}`);
  let cacheDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cache.discardSnapshot().then(() => cache.cursors()),
      new Promise((_, reject) => { cacheDeadline = setTimeout(() => reject(new Error("native_cache_preparation_timeout")), 7000); }),
    ]);
    require(true, "nativeCachePreparation");
  } finally { clearTimeout(cacheDeadline); cache.close(); }
  require(await rejected(hubFetch(fixture.proxy, "/api/pair", fixture.key, { method: "POST", body: "synthetic-must-not-leak" })), "activeProxyRejected");
  const proxySocket = hubSocket(fixture.proxy, fixture.key);
  require(await new Promise<boolean>((resolve) => { proxySocket.onopen = () => resolve(false); proxySocket.onclose = (event) => resolve(event.code === 1006); }), "proxySocketRejected");
  const health = await (await hubFetch(fixture.hub, "/health", fixture.key)).json();
  require(health.publicKey === fixture.key, "realHubHealth");
  const seed = ed25519.utils.randomSecretKey();
  const spki = new Uint8Array([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00, ...ed25519.getPublicKey(seed)]);
  const pairing = await (await hubFetch(fixture.hub, "/api/pair", fixture.key, { method: "POST", body: JSON.stringify({ deviceId: "native-webview-test", name: "Isolated WebView", platform: "macos", publicKey: encode(spki), invite: fixture.invite, requestId: randomNonce() }) })).json();
  await invoke("audit_approve", { code: pairing.code });
  const socket = hubSocket(fixture.hub, fixture.key), nonce = "a".repeat(43);
  const ready = await new Promise<{ sessionToken: string }>((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ v: 1, type: "hello", deviceId: "native-webview-test", nonce, protocolVersions: [1], capabilities: [], cursors: {} }));
    socket.onerror = () => reject(new Error("handshake failed"));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "challenge") socket.send(JSON.stringify({ v: 1, type: "auth", signature: encode(ed25519.sign(new TextEncoder().encode(`tarocub/device/v1\0native-webview-test\0${message.nonce}\0${nonce}`), seed)) }));
      if (message.type === "ready") resolve(message);
    };
  });
  const chats = await hubFetch(fixture.hub, "/api/conversations", fixture.key, { headers: { Authorization: `Bearer ${ready.sessionToken}` } });
  require(chats.status === 200 && (await chats.text()) === "[]", "authenticatedHttpAndWebSocket");
  const closed = new Promise<boolean>((resolve) => { socket.onclose = (event) => resolve(event.code === 1000 && event.wasClean); });
  socket.close(); require(await closed, "peerConfirmedClose");
  const payload = new Uint8Array(8 * 1024 * 1024).fill(0x61);
  void invoke("audit_progress", { stage: "upload8MiB-start" });
  const echoed = new Uint8Array(await (await hubFetch(fixture.rotating, "/api/echo", fixture.key, { method: "POST", body: payload })).arrayBuffer());
  require(echoed.length === payload.length && echoed.every((b) => b === 0x61), "upload8MiB");
  require(await rejected(hubFetch(fixture.rotating, "/api/redirect", fixture.key)), "redirectRejected");
  const started = performance.now();
  void invoke("audit_progress", { stage: "download512MiB-start" });
  const download = await hubFetch(fixture.rotating, "/api/large", fixture.key);
  const reader = download.body!.getReader(), digest = sha256.create(); let bytes = 0, maxChunk = 0;
  let nextProgress = 64 * 1024 * 1024;
  while (true) { const item = await reader.read(); if (item.done) break; digest.update(item.value); bytes += item.value.length; maxChunk = Math.max(maxChunk, item.value.length); if (bytes >= nextProgress) { void invoke("audit_progress", { stage: `download-${bytes}` }); nextProgress += 64 * 1024 * 1024; } }
  const expected = sha256.create(), chunk = new Uint8Array(65536).fill(0x61); for (let i = 0; i < 8192; i++) expected.update(chunk);
  require(bytes === 512 * 1024 * 1024 && maxChunk <= 256 * 1024 && encode(digest.digest()) === encode(expected.digest()), "download512MiBHash");
  results.largeDownload = { bytes, maxChunk, elapsedMs: Math.round(performance.now() - started) };
  await invoke("audit_report", { result: { ...results, ok: true } });
}
void run().catch((error) => invoke("audit_report", { result: { ...results, ok: false, error: String(error) } }));
setTimeout(() => { void invoke("audit_report", { result: { ...results, ok: false, error: "native_acceptance_timeout" } }); }, 180_000);

import { mkdtemp, mkdir, chmod, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { HubVoiceSettings } from "../src/hub/voice-settings.js";
import { readHostVoicePolicy, voicePolicyFile } from "../src/runtime/voice-policy.js";
import { readCloudAsrConfig } from "../src/runtime/asr-cloud.js";
import { voiceCommand } from "../src/host-cli/voice.js";
import { HubServer } from "../src/hub/server.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { cloudAsrAgentInstruction, localAsrAgentInstruction } from "../src/core/agent-instructions.js";
import { WebSocket } from "ws";
import { once } from "node:events";
import { hashSecret } from "../src/hub/auth.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-")); roots.push(root);
  const home = path.join(root, "home"), host = path.join(root, "host"), directory = path.join(home, ".tarocub-secrets/tingwu_asr");
  await mkdir(host, { recursive: true }); await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, ".venv", process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
  await writeFile(path.join(directory, "tingwu_transcribe.py"), "# fixture");
  await writeFile(path.join(directory, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), "fixture", { mode: 0o700 });
  // Deliberately invalid credentials: presence must never imply verified API.
  await writeFile(path.join(directory, ".env.local"), "SECRET_CANARY=not-a-real-key", { mode: 0o600 });
  const settings = new HubVoiceSettings(host, home, env);
  const initial = await settings.status();
  const command = { requestId: "save-one", revision: initial.revision, mode: "auto" as const, adapterId: initial.adapterId, thresholdSeconds: 900, cloudConsent: true };
  return { root, home, host, directory, settings, initial, command };
}
it("detects existing private adapter without enabling or reading credentials", async () => {
  const f = await fixture(); expect(f.initial).toMatchObject({ managed: false, mode: "local" as const, cloudVerified: false, thresholdSeconds: 900 });
  expect(f.initial.adapters.find(a => a.ready)?.directory).toBe(f.directory);
  expect(JSON.stringify(f.initial)).not.toContain("SECRET_CANARY"); expect(readHostVoicePolicy(f.host)).toBeUndefined();
});
it.each([true, false])("reads v1 enabled=%s without rewriting it and upgrades only on save", async enabled => {
  const f = await fixture();
  const legacy = JSON.stringify({ format: 1, revision: "v1", enabled, directory: f.directory, thresholdSeconds: 1200, receipts: [] });
  await writeFile(voicePolicyFile(f.host), legacy, { mode: 0o600 });
  expect(await f.settings.status()).toMatchObject({ mode: enabled ? "auto" : "local", thresholdSeconds: 1200, revision: "v1" });
  expect(await readFile(voicePolicyFile(f.host), "utf8")).toBe(legacy);
  const saved = await f.settings.update({ ...f.command, revision: "v1", mode: "cloud" }, "owner", async () => {});
  expect(saved.mode).toBe("cloud");
  expect(JSON.parse(await readFile(voicePolicyFile(f.host), "utf8"))).toMatchObject({ format: 2, mode: "cloud" });
});
it("rejects invalid modes and ambiguous v1 writes", async () => {
  const f = await fixture();
  await expect(f.settings.update({ ...f.command, mode: "unknown" } as any, "owner", async () => {})).rejects.toThrow();
  const { mode: _mode, ...legacy } = f.command;
  await expect(f.settings.update({ ...legacy, enabled: true } as any, "owner", async () => {})).rejects.toThrow();
  expect(readHostVoicePolicy(f.host)).toBeUndefined();
});
it.skipIf(process.platform === "win32").each([
  ["local", 10, "local"], ["local", 900, "local"], ["local", null, "local"],
  ["cloud", 10, "cloud"], ["cloud", 900, "cloud"], ["cloud", null, "cloud"],
  ["auto", 899, "local"], ["auto", 900, "cloud"], ["auto", null, "local"],
] as const)("routes %s mode at duration %s to %s", async (mode, duration, route) => {
  const f = await fixture();
  await writeFile(path.join(f.directory, ".venv/bin/python"), '#!/bin/sh\nprev=""\nfor arg in "$@"; do\n if [ "$prev" = "--out-dir" ]; then printf "cloud fixture transcript" > "$arg/transcription.txt"; fi\n prev="$arg"\ndone\n', { mode: 0o700 });
  await f.settings.update({ ...f.command, mode }, "owner", async () => {});
  const local = vi.fn(async () => new Response("local fixture transcript"));
  const transcribe = createDefaultTranscribeVoice({ env: { TAROBOT_HOST_DIR: f.host }, httpUrl: "http://127.0.0.1:8412/transcribe", cliPython: "", cliScript: "", stateDir: f.root,
    maxAudioSeconds: 2000, chunkAfterSeconds: 2000, fetchImpl: local, watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn() },
    execFileImpl: ((_file: any, args: string[], _options: any, done: any) => {
      if (args.includes("stream=codec_type")) return done(null, JSON.stringify({ streams: [{ codec_type: "audio" }] }), "");
      if (!args.includes("format=duration")) return done(new Error("Unexpected media command"), "", "");
      done(duration === null ? new Error("unknown") : null, String(duration), "");
    }) as any });
  const audio = path.join(f.root, "test.wav"); await writeFile(audio, "fixture bytes");
  // Fixed modes cannot be silently changed by old caption routing keywords.
  expect(await transcribe(audio, { messageText: mode === "local" ? "强制云端转写" : mode === "cloud" ? "强制本地转写" : "" })).toBe(`${route} fixture transcript`);
  expect(local).toHaveBeenCalledTimes(route === "local" ? 1 : 0);
});
it.skipIf(process.platform === "win32")("all-cloud failure stays a failure, while automatic mode can fall back", async () => {
  const f = await fixture();
  await writeFile(path.join(f.directory, ".venv/bin/python"), "#!/bin/sh\necho PRIVATE_STDERR >&2\nexit 1\n", { mode: 0o700 });
  const cloud = await f.settings.update({ ...f.command, mode: "cloud" }, "owner", async () => {});
  const local = vi.fn(async () => new Response("local fallback"));
  const transcribe = createDefaultTranscribeVoice({ env: { TAROBOT_HOST_DIR: f.host }, httpUrl: "http://127.0.0.1:8412/transcribe", cliPython: "", cliScript: "", stateDir: f.root,
    maxAudioSeconds: 2000, chunkAfterSeconds: 2000, fetchImpl: local, watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn() },
    execFileImpl: ((_file: any, args: string[], _options: any, done: any) => {
      if (args.includes("stream=codec_type")) return done(null, JSON.stringify({ streams: [{ codec_type: "audio" }] }), "");
      if (!args.includes("format=duration")) return done(new Error("Unexpected media command"), "", "");
      done(null, "901", "");
    }) as any });
  const audio = path.join(f.root, "test.wav"); await writeFile(audio, "fixture bytes");
  await expect(transcribe(audio)).rejects.toThrow("Cloud transcription failed in cloud-only mode"); expect(local).not.toHaveBeenCalled();
  const signal = AbortSignal.abort(); await expect(transcribe(audio, { abortSignal: signal })).rejects.toThrow(); expect(local).not.toHaveBeenCalled();
  vi.stubEnv("TAROBOT_HOST_DIR", f.host);
  expect(localAsrAgentInstruction()).toContain("do not fall back to local ASR");
  expect(cloudAsrAgentInstruction()).toContain("every duration");
  await f.settings.update({ ...f.command, revision: cloud.revision, requestId: "auto" }, "owner", async () => {});
  expect(await transcribe(audio)).toBe("local fallback"); expect(local).toHaveBeenCalledTimes(1);
});
it("preserves legacy configuration until first save, then changes routing live and persists", async () => {
  const f = await fixture(), env = { TAROBOT_HOST_DIR: f.host, TINGWU_ASR_DIR: "/legacy", ASR_CLOUD_THRESHOLD_SECONDS: "400" };
  expect(readCloudAsrConfig(env)).toMatchObject({ dir: "/legacy", thresholdSeconds: 400 });
  const on = await f.settings.update(f.command, "owner", async () => {});
  expect(readCloudAsrConfig(env)).toMatchObject({ dir: f.directory, thresholdSeconds: 900 });
  const off = await new HubVoiceSettings(f.host, f.home, {}).update({ ...f.command, requestId: "save-two", revision: on.revision, mode: "local" as const, cloudConsent: false }, "owner", async () => {});
  expect(off.mode).toBe("local"); expect(readCloudAsrConfig(env)).toBeNull();
  expect(readCloudAsrConfig({ TINGWU_ASR_DIR: "/another-host" })?.dir).toBe("/another-host");
  if (process.platform !== "win32") expect((await stat(voicePolicyFile(f.host))).mode & 0o777).toBe(0o600);
});
it("requires consent and refuses arbitrary directories or shell commands", async () => {
  const f = await fixture();
  await expect(f.settings.update({ ...f.command, cloudConsent: false }, "owner", async () => {})).rejects.toThrow("voice_consent_required");
  await expect(f.settings.update({ ...f.command, adapterId: "/arbitrary" }, "owner", async () => {})).rejects.toThrow("voice_adapter_unknown");
  await expect(f.settings.update({ ...f.command, command: "evil" } as any, "owner", async () => {})).rejects.toThrow();
  expect(readHostVoicePolicy(f.host)).toBeUndefined();
});
it.each([0, 59, 7201, NaN, 90.5])("rejects invalid threshold %s", async value => {
  const f = await fixture(); await expect(f.settings.update({ ...f.command, thresholdSeconds: value }, "owner", async () => {})).rejects.toThrow();
});
it("returns the same receipt after lost response, refuses request reuse, and preserves newer settings", async () => {
  const f = await fixture(), audit = vi.fn(async (op: () => Promise<void>) => op());
  const first = await f.settings.update(f.command, "owner", async () => {}, audit);
  expect((await f.settings.update(f.command, "owner", async () => {}, audit)).revision).toBe(first.revision); expect(audit).toHaveBeenCalledTimes(1);
  await expect(f.settings.update({ ...f.command, mode: "local" as const }, "owner", async () => {})).rejects.toThrow("voice_request_conflict");
  const newer = await f.settings.update({ ...f.command, requestId: "second", revision: first.revision, mode: "local" as const }, "owner", async () => {});
  expect(await f.settings.update(f.command, "owner", async () => {})).toMatchObject({ mode: "local" as const, revision: newer.revision, receipt: { requestId: "save-one", revision: first.revision } });
});
it("allows only one concurrent revision and rechecks authorization before commit", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.settings.update(f.command, "owner", async () => {}), f.settings.update({ ...f.command, requestId: "race" }, "owner", async () => {})]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const before = await readFile(voicePolicyFile(f.host)); let checks = 0;
  await expect(f.settings.update({ ...f.command, requestId: "revoke", revision: (await f.settings.status()).revision }, "owner", async () => { if (++checks === 2) throw new Error("revoked"); })).rejects.toThrow("revoked");
  expect(await readFile(voicePolicyFile(f.host))).toEqual(before);
});
it("preserves an operator policy replacement while adapter status is being read", async () => {
  const f = await fixture(), saved = await f.settings.update(f.command, "owner", async () => {});
  const replacement = { ...readHostVoicePolicy(f.host)!, revision: "operator-revision", mode: "local" as const };
  const status = f.settings.status.bind(f.settings);
  vi.spyOn(f.settings, "status").mockImplementationOnce(async requestId => {
    const result = await status(requestId);
    // External operator edits do not acquire the API writer mutex.
    await writeFile(voicePolicyFile(f.host), JSON.stringify(replacement));
    return result;
  });
  await expect(f.settings.update({ ...f.command, requestId: "stale-save", revision: saved.revision, mode: "cloud" }, "owner", async () => {})).rejects.toThrow("voice_revision_conflict");
  expect(readHostVoicePolicy(f.host)).toEqual(replacement);
});
it.each(["invalid", "oversized", "permissions", "symlink", "future"])("fails closed on %s policy", async mode => {
  const f = await fixture();
  if (mode === "symlink") { if (process.platform === "win32") return; await symlink(path.join(f.directory, ".env.local"), voicePolicyFile(f.host)); }
  else { await writeFile(voicePolicyFile(f.host), mode === "oversized" ? "x".repeat(40000) : mode === "future" ? JSON.stringify({format: 3}) : "invalid", { mode: 0o600 }); if (mode === "permissions" && process.platform !== "win32") await chmod(voicePolicyFile(f.host), 0o644); }
  await expect(f.settings.status()).rejects.toMatchObject({ status: 503, code: `voice_settings_unavailable_${mode === "invalid" ? "format" : mode === "symlink" ? "file" : mode === "permissions" && process.platform === "win32" ? "format" : mode}` });
  expect(readCloudAsrConfig({ TAROBOT_HOST_DIR: f.host, TINGWU_ASR_DIR: "/legacy" })).toBeNull();
});
it("can disable cloud even if its previously valid adapter has gone missing", async () => {
  const f = await fixture(), saved = await f.settings.update(f.command, "owner", async () => {});
  await rm(f.directory, { recursive: true });
  expect((await f.settings.update({ ...f.command, requestId: "disable", revision: saved.revision, mode: "local" as const, cloudConsent: false }, "owner", async () => {})).mode).toBe("local");
});
it.skipIf(process.platform === "win32")("switches the existing transcriber and agent instructions live without rerunning an active task", async () => {
  const f = await fixture();
  // Actual child-process contract, with no network access or cloud credentials.
  await writeFile(path.join(f.directory, ".venv/bin/python"), '#!/bin/sh\nprev=""\nfor arg in "$@"; do\n if [ "$prev" = "--out-dir" ]; then printf "cloud fixture transcript" > "$arg/transcription.txt"; fi\n prev="$arg"\ndone\n', { mode: 0o700 });
  const local = vi.fn(async () => new Response("local fixture transcript"));
  const env = { TAROBOT_HOST_DIR: f.host, TINGWU_ASR_DIR: "" };
  let probe: (() => void) | undefined, delay = false;
  const transcribe = createDefaultTranscribeVoice({ env, httpUrl: "http://127.0.0.1:8412/transcribe", cliPython: "", cliScript: "", stateDir: f.root,
    maxAudioSeconds: 2000, chunkAfterSeconds: 2000, fetchImpl: local, watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn() },
    execFileImpl: ((_file: any, args: string[], _options: any, done: any) => {
      if (args.includes("stream=codec_type")) return done(null, JSON.stringify({ streams: [{ codec_type: "audio" }] }), "");
      if (!args.includes("format=duration")) return done(new Error("Unexpected media command"), "", "");
      if (delay) probe = () => done(null, "901", ""); else done(null, "901", "");
    }) as any });
  vi.stubEnv("TAROBOT_HOST_DIR", f.host); vi.stubEnv("TINGWU_ASR_DIR", ""); vi.stubEnv("ASR_HTTP_URL", "http://127.0.0.1:8412/transcribe");
  const audio = path.join(f.root, "fixture.wav"); await writeFile(audio, "fixture bytes");
  expect(cloudAsrAgentInstruction()).toBeUndefined(); expect(localAsrAgentInstruction()).not.toContain("Aliyun Tingwu");
  expect(await transcribe(audio)).toBe("local fixture transcript");
  const on = await f.settings.update(f.command, "owner", async () => {});
  expect(await transcribe(audio)).toBe("cloud fixture transcript");
  expect(cloudAsrAgentInstruction()).toContain("15 min"); expect(localAsrAgentInstruction()).toContain(f.directory); expect(localAsrAgentInstruction()).not.toContain("$TINGWU_ASR_DIR");
  delay = true; const alreadyStarted = transcribe(audio);
  await vi.waitFor(() => expect(probe).toBeDefined());
  await f.settings.update({ ...f.command, requestId: "off", revision: on.revision, mode: "local" as const }, "owner", async () => {});
  probe!(); delay = false;
  expect(await alreadyStarted).toBe("cloud fixture transcript");
  expect(await transcribe(audio)).toBe("local fixture transcript"); expect(local).toHaveBeenCalledTimes(2); expect(cloudAsrAgentInstruction()).toBeUndefined();
});
it.skipIf(process.platform === "win32")("refuses workspace symlink escapes, public credentials and linked credentials", async () => {
  const f = await fixture();
  await chmod(path.join(f.directory, ".env.local"), 0o644); expect((await f.settings.status()).adapters.some(a => a.ready)).toBe(false);
  await rm(path.join(f.directory, ".env.local")); await symlink(path.join(f.directory, "tingwu_transcribe.py"), path.join(f.directory, ".env.local")); expect((await f.settings.status()).adapters.some(a => a.ready)).toBe(false);
  const workspace = path.join(f.root, "bots", "bot", "workspace"); await mkdir(workspace, { recursive: true, mode: 0o700 }); await rm(f.directory, { recursive: true }); await symlink(workspace, f.directory);
  expect((await f.settings.status()).adapters.find(a => a.directory === f.directory)?.private).toBe(false);
});
it("preserves explicit legacy env state and rejects corrupted integration config", async () => {
  const f = await fixture({ TINGWU_ASR_DIR: "/legacy", ASR_CLOUD_THRESHOLD_SECONDS: "1200" });
  expect(f.initial).toMatchObject({ mode: "auto" as const, thresholdSeconds: 1200, managed: false });
  await mkdir(path.join(f.home, ".tarobot"), { recursive: true }); await mkdir(path.join(f.home, ".tarobot/integrations.env"));
  await expect(f.settings.status()).rejects.toThrow("voice_settings_unavailable");
});
it("uses the shared authenticated endpoint for CLI, audits once, and refuses nonowners/revoked callers", async () => {
  const f = await fixture(), hub = await HubServer.start({ stateDir: f.host, voiceSettings: f.settings });
  const close = await startHubControl(f.host, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(f.host, { enroll: true });
  let worker: WebSocket | undefined;
  let transport: GatewayTransport | undefined;
  try {
    const secret = "isolated-voice-worker-credential-1234567890";
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('voice_bot','语音测试 Bot',?,'codex')", [hashSecret(secret)]);
    const connectWorker = async (capabilities: string[]) => {
      const ws = new WebSocket(hub.instanceUrl.replace(/^http/, "ws") + "/instance"); await once(ws, "open");
      const ready = once(ws, "message"); ws.send(JSON.stringify({ v: 1, type: "instance.hello", botId: "voice_bot", secret, engine: "codex", model: "", effort: "", capabilities }));
      expect(JSON.parse(String((await ready)[0])).type).toBe("instance.ready"); return ws;
    };
    worker = await connectWorker([]);
    expect(await client.request("/api/integrations/voice")).toMatchObject({ workersNeedingUpdate: [{ id: "voice_bot", name: "语音测试 Bot" }] });
    const closed = once(worker, "close"); worker.close(); await closed;
    for (const managed of [false, true]) {
      vi.stubEnv("TAROBOT_HOST_DIR", managed ? f.host : undefined);
      const stateDir = path.join(f.root, managed ? "managed-worker" : "manual-worker"); await mkdir(stateDir);
      transport = new GatewayTransport({ url: hub.instanceUrl.replace(/^http/, "ws") + "/instance", botId: "voice_bot", secret, stateDir, engine: "codex" });
      const ready = new Promise<void>(resolve => { transport!.onBoot = async () => resolve(); });
      await transport.connect(); await ready;
      expect(await client.request("/api/integrations/voice")).toMatchObject({ workersNeedingUpdate: managed ? [] : [{ id: "voice_bot", name: "语音测试 Bot" }] });
      await transport.disconnect(); transport = undefined;
    }
    expect((await fetch(hub.url + "/api/integrations/voice", { method: "PUT", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(f.command) })).ok).toBe(false);
    expect((await fetch(hub.url + "/api/integrations/voice")).ok).toBe(false);
    await expect(client.request("/api/integrations/voice", "PUT", { ...f.command, path: "/evil" })).rejects.toThrow();
    const view = await voiceCommand(client, "status", {}, () => {}); expect(view.mode).toBe("local");
    const flags = { enabled: "on", adapter: view.adapterId, revision: view.revision, thresholdSeconds: "900", yes: true, requestId: "cli-save" };
    await expect(voiceCommand(client, "set", { ...flags, yes: false }, () => {})).rejects.toThrow();
    expect((await voiceCommand(client, "set", flags, () => {})).mode).toBe("auto");
    await voiceCommand(client, "set", flags, () => {});
    const logs = await hub.store.db.all("SELECT detail_json FROM audit_log WHERE kind='voice.settings-updated'"); expect(logs).toHaveLength(1); expect(JSON.stringify(logs)).not.toContain("SECRET_CANARY");
    const { enabled: _enabled, ...modeFlags } = flags;
    const current = await voiceCommand(client, "status", {}, () => {});
    await expect(voiceCommand(client, "set", { ...flags, mode: "cloud" }, () => {})).rejects.toThrow("不能同时使用");
    const cloud = await voiceCommand(client, "set", { ...modeFlags, mode: "cloud", revision: current.revision, requestId: "cli-cloud" }, () => {});
    expect(cloud.mode).toBe("cloud");
    expect((await voiceCommand(client, "set", { ...modeFlags, mode: "local", revision: cloud.revision, requestId: "cli-local" }, () => {})).mode).toBe("local");
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await expect(client.request("/api/integrations/voice")).rejects.toThrow();
    await expect(client.request("/api/integrations/voice", "PUT", { ...f.command, requestId: "denied" })).rejects.toThrow();
    await hub.store.db.run("UPDATE devices SET revoked=1 WHERE id=?", [client.deviceId]); await expect(client.request("/api/integrations/voice")).rejects.toThrow();
  } finally { worker?.close(); await transport?.disconnect(); client.close(); await close(); await hub.close(); }
});
it.skipIf(process.platform === "win32")("compiled CLI sets all three modes on one existing Hub", async () => {
  const f = await fixture(), hub = await HubServer.start({ stateDir: f.host, voiceSettings: f.settings });
  const close = await startHubControl(f.host, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(f.host, { enroll: true }); client.close();
  const cli = async (args: string[]) => {
    const result = await promisify(execFile)(process.execPath, [path.resolve("bin/tarobot.mjs"), "integrations", "voice", ...args, "--state-dir", f.host, "--json"], {
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home, TAROBOT_HOST_DIR: f.host }, timeout: 15_000,
    });
    return JSON.parse(result.stdout);
  };
  try {
    let state = await cli(["status"]); expect(state.mode).toBe("local");
    for (const mode of ["auto", "cloud", "local"]) {
      const args = ["set", "--mode", mode, "--adapter", state.adapterId, "--threshold-seconds", "300", "--revision", state.revision, "--yes", "--request-id", `compiled-${mode}`];
      state = await cli(args); expect(state.mode).toBe(mode); expect(state.thresholdSeconds).toBe(300);
      expect((await cli(args)).revision).toBe(state.revision);
    }
    expect(await hub.store.db.all("SELECT 1 FROM audit_log WHERE kind='voice.settings-updated'")).toHaveLength(3);
  } finally { await close(); await hub.close(); }
}, 30_000);

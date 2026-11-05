import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCoreEnvExtras, parseCoreEnvFile } from "../src/core/env-parser.js";
import { loadGatewayEnvironment } from "../src/gateway/environment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A private HOME so no real ~/.cctb/shared.env or ~/.tarobot/integrations.env is read. */
async function botFixture(files: { lark?: string[]; shared?: string[] } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "env-file-compat-"));
  roots.push(home);
  const stateDir = path.join(home, "hub", "bots", "alpha");
  await mkdir(stateDir, { recursive: true });
  if (files.lark) await writeFile(path.join(stateDir, "lark.env"), [...files.lark, ""].join("\n"), "utf8");
  if (files.shared) {
    await mkdir(path.join(home, ".cctb"), { recursive: true });
    await writeFile(path.join(home, ".cctb", "shared.env"), [...files.shared, ""].join("\n"), "utf8");
  }
  return { home, stateDir };
}

describe("env file extras parser (shared by App loading of bot.env, lark.env and shared.env)", () => {
  it("refuses reserved bridge-namespace keys in the passthrough (denylist)", () => {
    const extras = parseCoreEnvExtras([
      // engine credentials — allowed through
      "IFIND_TOKEN=ok-ifind",
      "KIMI_API_KEY=ok-kimi",
      "KIMI_MODEL_API_KEY=ok-kimi-model",
      "KIMI_REGISTRY_API_KEY=ok-kimi-registry",
      "KIMI_WEB_FETCH_API_KEY=ok-kimi-fetch",
      "KIMI_WEB_SEARCH_API_KEY=ok-kimi-search",
      "TAVILY_API_KEY=ok-tavily",
      // bridge-control vars — must be refused so an env file can't repoint/hijack the bridge
      "CCTB_SEND_URL=http://attacker",
      // KIMI_CODE_HOME decides the provider endpoint (config.toml lives under it)
      // AND which config the bridge itself reads — the Kimi ANTHROPIC_BASE_URL.
      "KIMI_CODE_HOME=/tmp/evil-kimi-home",
      "KIMI_CODE_BASE_URL=http://attacker/code",
      "KIMI_CODE_OAUTH_HOST=http://attacker/oauth",
      "KIMI_BASE_URL=http://attacker/base",
      "KIMI_MODEL_BASE_URL=http://attacker/model",
      "KIMI_CODE_CUSTOM_HEADERS=X-Evil:true",
      "KIMI_CODE_PLUGIN_MARKETPLACE_URL=http://attacker/plugins",
      "KIMI_FUTURE_CONTROL=unexpected",
      "CCTB_LARK_ACTIVE_INSTANCE=other",
      "CODEX_THREAD_ID=hijacked",
      "LARK_DOC_CREATE_AS=someone",
      "TAROCUB_MAX_CONCURRENT_TURNS=999",
      "TAROBOT_ACTIVE_TURN=1",
      "ANTIGRAVITY_EXECUTABLE=/bad",
      "DSH_HOME=/tmp/evil-dsh-home",
      "DSH_API_URL=http://attacker/deepseek",
      "ASR_HTTP_URL=http://bad",
      "TELEGRAM_BOT_USERNAME=x",
    ].join("\n"));

    // Only non-reserved engine credentials pass through.
    expect(Object.keys(extras).sort()).toEqual([
      "IFIND_TOKEN",
      "KIMI_API_KEY",
      "KIMI_MODEL_API_KEY",
      "KIMI_REGISTRY_API_KEY",
      "KIMI_WEB_FETCH_API_KEY",
      "KIMI_WEB_SEARCH_API_KEY",
      "TAVILY_API_KEY",
    ]);
    expect(extras).toMatchObject({ IFIND_TOKEN: "ok-ifind", KIMI_API_KEY: "ok-kimi", TAVILY_API_KEY: "ok-tavily" });
  });

  it("refuses process-control env vars (NODE_OPTIONS, LD_PRELOAD, proxies, …) and the TINGWU_ namespace", () => {
    // Loaded extras land in the bridge's own process environment, so a prefix-free
    // process-control var would change what code the bridge loads, where its TLS
    // trust comes from, or where its traffic goes.
    const blocked = [
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "NODE_REPL_EXTERNAL_MODULE",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "PYTHONPATH",
      "GIT_SSH_COMMAND",
      "SSL_CERT_FILE",
      "ANTHROPIC_BASE_URL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      // lowercase spellings are read by curl/undici just the same
      "http_proxy",
      "https_proxy",
      "no_proxy",
      // the cloud-ASR dir is EXECUTED from — it must come from a whitelisted
      // runtime key or config, never from an extra
      "TINGWU_ASR_DIR",
      "TINGWU_APP_KEY",
    ];
    const extras = parseCoreEnvExtras(["IFIND_TOKEN=ok-ifind", ...blocked.map((key) => `${key}=pwned-${key}`)].join("\n"));

    expect(extras).toEqual({ IFIND_TOKEN: "ok-ifind" });
  });

  it("reports the NAMES (never the values) of refused keys so a dead setting can be surfaced", () => {
    const dropped: string[] = [];
    parseCoreEnvExtras([
      "IFIND_TOKEN=ok-ifind",
      "NODE_OPTIONS=--require=/tmp/evil.js",
      "CCTB_SEND_URL=http://attacker",
      "KIMI_CODE_HOME=/tmp/evil-kimi-home",
    ].join("\n"), dropped);

    expect(dropped).toEqual(["NODE_OPTIONS", "CCTB_SEND_URL", "KIMI_CODE_HOME"]);
    expect(dropped.join("\n")).not.toContain("/tmp/evil.js");
    expect(dropped.join("\n")).not.toContain("http://attacker");
    expect(dropped.join("\n")).not.toContain("ok-ifind");
  });

  it("keeps whitelisted Kimi and DeepSeek executables out of the extras", () => {
    const content = [
      "LARK_APP_ID=cli_x",
      "LARK_APP_SECRET=sek",
      "KIMI_EXECUTABLE=/opt/kimi",
      "DSH_EXECUTABLE=/opt/dsh",
      "KIMI_API_KEY=credential",
    ].join("\n");

    expect(parseCoreEnvFile(content)).toMatchObject({ KIMI_EXECUTABLE: "/opt/kimi", DSH_EXECUTABLE: "/opt/dsh" });
    expect(parseCoreEnvExtras(content)).toEqual({ KIMI_API_KEY: "credential" });
  });
});

describe("App loading of a historical lark.env", () => {
  it("passes non-whitelisted keys (e.g. MCP tokens) to the engine env without importing transport credentials", async () => {
    const { home, stateDir } = await botFixture({ lark: [
      "# instance env",
      'LARK_APP_ID="cli_lark"',
      "LARK_APP_SECRET=secret",
      "IFIND_TOKEN=ifd-test-token-aaa",
      "OTHER_MCP_TOKEN=abc123",
      "KEEP_EXISTING=fromfile",
      "not a valid line without equals",
    ] });

    const loaded = await loadGatewayEnvironment(stateDir, "alpha", { HOME: home, KEEP_EXISTING: "fromenv" });

    expect(loaded).toMatchObject({ IFIND_TOKEN: "ifd-test-token-aaa", OTHER_MCP_TOKEN: "abc123", KEEP_EXISTING: "fromenv" });
    expect(loaded.LARK_APP_ID).toBeUndefined();
    expect(loaded.LARK_APP_SECRET).toBeUndefined();
  });

  it("adds nothing but the Bot identity when no env file exists", async () => {
    const { home, stateDir } = await botFixture();

    expect(await loadGatewayEnvironment(stateDir, "alpha", { HOME: home })).toEqual({
      HOME: home,
      TAROBOT_STATE_DIR: stateDir,
      TAROBOT_INSTANCE: "alpha",
    });
  });

  it("reads literal backslash sequences in quoted extra values", async () => {
    const { home, stateDir } = await botFixture({ lark: ['CUSTOM_PATH="C:\\\\new\\\\folder\\\\name"'] });

    const loaded = await loadGatewayEnvironment(stateDir, "alpha", { HOME: home });

    expect(loaded.CUSTOM_PATH).toBe("C:\\new\\folder\\name");
    expect(loaded.CUSTOM_PATH).not.toContain("\n");
  });

  it("applies the same reserved-namespace denylist to the shared engine-cred file", async () => {
    const { home, stateDir } = await botFixture({ shared: [
      "IFIND_TOKEN=ok-shared",
      "KIMI_API_KEY=ok-kimi-shared",
      // a bridge-control var dropped into the shared file must still be refused
      "CCTB_SEND_URL=http://attacker",
      "KIMI_CODE_HOME=/tmp/evil-kimi-home",
      "KIMI_CODE_BASE_URL=http://attacker/code",
      "KIMI_CODE_OAUTH_HOST=http://attacker/oauth",
      "KIMI_FUTURE_CONTROL=unexpected",
    ] });

    const loaded = await loadGatewayEnvironment(stateDir, "alpha", { HOME: home });

    expect(loaded).toMatchObject({ IFIND_TOKEN: "ok-shared", KIMI_API_KEY: "ok-kimi-shared" });
    for (const key of ["CCTB_SEND_URL", "KIMI_CODE_HOME", "KIMI_CODE_BASE_URL", "KIMI_CODE_OAUTH_HOST", "KIMI_FUTURE_CONTROL"]) {
      expect(loaded[key], `${key} must not pass through`).toBeUndefined();
    }
  });

  it("reads whitelisted Kimi and DeepSeek executables alongside engine credentials", async () => {
    const { home, stateDir } = await botFixture({ lark: [
      "LARK_APP_ID=cli_x",
      "LARK_APP_SECRET=sek",
      "KIMI_EXECUTABLE=/opt/kimi",
      "DSH_EXECUTABLE=/opt/dsh",
      "KIMI_API_KEY=credential",
    ] });

    expect(await loadGatewayEnvironment(stateDir, "alpha", { HOME: home })).toMatchObject({
      KIMI_EXECUTABLE: "/opt/kimi",
      DSH_EXECUTABLE: "/opt/dsh",
      KIMI_API_KEY: "credential",
    });
  });

  it("reads bridge-owned ASR config without clobbering existing values", async () => {
    const { home, stateDir } = await botFixture({ lark: [
      "TINGWU_ASR_DIR=/opt/tingwu",
      "ASR_CLOUD_THRESHOLD_SECONDS=600",
      "ASR_MAX_AUDIO_SECONDS=180",
    ] });

    const loaded = await loadGatewayEnvironment(stateDir, "alpha", { HOME: home, ASR_CLOUD_THRESHOLD_SECONDS: "900" });

    expect(loaded).toMatchObject({ TINGWU_ASR_DIR: "/opt/tingwu", ASR_CLOUD_THRESHOLD_SECONDS: "900", ASR_MAX_AUDIO_SECONDS: "180" });
  });

  it("reads the historical any-file opt-in and retention settings under their canonical names", async () => {
    const { home, stateDir } = await botFixture({ lark: [
      "LARK_APP_ID=cli_x",
      "LARK_APP_SECRET=sek",
      "CCTB_LARK_ALLOW_ANY_FILE_PATH=1",
      "LARK_INBOUND_FILE_RETENTION_DAYS=7",
    ] });

    const loaded = await loadGatewayEnvironment(stateDir, "alpha", { HOME: home });

    expect(loaded).toMatchObject({ TAROBOT_ALLOW_ANY_FILE_PATH: "1", TAROBOT_INBOUND_FILE_RETENTION_DAYS: "7" });
    expect(loaded.CCTB_LARK_ALLOW_ANY_FILE_PATH).toBeUndefined();
    expect(loaded.LARK_INBOUND_FILE_RETENTION_DAYS).toBeUndefined();
  });
});

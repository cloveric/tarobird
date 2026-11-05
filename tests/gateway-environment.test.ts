import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadGatewayEnvironment } from "../src/gateway/environment.js";
import { createGatewayBridge } from "../src/gateway/worker.js";

it("initializes Kimi workspace instructions with the Gateway profile before the first turn", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-kimi-startup-"));
  try {
    const state = path.join(home, ".cctb", "alpha"); await mkdir(state, { recursive: true });
    await writeFile(path.join(state, "config.json"), JSON.stringify({ engine: "kimi" }));
    const { bridge } = await createGatewayBridge({ HOME: home, TAROCUB_INSTANCE: "alpha", CODEX_TELEGRAM_STATE_DIR: state });
    try {
      const instructions = await readFile(path.join(state, "workspace", ".kimi-code", "agents", "agent.md"), "utf8");
      expect(instructions).toContain("You are replying in TaroBird App"); expect(instructions).not.toContain("tarocub gdocs");
      expect(instructions).not.toContain("Lark Docs/Calendar"); expect(instructions).not.toContain("Lark cards do not render LaTeX");
    } finally { await bridge.destroy?.(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("loads shared MCP credentials and instance ASR settings without changing engine homes or leaking fleet identity", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-env-"));
  try {
    const state = path.join(home, "hub", "bots", "alpha"); await mkdir(state, { recursive: true }); await mkdir(path.join(home, ".cctb"));
    await writeFile(path.join(home, ".cctb", "shared.env"), "IFIND_TOKEN=shared-token\nBRAVE_API_KEY=shared-brave\nNODE_OPTIONS=--require=bad\nCODEX_HOME=/wrong\n");
    await writeFile(path.join(state, "lark.env"), "IFIND_TOKEN=instance-token\nTINGWU_ASR_DIR=/configured/tingwu\nASR_CLOUD_THRESHOLD_SECONDS=900\nCCTB_LARK_STATE_DIR=/wrong-fleet\nLARK_APP_SECRET=do-not-import\n");
    const base = { HOME: home, BRAVE_API_KEY: "explicit-brave" };
    const loaded = await loadGatewayEnvironment(state, "alpha", base);
    expect(loaded).toMatchObject({ HOME: home, IFIND_TOKEN: "instance-token", BRAVE_API_KEY: "explicit-brave", TINGWU_ASR_DIR: "/configured/tingwu", ASR_CLOUD_THRESHOLD_SECONDS: "900", TAROBOT_STATE_DIR: state, TAROBOT_INSTANCE: "alpha" });
    for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS", "LARK_APP_SECRET"]) expect(loaded[key]).toBeUndefined();
    expect(base).toEqual({ HOME: home, BRAVE_API_KEY: "explicit-brave" });
    expect(await loadGatewayEnvironment(state, "alpha", { HOME: home, CODEX_HOME: "/explicit/codex", CLAUDE_CONFIG_DIR: "/explicit/claude", IFIND_TOKEN: "process-token" })).toMatchObject({ CODEX_HOME: "/explicit/codex", CLAUDE_CONFIG_DIR: "/explicit/claude", IFIND_TOKEN: "process-token" });
    const fresh = path.join(home, "hub", "bots", "fresh"); await mkdir(fresh);
    expect(await loadGatewayEnvironment(fresh, "fresh", { HOME: home })).toMatchObject({ IFIND_TOKEN: "shared-token", BRAVE_API_KEY: "shared-brave" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { hashSecret } from "../src/hub/auth.js";
import { instanceFrameSchema } from "../src/client-protocol/instance.js";

it("syncs changed local model metadata and reconnects with the current configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-model-status-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const stateDir = path.join(root, "bot"), secret = randomBytes(32).toString("base64url");
  const config = path.join(stateDir, "config.json");
  await mkdir(stateDir);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?),('beta','Beta',?)", [hashSecret(secret), hashSecret(secret)]);
  const options = { stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "antigravity", model: "stale-startup-value" };
  let transport = new GatewayTransport(options);
  try {
    await writeFile(config, JSON.stringify({ engine: "antigravity", model: "gemini-3.7-pro", effort: "high", apiKey: "not-published" }));
    await transport.connect();
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.model).toBe("gemini-3.7-pro");
    await writeFile(config, JSON.stringify({ engine: "antigravity", model: "claude-opus-5-5", effort: "high" }));
    await transport.refreshStatus();
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.model).toBe("claude-opus-5-5");
    await writeFile(config, "{broken"); await transport.refreshStatus();
    expect((await hub.store.bots("owner"))[0]?.model).toBe("claude-opus-5-5");
    await writeFile(config, JSON.stringify({ engine: "antigravity", model: "deepseek-v4", effort: "" }));
    await transport.disconnect(); transport = new GatewayTransport(options); await transport.connect();
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.model).toBe("deepseek-v4");
    expect((await hub.store.bots("owner"))[1]).toMatchObject({ id: "beta", engine: "", model: "", online: 0 });
    await writeFile(config, JSON.stringify({ engine: "antigravity" })); await transport.refreshStatus();
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.model).toBe("");
  } finally { await transport.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

it("accepts legacy heartbeats and restricts metadata to the authenticated Bot's public configuration", () => {
  expect(instanceFrameSchema.parse({ v: 1, type: "ping" })).toEqual({ v: 1, type: "ping" });
  const frame = { v: 1, type: "ping", status: { engine: "kimi", model: "kimi-k3", effort: "", botId: "victim", online: 0, secret: "never-forward" } };
  expect(instanceFrameSchema.parse(frame)).toEqual({ v: 1, type: "ping", status: { engine: "kimi", model: "kimi-k3", effort: "" } });
  expect(instanceFrameSchema.safeParse({ ...frame, status: { ...frame.status, model: "x".repeat(129) } }).success).toBe(false);
});

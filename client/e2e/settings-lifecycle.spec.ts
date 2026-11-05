import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
for (const kind of ["permissions", "effort"] as const) test(`${kind} reads can close and retired Bot responses cannot replace current settings`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-lifecycle-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  const gateways: GatewayChannel[] = [], releases: (() => void)[] = [];
  const title = kind === "permissions" ? "权限与批准" : "思考强度";
  const trigger = page.getByRole("button", { name: kind === "permissions" ? "调整 Bot 权限" : "调整 Bot 思考强度", exact: true });
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const control = dialog.getByRole("combobox", { name: kind === "permissions" ? title : "Effort 档位", exact: true });
  const initial = kind === "permissions" ? "bypass" : "high", updated = kind === "permissions" ? "normal" : "low", fallback = kind === "permissions" ? "full-auto" : "high";
  let authorization = "";
  try {
    for (const [id, name, engine] of [["alpha", "研究助手", "codex"], ["beta", "写作助手", "kimi"]] as const) {
      const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir);
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, effort: "high" }));
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
      gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, effort: "high", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } }));
    }
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "审核群", "review", { type: "group" });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
    await selectConversation(page, group.title); await page.getByRole("button", { name: "查看对话详情", exact: true }).click(); await page.getByRole("button", { name: "Bot 设置", exact: true }).click();
    let readStarted = false, heldRead = false;
    const readGate = new Promise<void>(resolve => releases.push(resolve));
    await page.route(`**/api/bots/alpha/${kind}`, async route => {
      authorization = route.request().headers().authorization ?? authorization;
      if (route.request().method() !== "GET" || heldRead) { await route.continue(); return; }
      heldRead = true; const response = await route.fetch(); readStarted = true; await readGate;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await trigger.click(); await expect.poll(() => readStarted).toBe(true);
    // Loading configuration is a read, and must not lock every exit for the transport timeout.
    await expect(dialog.getByRole("button", { name: `关闭${title === "权限与批准" ? "权限设置" : title}`, exact: true })).toBeEnabled();
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await trigger.click(); await expect(control).toHaveValue(initial);
    releases[0]!(); await expect(control).toHaveValue(initial);
    await page.unroute(`**/api/bots/alpha/${kind}`);

    let savedAtHost = false;
    const saveGate = new Promise<void>(resolve => releases.push(resolve));
    await page.route(`**/api/bots/alpha/${kind}`, async route => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      const response = await route.fetch(); savedAtHost = true; await saveGate;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await control.selectOption(updated); await dialog.getByRole("button", { name: "保存到此 Bot", exact: true }).click();
    await expect.poll(() => savedAtHost).toBe(true);
    const changed = await fetch(`${hub.url}/api/groups/${group.id}/settings`, { method: "PUT", headers: { authorization }, body: JSON.stringify({ title: group.title, botIds: ["beta"], expectedTitle: group.title, expectedBotIds: ["alpha", "beta"] }) });
    expect(changed.status).toBe(200);
    await expect(dialog.locator(".effort-scope strong")).toHaveText("写作助手");
    await expect(control).toHaveValue(fallback);
    releases[1]!();
    await expect(control).toHaveValue(fallback); await expect(dialog.getByText(/^已保存为/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "保存到此 Bot", exact: true })).toBeDisabled();
  } finally {
    releases.forEach(release => release()); await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const gateway of gateways) await gateway.disconnect();
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
});

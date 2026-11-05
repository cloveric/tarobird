import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { preflightCoreDeliveryPath, resolveCoreDeliveryRoots } from "../src/core/delivery-preflight.js";
import { withChannelProfile } from "../src/core/channel-profile.js";

let root: string, stateDir: string, outside: string;
beforeEach(async () => {
  vi.stubEnv("TAROBOT_ALLOW_ANY_FILE_PATH", undefined); vi.stubEnv("CCTB_LARK_ALLOW_ANY_FILE_PATH", undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-file-policy-")); stateDir = path.join(root, "bot");
  await mkdir(path.join(stateDir, "workspace"), { recursive: true });
  outside = path.join(root, "external-report.txt"); await writeFile(outside, "external artifact");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const config = (value: unknown) => writeFile(path.join(stateDir, "config.json"), JSON.stringify(value));
const check = (file = outside) => withChannelProfile("gateway", async () => preflightCoreDeliveryPath(file, await resolveCoreDeliveryRoots({ stateDir })));

it.each(["codex", "claude", "antigravity", "kimi", "deepseek"])("defaults full-access %s to any readable file path", async engine => {
  await config({ engine, approvalMode: "bypass", ...(engine === "kimi" ? { kimiAutoNeverAskAcknowledged: true } : {}) });
  expect(await check()).toMatchObject({ ok: true });
});
it.each(["codex", "claude", "antigravity", "kimi", "deepseek"])("keeps %s normal mode scoped even with an explicit opt-in", async engine => {
  await config({ engine, approvalMode: "normal" });
  await writeFile(path.join(stateDir, "bot.env"), "TAROBOT_ALLOW_ANY_FILE_PATH=1\n");
  expect(await check()).toMatchObject({ ok: false, reason: "outside-workspace" });
});
it("follows effective engine permissions, including legacy Claude and Kimi acknowledgment", async () => {
  await config({ engine: "claude", approvalMode: "full-auto" }); expect(await check()).toMatchObject({ ok: true });
  for (const engine of ["codex", "antigravity", "deepseek", "kimi"]) {
    await config({ engine, approvalMode: "full-auto" }); expect(await check()).toMatchObject({ ok: false });
  }
  await config({ engine: "kimi", approvalMode: "bypass" }); expect(await check()).toMatchObject({ ok: false });
  await config({ engine: "codex" }); expect(await check()).toMatchObject({ ok: true });
});
it("honors explicit zero, canonical and legacy file precedence, and live config changes", async () => {
  await config({ engine: "claude", approvalMode: "bypass" });
  await writeFile(path.join(stateDir, "lark.env"), "CCTB_LARK_ALLOW_ANY_FILE_PATH=0\n"); expect(await check()).toMatchObject({ ok: false });
  await writeFile(path.join(stateDir, "bot.env"), "TAROBOT_ALLOW_ANY_FILE_PATH=1\n"); expect(await check()).toMatchObject({ ok: true });
  await writeFile(path.join(stateDir, "bot.env"), "TAROBOT_ALLOW_ANY_FILE_PATH=0\nCCTB_LARK_ALLOW_ANY_FILE_PATH=1\n"); expect(await check()).toMatchObject({ ok: false });
  vi.stubEnv("CCTB_LARK_ALLOW_ANY_FILE_PATH", "1"); expect(await check()).toMatchObject({ ok: true });
  vi.stubEnv("TAROBOT_ALLOW_ANY_FILE_PATH", "0"); expect(await check()).toMatchObject({ ok: false });
  vi.stubEnv("TAROBOT_ALLOW_ANY_FILE_PATH", "1"); expect(await check()).toMatchObject({ ok: true });
  await config({ engine: "claude", approvalMode: "normal" }); expect(await check()).toMatchObject({ ok: false });
});
it("does not infer full access from absent, unreadable or invalid permission config", async () => {
  vi.stubEnv("TAROBOT_ALLOW_ANY_FILE_PATH", "1");
  expect(await check()).toMatchObject({ ok: false });
  for (const value of [null, [], { approvalMode: "invalid" }, { engine: "unknown" }]) { await config(value); expect(await check()).toMatchObject({ ok: false }); }
  await writeFile(path.join(stateDir, "config.json"), "{"); expect(await check()).toMatchObject({ ok: false });
  await rm(path.join(stateDir, "config.json")); await mkdir(path.join(stateDir, "config.json")); expect(await check()).toMatchObject({ ok: false });
});
it("keeps credential env files and their symlinks unsendable under full access", async () => {
  await config({ engine: "codex", approvalMode: "bypass" });
  for (const name of [".env", "bot.env", "lark.env", "integrations.env", "private.key"]) {
    const file = path.join(root, name); await writeFile(file, "TOKEN=fixture");
    expect(await check(file)).toMatchObject({ ok: false, reason: "credentials-file" });
    const link = path.join(stateDir, "workspace", `${name}.txt`); await symlink(file, link);
    expect(await check(link)).toMatchObject({ ok: false, reason: "credentials-file" });
  }
});
it("does not interpret an external relative path as a full-access absolute-path grant", async () => {
  await config({ engine: "codex", approvalMode: "bypass" });
  expect(await check(path.relative(process.cwd(), outside))).toMatchObject({ ok: false, reason: "outside-workspace" });
});

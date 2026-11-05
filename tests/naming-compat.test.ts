import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { prepareCoreFileWorkflow } from "../src/core/files.js";
import { FileWorkflowStore } from "../src/state/file-workflow-store.js";
import { boundArchiveSummary } from "../src/runtime/file-workflow.js";
import { afterEach, expect, it } from "vitest";
import { JsonStore } from "../src/state/json-store.js";
import { loadInstanceConfig, updateInstanceConfig } from "../src/state/instance-config.js";
import { assertStableCoreIdMappings } from "../src/core/id-map.js";
import { CoreGroupModeStore } from "../src/core/group-mode-store.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { appendCoreTimelineEvent } from "../src/core/timeline.js";
import { normalizeCoreMessage } from "../src/core/message-normalizer.js";
import { recoverInterruptedCoreTurns } from "../src/core/recovery.js";
import { loadGatewayEnvironment } from "../src/gateway/environment.js";
import { parseCoreEnvExtras } from "../src/core/env-parser.js";
import { resolveBridgeConfig } from "../src/config.js";
import { buildEngineEnvironment } from "../src/core/engine-factory.js";
import { isLogicalSessionId } from "../src/runtime/logical-session.js";
import { appAgentInstructions, appCapabilityInstructions } from "../src/gateway/agent-instructions.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-naming-")); roots.push(root); return root; }

it("reads old settings, preserves explicit false/zero, and writes canonical names without dropping other settings", async () => {
  const root = await fixture(), file = path.join(root, "config.json");
  const old = JSON.stringify({ engine: "claude", approvalMode: "normal", larkElementStream: false, larkSteerEnabled: true, larkSteerWindowSeconds: 30, steerEnabled: false, steerWindowSeconds: 0, custom: { keep: true } });
  await writeFile(file, old);
  expect(await loadInstanceConfig(root)).toMatchObject({ engine: "claude", elementStream: false, steerEnabled: false, steerWindowSeconds: 0 });
  expect(await readFile(file, "utf8")).toBe(old);
  await updateInstanceConfig(root, config => { expect(config.steerWindowSeconds).toBe(0); config.verbosity = 1; });
  const updated = JSON.parse(await readFile(file, "utf8"));
  expect(updated).toMatchObject({ elementStream: false, steerEnabled: false, steerWindowSeconds: 0, approvalMode: "normal", custom: { keep: true } });
  expect(Object.keys(updated).some(key => key.startsWith("lark"))).toBe(false);
});

it("keeps historical identity collision checks when writing the new map, without deleting the original", async () => withChannelProfile("gateway", async () => {
  const root = await fixture(), old = path.join(root, "lark-chat-id-map.json");
  await writeFile(old, JSON.stringify({ "42": "lark:gw_original" }));
  await expect(assertStableCoreIdMappings(root, [["chat", 42, "lark:gw_other"]])).rejects.toThrow("collision");
  await Promise.all([assertStableCoreIdMappings(root, [["chat", 43, "lark:gw_next"]]), assertStableCoreIdMappings(root, [["chat", 44, "lark:gw_last"]])]);
  expect(JSON.parse(await readFile(path.join(root, "chat-id-map.json"), "utf8"))).toMatchObject({ "42": "lark:gw_original", "43": "lark:gw_next", "44": "lark:gw_last" });
  expect(JSON.parse(await readFile(old, "utf8"))).toEqual({ "42": "lark:gw_original" });
}));

it("does not resurrect legacy group settings after an explicit clear", async () => withChannelProfile("gateway", async () => {
  const root = await fixture(); await writeFile(path.join(root, "lark-group-mode.json"), JSON.stringify({ listenAllChatIds: ["gw_old"] }));
  expect(await new CoreGroupModeStore(root).isListenAll("gw_old")).toBe(true);
  await new CoreGroupModeStore(root).clearListenAll();
  expect(await new CoreGroupModeStore(root).isListenAll("gw_old")).toBe(false);
}));

it.each(["broken", "newer", "unreadable"])("does not fall back to stale state when the canonical file is %s", async kind => {
  const root = await fixture(), current = path.join(root, "current.json"), old = path.join(root, "old.json");
  await writeFile(old, '{"authorized":true}');
  if (kind === "unreadable") await mkdir(current);
  else await writeFile(current, kind === "broken" ? "{" : '{"schemaVersion":999999}');
  await expect(new JsonStore(current, undefined, [old]).read({ authorized: false })).rejects.toThrow();
});

it("pins the App identity, blocks namespace injection, and inherits only neutral identity in engine children", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "bot.env"), "TAROBOT_ALLOW_ANY_FILE_PATH=0\nTAROBOT_INBOUND_FILE_RETENTION_DAYS=7\nTAROBOT_STATE_DIR=/wrong\nTAROBOT_ACTIVE_TURN=1\n");
  const env = await loadGatewayEnvironment(root, "alpha", { HOME: root, CODEX_TELEGRAM_STATE_DIR: "/old", CCTB_LARK_INSTANCE: "old" });
  expect(env).toMatchObject({ TAROBOT_STATE_DIR: root, TAROBOT_INSTANCE: "alpha", TAROBOT_ALLOW_ANY_FILE_PATH: "0", TAROBOT_INBOUND_FILE_RETENTION_DAYS: "7" });
  for (const key of ["TAROBOT_ACTIVE_TURN", "CODEX_TELEGRAM_STATE_DIR", "CCTB_LARK_INSTANCE"]) expect(env[key]).toBeUndefined();
  expect(parseCoreEnvExtras("TAROBOT_STATE_DIR=/evil\ntarobot_active_turn=1\nAPI_KEY=allowed")).toEqual({ API_KEY: "allowed" });
  expect(resolveBridgeConfig(env)).toMatchObject({ stateDir: root, instanceName: "alpha" });
  const child = buildEngineEnvironment(env, "gateway");
  expect(child).toMatchObject({ TAROBOT_STATE_DIR: root, TAROBOT_INSTANCE: "alpha" });
  expect(child.CODEX_TELEGRAM_STATE_DIR).toBeUndefined();
});

it("keeps legacy environment inputs usable without overriding canonical settings", () => {
  expect(resolveBridgeConfig({ HOME: "/home", CODEX_TELEGRAM_STATE_DIR: "/old", CODEX_TELEGRAM_INSTANCE: "old" })).toMatchObject({ stateDir: "/old", instanceName: "old" });
  expect(resolveBridgeConfig({ HOME: "/home", TAROBOT_STATE_DIR: "/new", TAROBOT_INSTANCE: "new", CODEX_TELEGRAM_STATE_DIR: "/old", TAROCUB_INSTANCE: "old" })).toMatchObject({ stateDir: "/new", instanceName: "new" });
});

it.each(["codex", "claude", "antigravity", "kimi", "deepseek"] as const)("advertises neutral App question directives for %s", engine => {
  expect(appAgentInstructions({ engine })).toContain("send.choice");
  expect(appCapabilityInstructions("questions", { engine })).not.toContain("lark.choice");
});

it("recognizes both generations of host session IDs without treating native IDs as placeholders", () => {
  for (const id of ["tarobot-42", "tarobot-bus-uuid", "tarobot-cron-job", "telegram-42"]) expect(isLogicalSessionId(id)).toBe(true);
  expect(isLogicalSessionId("native-session-id")).toBe(false);
});

it("recovers new App timeline entries while keeping the old routing identity unchanged", async () => {
  const root = await fixture();
  const normalized = normalizeCoreMessage({ messageId: "msg_one", chatId: "gw_one", chatType: "p2p", senderId: "gwuser_one", text: "hi", resources: [] });
  await withChannelProfile("gateway", () => appendCoreTimelineEvent(root, normalized, { type: "input.received" }));
  const file = path.join(root, "timeline.log.jsonl");
  expect(JSON.parse((await readFile(file, "utf8")).trim())).toMatchObject({ channel: "gateway", conversationKey: "lark:gw_one", metadata: { messageId: "msg_one", sourceChatId: "gw_one" } });
  expect(await recoverInterruptedCoreTurns(root, "alpha")).toBe(1);
  expect(await recoverInterruptedCoreTurns(root, "alpha")).toBe(0);
});

it("keeps explicit process aliases ahead of lower-priority canonical env files", async () => {
  const root = await fixture(); await writeFile(path.join(root, "bot.env"), "TAROBOT_ELEMENT_STREAM=on\nTAROBOT_ALLOW_ANY_FILE_PATH=0\n");
  const env = await loadGatewayEnvironment(root, "alpha", { HOME: root, CCTB_LARK_ELEMENT_STREAM: "off", CCTB_LARK_ALLOW_ANY_FILE_PATH: "1" });
  expect(env.TAROBOT_ELEMENT_STREAM).toBe("off"); expect(env.TAROBOT_ALLOW_ANY_FILE_PATH).toBe("1");
  expect(env.CCTB_LARK_ELEMENT_STREAM).toBeUndefined();
});

it("leaves genuine Feishu state filenames intact", async () => {
  const root = await fixture();
  await withChannelProfile("feishu", async () => { await assertStableCoreIdMappings(root, [["chat", 42, "lark:oc_one"]]); await new CoreGroupModeStore(root).setListenAll("oc_one", true); });
  expect(JSON.parse(await readFile(path.join(root, "lark-chat-id-map.json"), "utf8"))).toMatchObject({ "42": "lark:oc_one" });
  expect(JSON.parse(await readFile(path.join(root, "lark-group-mode.json"), "utf8"))).toMatchObject({ listenAllChatIds: ["oc_one"] });
});


it("stages new App archives under tarobot names and resumes stored legacy archive paths unchanged", async () => withChannelProfile("gateway", async () => {
  const root = await fixture(), archive = path.join(root, "notes.zip");
  const zip = new AdmZip(); zip.addFile("notes.txt", Buffer.from("archive content")); await zip.writeZipPromise(archive);
  const normalized = normalizeCoreMessage({ messageId: "msg_zip", chatId: "gw_zip", chatType: "p2p", senderId: "gwuser_one", text: "read", resources: [] });
  const result = await prepareCoreFileWorkflow({ stateDir: root, normalized, commandText: "read", downloadedAttachments: [{ localPath: archive, attachment: { kind: "file", fileKey: "notes", fileName: "notes.zip" } }] });
  expect(result?.workflowRecordId).toBeTruthy();
  const store = new FileWorkflowStore(root);
  const record = (await store.list()).find(item => item.uploadId === result!.workflowRecordId)!;
  expect(record.extractedPath).toContain(`${path.sep}.tarobot-files${path.sep}`);
  expect(await readFile(path.join(record.extractedPath!, "notes.txt"), "utf8")).toBe("archive content");
  const legacy = path.join(root, "workspace", ".telegram-files", "old", "extracted");
  await mkdir(legacy, { recursive: true }); await writeFile(path.join(legacy, "notes.txt"), "old archive content");
  await store.update(record.uploadId, item => { item.extractedPath = legacy; });
  const continued = await prepareCoreFileWorkflow({ stateDir: root, normalized, commandText: "/continue", downloadedAttachments: [] });
  expect(continued?.kind).toBe("direct"); expect(continued?.text).toContain(legacy);
  expect(await readFile(path.join(legacy, "notes.txt"), "utf8")).toBe("old archive content");
  expect(boundArchiveSummary("x".repeat(5000))).not.toContain("Telegram");
}));

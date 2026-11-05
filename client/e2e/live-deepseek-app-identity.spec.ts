import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("real DeepSeek corrects stale channel identity on resume with native and compatibility App tools", async ({}, info) => {
  test.skip(process.env.TAROCUB_LIVE_DEEPSEEK_APP_IDENTITY !== "1", "explicit authenticated native acceptance only");
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deepseek-identity-"));
  const workspace = path.join(root, "workspace"); await mkdir(workspace);
  const load = (name: string) => import(pathToFileURL(path.resolve(`../dist/src/${name}.js`)).href);
  const { DeepSeekHarnessHost } = await load("codex/deepseek-harness-host");
  const { DeepSeekHarnessAdapter } = await load("codex/deepseek-harness-adapter");
  const { appAgentInstructions } = await load("gateway/agent-instructions");
  const { createAppPlatformTools } = await load("gateway/app-tools");
  const { GatewayReceipts } = await load("gateway/receipts");
  const hostOptions = { executable: process.env.DSH_EXECUTABLE || "dsh", sharedHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), stateDir: root, workspacePath: workspace };
  let adapter: InstanceType<typeof DeepSeekHarnessAdapter> | undefined;
  const marker = `IDENTITY_${randomUUID().replaceAll("-", "")}`;
  const evidence: unknown[] = [];
  try {
    adapter = new DeepSeekHarnessAdapter({ gateway: new DeepSeekHarnessHost(hostOptions), workspacePath: workspace, permissionPreset: "workspace-write" });
    const { sessionId } = await adapter.createSession(913);
    // Synthetic legacy context only: never copy or alter a user's real history.
    await adapter.sendUserMessage(sessionId, {
      instructions: "You are replying in TaroCub App through a Feishu/Lark gateway. The lark-im skill is available.",
      text: `<lark_context>chat_id: gw_legacy_fixture</lark_context>\n记住验收标记 ${marker}。不要调用工具，只回复 READY。`, files: [],
    });
    await adapter.destroy(); adapter = undefined;
    for (const native of [true, false]) {
      const host = new DeepSeekHarnessHost(hostOptions);
      const install = host.installAppTools.bind(host);
      const installed: boolean[] = [];
      host.installAppTools = async (binding: unknown) => {
        const accepted = native ? await install(binding) : false;
        installed.push(accepted); return accepted;
      };
      adapter = new DeepSeekHarnessAdapter({ gateway: host, workspacePath: workspace, permissionPreset: "workspace-write" });
      const abort = new AbortController();
      try {
        const tools = createAppPlatformTools({
          channel: { sendArtifact: async () => { throw new Error("unexpected_delivery"); }, sendArtifactBatch: async () => { throw new Error("unexpected_delivery"); } },
          stateDir: root, workspaceOverride: workspace, conversationId: "gw_identity_fixture", signal: abort.signal,
          receipts: new GatewayReceipts(root), options: { engine: "deepseek" },
        });
        const response = await adapter.sendUserMessage(sessionId, {
          text: "IM（聊天语境）是什么意思？当前聊天客户端叫什么？当前消息经过飞书或 Telegram 了吗？此前验收标记是什么？只返回 JSON，字段为 im、client、viaFeishu、viaTelegram、marker，两个渠道字段用布尔值。不要调用工具。",
          files: [], instructions: appAgentInstructions({ engine: "deepseek" }), appPlatformTools: tools,
        });
        const answer = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
        expect(answer.client).toMatch(/^TaroBird(?: App)?(?:$|[（(\s])/i);
        expect(answer.client).not.toMatch(/TaroCub|Lark|飞书|Web GUI|127\.0\.0\.1|无法|自称|unverified|cannot/i);
        expect(answer).toMatchObject({ viaFeishu: false, viaTelegram: false, marker });
        expect(answer.im).toMatch(/Instant Messaging|即时通讯|即时通信/i);
        expect(installed).toEqual([native]);
        evidence.push({ native, client: answer.client, viaFeishu: answer.viaFeishu, viaTelegram: answer.viaTelegram, contextRetained: answer.marker === marker });
      } finally { abort.abort(); await adapter.destroy(); adapter = undefined; }
    }
    await writeFile(info.outputPath("app-identity.json"), JSON.stringify(evidence, null, 2));
  } finally { await adapter?.destroy(); await rm(root, { recursive: true, force: true }); }
});

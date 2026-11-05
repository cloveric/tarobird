import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

test("real DeepSeek resumes a writer-refused session once, retains context and admits only one prompt", async ({}, info) => {
  test.skip(process.env.TAROCUB_LIVE_DEEPSEEK_WRITER_RECOVERY !== "1", "explicit native fault-injection acceptance only");
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "live-deepseek-writer-"));
  const workspace = path.join(root, "workspace"), plugin = path.join(root, "writer-fault.mjs"), receipt = path.join(root, "refusal.json");
  await mkdir(workspace);
  const { DeepSeekHarnessHost } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-host.js")).href);
  const { DeepSeekHarnessAdapter } = await import(pathToFileURL(path.resolve("../dist/src/codex/deepseek-harness-adapter.js")).href);
  const hostOptions = { executable: process.env.DSH_EXECUTABLE || "dsh", sharedHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), stateDir: root, workspacePath: workspace };
  const first = new DeepSeekHarnessAdapter({ gateway: new DeepSeekHarnessHost(hostOptions), workspacePath: workspace, permissionPreset: "workspace-write" });
  let resumed: InstanceType<typeof DeepSeekHarnessAdapter> | undefined;
  try {
    const { sessionId } = await first.createSession(912);
    const marker = `DSH_WRITER_${randomUUID().replaceAll("-", "")}`;
    await first.sendUserMessage(sessionId, { text: `记住验收标记 ${marker}。不要调用工具，只回复 READY。`, files: [] });
    await first.destroy();
    // Temporary private-host plugin reproduces the installed Harness's exact
    // persistence error before opening the writer. Its real controller maps
    // that error into session/writer-held; no production profile is patched.
    await writeFile(plugin, `import { writeFileSync } from 'node:fs';
export const name = 'tarocub-writer-handoff-test';
export const inject = ['sessionPersistence'];
export function apply(ctx) {
  const persistence = ctx.sessionPersistence, original = persistence.open;
  let refused = false;
  persistence.open = async function(id, mode, options) {
    if (id === ${JSON.stringify(sessionId)} && mode === 'write' && !refused) {
      refused = true;
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ sessionId: id, refused: true }));
      const error = new Error('session "' + id + '" is already owned by an active write handle');
      error.name = 'SessionAlreadyOwnedError'; throw error;
    }
    return original.call(this, id, mode, options);
  };
  ctx.effect(() => () => { persistence.open = original; });
}`);
    const host = new DeepSeekHarnessHost({ ...hostOptions, spawnDsh: (executable: string, args: string[], options: any) => {
      appendFileSync(path.join(options.env.DSH_HOME, "cordis.patch.yml"), `\n- insert:\n    - id: tarocub-writer-handoff-test\n      name: ${JSON.stringify(plugin)}\n`);
      return spawn(executable, args, options);
    } });
    const calls: Array<{ method: string; payload: unknown }> = [];
    const request = host.request.bind(host);
    host.request = async (method: string, payload: unknown, signal?: AbortSignal) => {
      calls.push({ method, payload }); return request(method, payload, signal);
    };
    resumed = new DeepSeekHarnessAdapter({ gateway: host, workspacePath: workspace, permissionPreset: "workspace-write" });
    const response = await resumed.sendUserMessage(sessionId, { text: "之前的验收标记是什么？不要调用工具，只回复标记。", files: [] });
    expect(response.text).toContain(marker);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({ sessionId, refused: true });
    const creates = calls.filter(c => c.method === "session.create");
    expect(creates).toHaveLength(2); expect(creates[1]!.payload).toEqual(creates[0]!.payload);
    expect(calls.filter(c => c.method === "session.prompt")).toHaveLength(1);
    const history = await request("session.history", { sessionId }) as { events: Array<{ event: { type: string; data: { source?: { rpcId?: string } } } }> };
    const admittedId = (calls.find(c => c.method === "session.prompt")!.payload as { requestId: string }).requestId;
    expect(history.events.filter(row => row.event.type === "user/message" && row.event.data.source?.rpcId === admittedId)).toHaveLength(1);
    await writeFile(info.outputPath("writer-recovery.json"), JSON.stringify({ refused: true, creates: creates.length, prompts: 1, contextRetained: true, durableUserMessages: 1 }, null, 2));
  } finally { await resumed?.destroy(); await first.destroy(); await rm(root, { recursive: true, force: true }); }
});

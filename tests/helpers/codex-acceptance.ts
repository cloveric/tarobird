import { spawn } from "node:child_process";
import { realpath, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
const pageSchema = z.object({ data: z.array(z.object({ id: z.string().min(1), cwd: z.string(), status: z.object({ type: z.string() }) })), nextCursor: z.string().nullable() });

/** Native protocol only: never edit Codex's live SQLite database or delete history. */
export async function openAcceptanceCodexRpc() {
  const child = spawn(process.env.CODEX_EXECUTABLE || "codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let serial = 0, stopped: Error | undefined;
  const fail = (error: Error) => { stopped = error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Acceptance cleanup Codex process exited")));
  child.stdin.on("error", fail);
  lines.on("line", (line) => {
    let frame: { id?: number; result?: unknown; error?: unknown };
    try { frame = JSON.parse(line); } catch { return; }
    if (typeof frame.id !== "number") return;
    const item = pending.get(frame.id); if (!item) return;
    pending.delete(frame.id); clearTimeout(item.timer);
    if (frame.error) item.reject(new Error("Codex rejected acceptance cleanup request"));
    else item.resolve(frame.result);
  });
  const request: Request = (method, params) => new Promise((resolve, reject) => {
    if (stopped) { reject(stopped); return; }
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Acceptance cleanup timed out: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    lines.close(); fail(new Error("Acceptance cleanup closed"));
  };
  try {
    await request("initialize", { clientInfo: { name: "tarocub_acceptance_cleanup", title: "TaroCub acceptance cleanup", version: "1" }, capabilities: { experimentalApi: true } });
    return { request, close };
  } catch (error) { await close(); throw error; }
}

/** Call only after the fixture's Hub/workers stop, and before removing its root. */
export async function archiveAcceptanceThreads(root: string, requestOverride?: Request, expectedThreadIds: readonly string[] = []): Promise<number> {
  const ownedRoot = await realpath(root), temporaryRoot = await realpath(os.tmpdir());
  if (path.dirname(ownedRoot) !== temporaryRoot || !/^live-(?:session-model|client-worker|hub-backup|client-bus|codex-input|codex-async|codex-permissions|codex-consent|app-tools|widget-interaction)-[A-Za-z0-9]+$/.test(path.basename(ownedRoot))) {
    throw new Error("Refusing Codex cleanup outside an owned acceptance directory");
  }
  const candidates = [ownedRoot, path.join(ownedRoot, "project"), path.join(ownedRoot, "workspace")];
  for (const botsRoot of [path.join(ownedRoot, "bots"), path.join(ownedRoot, "hub", "bots")]) {
    const bots = await readdir(botsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const bot of bots) if (bot.isDirectory() && /^client_[A-Za-z0-9]+$/.test(bot.name)) candidates.push(path.join(botsRoot, bot.name, "workspace"));
  }
  const cwds = new Set<string>();
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (resolved && (resolved === ownedRoot || resolved.startsWith(ownedRoot + path.sep))) cwds.add(resolved);
  }
  const rpc = requestOverride ? undefined : await openAcceptanceCodexRpc();
  const request = requestOverride ?? rpc!.request;
  const list = async () => {
    const found = new Map<string, z.infer<typeof pageSchema>["data"][number]>(), cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const result = pageSchema.parse(await request("thread/list", { cwd: [...cwds], sourceKinds, modelProviders: [], archived: false, limit: 100, cursor, useStateDbOnly: true }));
      for (const thread of result.data) if (cwds.has(thread.cwd)) found.set(thread.id, thread);
      if (!result.nextCursor) return [...found.values()];
      if (cursors.has(result.nextCursor)) throw new Error("Codex cleanup pagination repeated a cursor");
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error("Codex cleanup exceeded its pagination limit");
  };
  try {
    // Complete the inventory before mutation so archiving cannot skip a page.
    const threads = await list();
    const inventoriedIds = new Set(threads.map((thread) => thread.id));
    if (expectedThreadIds.some((id) => !inventoriedIds.has(id))) throw new Error("Owned acceptance thread is missing from the archive inventory");
    if (threads.some((thread) => thread.status.type === "active")) throw new Error("Acceptance worker must stop before its sessions are archived");
    for (const thread of threads) await request("thread/archive", { threadId: thread.id });
    if ((await list()).length) throw new Error("Acceptance sessions remain visible after archive");
    return threads.length;
  } finally { await rpc?.close(); }
}

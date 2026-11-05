import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reuseMediaTranscript } from "../src/runtime/media-transcript-cache.js";
import { childProcessTestEnv } from "./helpers/temp-files.js";

let root: string, input: Parameters<typeof reuseMediaTranscript>[0];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "media-reuse-"));
  input = { hostDir: root, conversationId: "group", attachmentId: "recording", file: path.join(root, "recording.m4a"), policy: { route: "cloud" } };
  await writeFile(input.file, "recorded voice");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const cacheFile = async () => path.join(root, "media-transcripts", (await readdir(path.join(root, "media-transcripts"))).find(name => name.endsWith(".json"))!);

it("shares across real Worker processes, then reuses a private persisted result", async () => {
  const entry = path.join(root, "worker.mts"), count = path.join(root, "uploads.txt");
  const module = pathToFileURL(path.resolve("src/runtime/media-transcript-cache.ts")).href;
  await writeFile(entry, `import { reuseMediaTranscript } from ${JSON.stringify(module)};
import { appendFile } from 'node:fs/promises';
const text = await reuseMediaTranscript(${JSON.stringify(input)}, async () => {
  await appendFile(${JSON.stringify(count)}, 'upload\\n');
  await new Promise(r => setTimeout(r, 200)); return 'one transcript';
});
if (text !== 'one transcript') process.exitCode = 1;
`);
  const cli = createRequire(import.meta.url).resolve("tsx/cli");
  await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, [cli, entry], { env: childProcessTestEnv(), timeout: 20_000 })));
  expect(await readFile(count, "utf8")).toBe("upload\n");
  const work = vi.fn(async () => "wrong");
  expect(await reuseMediaTranscript(input, work)).toBe("one transcript"); expect(work).not.toHaveBeenCalled();
  if (process.platform !== "win32") {
    expect((await stat(await cacheFile())).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(root, "media-transcripts"))).mode & 0o777).toBe(0o700);
  }
});

it("isolates conversations, attachment IDs, bytes and routing policy", async () => {
  const work = vi.fn(async () => "transcript");
  await reuseMediaTranscript(input, work);
  await reuseMediaTranscript({ ...input, conversationId: "another" }, work);
  await reuseMediaTranscript({ ...input, attachmentId: "another" }, work);
  await reuseMediaTranscript({ ...input, policy: { route: "local" } }, work);
  await writeFile(input.file, "replacement bytes");
  await reuseMediaTranscript(input, work);
  expect(work).toHaveBeenCalledTimes(5);
});

it("recovers a cache slot after its owning Worker process is killed", async () => {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, entry = path.join(root, "crash-owner.mts"), ready = path.join(root, "owner-ready");
  await writeFile(entry, `import { reuseMediaTranscript } from ${JSON.stringify(pathToFileURL(path.resolve("src/runtime/media-transcript-cache.ts")).href)};
import { writeFile } from 'node:fs/promises';
await reuseMediaTranscript(${JSON.stringify(input)}, async () => {
  await writeFile(${JSON.stringify(ready)}, String(process.pid));
  await new Promise(() => setInterval(() => {}, 1000)); return 'never completed';
});`);
  const owner = spawn(process.execPath, ["--import", loader, entry], { env: childProcessTestEnv(), stdio: "ignore" });
  const exited = new Promise<void>(resolve => owner.once("close", () => resolve()));
  try {
    await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe(String(owner.pid)), { timeout: 15_000 });
    const work = vi.fn(async () => "recovered");
    const waiter = reuseMediaTranscript({ ...input, waitTimeoutMs: 15_000 }, work);
    owner.kill("SIGKILL"); await exited;
    expect(await waiter).toBe("recovered"); expect(work).toHaveBeenCalledTimes(1);
    expect(await reuseMediaTranscript(input, work)).toBe("recovered"); expect(work).toHaveBeenCalledTimes(1);
  } finally { owner.kill("SIGKILL"); await exited; }
}, 25_000);

it("cancels a waiting Bot without cancelling the owner or executing the waiter later", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
  const owner = reuseMediaTranscript(input, async () => { entered(); await hold; return "shared"; });
  await ready;
  const controller = new AbortController(), work = vi.fn(async () => "wrong");
  const waiting = reuseMediaTranscript({ ...input, signal: controller.signal }, work);
  controller.abort(); await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  release(); expect(await owner).toBe("shared");
  expect(await reuseMediaTranscript(input, work)).toBe("shared"); expect(work).not.toHaveBeenCalled();
});

it("releases a cancelled owner for another active Bot without caching its late result", async () => {
  const controller = new AbortController();
  await expect(reuseMediaTranscript({ ...input, signal: controller.signal }, async () => { controller.abort(); return "cancelled result"; })).rejects.toMatchObject({ name: "AbortError" });
  expect(await reuseMediaTranscript(input, async () => "retried")).toBe("retried");
});

it("does not cache empty or failed transcripts", async () => {
  const work = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("partial")).mockResolvedValueOnce("").mockResolvedValue("complete");
  await expect(reuseMediaTranscript(input, work)).rejects.toThrow("partial");
  expect(await reuseMediaTranscript(input, work)).toBe("");
  expect(await reuseMediaTranscript(input, work)).toBe("complete");
  expect(await reuseMediaTranscript(input, work)).toBe("complete"); expect(work).toHaveBeenCalledTimes(3);
});

it.each(["expired", "future", "damaged", "oversized"])("ignores %s persisted results", async kind => {
  await reuseMediaTranscript(input, async () => "old");
  const file = await cacheFile();
  const bytes = kind === "damaged" ? "{" : kind === "oversized" ? "x".repeat(1024 * 1024 + 1) : JSON.stringify({ version: 1, at: Date.now() + (kind === "future" ? 60_000 : -86400_001), text: "old" });
  await writeFile(file, bytes);
  expect(await reuseMediaTranscript(input, async () => "fresh")).toBe("fresh");
});

it("does not read symlinked results and bypasses an unsafe cache without losing transcription", async () => {
  if (process.platform === "win32") return; // Symlink creation requires a separate Windows privilege gate.
  await reuseMediaTranscript(input, async () => "safe");
  const file = await cacheFile(), outside = path.join(root, "outside.json");
  const contents = JSON.stringify({ version: 1, at: Date.now(), text: "untrusted" });
  await writeFile(outside, contents); await rm(file); await symlink(outside, file);
  expect(await reuseMediaTranscript(input, async () => "fresh")).toBe("fresh");
  expect(await readFile(outside, "utf8")).toBe(contents);
  await rm(path.join(root, "media-transcripts"), { recursive: true });
  await symlink(root, path.join(root, "media-transcripts"));
  const work = vi.fn(async () => "uncached authorized result");
  expect(await reuseMediaTranscript(input, work)).toBe("uncached authorized result");
  expect(work).toHaveBeenCalledTimes(1);
  expect(await readFile(outside, "utf8")).toBe(contents);
});

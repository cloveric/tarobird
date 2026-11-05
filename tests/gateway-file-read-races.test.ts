import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";

const fault = vi.hoisted(() => ({ file: "", mode: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === fault.file && fault.mode === "truncate") await fs.truncate(fault.file, 0);
    const handle = await fs.open(...args);
    if (args[0] !== fault.file || fault.mode !== "rewrite") return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === "readFile") return async (...input: unknown[]) => {
        const bytes = await Reflect.apply(target.readFile, target, input);
        const before = await target.stat();
        await fs.writeFile(fault.file, Buffer.alloc(before.size, "x"));
        await fs.utimes(fault.file, before.atime, new Date(before.mtimeMs + 2000));
        return bytes;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
});
let root: string, file: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "app-file-race-")));
  await mkdir(path.join(root, "workspace"));
  file = path.join(root, "workspace", "report.txt");
  await writeFile(file, "verified bytes"); fault.file = file;
});
afterEach(async () => { fault.file = ""; fault.mode = ""; await rm(root, { recursive: true, force: true }); });

it.each(["empty", "truncate", "rewrite"])("does not publish an %s file or misleading retry advice", async mode => {
  if (mode === "empty") await writeFile(file, "");
  else fault.mode = mode;
  const sendArtifact = vi.fn(async () => ({ messageId: "should-not-send" }));
  const tools = createAppPlatformTools({ channel: { sendArtifact }, stateDir: root, conversationId: "conv", receipts: new GatewayReceipts(root), signal: new AbortController().signal });
  const call = () => tools.call({ name: "app_send_file", arguments: { path: file, kind: "file" }, callId: "file", sessionId: "session", abortSignal: new AbortController().signal });
  const result = await call(), receipt = JSON.parse(result.text);
  expect(result.isError).toBe(true);
  expect(receipt).toMatchObject({ error: mode === "empty" ? "empty_file" : "file_changed", published: false });
  expect(receipt.retryable).not.toBe(true);
  expect(await call()).toEqual(result);
  expect(sendArtifact).not.toHaveBeenCalled();
});

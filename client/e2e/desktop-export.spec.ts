import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportAttachment } from "../src/attachment-export.js";

/** The shipped Tauri JS plugins use a narrow IPC double writing real temporary
 * files with injected short writes. This is not native save-dialog acceptance. */
async function nativeFile(run: (fixture: {
  target: string; calls: { command: string; bytes?: number }[];
  select: (value: string | null) => void;
  writer: (write: (file: FileHandle, data: Uint8Array) => Promise<number>) => void;
  failClose: () => void;
  failQuarantine: () => void;
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-file-export-"));
  const target = path.join(root, "result.bin"), calls: { command: string; bytes?: number }[] = [];
  let selected: string | null = target, file: FileHandle | undefined, closeFailure = false, quarantineFailure = false;
  let write = async (handle: FileHandle, data: Uint8Array) => (await handle.write(data)).bytesWritten;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window"), tauriDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", { value: true, configurable: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (command: string, args: { rid?: number; path?: string; data?: Uint8Array; options?: object; len?: number }) => {
    calls.push({ command, ...(args.data ? { bytes: args.data.length } : {}) });
    switch (command) {
      case "plugin:dialog|save": return selected;
      case "plugin:fs|open": expect(args.path).toBe(selected); expect(args.options).toEqual({ read: false, write: true, create: true }); file = await open(target, constants.O_WRONLY | constants.O_CREAT); return 7;
      case "quarantine_saved_file": {
        expect(args.path).toBe(selected); expect(file).toBeDefined();
        expect(calls.filter(c => c.command === "plugin:fs|write")).toHaveLength(0);
        if (quarantineFailure) throw "saved_file_quarantine_failed";
        return;
      }
      case "plugin:fs|ftruncate": expect(args.rid).toBe(7); expect(args.len).toBe(0); await file!.truncate(args.len); return;
      case "plugin:fs|write": expect(args.rid).toBe(7); return write(file!, args.data!);
      case "plugin:resources|close": {
        expect(args.rid).toBe(7); const handle = file!; file = undefined; await handle.close();
        if (closeFailure) throw new Error("native_close_failed"); return;
      }
      default: throw new Error(`unexpected_ipc:${command}`);
    }
  } } } });
  try { await run({ target, calls, select: value => { selected = value; }, writer: value => { write = value; }, failClose: () => { closeFailure = true; }, failQuarantine: () => { quarantineFailure = true; } }); }
  finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window");
    if (tauriDescriptor) Object.defineProperty(globalThis, "isTauri", tauriDescriptor); else Reflect.deleteProperty(globalThis, "isTauri");
    await file?.close(); await rm(root, { recursive: true, force: true });
  }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("desktop save retains every byte across partial native writes and chunk boundaries", async () => {
  await nativeFile(async ({ target, calls, writer }) => {
    const bytes = Uint8Array.from({ length: 2 * 1024 ** 2 + 177 }, (_, i) => (i * 31 + (i >>> 9)) % 256);
    let writes = 0;
    writer(async (file, data) => (await file.write(data.subarray(0, ++writes % 2 ? 4093 : 65_537))).bytesWritten);
    const stages: string[] = [];
    expect(await exportAttachment(new Blob([bytes]), "result.bin", {
      stage: stage => { stages.push(stage); },
      delivered: (result, savedPath) => {
        expect(calls.at(-1)?.command).toBe("plugin:resources|close");
        expect(savedPath).toBe(target);
        stages.push(result);
      },
    })).toBe(true);
    expect(stages).toEqual(["choosing", "preparing", "saving", "saved"]);
    const saved = await readFile(target);
    expect(saved.length).toBe(bytes.length); expect(digest(saved)).toBe(digest(bytes));
    expect(writes).toBeGreaterThan(3);
    expect(calls.filter(c => c.command === "plugin:resources|close")).toHaveLength(1);
    expect(calls.slice(0, 4).map(c => c.command)).toEqual(["plugin:dialog|save", "plugin:fs|open", "quarantine_saved_file", "plugin:fs|ftruncate"]);
    expect(Math.max(...calls.map(c => c.bytes ?? 0))).toBeLessThanOrEqual(1024 ** 2);
  });
});

for (const count of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 100]) test(`invalid native write count ${count} never reports a saved file`, async () => {
  await nativeFile(async ({ calls, writer }) => {
    writer(async () => count);
    await expect(exportAttachment(new Blob(["file content"]), "result.bin")).rejects.toThrow("文件未完整写入，请重新保存。");
    expect(calls.filter(c => c.command === "plugin:fs|write")).toHaveLength(1);
    expect(calls.filter(c => c.command === "plugin:resources|close")).toHaveLength(1);
  });
});

test("cancel, I/O failure and close failure never become successful saves", async () => {
  await nativeFile(async ({ calls, select }) => {
    const delivered: string[] = [];
    select(null); expect(await exportAttachment(new Blob(["private bytes"]), "result.bin", { delivered: value => { delivered.push(value); } })).toBe(false);
    expect(delivered).toEqual([]);
    expect(calls.map(c => c.command)).toEqual(["plugin:dialog|save"]);
  });
  await nativeFile(async ({ calls, writer }) => {
    writer(async () => { throw new Error("disk_full"); });
    await expect(exportAttachment(new Blob(["private bytes"]), "result.bin")).rejects.toThrow("disk_full");
    expect(calls.filter(c => c.command === "plugin:resources|close")).toHaveLength(1);
  });
  await nativeFile(async ({ failClose }) => {
    const delivered: string[] = [];
    failClose(); await expect(exportAttachment(new Blob(["private bytes"]), "result.bin", { delivered: value => { delivered.push(value); } })).rejects.toThrow("native_close_failed");
    expect(delivered).toEqual([]);
  });
});

test("empty attachment creates and closes an empty file without a write loop", async () => {
  await nativeFile(async ({ target, calls }) => {
    expect(await exportAttachment(new Blob(), "empty.bin")).toBe(true);
    expect((await readFile(target)).length).toBe(0);
    expect(calls.map(c => c.command)).toEqual(["plugin:dialog|save", "plugin:fs|open", "quarantine_saved_file", "plugin:fs|ftruncate", "plugin:resources|close"]);
  });
});

test("successful replacement truncates old trailing bytes only after quarantine", async () => {
  await nativeFile(async ({ target, calls }) => {
    await writeFile(target, "previous longer document");
    expect(await exportAttachment(new Blob(["new"]), "result.bin")).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new");
    expect(calls.findIndex(call => call.command === "plugin:fs|ftruncate")).toBeGreaterThan(calls.findIndex(call => call.command === "quarantine_saved_file"));
  });
});

test("quarantine failure preserves the replaced file and never writes or reports a saved file", async () => {
  await nativeFile(async ({ target, calls, failQuarantine }) => {
    const delivered: string[] = [];
    const previous = Buffer.from("the user's existing document must survive");
    await writeFile(target, previous);
    failQuarantine();
    const error = await exportAttachment(new Blob(["untrusted attachment bytes"]), "file.terminal", { delivered: result => { delivered.push(result); } }).catch(error => error);
    expect(await readFile(target)).toEqual(previous);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("无法在此位置安全保存附件，请选择其他文件夹后重试。");
    expect(delivered).toEqual([]);
    expect(calls.map(c => c.command)).toEqual(["plugin:dialog|save", "plugin:fs|open", "quarantine_saved_file", "plugin:resources|close"]);
  });
});

test("native string rejection explains a save failure and closes the file", async () => {
  await nativeFile(async ({ calls, writer }) => {
    writer(async () => { throw "No space left on device (os error 28)"; });
    await expect(exportAttachment(new Blob(["private bytes"]), "result.bin")).rejects.toThrow("保存失败，请检查剩余空间和文件权限后重试。");
    expect(calls.filter(c => c.command === "plugin:resources|close")).toHaveLength(1);
  });
});

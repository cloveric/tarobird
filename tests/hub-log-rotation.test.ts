import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rotateHubLog, readHubLogTail, startHubLogRotation, isHubLogFile } from "../src/hub/log-rotation.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "hub-log-rotation-")); });
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

it("bounds retained logs while existing stdout/stderr append handles keep the same inode", async () => {
  const file = path.join(root, "hub.log"), stdout = await open(file, "a", 0o600), stderr = await open(file, "a");
  try {
    const identity = await stdout.stat();
    for (let turn = 0; turn < 6; turn++) {
      await stdout.write(`stdout ${turn}\n` + "a".repeat(100));
      await stderr.write(`stderr ${turn}\n`);
      expect(await rotateHubLog(root, { maxBytes: 64, keepCount: 2 })).toBe(true);
      const current = await stat(file);
      expect([current.dev, current.ino, current.size]).toEqual([identity.dev, identity.ino, 0]);
      expect((await readFile(`${file}.1`, "utf8")).endsWith(`stderr ${turn}\n`)).toBe(true);
      expect((await stat(`${file}.1`)).size).toBeLessThanOrEqual(64);
      if (turn) expect((await stat(`${file}.2`)).size).toBeLessThanOrEqual(64);
    }
    await stdout.write("kept stdout\n"); await stderr.write("kept stderr\n");
    expect(await readFile(file, "utf8")).toBe("kept stdout\nkept stderr\n");
    expect((await readdir(root)).sort()).toEqual(["hub.log", "hub.log.1", "hub.log.2"]);
    expect((await readHubLogTail(root)).endsWith("kept stdout\nkept stderr\n")).toBe(true);
    expect(await readHubLogTail(root)).toContain("stderr 5");
  } finally { await stdout.close(); await stderr.close(); }
});

it("continues concurrent append traffic across repeated copy-truncate without moving the open log", async () => {
  const file = path.join(root, "hub.log"), writer = await open(file, "a", 0o600);
  try {
    const initial = await writer.stat();
    for (let batch = 0; batch < 5; batch++) {
      await writer.write("p".repeat(128));
      await Promise.all([rotateHubLog(root, { maxBytes: 64, keepCount: 2 }), (async () => {
        for (let n = 0; n < 10; n++) { await writer.write(`during ${batch}/${n}\n`); await new Promise(resolve => setImmediate(resolve)); }
      })()]);
      await rotateHubLog(root, { maxBytes: 64, keepCount: 2 });
      expect((await stat(file)).size).toBeLessThan(64);
      expect((await stat(file)).ino).toBe(initial.ino);
    }
    await writer.write("still alive\n");
    expect((await readFile(file, "utf8")).endsWith("still alive\n")).toBe(true);
    for (const name of await readdir(root)) expect((await stat(path.join(root, name))).size).toBeLessThanOrEqual(64);
  } finally { await writer.close(); }
});

it("does not follow symlinks or truncate the live log if archive publication fails", async () => {
  const target = path.join(root, "unrelated"), file = path.join(root, "hub.log");
  await writeFile(target, "preserve outside content"); await symlink(target, file);
  await expect(rotateHubLog(root, { maxBytes: 8, keepCount: 2 })).rejects.toThrow("hub_log_not_regular");
  expect(await readFile(target, "utf8")).toBe("preserve outside content");
  await rm(file); await writeFile(file, "live content must survive");
  await symlink(target, `${file}.1`);
  await expect(rotateHubLog(root, { maxBytes: 8, keepCount: 2 })).rejects.toThrow("hub_log_not_regular");
  expect(await readFile(file, "utf8")).toBe("live content must survive");
  expect(await readFile(target, "utf8")).toBe("preserve outside content");
});

it("checks at startup and during runtime, drains and stops its timer without stopping the writer", async () => {
  const file = path.join(root, "hub.log"), writer = await open(file, "a", 0o600), warning = vi.fn();
  const stop = startHubLogRotation(root, warning, { maxBytes: 32, keepCount: 2 }, 10);
  try {
    await writer.write("a".repeat(40));
    await vi.waitFor(async () => expect((await stat(file)).size).toBe(0));
    await writer.write("b".repeat(40));
    await vi.waitFor(async () => expect((await readFile(`${file}.1`, "utf8"))).toBe("b".repeat(32)));
    await stop(); await writer.write("c".repeat(40));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await readFile(file, "utf8")).toBe("c".repeat(40));
    expect(warning).not.toHaveBeenCalled();
  } finally { await stop(); await writer.close(); }
});

it("does not create a log for foreground terminals and bounds log tail reads", async () => {
  expect(await rotateHubLog(root)).toBe(false);
  expect(await readHubLogTail(root)).toBe("No Hub log yet.");
  await writeFile(path.join(root, "hub.log.1"), "older\n" + "x".repeat(128));
  await writeFile(path.join(root, "hub.log"), "newer\n");
  const tail = await readHubLogTail(root, 32);
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(32);
  expect(tail.endsWith("newer\n")).toBe(true);
});

it("identifies only root operational logs for backup/update exclusions", () => {
  for (const name of ["hub.log", "hub.log.1", "hub.log.3", ".hub.log.rotation.tmp"]) expect(isHubLogFile(name)).toBe(true);
  for (const name of ["bots/alpha/workspace/hub.log.1", "hub.log.notes", "notes.hub.log", "hub.log.0"]) expect(isHubLogFile(name)).toBe(false);
});

it("keeps an actual child process's inherited stdout/stderr handles usable after rotation", async () => {
  const file = path.join(root, "hub.log"), output = await open(file, "a", 0o600);
  const child = spawn(process.execPath, ["-e", `process.on("message", text => {
    if (text === "quit") process.exit(0);
    process.stdout.write(text + "\\n", () => process.stderr.write("stderr\\n", () => process.send("done")));
  });`], { stdio: ["ignore", output.fd, output.fd, "ipc"] });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn"); await output.close();
    const identity = await stat(file);
    for (let i = 0; i < 3; i++) {
      const done = once(child, "message"); child.send("x".repeat(96)); await done;
      expect(await rotateHubLog(root, { maxBytes: 64, keepCount: 2 })).toBe(true);
      expect((await stat(file)).ino).toBe(identity.ino);
    }
    const done = once(child, "message"); child.send("final child output"); await done;
    expect(await readFile(file, "utf8")).toBe("final child output\nstderr\n");
  } finally { if (child.connected) child.send("quit"); else child.kill(); await exited; await output.close().catch(() => {}); }
});

it("replaces one crash-left staging snapshot without accumulating temporary files", async () => {
  await writeFile(path.join(root, "hub.log"), "l".repeat(128));
  await writeFile(path.join(root, ".hub.log.rotation.tmp"), "abandoned staging");
  expect(await rotateHubLog(root, { maxBytes: 64, keepCount: 2 })).toBe(true);
  expect((await readdir(root)).sort()).toEqual(["hub.log", "hub.log.1"]);
  expect(await readFile(path.join(root, "hub.log.1"), "utf8")).toBe("l".repeat(64));
});

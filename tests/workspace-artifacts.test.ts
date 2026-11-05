import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { cleanupCoreMessageArtifacts, downloadCoreAttachments } from "../src/core/files.js";
import type { CoreChannelLike } from "../src/core/types.js";
import { createArchive } from "../src/state/archive.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-artifacts-")); roots.push(root);
  return root;
}

it.each(["gateway", "feishu"] as const)("writes %s attachments without moving or overwriting old references", async profile => {
  const stateDir = await fixture(), workspace = path.join(stateDir, "workspace");
  const oldFile = path.join(workspace, ".lark-files", "previous", "input", "notes.txt");
  await mkdir(path.dirname(oldFile), { recursive: true }); await writeFile(oldFile, "old bytes");
  const channel = { downloadResource: async () => Buffer.from("new bytes") } as CoreChannelLike;
  const files = await withChannelProfile(profile, () => downloadCoreAttachments({
    stateDir, channel, messageId: "current", attachments: [{ kind: "file", fileKey: "file", fileName: "notes.txt" }],
  }));
  expect(files[0]!.localPath).toBe(path.join(workspace, profile === "gateway" ? ".tarobot-files" : ".lark-files", "current", "input", "notes.txt"));
  expect(await readFile(files[0]!.localPath, "utf8")).toBe("new bytes");
  expect(await readFile(oldFile, "utf8")).toBe("old bytes");
  if (profile === "gateway") expect(await readdir(path.join(workspace, ".lark-files"))).toEqual(["previous"]);
  else expect(await readdir(workspace)).not.toContain(".tarobot-files");
});

it.each([0, 3])("applies App retention %s to both generations without removing other recent files", async retentionDays => {
  const stateDir = await fixture();
  for (const name of [".tarobot-files", ".lark-files"]) {
    for (const id of ["current", "expired", "recent"]) {
      const dir = path.join(stateDir, "workspace", name, id);
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "file.txt"), id);
      if (id === "expired") { const old = new Date(Date.now() - 5 * 86400_000); await utimes(dir, old, old); }
    }
  }
  await withChannelProfile("gateway", () => cleanupCoreMessageArtifacts(stateDir, "current", retentionDays));
  for (const name of [".tarobot-files", ".lark-files"]) {
    expect((await readdir(path.join(stateDir, "workspace", name))).sort()).toEqual(retentionDays ? ["current", "recent"] : ["expired", "recent"]);
  }
});

it("does not let legacy cleanup remove App working copies", async () => {
  const stateDir = await fixture(), dir = path.join(stateDir, "workspace", ".tarobot-files", "current");
  await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "file.txt"), "App data");
  await withChannelProfile("feishu", () => cleanupCoreMessageArtifacts(stateDir, "current", 0));
  expect(await readFile(path.join(dir, "file.txt"), "utf8")).toBe("App data");
});

it("keeps both generations of scratch data out of instance backups while preserving user files", async () => {
  const root = await fixture(), stateDir = path.join(root, "state"), names = [".tarobot-files", ".tarobot-out", ".lark-files", ".lark-out"];
  for (const name of names) {
    const dir = path.join(stateDir, "workspace", name); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "scratch.txt"), "scratch");
  }
  await writeFile(path.join(stateDir, "workspace", "notes.md"), "keep me");
  const archive = await createArchive(stateDir, path.join(root, "backup.gz"));
  expect(archive.excludedDirectories.sort()).toEqual(names.map(name => `workspace/${name}`).sort());
  expect(archive.fileCount).toBe(1);
});

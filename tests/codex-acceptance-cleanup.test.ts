import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveAcceptanceThreads } from "./helpers/codex-acceptance.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(prefix = "live-session-model-") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix))); roots.push(root);
  await mkdir(path.join(root, "project")); return root;
}
const thread = (id: string, cwd: string, type = "notLoaded") => ({ id, cwd, status: { type } });

describe("real Codex acceptance cleanup", () => {
  it("requires every observed fixture thread in the inventory before any archive", async () => {
    const root = await fixture();
    const request = vi.fn(async () => ({ data: [thread("one", root)], nextCursor: null }));
    await expect(archiveAcceptanceThreads(root, request, ["one", "missing"])).rejects.toThrow("missing from the archive inventory");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["live-app-tools-", "live-widget-interaction-"])("archives only the owned %s fixture workspace and verifies removal", async (prefix) => {
    const root = await fixture(prefix);
    await mkdir(path.join(root, "workspace"));
    const archived: string[] = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/archive") { archived.push(String(params.threadId)); return {}; }
      return { data: archived.length ? [] : [thread("app-tools", path.join(root, "workspace")), thread("unrelated", root + "-sibling/workspace")], nextCursor: null };
    });
    expect(await archiveAcceptanceThreads(root, request, ["app-tools"])).toBe(1);
    expect(archived).toEqual(["app-tools"]);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/list", "thread/archive", "thread/list"]);
  });

  it("rejects ordinary project directories before opening Codex", async () => {
    const root = await fixture("ordinary-project-"), request = vi.fn();
    await expect(archiveAcceptanceThreads(root, request)).rejects.toThrow("outside an owned");
    expect(request).not.toHaveBeenCalled();
  });

  it("inventories all pages before archiving and excludes sibling paths and symlinks", async () => {
    const root = await fixture(), outside = await fixture("ordinary-project-");
    await symlink(outside, path.join(root, "workspace"), "dir");
    await mkdir(path.join(root, "hub", "bots", "client_test", "workspace"), { recursive: true });
    const rows = [thread("private", path.join(root, "project")), thread("group", path.join(root, "hub/bots/client_test/workspace"))];
    const archived: string[] = [], calls: string[] = [];
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push(method);
      if (method === "thread/archive") { archived.push(String(params.threadId)); return {}; }
      expect(params.cwd).toEqual(expect.arrayContaining([root, rows[0]!.cwd, rows[1]!.cwd]));
      expect(params.cwd).not.toContain(outside);
      if (archived.length) return { data: [], nextCursor: null };
      return params.cursor ? { data: [rows[1]], nextCursor: null } : { data: [rows[0], thread("personal", outside), thread("prefix-collision", root + "-other/project")], nextCursor: "next" };
    });
    expect(await archiveAcceptanceThreads(root, request)).toBe(2);
    expect(archived).toEqual(["private", "group"]);
    expect(calls).toEqual(["thread/list", "thread/list", "thread/archive", "thread/archive", "thread/list"]);
  });

  it("refuses to archive any inventoried thread when an owned worker is active", async () => {
    const root = await fixture();
    const request = vi.fn(async () => ({ data: [thread("idle", root), thread("active", path.join(root, "project"), "active")], nextCursor: null }));
    await expect(archiveAcceptanceThreads(root, request)).rejects.toThrow("must stop");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed on looping pagination without archiving anything", async () => {
    const root = await fixture(), request = vi.fn(async () => ({ data: [thread("test", root)], nextCursor: "repeat" }));
    await expect(archiveAcceptanceThreads(root, request)).rejects.toThrow("repeated a cursor");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("requires read-back confirmation rather than trusting an archive response", async () => {
    const root = await fixture();
    const request = vi.fn(async (method: string) => method === "thread/list" ? { data: [thread("test", root)], nextCursor: null } : {});
    await expect(archiveAcceptanceThreads(root, request)).rejects.toThrow("remain visible");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/list", "thread/archive", "thread/list"]);
  });

  it("propagates archive failures without deleting or retrying unrelated history", async () => {
    const root = await fixture();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/archive") throw new Error("server unavailable");
      return { data: [thread("test", root)], nextCursor: null };
    });
    await expect(archiveAcceptanceThreads(root, request)).rejects.toThrow("server unavailable");
    expect(request).toHaveBeenCalledTimes(2);
    expect(await realpath(root)).toBe(root);
  });
});

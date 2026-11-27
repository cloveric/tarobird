import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubWorkspaceFiles } from "../src/hub/workspace-files.js";
import { HubWorkspaceDiff } from "../src/hub/workspace-diff.js";
import { WORKSPACE_FILES_CAPABILITY, WORKSPACE_FILES_MAX_ENTRIES } from "../src/client-protocol/workspace-files.js";
import { SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import { HubServer } from "../src/hub/server.js";
import { HubError } from "../src/hub/store.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { setLocale } from "../client/src/i18n.js";
import { groupMentions } from "../client/src/group-mentions.js";
import {
  changeBadgeLabel,
  classifyWorkspaceEntry,
  entryToneClass,
  formatSafeWorkspaceErrorHint,
  formatWorkspaceFileMention,
} from "../client/src/workspace-files-meta.js";

const execFile = promisify(execFileCallback);

const tempDirs: string[] = [];
async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Workspace read-only file tree and preview (#99)", () => {
  it("advertises workspace.files.v1 capability", () => {
    expect(SERVER_CAPABILITIES).toContain(WORKSPACE_FILES_CAPABILITY);
  });

  it("lists workspace tree lazily, sorts dirs before files, flags heavy and sensitive entries, and blocks symlink escapes", async () => {
    const root = await makeTemp("ws-files-root-");
    const outside = await makeTemp("ws-files-outside-");
    const stateDir = path.join(root, "bot-state");
    const workspace = path.join(root, "project");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(workspace, "src", "components"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));
    await writeFile(path.join(workspace, "README.md"), "# Demo Project\n\nHello world.\n");
    await writeFile(path.join(workspace, ".env"), "SECRET_KEY=top-secret-value\n");
    await writeFile(path.join(workspace, "src", "index.ts"), "export const answer = 42;\n");
    await writeFile(path.join(workspace, "src", "components", "App.tsx"), "export function App() { return null; }\n");
    await writeFile(path.join(outside, "secret.txt"), "outside-secret");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape-link.txt"));
    await symlink(outside, path.join(workspace, "escape-dir"));

    const service = new HubWorkspaceFiles(async () => stateDir);
    const scope = { conversationId: "conv_1", botId: "bot_1" };
    const authorize = async () => {};
    const signal = new AbortController().signal;

    const top = await service.list(scope, "", signal, authorize);
    expect(top.workspaceName).toBe("project");
    expect(top.path).toBe("");
    const names = top.entries.map((entry) => entry.name);
    // Directories appear before files; heavy dirs (.git, node_modules) are flagged
    expect(names.indexOf("src")).toBeLessThan(names.indexOf("README.md"));
    const nodeModules = top.entries.find((e) => e.name === "node_modules");
    expect(nodeModules).toMatchObject({ kind: "dir", heavy: true });
    const gitDir = top.entries.find((e) => e.name === ".git");
    expect(gitDir).toMatchObject({ kind: "dir", heavy: true });
    const envFile = top.entries.find((e) => e.name === ".env");
    expect(envFile).toMatchObject({ kind: "file", sensitive: true });

    // Lazy subdirectory listing
    const src = await service.list(scope, "src", signal, authorize);
    expect(src.entries.map((e) => e.path)).toEqual(["src/components", "src/index.ts"]);

    // Preview markdown & code
    const md = await service.preview(scope, "README.md", false, signal, authorize);
    expect(md).toMatchObject({ kind: "text", markdown: true, content: "# Demo Project\n\nHello world.\n" });
    const ts = await service.preview(scope, "src/index.ts", false, signal, authorize);
    expect(ts).toMatchObject({ kind: "text", language: "typescript", content: "export const answer = 42;\n" });

    // Sensitive file requires explicit reveal
    const gated = await service.preview(scope, ".env", false, signal, authorize);
    expect(gated).toMatchObject({ kind: "sensitive", path: ".env" });
    expect((gated as Record<string, unknown>).content).toBeUndefined();
    const revealed = await service.preview(scope, ".env", true, signal, authorize);
    expect(revealed).toMatchObject({ kind: "text", sensitive: true, content: "SECRET_KEY=top-secret-value\n" });

    // Symlink escapes & path traversal are strictly blocked
    await expect(service.preview(scope, "escape-link.txt", true, signal, authorize)).rejects.toThrow(/outside|symlink|invalid/);
    await expect(service.list(scope, "escape-dir", signal, authorize)).rejects.toThrow(/outside|symlink|invalid/);
    await expect(service.list(scope, "../outside", signal, authorize)).rejects.toThrow();
    await expect(service.preview(scope, "../../etc/passwd", true, signal, authorize)).rejects.toThrow();
  });

  it("blocks hardlink escapes, flags in-workspace symlinks to sensitive targets, and skips symlinks to special files", async () => {
    const root = await makeTemp("ws-files-sec-");
    const outside = await makeTemp("ws-files-sec-outside-");
    const stateDir = path.join(root, "bot-state");
    const workspace = path.join(root, "project");
    await mkdir(stateDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));
    await writeFile(path.join(outside, "outside-secret.txt"), "OUTSIDE_HARDLINK_SECRET\n");
    await link(path.join(outside, "outside-secret.txt"), path.join(workspace, "hardlink-escape.txt"));
    await writeFile(path.join(workspace, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(workspace, "plain.txt"), "hello\n");
    await symlink(path.join(workspace, ".env"), path.join(workspace, "innocent-link.txt"));
    await symlink(path.join(workspace, "plain.txt"), path.join(workspace, "ok-link.txt"));

    let hasFifo = false;
    if (process.platform !== "win32") {
      try {
        await execFile("mkfifo", [path.join(workspace, "pipe.fifo")]);
        await symlink(path.join(workspace, "pipe.fifo"), path.join(workspace, "link-to-fifo"));
        hasFifo = true;
      } catch {
        // Skip FIFO assertion if mkfifo is unavailable in the environment.
      }
    }

    const service = new HubWorkspaceFiles(async () => stateDir);
    const scope = { conversationId: "conv_sec", botId: "bot_1" };
    const authorize = async () => {};
    const signal = new AbortController().signal;

    // Hardlink pointing outside workspace must never be previewed.
    await expect(service.preview(scope, "hardlink-escape.txt", true, signal, authorize))
      .rejects.toMatchObject({ code: "workspace_files_outside_root", status: 403 });

    // In-workspace symlink to .env must be flagged sensitive in list() and gated in preview().
    const tree = await service.list(scope, "", signal, authorize);
    expect(tree.entries.find((e) => e.name === "innocent-link.txt")).toMatchObject({ kind: "symlink", sensitive: true });
    expect(tree.entries.find((e) => e.name === "ok-link.txt")).toMatchObject({ kind: "symlink", sensitive: false });
    expect(await service.preview(scope, "innocent-link.txt", false, signal, authorize)).toMatchObject({ kind: "sensitive", path: "innocent-link.txt" });
    expect(await service.preview(scope, "ok-link.txt", false, signal, authorize)).toMatchObject({ kind: "text", content: "hello\n" });

    if (hasFifo) {
      expect(tree.entries.find((e) => e.name === "pipe.fifo")).toBeUndefined();
      expect(tree.entries.find((e) => e.name === "link-to-fifo")).toBeUndefined();
      await expect(service.preview(scope, "link-to-fifo", true, signal, authorize))
        .rejects.toMatchObject({ code: "workspace_files_not_file", status: 400 });
    }
  });

  it("handles 0-byte PDFs/images and revealed sensitive images/PDFs without ZodError or binary fallback", async () => {
    const root = await makeTemp("ws-files-media-");
    const stateDir = path.join(root, "bot-state");
    const workspace = path.join(root, "project");
    await mkdir(stateDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));
    await writeFile(path.join(workspace, "empty.pdf"), Buffer.alloc(0));
    await writeFile(path.join(workspace, "empty.png"), Buffer.alloc(0));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const pdfBytes = Buffer.from("%PDF-1.4\n%fixture\n");
    await writeFile(path.join(workspace, "env.png"), pngBytes);
    await writeFile(path.join(workspace, "dev.env.pdf"), pdfBytes);

    const service = new HubWorkspaceFiles(async () => stateDir);
    const scope = { conversationId: "conv_media", botId: "bot_1" };
    const authorize = async () => {};
    const signal = new AbortController().signal;

    expect(await service.preview(scope, "empty.pdf", false, signal, authorize)).toMatchObject({ kind: "binary", path: "empty.pdf", size: 0 });
    expect(await service.preview(scope, "empty.png", false, signal, authorize)).toMatchObject({ kind: "binary", path: "empty.png", size: 0 });

    expect(await service.preview(scope, "env.png", false, signal, authorize)).toMatchObject({ kind: "sensitive", path: "env.png" });
    expect(await service.preview(scope, "env.png", true, signal, authorize)).toMatchObject({
      kind: "image",
      path: "env.png",
      mime: "image/png",
      dataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
    });

    expect(await service.preview(scope, "dev.env.pdf", false, signal, authorize)).toMatchObject({ kind: "sensitive", path: "dev.env.pdf" });
    expect(await service.preview(scope, "dev.env.pdf", true, signal, authorize)).toMatchObject({
      kind: "pdf",
      path: "dev.env.pdf",
      mime: "application/pdf",
      base64: pdfBytes.toString("base64"),
    });
  });

  it("coalesces concurrent Git diff lookups across subdirectories and synthesizes deleted Git-tracked entries", async () => {
    const root = await makeTemp("ws-files-git-");
    const stateDir = path.join(root, "bot-state");
    const workspace = path.join(root, "repo");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(workspace, "a", "b"), { recursive: true });
    await mkdir(path.join(workspace, "c"), { recursive: true });
    await mkdir(path.join(workspace, "gone"), { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));

    await git(workspace, "init", "-q");
    await writeFile(path.join(workspace, "deleted.txt"), "remove me\n");
    await writeFile(path.join(workspace, "a", "one.txt"), "1\n");
    await writeFile(path.join(workspace, "a", "b", "two.txt"), "2\n");
    await writeFile(path.join(workspace, "c", "three.txt"), "3\n");
    await writeFile(path.join(workspace, "gone", "vanished.txt"), "bye\n");
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-q", "-m", "initial");

    // Mutate files across multiple dirs + delete tracked files.
    await rm(path.join(workspace, "deleted.txt"));
    await rm(path.join(workspace, "gone"), { recursive: true });
    await writeFile(path.join(workspace, "a", "one.txt"), "1-edited\n");
    await writeFile(path.join(workspace, "a", "b", "two.txt"), "2-edited\n");
    await writeFile(path.join(workspace, "c", "three.txt"), "3-edited\n");

    const diff = new HubWorkspaceDiff(async () => stateDir);
    const diffSpy = vi.spyOn(diff, "list");
    const service = new HubWorkspaceFiles(async () => stateDir, diff);
    const scope = { conversationId: "conv_git", botId: "bot_1" };
    const authorize = async () => {};
    const signal = new AbortController().signal;

    // 4 concurrent list() calls must coalesce into 1 HubWorkspaceDiff call and never hit 429 workspace_diff_busy.
    const [top, dirA, dirAB, dirC] = await Promise.all(
      ["", "a", "a/b", "c"].map((dir) => service.list(scope, dir, signal, authorize)),
    );
    expect(diffSpy).toHaveBeenCalledTimes(1);
    for (const res of [top, dirA, dirAB, dirC]) {
      expect(res.changedFiles.length).toBe(5);
    }
    expect(top.entries.find((e) => e.path === "deleted.txt")).toMatchObject({ kind: "file", changed: "deleted", mtimeMs: null });
    expect(top.entries.find((e) => e.path === "gone")).toMatchObject({ kind: "dir", hasChangedChildren: true, mtimeMs: null });
    expect(top.entries.find((e) => e.path === "a")).toMatchObject({ kind: "dir", hasChangedChildren: true });
    expect(dirA.entries.find((e) => e.path === "a/one.txt")).toMatchObject({ changed: "modified" });
    expect(dirAB.entries.find((e) => e.path === "a/b/two.txt")).toMatchObject({ changed: "modified" });
    expect(dirC.entries.find((e) => e.path === "c/three.txt")).toMatchObject({ changed: "modified" });

    // Subdirectory call with includeChanges: false skips diff entirely.
    diffSpy.mockClear();
    const quiet = await service.list(scope, "a", signal, authorize, { includeChanges: false });
    expect(diffSpy).not.toHaveBeenCalled();
    expect(quiet.changedFiles).toEqual([]);
    expect(quiet.entries.map((e) => e.path)).toEqual(["a/b", "a/one.txt"]);
  });

  it("maps missing stateDir and missing paths to structured HubError instead of raw ENOENT", async () => {
    const root = await makeTemp("ws-files-err-");
    const missingState = path.join(root, "does-not-exist");
    const serviceMissing = new HubWorkspaceFiles(async () => missingState);
    const scope = { conversationId: "conv_err", botId: "bot_1" };
    const authorize = async () => {};
    const signal = new AbortController().signal;

    await expect(serviceMissing.list(scope, "", signal, authorize))
      .rejects.toMatchObject({ code: "workspace_files_unavailable", status: 409 });
    await expect(serviceMissing.preview(scope, "a.txt", false, signal, authorize))
      .rejects.toMatchObject({ code: "workspace_files_unavailable", status: 409 });

    const stateDir = path.join(root, "bot-state");
    const workspace = path.join(root, "project");
    await mkdir(stateDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));
    const service = new HubWorkspaceFiles(async () => stateDir);
    await expect(service.list(scope, "missing-dir", signal, authorize))
      .rejects.toBeInstanceOf(HubError);
    await expect(service.list(scope, "missing-dir", signal, authorize))
      .rejects.toMatchObject({ code: "workspace_files_not_found", status: 404 });
    await expect(service.preview(scope, "missing.txt", false, signal, authorize))
      .rejects.toMatchObject({ code: "workspace_files_not_found", status: 404 });
  });

  it("prioritizes directories and changed files before truncating large folders at 500 entries", async () => {
    const root = await makeTemp("ws-files-trunc-");
    const stateDir = path.join(root, "bot-state");
    const workspace = path.join(root, "project");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(workspace, "zzz-dir"), { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));
    const writes: Promise<void>[] = [];
    for (let i = 0; i < WORKSPACE_FILES_MAX_ENTRIES + 25; i++) {
      writes.push(writeFile(path.join(workspace, `file-${String(i).padStart(4, "0")}.txt`), "x"));
    }
    writes.push(writeFile(path.join(workspace, "zzz-changed.txt"), "edited"));
    await Promise.all(writes);

    const fakeDiff = {
      list: async () => ({
        scope: "current_workspace" as const,
        conversationId: "conv_trunc",
        botId: "bot_1",
        head: null,
        capturedAt: Date.now(),
        state: "ready" as const,
        notes: [],
        truncated: false,
        items: [{
          path: "zzz-changed.txt",
          status: "modified" as const,
          staged: false,
          unstaged: true,
          generated: false,
          kind: "file" as const,
          protected: false,
          additions: 1,
          deletions: 0,
        }],
      }),
    };
    const service = new HubWorkspaceFiles(async () => stateDir, fakeDiff);
    const res = await service.list({ conversationId: "conv_trunc", botId: "bot_1" }, "", new AbortController().signal, async () => {});
    expect(res.truncated).toBe(true);
    expect(res.entries.length).toBe(WORKSPACE_FILES_MAX_ENTRIES);
    expect(res.entries[0]).toMatchObject({ name: "zzz-dir", kind: "dir" });
    expect(res.entries.find((e) => e.name === "zzz-changed.txt")).toMatchObject({ changed: "modified" });
  });

  it("serves authenticated tree and preview endpoints over HubServer", async () => {
    const stateDir = await makeTemp("ws-files-hub-");
    const workspace = await makeTemp("ws-files-work-");
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    await writeFile(path.join(workspace, "docs", "guide.md"), "# Guide\n");
    await writeFile(path.join(workspace, "empty.pdf"), Buffer.alloc(0));
    const botState = path.join(stateDir, "bots", "bot1");
    await mkdir(botState, { recursive: true });
    await writeFile(path.join(botState, "config.json"), JSON.stringify({ workspacePath: workspace }));

    const hub = await HubServer.start({ stateDir });
    (hub as unknown as { botManager: unknown }).botManager = {
      owns: async (id: string) => id === "bot1",
      beginShutdown: () => {},
      close: async () => {},
      shutdownComplete: true,
    };
    try {
      const secret = randomBytes(32).toString("base64url");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot1','Bot 1',?,'claude')", [hashSecret(secret)]);
      const conv = await hub.store.createConversation("owner", ["bot1"], "Tree test", "tree-test");

      const keys = generateKeyPairSync("ed25519");
      const pair = await hub.auth.pair({
        deviceId: "owner-dev", name: "Owner", platform: "web",
        publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      }, "127.0.0.1");
      await hub.auth.approve(pair.code, "local-owner");
      const challenge = await hub.auth.challenge("conn_1", "owner-dev", "n1", "127.0.0.1");
      const session = await hub.auth.authenticate("conn_1", sign(null, deviceProof("owner-dev", challenge.nonce, "n1"), keys.privateKey).toString("base64"));

      const headers = { Authorization: `Bearer ${session.token}` };
      const treeRes = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/tree?botId=bot1`, { headers });
      expect(treeRes.status).toBe(200);
      const tree = await treeRes.json() as { entries: Array<{ name: string; kind: string }> };
      expect(tree.entries).toEqual(expect.arrayContaining([expect.objectContaining({ name: "docs", kind: "dir" })]));

      const subRes = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/tree?botId=bot1&path=docs&changes=0`, { headers });
      expect(subRes.status).toBe(200);
      const sub = await subRes.json() as { entries: Array<{ path: string }>; changedFiles: unknown[] };
      expect(sub.entries.map((e) => e.path)).toEqual(["docs/guide.md"]);
      expect(sub.changedFiles).toEqual([]);

      const previewRes = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/preview?botId=bot1&path=docs%2Fguide.md`, { headers });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { kind: string; content: string };
      expect(preview).toMatchObject({ kind: "text", content: "# Guide\n" });

      const emptyPdfRes = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/preview?botId=bot1&path=empty.pdf`, { headers });
      expect(emptyPdfRes.status).toBe(200);
      expect(await emptyPdfRes.json()).toMatchObject({ kind: "binary", path: "empty.pdf" });

      const missingRes = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/preview?botId=bot1&path=nope.txt`, { headers });
      expect(missingRes.status).toBe(404);

      const unauth = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/tree?botId=bot1`);
      expect(unauth.status).toBe(401);
    } finally {
      await hub.close();
    }
  });

  it("renders plain-language change pills, color-coded file kinds, safe error hints, and group-safe mentions", () => {
    const origDocument = globalThis.document;
    try {
      // @ts-expect-error minimal document stub for i18n.setLocale in node vitest
      globalThis.document = { documentElement: { lang: "" } };

      setLocale("zh");
      expect(changeBadgeLabel("added")).toBe("新增");
      expect(changeBadgeLabel("modified")).toBe("改过");
      expect(changeBadgeLabel("deleted")).toBe("已删");
      expect(changeBadgeLabel("untracked")).toBe("新文件");
      expect(changeBadgeLabel("conflicted")).toBe("有冲突");
      expect(changeBadgeLabel("type_changed")).toBe("变更");

      setLocale("en");
      expect(changeBadgeLabel("added")).toBe("Added");
      expect(changeBadgeLabel("modified")).toBe("Edited");
      expect(changeBadgeLabel("deleted")).toBe("Deleted");
      expect(changeBadgeLabel("untracked")).toBe("New");
      expect(changeBadgeLabel("conflicted")).toBe("Conflict");
      expect(changeBadgeLabel("type_changed")).toBe("Type");
    } finally {
      if (origDocument === undefined) {
        // @ts-expect-error restore node test global
        delete globalThis.document;
      } else {
        globalThis.document = origDocument;
      }
    }

    expect(entryToneClass(classifyWorkspaceEntry({ kind: "dir", name: "src", sensitive: false }))).toBe("is-dir");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: ".env", sensitive: true }))).toBe("is-sensitive");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: "README.md", sensitive: false }))).toBe("is-doc");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: "budget.xlsx", sensitive: false }))).toBe("is-sheet");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: "metrics.csv", sensitive: false }))).toBe("is-sheet");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: "diagram.png", sensitive: false }))).toBe("is-img");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: "report.pdf", sensitive: false }))).toBe("is-pdf");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: "App.tsx", sensitive: false }))).toBe("is-code");
    expect(entryToneClass(classifyWorkspaceEntry({ kind: "file", name: "archive.bin", sensitive: false }))).toBe("is-file");

    expect(formatSafeWorkspaceErrorHint(Object.assign(new Error("boom"), { status: 503 }), "tree_unavailable")).toBe("HTTP 503");
    expect(formatSafeWorkspaceErrorHint(new Error("workspace_offline"), "tree_unavailable")).toBe("workspace_offline");
    expect(formatSafeWorkspaceErrorHint(new Error("/example/secret/path failed"), "tree_unavailable")).toBe("tree_unavailable");

    const members = [{ id: "bot1", names: ["Architect", "src"] }, { id: "bot2", names: ["Reviewer"] }];
    for (const sample of ["Makefile", "src", "My Notes.md", "需求文档.md", "docs/a`b.md"]) {
      expect(groupMentions(formatWorkspaceFileMention(sample), members)).toEqual({ ids: [], unresolved: [] });
    }
    expect(groupMentions(`@Reviewer 请看 ${formatWorkspaceFileMention("Makefile")} ${formatWorkspaceFileMention("My Notes.md")} ${formatWorkspaceFileMention("需求文档.md")}`, members))
      .toEqual({ ids: ["bot2"], unresolved: [] });
  });
});

import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubWorkspaceDiff, createWorkspaceGitRunner, inspectWorkspaceGitMetadata, parseWorkspaceNumstat, parseWorkspacePatch, parseWorkspaceStatus, resolveWorkspaceGit, unsafeWorkspaceGitConfig, workspaceGitEnvironment, type WorkspaceGitCommand } from "../src/hub/workspace-diff.js";
import { workspaceChangesSchema, workspaceDiffPathSchema, workspaceFileDiffSchema } from "../src/client-protocol/workspace-diff.js";
import { HubError } from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const base = process.env.TAROBOT_DIFF_TEST_TMPDIR || os.tmpdir();
const hash = "a".repeat(40), blobHash = "b".repeat(40), scope = { conversationId: "chat", botId: "bot" };
const abort = () => new AbortController().signal;
const authorize = async () => {};
const ok = (stdout = "", code = 0, stderr = "") => ({ stdout: Buffer.from(stdout), code, stderr, limited: false });
const ordinary = (name: string, xy = ".M", mode = "100644") => `1 ${xy} N... ${mode} ${mode} ${mode} ${hash} ${hash} ${name}\0`;
async function fixture(options: { status?: string; head?: boolean; config?: string; previous?: string; patch?: string; rootPrefix?: string; shortRoot?: boolean; deadlineMs?: number; intercept?: WorkspaceGitCommand } = {}) {
  const root = await mkdtemp(path.join(base, options.shortRoot ? "s" : "diff-unit-")); roots.push(root);
  const state = path.join(root, "bot"), repo = path.join(root, "repo"), workspace = options.rootPrefix ? path.join(repo, options.rootPrefix) : repo;
  await mkdir(state, { recursive: true }); await mkdir(workspace, { recursive: true });
  await mkdir(path.join(repo, ".git", "objects", "info"), { recursive: true });
  await writeFile(path.join(state, "config.json"), JSON.stringify({ workspacePath: workspace }));
  const calls: string[][] = [];
  const run: WorkspaceGitCommand = async (cwd, args, signal, max, allowLimit) => {
    calls.push(args); signal.throwIfAborted();
    if (options.intercept) return options.intercept(cwd, args, signal, max, allowLimit);
    if (args[0] === "config") return ok(options.config ?? "core.repositoryformatversion\n0\0core.fsmonitor\nfalse\0");
    if (args[0] === "rev-parse") return args.includes("--show-toplevel") ? ok(repo + "\n") : args.includes("--absolute-git-dir") ? ok(path.join(repo, ".git") + "\n") : args.includes("--git-common-dir") ? ok(path.join(repo, ".git") + "\n") : args.includes("--is-bare-repository") ? ok("false\n") : args.includes("--show-prefix") ? ok(options.rootPrefix ? options.rootPrefix + "/\n" : "\n") : options.head === false ? ok("", 128, "fatal: Needed a single revision") : ok(hash + "\n");
    if (args[0] === "status") return ok(options.status ?? "? file.txt\0");
    if (args[0] === "ls-tree") return ok(options.previous === undefined ? "" : `100644 blob ${blobHash} ${Buffer.byteLength(options.previous)}\t${options.rootPrefix ? options.rootPrefix + "/" : ""}file.txt\0`);
    if (args[0] === "cat-file") return ok(options.previous ?? "");
    if (args.includes("--numstat")) return ok(`1\t1\t${options.rootPrefix ? options.rootPrefix + "/" : ""}file.txt\0`);
    if (args.includes("--patch")) return ok(options.patch ?? "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n");
    throw new Error(`unexpected fixture command ${args[0]}`);
  };
  const service = new HubWorkspaceDiff(async () => state, { runGit: run, deadlineMs: options.deadlineMs });
  return { root, state, repo, workspace, service, calls, run };
}

describe("workspace diff safety and bounded parsing", () => {
  it.each(["../private", "/private", "C:/private", "a\\b", ".git/config", "x/.GIT/HEAD", "a/../b", "a//b", "a\0b", "x/NUL.txt", "a.", "a/ "])("rejects nonportable or escaping path %s", value => expect(workspaceDiffPathSchema.safeParse(value).success).toBe(false));
  it("keeps literal punctuation, spaces, Unicode and pathspec-looking names", () => {
    for (const value of ["src/中文 file.ts", "--option.txt", "[abc].txt", "version..txt", "file%23.txt"]) expect(workspaceDiffPathSchema.parse(value)).toBe(value);
  });
  it("parses porcelain v2 NUL records and restricts nested-workspace paths", () => {
    const entries = parseWorkspaceStatus(Buffer.from(ordinary("inside/file.txt", "MM") + "? inside/new file.txt\0" + ordinary("outside.txt") + "? inside/.git/config\0" + "? inside/truncated"), "inside/");
    expect(entries.map(row => row.item)).toEqual([
      expect.objectContaining({ path: "file.txt", staged: true, unstaged: true, status: "modified" }),
      expect.objectContaining({ path: "new file.txt", status: "untracked" }),
    ]);
    expect(parseWorkspaceNumstat(Buffer.from("3\t2\tinside/file.txt\0-\t-\tinside/image.png\0"), "inside/").get("image.png")).toEqual({ additions: null, deletions: null });
    const replacement = parseWorkspaceStatus(Buffer.from(ordinary("same.txt", "D.") + "? same.txt\0"));
    expect(replacement).toHaveLength(1); expect(replacement[0]!.item).toMatchObject({ status: "modified", staged: true, unstaged: true });
    expect(parseWorkspaceStatus(Buffer.from([63, 32, 255, 0]))).toEqual([]); // Invalid UTF-8 cannot alias a different U+FFFD filename.
  });
  it("parses line coordinates and clips huge lines without interpreting markup", () => {
    const parsed = parseWorkspacePatch("@@ -2,2 +2,2 @@ name\n <script>x</script>\n-old\n+" + "x".repeat(10_000) + "\n\\ No newline at end of file\n");
    expect(parsed.hunks[0]!.lines).toEqual([
      { kind: "context", text: "<script>x</script>", oldLine: 2, newLine: 2, clipped: false },
      { kind: "delete", text: "old", oldLine: 3, newLine: null, clipped: false },
      { kind: "add", text: "x".repeat(4096), oldLine: null, newLine: 3, clipped: true },
      { kind: "meta", text: " No newline at end of file", oldLine: null, newLine: null, clipped: false },
    ]);
    expect(parseWorkspacePatch("@@ -0,0 +1,3000 @@\n" + "+x\n".repeat(3000)).limited).toBe(true);
  });
  it.each(["filter.lfs.clean\ngit-lfs clean\0", "filter.a.process\nscript\0", "filter.a.smudge\ncat\0", "diff.external\nscript\0", "diff.secret.textconv\nscript\0", "diff.secret.command\nscript\0", "core.fsmonitor\nscript\0core.fsmonitor\nfalse\0"])("rejects executable config even before command-line overrides", config => expect(unsafeWorkspaceGitConfig(Buffer.from(config))).toBe("unsafe_git_config"));
  it("rejects promisor repositories and strips inherited Git routing overrides", () => {
    expect(unsafeWorkspaceGitConfig(Buffer.from("remote.origin.promisor\ntrue\0"))).toBe("partial_clone");
    expect(unsafeWorkspaceGitConfig(Buffer.from("extensions.partialClone\norigin\0"))).toBe("partial_clone");
    const env = workspaceGitEnvironment({ PATH: [".", "/usr/bin"].join(path.delimiter), GIT_DIR: "/outside", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "evil", GIT_CONFIG_VALUE_0: "yes", API_KEY: "secret", LD_PRELOAD: "/evil", DYLD_INSERT_LIBRARIES: "/evil", SSH_AUTH_SOCK: "/secret" });
    expect(env.GIT_DIR).toBeUndefined(); expect(env.GIT_CONFIG_COUNT).toBeUndefined(); expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.API_KEY).toBeUndefined(); expect(env.LD_PRELOAD).toBeUndefined(); expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined(); expect(env.SSH_AUTH_SOCK).toBeUndefined(); expect(env.PATH).toBe("/usr/bin");
  });
  it("does not select a workspace-local executable or relative PATH entry", async () => {
    const { workspace } = await fixture();
    await writeFile(path.join(workspace, process.platform === "win32" ? "git.exe" : "git"), "not executable");
    await expect(resolveWorkspaceGit(workspace, { PATH: [".", workspace].join(path.delimiter) })).rejects.toMatchObject({ code: "workspace_diff_git_unavailable" });
  });
});

describe("workspace diff operations with controlled Git outputs and real filesystem", () => {
  it("lists bounded current changes and counts without fetching any patches", async () => {
    const { workspace, service, calls } = await fixture({ status: ordinary("file.txt") });
    await writeFile(path.join(workspace, "file.txt"), "new\n");
    const result = await service.list(scope, abort(), authorize);
    expect(result.items[0]).toMatchObject({ path: "file.txt", additions: 1, deletions: 1 });
    expect(calls.some(args => args.includes("--patch") || args[0] === "cat-file")).toBe(false);
    expect(calls.find(args => args[0] === "status")).toContain("--ignore-submodules=all");
  });
  it("degrades only changed leaf counts when a Bot writes during list collection", async () => {
    const { workspace, state, run } = await fixture({ status: ordinary("file.txt") });
    await writeFile(path.join(workspace, "file.txt"), "before\n");
    const service = new HubWorkspaceDiff(async () => state, { runGit: async (...args) => {
      const result = await run(...args);
      if (args[1].includes("--numstat")) await writeFile(path.join(workspace, "file.txt"), "after the Bot writes more content\n");
      return result;
    } });
    expect(await service.list(scope, abort(), authorize)).toMatchObject({
      items: [expect.objectContaining({ path: "file.txt", kind: "file", additions: null, deletions: null })], notes: expect.arrayContaining(["changed_during_read"]),
    });
  });
  it("omits a changed entry when its parent becomes a symlink during list collection", async () => {
    const { root, workspace, state, run } = await fixture({ status: ordinary("folder/file.txt") });
    await mkdir(path.join(workspace, "folder")); await writeFile(path.join(workspace, "folder/file.txt"), "before\n");
    await mkdir(path.join(root, "outside")); await writeFile(path.join(root, "outside/file.txt"), "private\n");
    const service = new HubWorkspaceDiff(async () => state, { runGit: async (...args) => {
      const result = await run(...args);
      if (args[1].includes("--numstat")) { await rename(path.join(workspace, "folder"), path.join(workspace, "old-folder")); await symlink(path.join(root, "outside"), path.join(workspace, "folder")); }
      return result;
    } });
    expect(await service.list(scope, abort(), authorize)).toMatchObject({ items: [], truncated: true, notes: expect.arrayContaining(["changed_during_read", "path_unavailable"]) });
  });
  it("keeps strict single-file snapshots and reports metadata races explicitly", async () => {
    const f = await fixture({ status: ordinary("file.txt"), previous: "old\n" }); await writeFile(path.join(f.workspace, "file.txt"), "new\n");
    const detail = new HubWorkspaceDiff(async () => f.state, { runGit: async (...args) => {
      const result = await f.run(...args); if (args[1].includes("--patch")) await writeFile(path.join(f.workspace, "file.txt"), "changed again\n"); return result;
    } });
    await expect(detail.file(scope, "file.txt", false, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
    const list = new HubWorkspaceDiff(async () => f.state, { runGit: async (...args) => {
      const result = await f.run(...args); if (args[1].includes("--numstat")) await writeFile(path.join(f.repo, ".git/index"), "updated index"); return result;
    } });
    await expect(list.list(scope, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
  });
  it("does not execute status after executable filters or partial-clone configuration", async () => {
    const { service, calls } = await fixture({ config: "filter.fixture.clean\nmarker-command\0" });
    expect(await service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["unsafe_git_config"], items: [] });
    expect(calls).toHaveLength(1);
  });
  it("refuses redirected git metadata, alternate objects and an inherited HOME repository", async () => {
    const redirected = await fixture(); await rm(path.join(redirected.repo, ".git"), { recursive: true }); await writeFile(path.join(redirected.repo, ".git"), "gitdir: /private-repository\n");
    expect(await redirected.service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["external_git_metadata"] });
    expect(redirected.calls.some(args => args[0] === "status" || args[0] === "cat-file")).toBe(false);
    const alternate = await fixture(); await writeFile(path.join(alternate.repo, ".git/objects/info/alternates"), "/private-repository/objects\n");
    expect(await alternate.service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["external_git_metadata"] });
    const home = await fixture({ rootPrefix: "nested" });
    const homeService = new HubWorkspaceDiff(async () => home.state, { runGit: home.run, env: { HOME: home.repo } });
    expect(await homeService.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["repository_root_unsafe"] });
    const symlinked = await fixture(); await rm(path.join(symlinked.repo, ".git/objects"), { recursive: true }); await symlink(path.join(symlinked.root, "bot"), path.join(symlinked.repo, ".git/objects"));
    expect(await symlinked.service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["external_git_metadata"] });
  });
  it.each(["objects/ab", "objects/ab/loose", "objects/pack/pack-fixture.pack", "refs/heads/private", "info/grafts", "index"])("refuses static metadata symlink %s before object or status reads", async name => {
    const { root, repo, service, calls } = await fixture();
    const link = path.join(repo, ".git", name); await mkdir(path.dirname(link), { recursive: true });
    await symlink(path.join(root, "bot"), link);
    expect(await service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["external_git_metadata"] });
    expect(calls.some(args => args[0] === "status" || args[0] === "cat-file" || args[0] === "ls-tree" || args.includes("--verify"))).toBe(false);
  });
  it("bounds metadata traversal and detects changes after inspection", async () => {
    const { repo } = await fixture(), metadata = path.join(repo, ".git");
    await expect(inspectWorkspaceGitMetadata(metadata, abort(), 2)).rejects.toMatchObject({ code: "workspace_diff_git_metadata_limit" });
    const verify = await inspectWorkspaceGitMetadata(metadata, abort());
    await writeFile(path.join(metadata, "new-index"), "new");
    await expect(verify()).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
    const deep = path.join(metadata, "refs", ...Array.from({ length: 33 }, () => "nested")); await mkdir(deep, { recursive: true });
    await expect(inspectWorkspaceGitMetadata(metadata, abort())).rejects.toMatchObject({ code: "workspace_diff_git_metadata_limit" });
  });
  it.skipIf(process.platform === "win32")("accepts a real inactive fsmonitor IPC socket when fsmonitor is disabled", async () => {
    const f = await fixture({ shortRoot: true, config: "core.fsmonitor\ntrue\0" });
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path.join(f.repo, ".git/fsmonitor--daemon.ipc"), resolve));
      expect(await f.service.list(scope, abort(), authorize)).toMatchObject({ state: "ready" });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("does not fail a list for a writer's lock file or an irrelevant reflog update", async () => {
    const f = await fixture({ status: ordinary("file.txt") }); await writeFile(path.join(f.workspace, "file.txt"), "new\n");
    await mkdir(path.join(f.repo, ".git/logs")); await writeFile(path.join(f.repo, ".git/logs/HEAD"), "log before");
    const service = new HubWorkspaceDiff(async () => f.state, { runGit: async (...args) => {
      const result = await f.run(...args);
      if (args[1].includes("--numstat")) { await writeFile(path.join(f.repo, ".git/index.lock"), "writer preparing an index"); await writeFile(path.join(f.repo, ".git/logs/another-log"), "unrelated log"); }
      return result;
    } });
    expect(await service.list(scope, abort(), authorize)).toMatchObject({ state: "ready", items: [expect.objectContaining({ additions: 1, deletions: 1 })] });
  });
  it("ignores valid regular ref locks but still checks real refs and similarly named files", async () => {
    const f = await fixture(), gitDir = path.join(f.repo, ".git"); await mkdir(path.join(gitDir, "refs/heads"), { recursive: true });
    await writeFile(path.join(gitDir, "refs/heads/main"), hash);
    const verifyLocks = await inspectWorkspaceGitMetadata(gitDir, abort());
    await writeFile(path.join(gitDir, "refs/heads/main.lock"), "pending"); await verifyLocks();
    const verifyRef = await inspectWorkspaceGitMetadata(gitDir, abort());
    await writeFile(path.join(gitDir, "refs/heads/main"), blobHash);
    await expect(verifyRef()).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
    const verifySimilarName = await inspectWorkspaceGitMetadata(gitDir, abort());
    await writeFile(path.join(gitDir, "refs/heads/main.locked"), hash);
    await expect(verifySimilarName()).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
  });
  it.each(["index.lock", "refs/heads/main.lock", "fsmonitor--daemon.ipc", "logs"])("does not follow symlinks even at ignored runtime name %s", async name => {
    const f = await fixture(), file = path.join(f.repo, ".git", name); await mkdir(path.dirname(file), { recursive: true }); await symlink(f.state, file);
    expect(await f.service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["external_git_metadata"] });
  });
  it("retains strict HEAD, index and consumed object snapshots", async () => {
    for (const name of ["HEAD", "index", "objects/ab/object"]) {
      const f = await fixture(), metadata = path.join(f.repo, ".git"), file = path.join(metadata, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "before");
      const verify = await inspectWorkspaceGitMetadata(metadata, abort()); await writeFile(file, "after bytes");
      await expect(verify()).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
    }
  });
  it("maps a vanished first-snapshot metadata directory to changed-during-read and preserves cancellation", async () => {
    const f = await fixture(), metadata = path.join(f.repo, ".git");
    await rm(metadata, { recursive: true });
    await expect(inspectWorkspaceGitMetadata(metadata, abort())).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
    const cancelled = new AbortController(), reason = new HubError("device_revoked", 401); cancelled.abort(reason);
    await expect(inspectWorkspaceGitMetadata(metadata, cancelled.signal)).rejects.toBe(reason);
  });
  it("accepts only exact SHA-1 or SHA-256 object IDs", async () => {
    const { service } = await fixture(), result = await service.list(scope, abort(), authorize);
    for (const length of [40, 64]) expect(workspaceChangesSchema.safeParse({ ...result, head: "a".repeat(length) }).success).toBe(true);
    for (const length of [39, 41, 63, 65]) expect(workspaceChangesSchema.safeParse({ ...result, head: "a".repeat(length) }).success).toBe(false);
  });
  it("returns honest no-HEAD changes and new-file line coordinates", async () => {
    const { workspace, service } = await fixture({ head: false }); await writeFile(path.join(workspace, "file.txt"), "一\n二\n");
    expect(await service.list(scope, abort(), authorize)).toMatchObject({ state: "no_head", head: null, items: [expect.objectContaining({ additions: null })] });
    const detail = await service.file(scope, "file.txt", false, abort(), authorize);
    expect(detail.hunks[0]!.lines[1]).toMatchObject({ kind: "add", oldLine: null, newLine: 2, text: "二" });
  });
  it("revalidates the literal file's change membership and refuses ignored/unchanged reads", async () => {
    const { workspace, service, calls } = await fixture({ status: "" }); await writeFile(path.join(workspace, "private.json"), "never return");
    await expect(service.file(scope, "private.json", false, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_not_changed" });
    expect(calls.some(args => args[0] === "cat-file" || args.includes("--patch"))).toBe(false);
    expect(calls.find(args => args[0] === "status")!.at(-1)).toBe("private.json");
  });
  it("rejects credentials before Git, including credential locations derived from the root", async () => {
    const { workspace, state, service, calls } = await fixture();
    await expect(service.file(scope, ".env.local", false, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_protected" });
    await mkdir(path.join(workspace, ".codex")); await writeFile(path.join(state, "config.json"), JSON.stringify({ workspacePath: path.join(workspace, ".codex") }));
    await expect(service.file(scope, "auth.json", false, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_protected" });
    expect(calls).toHaveLength(0);
  });
  it("reports binary and symlink metadata without returning contents or following targets", async () => {
    const { root, workspace, service } = await fixture();
    await writeFile(path.join(workspace, "file.txt"), Buffer.from([0, 1, 2]));
    expect(await service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ binary: true, metadataOnly: true, hunks: [] });
    await writeFile(path.join(workspace, "file.txt"), Buffer.alloc(300 * 1024));
    expect(await service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ binary: true, reason: "binary", metadataOnly: true, hunks: [] });
    await rm(path.join(workspace, "file.txt")); await writeFile(path.join(root, "outside.txt"), "outside-content"); await symlink(path.join(root, "outside.txt"), path.join(workspace, "file.txt"));
    expect(await service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ metadataOnly: true, reason: "symlink", hunks: [] });
  });
  it("rejects a symlink parent and does not open a FIFO", async () => {
    const { root, workspace, service } = await fixture({ status: "? folder/file.txt\0" });
    await mkdir(path.join(root, "outside")); await writeFile(path.join(root, "outside/file.txt"), "outside-content"); await symlink(path.join(root, "outside"), path.join(workspace, "folder"));
    await expect(service.file(scope, "folder/file.txt", false, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_path_unavailable" });
    if (process.platform !== "win32") {
      const other = await fixture(); spawnSync("mkfifo", [path.join(other.workspace, "file.txt")]);
      expect(await other.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ reason: "unavailable", hunks: [] });
    }
  });
  it("makes oversized text and long lines explicit previews with bounded rows", async () => {
    const { workspace, service } = await fixture(); await writeFile(path.join(workspace, "file.txt"), "x\n".repeat(2000));
    expect(await service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ metadataOnly: true, reason: "too_large", hunks: [] });
    const preview = await service.file(scope, "file.txt", true, abort(), authorize);
    expect(preview.preview).toBe(true); expect(preview.hunks[0]!.lines).toHaveLength(200); expect(preview.additions).toBeNull();
    await writeFile(path.join(workspace, "file.txt"), "x".repeat(8000));
    const long = await service.file(scope, "file.txt", true, abort(), authorize);
    expect(long.hunks[0]!.lines[0]).toMatchObject({ clipped: true, text: "x".repeat(4096) });
  });
  it("compares tracked files against fixed HEAD and limits status rows", async () => {
    const { workspace, service, calls } = await fixture({ status: ordinary("file.txt"), previous: "old\n" }); await writeFile(path.join(workspace, "file.txt"), "new\n");
    const result = await service.file(scope, "file.txt", false, abort(), authorize);
    expect(result).toMatchObject({ head: hash, additions: 1, deletions: 1, metadataOnly: false });
    expect(calls.find(args => args.includes("--patch"))).toContain(hash);
    const many = await fixture({ status: Array.from({ length: 205 }, (_, index) => `? ${index}.txt\0`).join("") });
    const listing = await many.service.list(scope, abort(), authorize);
    expect(listing.items).toHaveLength(200); expect(listing.truncated).toBe(true);
  });
  it("reads deleted HEAD-side content and previews deleted large files without a worktree leaf", async () => {
    const deleted = await fixture({ status: ordinary("file.txt", "D."), previous: "old\n", patch: "@@ -1 +0,0 @@\n-old\n" });
    expect(await deleted.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ additions: 0, deletions: 1, hunks: [expect.objectContaining({ lines: [expect.objectContaining({ oldLine: 1, newLine: null, text: "old" })] })] });
    const large = await fixture({ status: ordinary("file.txt", "D."), previous: "old\n".repeat(60_000) });
    const preview = await large.service.file(scope, "file.txt", true, abort(), authorize);
    expect(preview.hunks[0]!.lines).toHaveLength(200); expect(preview.hunks[0]!.lines[0]).toMatchObject({ oldLine: 1, newLine: null });
    expect(preview.notes).toContain("preview_prefix"); expect(preview.additions).toBeNull();
  });
  it("does not read a submodule and explains mode-only differences", async () => {
    const submodule = await fixture({ status: ordinary("file.txt", "M.", "160000") });
    expect(await submodule.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ metadataOnly: true, reason: "submodule", hunks: [] });
    expect(submodule.calls.some(args => args[0] === "cat-file" || args.includes("--patch"))).toBe(false);
    const mode = await fixture({ status: ordinary("file.txt"), previous: "same\n", patch: "diff --git a/file.txt b/file.txt\nold mode 100644\nnew mode 100755\n" });
    await writeFile(path.join(mode.workspace, "file.txt"), "same\n");
    expect(await mode.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ notes: expect.arrayContaining(["mode_only"]), hunks: [] });
  });
  it("shows a tiny tracked patch in a many-line file and clips only changed long lines", async () => {
    const f = await fixture({ status: ordinary("file.txt"), previous: "old\n".repeat(1800), patch: "@@ -1700 +1700 @@\n-old\n+new\n" });
    await writeFile(path.join(f.workspace, "file.txt"), "new\n".repeat(1800));
    const result = await f.service.file(scope, "file.txt", false, abort(), authorize);
    expect(result).toMatchObject({ metadataOnly: false, preview: false, additions: 1, deletions: 1, hunks: [expect.objectContaining({ oldStart: 1700 })] });
    const long = await fixture({ status: ordinary("file.txt"), previous: "old\n", patch: "@@ -1 +1 @@\n-old\n+" + "x".repeat(8000) + "\n" });
    await writeFile(path.join(long.workspace, "file.txt"), "x".repeat(8000));
    const detail = await long.service.file(scope, "file.txt", false, abort(), authorize);
    expect(detail).toMatchObject({ metadataOnly: false, preview: false, notes: expect.arrayContaining(["long_lines"]) });
    expect(detail.hunks[0]!.lines[1]).toMatchObject({ clipped: true, text: "x".repeat(4096) });
  });
  it("previews the bounded patch prefix rather than unrelated file-start lines", async () => {
    const f = await fixture({ status: ordinary("file.txt"), previous: "old\n".repeat(1800), patch: "@@ -1200,600 +1200,600 @@\n" + "-old\n+changed\n".repeat(600) });
    await writeFile(path.join(f.workspace, "file.txt"), "unrelated file prefix\n".repeat(1800));
    expect(await f.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ metadataOnly: true, reason: "too_large" });
    const detail = await f.service.file(scope, "file.txt", true, abort(), authorize);
    expect(detail).toMatchObject({ metadataOnly: false, preview: true, truncated: true, additions: null, deletions: null, notes: expect.arrayContaining(["preview_patch"]) });
    expect(detail.notes).not.toContain("preview_prefix"); expect(detail.hunks[0]!.oldStart).toBe(1200);
    expect(detail.hunks[0]!.lines[0]).toMatchObject({ text: "old", kind: "delete", oldLine: 1200 });
    expect(detail.hunks.reduce((sum, hunk) => sum + 1 + hunk.lines.length, 0)).toBeLessThanOrEqual(200);
  });
  it("does not turn index removal plus a current worktree file into a whole-file deletion", async () => {
    const f = await fixture({ status: ordinary("file.txt", "D.") + "? file.txt\0", previous: "old\n" }); await writeFile(path.join(f.workspace, "file.txt"), "still exists\n");
    expect(await f.service.list(scope, abort(), authorize)).toMatchObject({ items: [expect.objectContaining({ path: "file.txt", status: "modified", additions: null, deletions: null })], notes: expect.arrayContaining(["index_removed_worktree"]) });
    expect(await f.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ metadataOnly: true, reason: "unavailable", hunks: [], notes: expect.arrayContaining(["index_removed_worktree"]) });
    expect(f.calls.some(args => args.includes("--numstat") || args.includes("--patch") || args[0] === "cat-file")).toBe(false);
  });
  it("shows untracked repository directories as metadata without filename errors", async () => {
    const f = await fixture({ status: "? sub/\0" }); await mkdir(path.join(f.workspace, "sub"));
    const list = await f.service.list(scope, abort(), authorize);
    expect(list).toMatchObject({ items: [expect.objectContaining({ path: "sub", kind: "other" })], truncated: false, notes: expect.arrayContaining(["nested_repository"]) });
    expect(list.notes).not.toContain("path_unavailable");
    expect(await f.service.file(scope, "sub", false, abort(), authorize)).toMatchObject({ metadataOnly: true, notes: expect.arrayContaining(["nested_repository"]) });
    expect(f.calls.some(args => args[0] === "cat-file" || args.includes("--patch"))).toBe(false);
  });
  it("rejects core.worktree and mismatched workspace/repository metadata before status", async () => {
    const configured = await fixture({ config: "core.worktree\n..\0" });
    expect(await configured.service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["unsafe_git_config"] });
    expect(configured.calls).toHaveLength(1);
    const f = await fixture({ rootPrefix: "nested" }); await mkdir(path.join(f.workspace, ".git"));
    const service = new HubWorkspaceDiff(async () => f.state, { runGit: async (...args) => args[0] === f.workspace && args[1].includes("--absolute-git-dir") ? ok(path.join(f.workspace, ".git")) : f.run(...args) });
    expect(await service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["external_git_metadata"] });
    expect(f.calls.some(args => args[0] === "status")).toBe(false);
  });
  it("allows disabled built-in fsmonitor booleans but still rejects commands", () => {
    for (const value of ["true", "on", "yes", "1", "false", "off", "no", "0"]) expect(unsafeWorkspaceGitConfig(Buffer.from(`core.fsmonitor\n${value}\0`))).toBeUndefined();
    expect(unsafeWorkspaceGitConfig(Buffer.from("core.fsmonitor\n/usr/bin/monitor\0"))).toBe("unsafe_git_config");
  });
  it("refuses workspace hardlinks and distinguishes non-UTF8 text from binary", async () => {
    const f = await fixture(); await writeFile(path.join(f.root, "outside"), "private"); await link(path.join(f.root, "outside"), path.join(f.workspace, "file.txt"));
    expect(await f.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ metadataOnly: true, reason: "unavailable", hunks: [] });
    expect(f.calls.some(args => args[0] === "cat-file" || args.includes("--patch"))).toBe(false);
    await rm(path.join(f.workspace, "file.txt")); await writeFile(path.join(f.workspace, "file.txt"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    expect(await f.service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ binary: false, metadataOnly: true, reason: "unavailable", notes: expect.arrayContaining(["unsupported_encoding"]) });
  });
  it.skipIf(process.platform === "win32")("does not invoke the Darwin Git installer shim when developer tools are absent", async () => {
    const f = await fixture(); const missing = vi.fn(async () => { throw new Error("developer tools absent"); });
    await expect(resolveWorkspaceGit(f.workspace, { PATH: "/usr/bin" }, { platform: "darwin", selectedDeveloperDir: missing })).rejects.toMatchObject({ code: "workspace_diff_git_unavailable" });
    expect(missing).toHaveBeenCalledOnce();
    const developer = path.join(f.root, "developer"); await mkdir(path.join(developer, "usr/bin"), { recursive: true }); await writeFile(path.join(developer, "usr/bin/git"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(developer, "usr/bin/git"), 0o755);
    expect(await resolveWorkspaceGit(f.workspace, { PATH: "/usr/bin" }, { platform: "darwin", selectedDeveloperDir: async () => developer })).toBe(path.join(developer, "usr/bin/git"));
  });
  it("preserves a preparation-time changed-during-read error instead of generic workspace failure", async () => {
    const f = await fixture();
    const service = new HubWorkspaceDiff(async () => f.state, { runGit: async () => { throw new HubError("workspace_diff_changed_during_read", 409); } });
    await expect(service.list(scope, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
  });
  it("keeps counts unknown on a bounded numstat failure and keeps nested paths relative", async () => {
    const nested = await fixture({ rootPrefix: "nested", status: ordinary("nested/file.txt") + ordinary("outside.txt") });
    await writeFile(path.join(nested.workspace, "file.txt"), "new\n");
    const service = new HubWorkspaceDiff(async () => nested.state, { runGit: async (...args) => { if (args[1].includes("--numstat")) throw new HubError("workspace_diff_counts_timeout", 504); return nested.run(...args); } });
    const result = await service.list(scope, abort(), authorize);
    expect(result.items).toHaveLength(1); expect(result.items[0]).toMatchObject({ path: "file.txt", additions: null, deletions: null }); expect(result.notes).toContain("counts_unavailable");
    expect(JSON.stringify(result)).not.toContain(nested.workspace);
  });
  it("rechecks permission after I/O and rejects unbounded admission and timeout", async () => {
    const { workspace, service } = await fixture(); await writeFile(path.join(workspace, "file.txt"), "safe");
    let checks = 0;
    await expect(service.file(scope, "file.txt", false, abort(), async () => { if (++checks === 3) throw new HubError("device_revoked", 401); })).rejects.toMatchObject({ code: "device_revoked" });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new HubWorkspaceDiff(async () => { await gate; return "/unreachable"; }, { deadlineMs: 100 });
    // Subscribe to both failures immediately: either deadline may fire first
    // under load, so sequentially attaching the second assertion is unsafe.
    const first = expect(waiting.list(scope, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_timeout" });
    const second = expect(waiting.list(scope, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_timeout" });
    await expect(waiting.list(scope, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_busy" });
    await Promise.all([first, second]);
    await expect(waiting.list(scope, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_busy" }); release();
  });
  it("cancels during root resolution without spawning Git", async () => {
    const { state, run, calls } = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = new HubWorkspaceDiff(async () => { await gate; return state; }, { runGit: run });
    const controller = new AbortController(), pending = service.list(scope, controller.signal, authorize);
    controller.abort(new HubError("device_revoked", 401));
    await expect(pending).rejects.toMatchObject({ code: "device_revoked" }); release();
    expect(calls).toHaveLength(0);
  });
  it("rejects a root config replaced during a read", async () => {
    const { workspace, state, service } = await fixture(); await writeFile(path.join(workspace, "file.txt"), "text");
    let checks = 0;
    await expect(service.file(scope, "file.txt", false, abort(), async () => { if (++checks === 2) await writeFile(path.join(state, "config.json"), JSON.stringify({ workspacePath: "/another-workspace" })); })).rejects.toMatchObject({ code: "workspace_diff_changed_during_read" });
  });
  it("rejects aggregate hostile-host hunk rows even if each hunk is individually bounded", async () => {
    const { workspace, service } = await fixture(); await writeFile(path.join(workspace, "file.txt"), "x\n");
    const result = await service.file(scope, "file.txt", false, abort(), authorize);
    const hunk = result.hunks[0]!;
    expect(workspaceFileDiffSchema.safeParse({ ...result, hunks: Array.from({ length: 1000 }, () => hunk) }).success).toBe(false);
  });
});

describe("absolute child runner", () => {
  it.skipIf(process.platform === "win32")("spawns without a shell, preserves literal argv, and bounds output/abort", async () => {
    const { root, workspace } = await fixture();
    const executable = path.join(root, "fixture-git");
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),gitdir:process.env.GIT_DIR}));\n`);
    await chmod(executable, 0o700);
    const run = createWorkspaceGitRunner(executable, { ...process.env, GIT_DIR: "/forbidden" });
    const reply = await run(workspace, ["status", "--", "$(literal)"], abort(), 10000);
    expect(reply.code).toBe(0);
    const body = JSON.parse(reply.stdout.toString()); expect(body.cwd).toBe(root); expect(body.argv).toContain("$(literal)"); expect(body.gitdir).toBeUndefined();
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(10000));setInterval(()=>{},1000);\n`);
    await expect(run(workspace, [], abort(), 100)).rejects.toMatchObject({ code: "workspace_diff_output_limit" });
    await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
    const controller = new AbortController(), pending = run(workspace, [], controller.signal, 100);
    const timer = setTimeout(() => controller.abort(new HubError("fixture_cancelled", 499)), 20);
    try { await expect(pending).rejects.toMatchObject({ code: "fixture_cancelled" }); } finally { clearTimeout(timer); }
  });
});

describe("real HTTP authorization boundaries", () => {
  async function authenticatedHub() {
    const root = await mkdtemp(path.join(base, "diff-http-")); roots.push(root);
    const hub = await HubServer.start({ stateDir: root });
    const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
    const pairing = await hub.auth.pair({ deviceId: "device", name: "Fixture", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
    await hub.auth.approve(pairing.code, "local-owner");
    const challenge = await hub.auth.challenge("device", "device", nonce, "fixture"), session = await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot',?)", [hashSecret("fixture")]);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('other','Other',?)", [hashSecret("other")]);
    const conversation = await hub.store.createConversation("owner", ["bot"], "Diff", "diff");
    const url = `${hub.url}/api/conversations/${conversation.id}/changes?botId=bot`, headers = { Authorization: `Bearer ${session.token}` };
    return { hub, url, headers, conversation };
  }
  it("rejects unauthenticated, missing-Bot, foreign-Bot and duplicate query requests before work", async () => {
    const { hub, url, headers } = await authenticatedHub();
    const call = vi.spyOn(hub.workspaceDiff, "list");
    try {
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url.split("?")[0]!, { headers })).status).toBe(400);
      expect((await fetch(url.replace("botId=bot", "botId=other"), { headers })).status).toBe(403);
      expect((await fetch(url + "&botId=other", { headers })).status).toBe(400);
      expect(call).not.toHaveBeenCalled();
    } finally { await hub.close(); }
  });
  it.each(["revoked", "member_removed", "bot_deleted", "owner_removed"] as const)("rechecks %s after asynchronous reads before returning a body", async kind => {
    const { hub, url, headers, conversation } = await authenticatedHub();
    let began!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(hub.workspaceDiff, "list").mockImplementation(async () => { began(); await gate; return { scope: "current_workspace", conversationId: conversation.id, botId: "bot", head: hash, capturedAt: 1, state: "ready", notes: [], items: [], truncated: false }; });
    try {
      const response = fetch(url, { headers }); await entered;
      if (kind === "revoked") await hub.auth.revoke("device", "local-owner");
      if (kind === "member_removed") await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [conversation.id]);
      if (kind === "bot_deleted") await hub.store.db.run("UPDATE bots SET deleted_at=1 WHERE id='bot'");
      if (kind === "owner_removed") await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
      resume(); const result = await response;
      expect(result.status).toBe(kind === "revoked" ? 401 : kind === "bot_deleted" ? 410 : 403);
      expect(await result.text()).not.toContain("current_workspace");
    } finally { resume(); await hub.close(); }
  });
});

// Opt-in live-Git acceptance is deliberately separate from controlled-output
// tests: a TCC failure is a failed gate, never silently skipped as a pass.
it.skipIf(process.env.TAROBOT_DIFF_REAL_GIT !== "1")("real Git: tracked/untracked/ignored/filter rejection and unchanged repository bytes", async () => {
  const root = await mkdtemp(path.join(base, "diff-real-")); roots.push(root);
  const repo = path.join(root, "repo"), state = path.join(root, "bot"); await mkdir(repo); await mkdir(state);
  const run = (args: string[]) => { const result = spawnSync("git", args, { cwd: repo, env: workspaceGitEnvironment(), encoding: "utf8" }); if (result.status) throw new Error(`git ${args[0]} failed (${result.status}): ${result.stderr}`); return result.stdout; };
  run(["init", "-q"]); run(["config", "user.name", "Fixture"]); run(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(repo, "file.txt"), "old\n"); await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n"); run(["add", "file.txt", ".gitignore"]); run(["commit", "-qm", "fixture"]);
  const beforeIndex = await readFile(path.join(repo, ".git/index")), beforeHead = await readFile(path.join(repo, ".git/HEAD"));
  await writeFile(path.join(repo, "file.txt"), "new\n"); await writeFile(path.join(repo, "added.txt"), "untracked\n"); await writeFile(path.join(repo, "ignored.txt"), "secret fixture\n"); await writeFile(path.join(state, "config.json"), JSON.stringify({ workspacePath: repo }));
  const service = new HubWorkspaceDiff(async () => state);
  expect((await service.list(scope, abort(), authorize)).items.map(item => item.path)).toEqual(expect.arrayContaining(["file.txt", "added.txt"]));
  expect(await service.file(scope, "file.txt", false, abort(), authorize)).toMatchObject({ additions: 1, deletions: 1 });
  await expect(service.file(scope, "ignored.txt", false, abort(), authorize)).rejects.toMatchObject({ code: "workspace_diff_not_changed" });
  run(["config", "filter.marker.clean", "touch should-not-exist"]);
  expect(await service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository" });
  expect(await readFile(path.join(repo, ".git/index"))).toEqual(beforeIndex); expect(await readFile(path.join(repo, ".git/HEAD"))).toEqual(beforeHead);
});

it("refuses included configuration outside the metadata consistency boundary", async () => {
  for (const config of ["include.path\n../settings\0", "includeif.gitdir:*.path\n../settings\0"]) {
    const f = await fixture({ config });
    expect(await f.service.list(scope, abort(), authorize)).toMatchObject({ state: "unsafe_repository", notes: ["unsafe_git_config"] });
    expect(f.calls.some(args => args[0] === "status")).toBe(false);
  }
});

it.each([false, true])("marks a successful but incomplete status with unreadable directories (warning beyond retained stderr: %s)", async late => {
  const f = await fixture({ status: ordinary("file.txt") }); await writeFile(path.join(f.workspace, "file.txt"), "new\n");
  const run: WorkspaceGitCommand = async (...args) => {
    const result = await f.run(...args);
    return args[1][0] === "status" ? { ...result, stderr: late ? "warning: CRLF conversion notice\n" : "warning: could not open directory 'hidden/': Permission denied\n", pathUnavailable: late } : result;
  };
  const service = new HubWorkspaceDiff(async () => f.state, { runGit: run });
  expect(await service.list(scope, abort(), authorize)).toMatchObject({ truncated: true, notes: expect.arrayContaining(["path_unavailable"]), items: [expect.objectContaining({ path: "file.txt" })] });
});

it.skipIf(process.platform === 'win32')("drains excessive Git warnings while retaining bounded stderr and valid stdout", async () => {
  const f = await fixture(), executable = path.join(f.root, 'noisy-git');
  await writeFile(executable, '#!/bin/sh\ni=0; while [ "$i" -lt 3000 ]; do printf "warning: CRLF conversion notice\\n" >&2; i=$((i+1)); done\nprintf "1\\t1\\tfile.txt\\0"\n');
  await chmod(executable, 0o700);
  const run = createWorkspaceGitRunner(executable);
  const result = await run(f.workspace, [], AbortSignal.timeout(5000), 1024, true);
  expect(result.code).toBe(0); expect(result.stdout.toString()).toBe('1\t1\tfile.txt\0'); expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16384); expect(result.limited).toBe(false);
});


it.skipIf(process.platform === "win32")("keeps incomplete-status warnings after the stderr cap and across chunks", async () => {
  const f = await fixture(), executable = path.join(f.root, "late-warning-git");
  await writeFile(executable, '#!/bin/sh\ni=0; while [ "$i" -lt 3000 ]; do printf "warning: CRLF conversion notice\\n" >&2; i=$((i+1)); done\nprintf "warning: could not open direc" >&2\nsleep 0.02\nprintf "tory hidden" >&2\nprintf "ok"\n');
  await chmod(executable, 0o700);
  const result = await createWorkspaceGitRunner(executable)(f.workspace, [], AbortSignal.timeout(5000), 1024, true);
  expect(result).toMatchObject({ code: 0, limited: false, pathUnavailable: true });
  expect(result.stdout.toString()).toBe("ok");
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16384);
  expect(result.stderr).not.toContain("hidden");
});

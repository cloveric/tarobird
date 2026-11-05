import { execFile, spawn } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isCredentialStylePath } from "../runtime/credential-files.js";
import {
  WORKSPACE_DIFF_LINE_CHARS, WORKSPACE_DIFF_MAX_BYTES, WORKSPACE_DIFF_MAX_FILES, WORKSPACE_DIFF_MAX_LINES, WORKSPACE_DIFF_PREVIEW_LINES,
  workspaceChangesSchema, workspaceDiffPathSchema, workspaceFileDiffSchema,
  type WorkspaceChange, type WorkspaceChanges, type WorkspaceDiffHunk, type WorkspaceDiffLine, type WorkspaceDiffNote, type WorkspaceFileDiff,
} from "../client-protocol/workspace-diff.js";
import { HubError } from "./store.js";

const STATUS_BYTES = 1024 * 1024, CONFIG_BYTES = 128 * 1024, DEADLINE_MS = 10_000;
type Scope = { conversationId: string; botId: string };
type GitResult = { stdout: Buffer; stderr: string; code: number; limited: boolean; pathUnavailable?: boolean };
export type WorkspaceGitCommand = (root: string, args: string[], signal: AbortSignal, maxBytes: number, allowLimit?: boolean) => Promise<GitResult>;
type Operation = { signal: AbortSignal; remaining: () => number; authorize: () => Promise<void>; verify?: () => Promise<void> };
type Context = { workspace: string; repo: string; prefix: string; head: string | null; notes: WorkspaceDiffNote[]; run: WorkspaceGitCommand };
type PathIdentity = { file: string; parents: { file: string; stat: BigIntStats }[]; leaf?: BigIntStats; kind: WorkspaceChange["kind"] };
type Entry = { item: WorkspaceChange; repoPath: string; indexRemovedWorktree?: boolean; nestedRepository?: boolean };
type ParentStats = Map<string, BigIntStats>;

const within = (root: string, file: string) => { const rel = path.relative(root, file); return rel === "" || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const sameNode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const unchanged = (a: BigIntStats, b: BigIntStats) => sameNode(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const unique = (notes: WorkspaceDiffNote[]) => [...new Set(notes)];
const asText = (bytes: Buffer, partial = false) => new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
const lineCount = (text: string) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const contentIssue = (bytes: Buffer, partial = false): "binary" | "unsupported_encoding" | undefined => { if (bytes.includes(0)) return "binary"; try { asText(bytes, partial); } catch { return "unsupported_encoding"; } };
const emptyItem = (file: string): WorkspaceChange => ({ path: file, status: "modified", staged: false, unstaged: false, generated: generated(file), kind: "file", protected: isCredentialStylePath(file), additions: null, deletions: null });
function generated(file: string): boolean { return /(?:^|\/)(?:node_modules|dist|build|coverage|vendor)\//i.test(file) || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$|\.(?:min\.(?:js|css)|map|generated\.[^/]+)$/i.test(file); }

/** Strip inherited Git control variables. Global/system settings intentionally do
 * not widen this API's scope, and safe.directory is never overridden. */
export function workspaceGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TMPDIR", "TMP", "TEMP"]) if (env[key] !== undefined) result[key] = env[key];
  result.PATH = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(directory => path.isAbsolute(directory)).join(path.delimiter);
  const nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...result, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C", LANG: "C" };
}
export async function resolveWorkspaceGit(workspace: string, env: NodeJS.ProcessEnv = process.env, options: { signal?: AbortSignal; platform?: NodeJS.Platform; selectedDeveloperDir?: () => Promise<string> } = {}): Promise<string> {
  const search = env.PATH ?? env.Path ?? "";
  for (const directory of search.split(path.delimiter)) {
    options.signal?.throwIfAborted();
    if (!path.isAbsolute(directory) || within(workspace, directory)) continue;
    try {
      let executable = await realpath(path.join(directory, process.platform === "win32" ? "git.exe" : "git"));
      if ((options.platform ?? process.platform) === "darwin" && executable === "/usr/bin/git") {
        // Never invoke Apple's installer-triggering shim. xcode-select -p only
        // reports selection; invoke the selected, installed Git directly.
        const selected = await (options.selectedDeveloperDir?.() ?? new Promise<string>((resolve, reject) => {
          execFile("/usr/bin/xcode-select", ["-p"], { cwd: "/", env: workspaceGitEnvironment(env), signal: options.signal, timeout: 1000, maxBuffer: 8192, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout.trimEnd()));
        }));
        if (!path.isAbsolute(selected)) continue;
        executable = await realpath(path.join(selected, "usr", "bin", "git"));
        if (executable === "/usr/bin/git") continue;
      }
      if (within(workspace, executable) || !(await lstat(executable)).isFile()) continue;
      await access(executable, constants.X_OK); return executable;
    } catch { /* Try the next absolute, trusted host PATH entry. */ }
  }
  throw new HubError("workspace_diff_git_unavailable", 503);
}
export function createWorkspaceGitRunner(executable: string, env: NodeJS.ProcessEnv = process.env): WorkspaceGitCommand {
  if (!path.isAbsolute(executable)) throw new Error("git_executable_must_be_absolute");
  const neutral = path.dirname(executable), gitEnv = workspaceGitEnvironment(env);
  const fixed = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${path.join(neutral, ".tarobot-disabled-hooks")}`,
    "-c", "safe.bareRepository=explicit", "-c", "protocol.allow=never", "-c", `core.bigFileThreshold=${WORKSPACE_DIFF_MAX_BYTES}`, "-c", "diff.submodule=short", "-c", "diff.autoRefreshIndex=false", "-c", "status.relativePaths=false", "-c", "diff.relative=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false", "-c", "color.ui=false", "-c", "color.diff=false"];
  return (root, args, signal, maxBytes, allowLimit = false) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const child = spawn(executable, [...fixed, "-C", root, ...args], { cwd: neutral, env: gitEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let size = 0, errorBytes = 0, limited = false, failure: unknown;
    let warningTail = "", pathUnavailable = false;
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    const stop = (error: unknown) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(signal.reason ?? new HubError("workspace_diff_cancelled", 499));
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      if (size < maxBytes) chunks.push(data.subarray(0, maxBytes - size));
      size += data.length;
      if (size > maxBytes) { limited = true; if (allowLimit) child.kill("SIGKILL"); else stop(new HubError("workspace_diff_output_limit", 413)); }
    });
    // Warnings (for example one CRLF notice per file) must not discard valid
    // output. Drain stderr with bounded storage; the operation deadline still
    // terminates a noisy or hung process.
    child.stderr.on("data", (data: Buffer) => {
      if (errorBytes < 16 * 1024) errors.push(data.subarray(0, 16 * 1024 - errorBytes));
      errorBytes = Math.min(16 * 1024, errorBytes + data.length);
      const warning = warningTail + data.toString("utf8");
      pathUnavailable ||= /could not open directory|permission denied/i.test(warning);
      warningTail = warning.slice(-64);
    });
    child.once("error", error => { failure = (error as NodeJS.ErrnoException).code === "ENOENT" ? new HubError("workspace_diff_git_unavailable", 503) : new HubError("workspace_diff_git_failed", 503); });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString("utf8"), code: code ?? 1, limited, pathUnavailable });
    });
  });
}

/** git config --null --list keeps every occurrence, including values overridden
 * by our command-line flags. Never return its contents (they may hold secrets). */
export function unsafeWorkspaceGitConfig(bytes: Buffer): "unsafe_git_config" | "partial_clone" | undefined {
  for (const record of bytes.toString("utf8").split("\0")) {
    const boundary = record.indexOf("\n"), key = (boundary < 0 ? record : record.slice(0, boundary)).toLowerCase(), value = boundary < 0 ? "" : record.slice(boundary + 1);
    if (key === "core.worktree" && value.trim()) return "unsafe_git_config";
    // Include targets may live outside the metadata snapshot (even in the
    // writable worktree). v1 cannot verify that configuration consistently.
    if (/^include(?:if)?\./.test(key)) return "unsafe_git_config";
    if (/^extensions\.partialclone$|^remote\..*\.promisor$/.test(key)) return "partial_clone";
    if (value.trim() && (/^filter\..*\.(?:clean|smudge|process)$|^diff\..*\.(?:command|textconv)$|^diff\.external$/.test(key)
      || key === "core.fsmonitor" && !/^(?:false|off|no|0|true|on|yes|1)$/i.test(value.trim()))) return "unsafe_git_config";
  }
}
function gitFailure(result: GitResult): HubError {
  if (/dubious ownership|unsafe repository/i.test(result.stderr)) return new HubError("workspace_diff_ownership", 403);
  if (/not a git repository/i.test(result.stderr)) return new HubError("workspace_diff_not_repository", 409);
  return new HubError("workspace_diff_git_failed", 503);
}
async function checked(run: WorkspaceGitCommand, root: string, args: string[], op: Operation, max = STATUS_BYTES, allowLimit = false): Promise<GitResult> {
  op.signal.throwIfAborted();
  const result = await run(root, args, op.signal, max, allowLimit);
  op.signal.throwIfAborted();
  if (result.code !== 0 && !result.limited) throw gitFailure(result);
  return result;
}

/** Parse only NUL-delimited porcelain v2 paths, never patch header filenames. */
function nulRecords(bytes: Buffer, onInvalid?: () => void): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const end = bytes.indexOf(0, offset); if (end < 0) break;
    try { result.push(asText(bytes.subarray(offset, end))); } catch { onInvalid?.(); }
    offset = end + 1;
  }
  return result;
}
export function parseWorkspaceStatus(bytes: Buffer, prefix = "", onInvalid?: () => void): Entry[] {
  const records = nulRecords(bytes, onInvalid), entries: Entry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    let name: string, xy = "??", sub = "N...", mode = "";
    if (record.startsWith("? ")) name = record.slice(2);
    else if (/^[12u] /.test(record)) {
      const count = record[0] === "u" ? 10 : record[0] === "2" ? 9 : 8;
      let offset = 0; const fields: string[] = [];
      for (let field = 0; field < count; field++) { const end = record.indexOf(" ", offset); if (end < 0) { offset = -1; break; } fields.push(record.slice(offset, end)); offset = end + 1; }
      if (offset < 0) continue;
      name = record.slice(offset); xy = fields[1]!; sub = fields[2]!; mode = fields[3]!;
      if (record[0] === "2") index++; // Rename detection is disabled; fail safely if a Git still emits it.
    } else continue;
    if (prefix && !name.startsWith(prefix)) continue;
    const nestedRepository = record.startsWith("? ") && name.endsWith("/");
    if (nestedRepository) name = name.slice(0, -1);
    const relative = name.slice(prefix.length);
    if (!workspaceDiffPathSchema.safeParse(relative).success) { onInvalid?.(); continue; }
    const item = emptyItem(relative);
    item.status = record[0] === "u" || xy.includes("U") ? "conflicted" : xy === "??" ? "untracked" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : xy.includes("T") ? "type_changed" : "modified";
    item.staged = xy !== "??" && xy[0] !== "." && xy[0] !== " "; item.unstaged = xy === "??" || xy[1] !== "." && xy[1] !== " ";
    if (sub.startsWith("S") || mode === "160000") item.kind = "submodule";
    else if (mode === "120000") item.kind = "symlink";
    if (nestedRepository) item.kind = "other";
    entries.push({ item, repoPath: name, ...(nestedRepository ? { nestedRepository: true } : {}) });
  }
  const unique = new Map<string, Entry>();
  for (const entry of entries) {
    const previous = unique.get(entry.repoPath);
    if (!previous) { unique.set(entry.repoPath, entry); continue; }
    // A staged deletion followed by a new untracked file at the same path is
    // one current-workspace change. Git diff-index would describe an index
    // deletion, not the recreated bytes, so expose this case as metadata only.
    previous.item.staged ||= entry.item.staged; previous.item.unstaged ||= entry.item.unstaged;
    if (previous.item.status === "deleted" && entry.item.status === "untracked" || previous.item.status === "untracked" && entry.item.status === "deleted") { previous.item.status = "modified"; previous.indexRemovedWorktree = true; }
    else if (entry.item.status === "conflicted") previous.item.status = "conflicted";
  }
  return [...unique.values()];
}
export function parseWorkspaceNumstat(bytes: Buffer, prefix = ""): Map<string, { additions: number | null; deletions: number | null }> {
  const result = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const record of nulRecords(bytes)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match || prefix && !match[3]!.startsWith(prefix)) continue;
    result.set(match[3]!.slice(prefix.length), { additions: match[1] === "-" ? null : Number(match[1]), deletions: match[2] === "-" ? null : Number(match[2]) });
  }
  return result;
}
function clip(text: string): { text: string; clipped: boolean } { return { text: text.slice(0, WORKSPACE_DIFF_LINE_CHARS), clipped: text.length > WORKSPACE_DIFF_LINE_CHARS }; }
export function parseWorkspacePatch(text: string): { hunks: WorkspaceDiffHunk[]; limited: boolean; binary: boolean } {
  const hunks: WorkspaceDiffHunk[] = []; let current: WorkspaceDiffHunk | undefined, oldLine = 0, newLine = 0, rows = 0, limited = false;
  for (const raw of text.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      if (++rows > WORKSPACE_DIFF_MAX_LINES) { limited = true; break; }
      current = { header: clip(raw).text, oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1), newStart: Number(header[3]), newLines: Number(header[4] ?? 1), lines: [] };
      oldLine = current.oldStart; newLine = current.newStart; hunks.push(current); continue;
    }
    if (!current || !/^[ +\\-]/.test(raw)) continue;
    if (++rows > WORKSPACE_DIFF_MAX_LINES) { limited = true; break; }
    const type = raw[0], line: WorkspaceDiffLine = { kind: type === "+" ? "add" : type === "-" ? "delete" : type === " " ? "context" : "meta", ...clip(raw.slice(1)), oldLine: null, newLine: null };
    if (type === " " || type === "-") line.oldLine = oldLine++;
    if (type === " " || type === "+") line.newLine = newLine++;
    current.lines.push(line);
  }
  return { hunks, limited, binary: /(?:^|\n)Binary files |(?:^|\n)GIT binary patch/.test(text) };
}

async function parentStat(file: string, cache?: ParentStats): Promise<BigIntStats> {
  const previous = cache?.get(file); if (previous) return previous;
  const stat = await lstat(file, { bigint: true }); if (cache && cache.size < 8192) cache.set(file, stat); return stat;
}
async function identify(root: string, relative: string, cache?: ParentStats): Promise<PathIdentity> {
  workspaceDiffPathSchema.parse(relative);
  const parents: PathIdentity["parents"] = [];
  let current = root;
  const rootStat = await parentStat(root, cache);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new HubError("workspace_diff_path_unavailable", 409);
  parents.push({ file: root, stat: rootStat });
  const parts = relative.split("/");
  for (const component of parts.slice(0, -1)) {
    current = path.join(current, component);
    let info: BigIntStats;
    try { info = await parentStat(current, cache); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: path.join(root, ...parts), parents, kind: "missing" }; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HubError("workspace_diff_path_unavailable", 409);
    parents.push({ file: current, stat: info });
  }
  const file = path.join(root, ...parts), leaf = await lstat(file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  return { file, parents, leaf, kind: !leaf ? "missing" : leaf.isSymbolicLink() ? "symlink" : leaf.isFile() && leaf.nlink === 1n ? "file" : "other" };
}
async function recheck(identity: PathIdentity, cache?: ParentStats): Promise<void> {
  for (const parent of identity.parents) { const current = await parentStat(parent.file, cache); if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(parent.stat, current)) throw new HubError("workspace_diff_changed_during_read", 409); }
  const current = await lstat(identity.file, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (identity.leaf ? !current || !unchanged(identity.leaf, current) : current) throw new HubError("workspace_diff_changed_during_read", 409);
}
async function readBounded(identity: PathIdentity, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!identity.leaf?.isFile() || identity.leaf.nlink !== 1n || identity.leaf.isSymbolicLink() || process.platform === "win32" && identity.leaf.ino === 0n) throw new HubError("workspace_diff_path_unavailable", 409);
  signal.throwIfAborted(); await recheck(identity);
  const handle = await open(identity.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !unchanged(identity.leaf, before) || process.platform === "win32" && before.ino === 0n) throw new HubError("workspace_diff_changed_during_read", 409);
    await recheck(identity);
    const buffer = Buffer.alloc(Math.min(maxBytes, Number(before.size > BigInt(maxBytes) ? BigInt(maxBytes) : before.size)));
    let offset = 0;
    while (offset < buffer.length) { signal.throwIfAborted(); const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (!unchanged(before, await handle.stat({ bigint: true }))) throw new HubError("workspace_diff_changed_during_read", 409);
    await recheck(identity); signal.throwIfAborted(); return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Check only metadata that read-only Git may consume, with streaming directory
 * iteration and a shared operation deadline. Never follow even static object,
 * pack or ref symlinks. This is not an atomic sandbox against local renames. */
export async function inspectWorkspaceGitMetadata(gitDir: string, signal: AbortSignal, maxEntries = 8192): Promise<() => Promise<void>> {
  type MetadataNode = { stat: BigIntStats; strictTimes: boolean };
  const snapshot = async (): Promise<Map<string, MetadataNode>> => {
    const nodes = new Map<string, MetadataNode>(); let visited = 0;
    const inspect = async (file: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (++visited > maxEntries || depth > 32) throw new HubError("workspace_diff_git_metadata_limit", 409);
      const relative = path.relative(gitDir, file).split(path.sep).join("/");
      // Git ref components cannot end in .lock. Only these precise top-level
      // lock targets and regular ref lock files are irrelevant to our readers.
      const runtimeLock = /^(?:HEAD|index|config(?:\.worktree)?|packed-refs|shallow)\.lock$/.test(relative) || /^refs\/.+\.lock$/.test(relative);
      const stat = await lstat(file, { bigint: true }).catch(error => {
        if ((runtimeLock || ["fsmonitor--daemon.ipc", "logs", "hooks"].includes(relative)) && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) return;
      // fsmonitor is force-disabled on every Git command. Do not open or
      // connect to its documented Unix socket; every other special node fails.
      if (relative === "fsmonitor--daemon.ipc" && stat.isSocket()) return;
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || process.platform === "win32" && stat.ino === 0n) throw new HubError("workspace_diff_external_git_metadata", 409);
      if (runtimeLock && stat.isFile()) return;
      // No reflog selectors or hooks are used. Validate their root node type,
      // but their contents/mtime cannot affect the fixed read-only commands.
      if (depth === 1 && ["logs", "hooks"].includes(relative) && stat.isDirectory()) return;
      if (relative === "commondir" || relative === "gitdir" || /^objects\/info\/(?:alternates|http-alternates)$/.test(relative) && stat.size > 0n) throw new HubError("workspace_diff_external_git_metadata", 409);
      const recurse = stat.isDirectory() && (depth !== 1 || ["objects", "refs", "info", "reftable"].includes(relative));
      const filteredDirectory = stat.isDirectory() && (!relative || relative === "refs" || relative.startsWith("refs/"));
      nodes.set(file, { stat, strictTimes: !filteredDirectory });
      if (!recurse) return;
      const directory = await opendir(file);
      try { for await (const entry of directory) { signal.throwIfAborted(); await inspect(path.join(file, entry.name), depth + 1); } }
      finally { await directory.close().catch(() => {}); }
    };
    await inspect(gitDir, 0); return nodes;
  };
  let before: Map<string, MetadataNode>;
  try { before = await snapshot(); }
  catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HubError("workspace_diff_changed_during_read", 409);
    throw error;
  }
  return async () => {
    let after: Map<string, MetadataNode>;
    try { after = await snapshot(); }
    catch { signal.throwIfAborted(); throw new HubError("workspace_diff_changed_during_read", 409); }
    if (before.size !== after.size) throw new HubError("workspace_diff_changed_during_read", 409);
    for (const [file, node] of before) {
      signal.throwIfAborted(); const current = after.get(file);
      // Root/refs directory membership is compared through the bounded filtered
      // node set, so lock/socket churn is harmless. Consumed files and object
      // directories retain strict identity, size and timestamp protection.
      if (!current || !(node.strictTimes ? unchanged(node.stat, current.stat) : sameNode(node.stat, current.stat))) throw new HubError("workspace_diff_changed_during_read", 409);
    }
  };
}

export class HubWorkspaceDiff {
  private readonly operations = new Set<AbortController>();
  private stopped = false;
  constructor(private readonly stateDirectory: (botId: string, remainingMs: number) => Promise<string>, private readonly options: { env?: NodeJS.ProcessEnv; runGit?: WorkspaceGitCommand; deadlineMs?: number } = {}) {}
  close(): void { this.stopped = true; for (const controller of this.operations) controller.abort(new HubError("hub_stopping", 503)); }
  private async operation<T>(scope: Scope, signal: AbortSignal, authorize: () => Promise<void>, work: (op: Operation) => Promise<T>): Promise<T> {
    if (this.stopped) throw new HubError("hub_stopping", 503);
    if (this.operations.size >= 2) throw new HubError("workspace_diff_busy", 429);
    const controller = new AbortController(), deadline = Date.now() + (this.options.deadlineMs ?? DEADLINE_MS);
    const cancel = () => controller.abort(signal.reason ?? new HubError("workspace_diff_cancelled", 499));
    signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new HubError("workspace_diff_timeout", 504)), Math.max(1, deadline - Date.now())); timer.unref();
    this.operations.add(controller);
    let onAbort: (() => void) | undefined;
    const settled = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); this.operations.delete(controller); };
    try {
      const abort = new Promise<never>((_resolve, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
      const task = (async () => { await authorize(); controller.signal.throwIfAborted(); const op: Operation = { signal: controller.signal, remaining: () => Math.max(1, deadline - Date.now()), authorize }; const result = await work(op); controller.signal.throwIfAborted(); await op.verify?.(); await authorize(); return result; })();
      // Return a timeout promptly, but retain admission while an uncancellable
      // filesystem/RPC operation settles. Repeated timeouts cannot grow a queue.
      void task.then(settled, settled);
      return await Promise.race([task, abort]);
    } finally { if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
  }
  private async context(scope: Scope, op: Operation, requestedPath?: string): Promise<Context> {
    const state = await this.stateDirectory(scope.botId, op.remaining()); op.signal.throwIfAborted();
    if (!path.isAbsolute(state)) throw new HubError("workspace_diff_workspace_unavailable", 409);
    const canonicalState = await realpath(state);
    const configIdentity = await identify(canonicalState, "config.json");
    let config: Record<string, unknown> = {};
    if (configIdentity.kind !== "missing") {
      if (!configIdentity.leaf || configIdentity.leaf.size > BigInt(CONFIG_BYTES)) throw new HubError("workspace_diff_workspace_unavailable", 409);
      const parsed: unknown = JSON.parse(asText(await readBounded(configIdentity, CONFIG_BYTES, op.signal)));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HubError("workspace_diff_workspace_unavailable", 409);
      config = parsed as Record<string, unknown>;
    }
    const resume = config.resume && typeof config.resume === "object" ? config.resume as Record<string, unknown> : {};
    const configured = config.workspacePath ?? resume.workspacePath ?? path.join(canonicalState, "workspace");
    if (typeof configured !== "string" || !path.isAbsolute(configured)) throw new HubError("workspace_diff_workspace_unavailable", 409);
    const workspace = await realpath(configured);
    const workspaceIdentity = await lstat(workspace, { bigint: true });
    if (workspace === path.parse(workspace).root || !workspaceIdentity.isDirectory()) throw new HubError("workspace_diff_workspace_unavailable", 409);
    if (requestedPath && isCredentialStylePath(path.join(configured, requestedPath), path.join(workspace, requestedPath))) throw new HubError("workspace_diff_protected", 403);
    op.verify = async () => {
      await recheck(configIdentity);
      if (await realpath(configured) !== workspace || !sameNode(workspaceIdentity, await lstat(workspace, { bigint: true }))) throw new HubError("workspace_diff_changed_during_read", 409);
    };
    const run = this.options.runGit ?? createWorkspaceGitRunner(await resolveWorkspaceGit(workspace, this.options.env, { signal: op.signal }), this.options.env);
    const configResult = await checked(run, workspace, ["config", "--null", "--list", "--includes"], op, CONFIG_BYTES);
    const unsafe = unsafeWorkspaceGitConfig(configResult.stdout);
    if (unsafe) throw new HubError(`workspace_diff_${unsafe}`, 409);
    const top = await checked(run, workspace, ["rev-parse", "--show-toplevel"], op, 8192);
    const repo = await realpath(top.stdout.toString("utf8").trim());
    if (!within(repo, workspace)) throw new HubError("workspace_diff_workspace_unavailable", 409);
    const repoIdentity = await lstat(repo, { bigint: true });
    const home = this.options.env?.HOME ?? this.options.env?.USERPROFILE ?? os.homedir();
    const homeIdentity = await lstat(await realpath(home), { bigint: true }).catch(() => undefined);
    if (repo === path.parse(repo).root || homeIdentity && sameNode(repoIdentity, homeIdentity)) throw new HubError("workspace_diff_repository_root_unsafe", 409);
    if (repo === workspace && !sameNode(repoIdentity, workspaceIdentity)) throw new HubError("workspace_diff_changed_during_read", 409);
    // v1 deliberately supports normal in-repository metadata only. Linked
    // worktrees, gitdir redirect files and alternate object stores need their
    // own explicit trust contract before they can expose historical blobs.
    const expectedGitDir = path.join(repo, ".git"), metadataIdentity = await lstat(expectedGitDir, { bigint: true }).catch(() => undefined);
    if (!metadataIdentity?.isDirectory() || metadataIdentity.isSymbolicLink()) throw new HubError("workspace_diff_external_git_metadata", 409);
    const gitDir = await realpath((await checked(run, repo, ["rev-parse", "--absolute-git-dir"], op, 8192)).stdout.toString("utf8").trimEnd());
    const commonValue = (await checked(run, repo, ["rev-parse", "--git-common-dir"], op, 8192)).stdout.toString("utf8").trimEnd();
    const commonDir = await realpath(path.resolve(repo, commonValue));
    const workspaceGitDir = await realpath((await checked(run, workspace, ["rev-parse", "--absolute-git-dir"], op, 8192)).stdout.toString("utf8").trimEnd());
    const workspaceCommonValue = (await checked(run, workspace, ["rev-parse", "--git-common-dir"], op, 8192)).stdout.toString("utf8").trimEnd();
    const workspaceCommonDir = await realpath(path.resolve(workspace, workspaceCommonValue));
    if (gitDir !== workspaceGitDir || commonDir !== workspaceCommonDir) throw new HubError("workspace_diff_external_git_metadata", 409);
    if (gitDir !== await realpath(expectedGitDir) || commonDir !== gitDir || (await checked(run, repo, ["rev-parse", "--is-bare-repository"], op, 64)).stdout.toString().trim() !== "false") throw new HubError("workspace_diff_external_git_metadata", 409);
    const verifyMetadata = await inspectWorkspaceGitMetadata(gitDir, op.signal);
    // Recheck effective configuration inside the metadata snapshot, not just
    // before discovery. Post-read verification rejects concurrent changes.
    const checkedConfig = await checked(run, workspace, ["config", "--null", "--list", "--includes"], op, CONFIG_BYTES);
    const changedConfig = unsafeWorkspaceGitConfig(checkedConfig.stdout);
    if (changedConfig) throw new HubError(`workspace_diff_${changedConfig}`, 409);
    await verifyMetadata();
    const verifyRoot = op.verify;
    op.verify = async () => { await verifyRoot?.(); await verifyMetadata(); };
    const prefix = path.relative(repo, workspace).split(path.sep).filter(Boolean).join("/");
    const gitPrefix = (await checked(run, workspace, ["rev-parse", "--show-prefix"], op, 8192)).stdout.toString("utf8").trimEnd();
    if (gitPrefix !== (prefix ? `${prefix}/` : "")) throw new HubError("workspace_diff_workspace_unavailable", 409);
    const headResult = await run(repo, ["rev-parse", "--verify", "HEAD"], op.signal, 256);
    let head: string | null = null;
    if (!headResult.code && /^(?:[a-f0-9]{40}|[a-f0-9]{64})\s*$/.test(headResult.stdout.toString())) head = headResult.stdout.toString().trim();
    else if (!/Needed a single revision|unknown revision|ambiguous argument|bad revision/i.test(headResult.stderr)) throw gitFailure(headResult);
    const notes: WorkspaceDiffNote[] = ["global_config_ignored"];
    if (!head) notes.push("no_head");
    if (await lstat(path.join(repo, ".gitmodules")).then(() => true, () => false)) notes.push("submodules_ignored");
    await op.authorize(); op.signal.throwIfAborted();
    return { workspace, repo, prefix: prefix ? `${prefix}/` : "", head, notes, run };
  }
  private scope(scope: Scope, context?: Context): Pick<WorkspaceChanges, "scope" | "conversationId" | "botId" | "head" | "capturedAt" | "state" | "notes"> {
    return { ...scope, scope: "current_workspace", head: context?.head ?? null, capturedAt: Date.now(), state: context?.head ? "ready" : "no_head", notes: context?.notes ?? [] };
  }
  private async status(context: Context, op: Operation, file?: string): Promise<{ entries: Entry[]; limited: boolean; unsupported: boolean }> {
    const result = await checked(context.run, context.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all", "--no-renames", "--", file ? context.prefix + file : context.prefix || "."], op, STATUS_BYTES, true);
    let unsupported = result.pathUnavailable === true || /could not open directory|permission denied/i.test(result.stderr);
    const entries = parseWorkspaceStatus(result.stdout, context.prefix, () => { unsupported = true; }).filter(entry => !file || entry.item.path === file);
    return { entries, limited: result.limited, unsupported };
  }
  async list(scope: Scope, signal: AbortSignal, authorize: () => Promise<void>): Promise<WorkspaceChanges> {
    return this.operation(scope, signal, authorize, async op => {
      let context: Context;
      try { context = await this.context(scope, op); }
      catch (error) {
        if (error instanceof HubError && ["workspace_diff_timeout", "workspace_diff_busy", "workspace_diff_changed_during_read", "device_revoked", "session_expired", "owner_required", "conversation_forbidden", "bot_forbidden", "bot_deleted"].includes(error.code)) throw error;
        const code = error instanceof HubError ? error.code : "workspace_diff_workspace_unavailable";
        const note: WorkspaceDiffNote = code === "workspace_diff_not_repository" ? "not_repository" : code === "workspace_diff_git_unavailable" ? "git_unavailable" : code === "workspace_diff_unsafe_git_config" ? "unsafe_git_config" : code === "workspace_diff_partial_clone" ? "partial_clone" : code === "workspace_diff_ownership" ? "ownership" : code === "workspace_diff_git_metadata_limit" ? "git_metadata_limit" : code === "workspace_diff_external_git_metadata" ? "external_git_metadata" : code === "workspace_diff_repository_root_unsafe" ? "repository_root_unsafe" : code === "workspace_diff_git_failed" ? "git_failed" : "workspace_unavailable";
        return workspaceChangesSchema.parse({ ...this.scope(scope), state: note === "not_repository" ? "not_repository" : note === "git_unavailable" ? "git_unavailable" : ["unsafe_git_config", "partial_clone", "ownership", "external_git_metadata", "repository_root_unsafe", "git_metadata_limit"].includes(note) ? "unsafe_repository" : note === "git_failed" ? "git_error" : "workspace_unavailable", notes: [note], items: [], truncated: false });
      }
      const status = await this.status(context, op), entries = status.entries.slice(0, WORKSPACE_DIFF_MAX_FILES), identities: { entry: Entry; identity: PathIdentity }[] = [], omitted = new Set<Entry>(), initialParents: ParentStats = new Map(), finalParents: ParentStats = new Map();
      if (status.limited) context.notes.push("status_limit"); if (status.entries.length > entries.length) context.notes.push("file_limit");
      if (status.unsupported) context.notes.push("path_unavailable");
      for (const entry of entries) {
        op.signal.throwIfAborted();
        try { const identity = await identify(context.workspace, entry.item.path, initialParents); identities.push({ entry, identity }); if (!entry.nestedRepository && entry.item.kind !== "submodule" && entry.item.kind !== "symlink") entry.item.kind = identity.kind; entry.item.protected ||= isCredentialStylePath(identity.file); }
        catch { omitted.add(entry); context.notes.push("path_unavailable"); }
        if (entry.item.status === "deleted" && entry.item.staged && entry.item.kind === "file") entry.indexRemovedWorktree = true;
        if (entry.indexRemovedWorktree) context.notes.push("index_removed_worktree");
        if (entry.nestedRepository) context.notes.push("nested_repository");
        if (entry.item.status === "conflicted") context.notes.push("conflicts");
      }
      const safe = entries.filter(entry => !omitted.has(entry) && !entry.indexRemovedWorktree && !entry.item.protected && ["file", "missing"].includes(entry.item.kind) && !["untracked", "conflicted"].includes(entry.item.status));
      if (context.head && safe.length && op.remaining() > 250) {
        const countController = new AbortController(), cancel = () => countController.abort(op.signal.reason);
        op.signal.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => countController.abort(new HubError("workspace_diff_counts_timeout", 504)), Math.min(2000, op.remaining() - 100));
        try {
          const result = await context.run(context.repo, [...diffArguments(), "--numstat", "-z", context.head, "--", ...safe.map(entry => entry.repoPath)], countController.signal, STATUS_BYTES, true);
          if (result.code || result.limited) context.notes.push("counts_unavailable");
          else { const counts = parseWorkspaceNumstat(result.stdout, context.prefix); for (const entry of safe) Object.assign(entry.item, counts.get(entry.item.path) ?? { additions: 0, deletions: 0 }); }
        } catch { op.signal.throwIfAborted(); context.notes.push("counts_unavailable"); }
        finally { clearTimeout(timer); op.signal.removeEventListener("abort", cancel); }
      } else if (safe.length) context.notes.push("counts_unavailable");
      for (const { entry, identity } of identities) {
        try { await recheck(identity, finalParents); }
        catch {
          op.signal.throwIfAborted();
          // Bots commonly keep writing while the list is open. Do not discard
          // other files just because this leaf's earlier counts are now stale.
          entry.item.additions = null; entry.item.deletions = null; context.notes.push("changed_during_read");
          try {
            const current = await identify(context.workspace, entry.item.path);
            if (entry.item.kind !== "submodule" && entry.item.kind !== "symlink") entry.item.kind = current.kind;
          } catch { omitted.add(entry); context.notes.push("path_unavailable"); }
        }
      }
      return workspaceChangesSchema.parse({ ...this.scope(scope, context), notes: unique(context.notes), items: entries.filter(entry => !omitted.has(entry)).map(entry => entry.item), truncated: status.limited || status.unsupported || omitted.size > 0 || status.entries.length > entries.length });
    });
  }
  async file(scope: Scope, file: string, preview: boolean, signal: AbortSignal, authorize: () => Promise<void>): Promise<WorkspaceFileDiff> {
    workspaceDiffPathSchema.parse(file);
    return this.operation(scope, signal, authorize, async op => {
      // Reject known credential paths before spawning Git or opening their data.
      if (isCredentialStylePath(file)) throw new HubError("workspace_diff_protected", 403);
      const context = await this.context(scope, op, file);
      if (isCredentialStylePath(path.join(context.workspace, file))) throw new HubError("workspace_diff_protected", 403);
      const status = await this.status(context, op, file), entry = status.entries.find(value => value.item.path === file);
      if (!entry) throw new HubError("workspace_diff_not_changed", 404);
      const identity = await identify(context.workspace, file), item = entry.item;
      if (!entry.nestedRepository && item.kind !== "submodule" && item.kind !== "symlink") item.kind = identity.kind;
      const result: WorkspaceFileDiff = { ...this.scope(scope, context), file: item, binary: false, metadataOnly: false, reason: null, truncated: false, preview: false, additions: null, deletions: null, hunks: [] };
      const metadata = (reason: WorkspaceFileDiff["reason"], note?: WorkspaceDiffNote) => { result.metadataOnly = true; result.reason = reason; if (note) result.notes.push(note); result.notes = unique(result.notes); return workspaceFileDiffSchema.parse(result); };
      if (item.kind === "submodule") return metadata("submodule", "submodules_ignored");
      if (item.kind === "symlink" || identity.kind === "symlink") return metadata("symlink");
      if (entry.nestedRepository) return metadata("unavailable", "nested_repository");
      if (entry.indexRemovedWorktree || item.status === "deleted" && item.staged && identity.kind === "file") return metadata("unavailable", "index_removed_worktree");
      if (item.kind === "other") return metadata("unavailable", "path_unavailable");
      if (item.status === "conflicted") return metadata("conflict", "conflicts");
      let blob: { hash: string; size: number } | undefined;
      if (context.head) {
        const tree = await checked(context.run, context.repo, ["ls-tree", "-z", "-l", context.head, "--", entry.repoPath], op, 8192);
        const record = tree.stdout.toString("utf8").split("\0")[0] ?? "", tab = record.indexOf("\t"), meta = record.slice(0, tab).trim().split(/\s+/);
        if (tab >= 0 && record.slice(tab + 1) === entry.repoPath) {
          if (meta[0] === "120000") return metadata("symlink");
          if (meta[0] === "160000") return metadata("submodule", "submodules_ignored");
          if (!/^(?:100644|100755)$/.test(meta[0] ?? "") || meta[1] !== "blob" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(meta[2] ?? "") || !/^\d+$/.test(meta[3] ?? "")) return metadata("unavailable", "path_unavailable");
          blob = { hash: meta[2]!, size: Number(meta[3]) };
        }
      }
      const tooBig = (identity.leaf?.size ?? 0n) > BigInt(WORKSPACE_DIFF_MAX_BYTES) || (blob?.size ?? 0) > WORKSPACE_DIFF_MAX_BYTES;
      if (tooBig && !preview) {
        const currentSample = identity.kind === "file" ? await readBounded(identity, 8192, op.signal) : Buffer.alloc(0);
        const previousSample = blob ? (await checked(context.run, context.repo, ["cat-file", "blob", blob.hash], op, 8192, true)).stdout : Buffer.alloc(0);
        const issue = contentIssue(currentSample, true) ?? contentIssue(previousSample, true);
        if (issue) { result.binary = issue === "binary"; return metadata(result.binary ? "binary" : "unavailable", issue); }
        return metadata("too_large", "too_large");
      }
      let current: Buffer = identity.kind === "file" ? await readBounded(identity, WORKSPACE_DIFF_MAX_BYTES, op.signal) : Buffer.alloc(0);
      let previous: Buffer = Buffer.alloc(0);
      if (blob && (!tooBig || identity.kind === "missing")) {
        const content = await checked(context.run, context.repo, ["cat-file", "blob", blob.hash], op, WORKSPACE_DIFF_MAX_BYTES, tooBig);
        previous = content.stdout;
      }
      const currentPartial = (identity.leaf?.size ?? 0n) > BigInt(current.length), previousPartial = (blob?.size ?? 0) > previous.length;
      const issue = contentIssue(current, currentPartial) ?? contentIssue(previous, previousPartial);
      if (issue) { result.binary = issue === "binary"; return metadata(result.binary ? "binary" : "unavailable", issue); }
      const newText = asText(current, currentPartial), oldText = asText(previous, previousPartial);
      const longLines = [...newText.split("\n"), ...oldText.split("\n")].some(line => line.length > WORKSPACE_DIFF_LINE_CHARS);
      const wholeFile = !context.head || item.status === "untracked";
      const large = tooBig || wholeFile && (lineCount(newText) > WORKSPACE_DIFF_MAX_LINES || longLines);
      if (large && !preview) return metadata("too_large", longLines ? "long_lines" : "too_large");
      const usePreview = () => {
        const deleted = identity.kind === "missing", text = deleted ? oldText : newText;
        const lines = text.split("\n"); if (text.endsWith("\n")) lines.pop();
        const selected = lines.slice(0, WORKSPACE_DIFF_PREVIEW_LINES);
        result.hunks = [{ header: `@@ preview ${deleted ? "old" : "new"}:1-${selected.length} @@`, oldStart: deleted ? 1 : 0, oldLines: deleted ? selected.length : 0, newStart: deleted ? 0 : 1, newLines: deleted ? 0 : selected.length,
          lines: selected.map((line, index) => ({ kind: "context", ...clip(line), oldLine: deleted ? index + 1 : null, newLine: deleted ? null : index + 1 })) }];
        result.preview = true; result.truncated = true; result.reason = "too_large"; result.notes.push("preview_prefix"); if (longLines) result.notes.push("long_lines");
      };
      if (large) usePreview();
      else if (wholeFile) {
        const lines = newText.split("\n"); if (newText.endsWith("\n")) lines.pop(); if (!newText) lines.length = 0;
        if (lines.length + 1 > WORKSPACE_DIFF_MAX_LINES) { if (!preview) return metadata("too_large", "too_large"); usePreview(); }
        else {
          result.hunks = lines.length ? [{ header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line, index) => ({ kind: "add", ...clip(line), oldLine: null, newLine: index + 1 })) }] : [];
          result.additions = lines.length; result.deletions = 0;
        }
      } else {
        const patch = await checked(context.run, context.repo, [...diffArguments(), "--patch", "--unified=3", "--inter-hunk-context=0", context.head!, "--", entry.repoPath], op, WORKSPACE_DIFF_MAX_BYTES, true);
        const patchText = patch.stdout.toString("utf8");
        // An output cap may split the last physical line; never present that
        // partial row as complete or let it become an annotation reference.
        const parsed = parseWorkspacePatch(patch.limited ? patchText.slice(0, patchText.lastIndexOf("\n") + 1) : patchText);
        if (parsed.binary) { result.binary = true; return metadata("binary", "binary"); }
        if (patch.limited || parsed.limited) {
          if (!preview) return metadata("too_large", "too_large");
          let remaining = WORKSPACE_DIFF_PREVIEW_LINES;
          result.hunks = parsed.hunks.flatMap(hunk => {
            if (remaining <= 1) return [];
            const lines = hunk.lines.slice(0, --remaining); remaining -= lines.length;
            return [{ ...hunk, lines }];
          });
          result.preview = true; result.truncated = true; result.reason = "too_large"; result.notes.push("preview_patch");
        }
        else {
          result.hunks = parsed.hunks;
          result.additions = parsed.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === "add").length, 0);
          result.deletions = parsed.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.kind === "delete").length, 0);
          if (!result.hunks.length && /(?:^|\n)(?:old|new) mode /.test(patch.stdout.toString("utf8"))) result.notes.push("mode_only");
          else if (!result.hunks.length && item.staged && item.unstaged) result.notes.push("index_only");
        }
      }
      if (result.hunks.some(hunk => hunk.lines.some(line => line.clipped))) result.notes.push("long_lines");
      await recheck(identity);
      // Hold only bounded buffers through parsing; no cross-request content cache.
      current = Buffer.alloc(0); previous = Buffer.alloc(0);
      result.file.additions = result.additions; result.file.deletions = result.deletions; result.notes = unique(result.notes);
      return workspaceFileDiffSchema.parse(result);
    });
  }
}
function diffArguments(): string[] {
  return ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all", "--no-relative", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", `-O${process.platform === "win32" ? "NUL" : "/dev/null"}`];
}

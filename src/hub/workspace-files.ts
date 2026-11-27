import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isCredentialStylePath } from "../runtime/credential-files.js";
import {
  WORKSPACE_FILES_MAX_ENTRIES,
  WORKSPACE_FILES_MAX_IMAGE_BYTES,
  WORKSPACE_FILES_MAX_PDF_BYTES,
  WORKSPACE_FILES_MAX_TEXT_BYTES,
  workspaceFilePathSchema,
  workspacePreviewResponseSchema,
  workspaceRequiredPathSchema,
  workspaceTreeResponseSchema,
  type WorkspaceChangeBadge,
  type WorkspaceFileEntry,
  type WorkspacePreviewResponse,
  type WorkspaceTreeResponse,
} from "../client-protocol/workspace-files.js";
import { HubError } from "./store.js";
import type { HubWorkspaceDiff } from "./workspace-diff.js";

type Scope = { conversationId: string; botId: string };
type ChangedFile = { path: string; status: WorkspaceChangeBadge };
type FileIdentity = {
  file: string;
  parents: Array<{ file: string; stat: BigIntStats }>;
  leaf: BigIntStats;
};

const CONFIG_MAX_BYTES = 128 * 1024;
const MAX_SCAN_ENTRIES = 5_000;
const HEAVY_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", "dist", "build", "target", "__pycache__", ".venv", "venv"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sql": "sql",
  ".graphql": "graphql",
  ".dockerfile": "dockerfile",
  ".env": "dotenv",
  ".ini": "ini",
  ".txt": "text",
  ".log": "text",
  ".csv": "csv",
};

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function isNotFoundError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isAccessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function sameNode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return sameNode(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function isSingleLinkedRegularFile(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && !(process.platform === "win32" && stat.ino === 0n);
}

function safeInt(value: bigint): number {
  if (value <= 0n) return 0;
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function safeMtimeMs(stat: BigIntStats): number {
  return Math.max(0, Math.floor(Number(stat.mtimeMs)));
}

function detectLanguage(name: string): { language: string; markdown: boolean } {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return { language: "dockerfile", markdown: false };
  if (lower === "makefile") return { language: "makefile", markdown: false };
  if (lower.startsWith(".env")) return { language: "dotenv", markdown: false };
  const ext = path.extname(lower);
  const language = EXTENSION_LANGUAGE[ext] ?? "text";
  return { language, markdown: ext === ".md" || ext === ".markdown" || ext === ".mdx" };
}

function isSensitiveEntry(relPath: string, fullPath: string, targetFullPath?: string): boolean {
  if (isCredentialStylePath(relPath, fullPath, targetFullPath)) return true;
  for (const candidate of [relPath, targetFullPath ? targetFullPath.replace(/\\/g, "/") : undefined]) {
    if (!candidate) continue;
    const base = path.posix.basename(candidate).toLowerCase();
    if (base === ".env" || base.startsWith(".env.")) return true;
    if (base === ".npmrc" || base === ".pypirc" || base === ".netrc") return true;
  }
  return false;
}

function compareEntriesDisplay(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
  const aDir = a.kind === "dir" ? 0 : 1;
  const bDir = b.kind === "dir" ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function entryTruncationPriority(entry: WorkspaceFileEntry): number {
  if (entry.changed || entry.hasChangedChildren) return 0;
  if (entry.kind === "dir") return 1;
  return 2;
}

async function identifyCanonicalFile(root: string, resolved: string): Promise<FileIdentity> {
  if (!within(root, resolved)) throw new HubError("workspace_files_outside_root", 403);
  const rel = path.relative(root, resolved);
  if (!rel) throw new HubError("workspace_files_not_file", 400);
  const parents: FileIdentity["parents"] = [];
  let current = root;
  const parts = rel.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    let info: BigIntStats;
    try {
      info = await lstat(current, { bigint: true });
    } catch (error) {
      if (isNotFoundError(error)) throw new HubError("workspace_files_not_found", 404);
      if (isAccessError(error)) throw new HubError("workspace_files_unavailable", 409);
      throw error;
    }
    if (info.isSymbolicLink()) throw new HubError("workspace_files_outside_root", 403);
    if (!info.isDirectory() || (process.platform === "win32" && info.ino === 0n)) {
      throw new HubError("workspace_files_not_found", 404);
    }
    parents.push({ file: current, stat: info });
    if (index < parts.length - 1) {
      current = path.join(current, parts[index]!);
    }
  }
  let leaf: BigIntStats;
  try {
    leaf = await lstat(resolved, { bigint: true });
  } catch (error) {
    if (isNotFoundError(error)) throw new HubError("workspace_files_not_found", 404);
    if (isAccessError(error)) throw new HubError("workspace_files_unavailable", 409);
    throw error;
  }
  if (leaf.isSymbolicLink()) throw new HubError("workspace_files_outside_root", 403);
  if (!leaf.isFile()) throw new HubError("workspace_files_not_file", 400);
  if (!isSingleLinkedRegularFile(leaf)) throw new HubError("workspace_files_outside_root", 403);
  return { file: resolved, parents, leaf };
}

async function recheckFileIdentity(identity: FileIdentity): Promise<void> {
  for (const parent of identity.parents) {
    let current: BigIntStats;
    try {
      current = await lstat(parent.file, { bigint: true });
    } catch {
      throw new HubError("workspace_files_changed_during_read", 409);
    }
    if (!current.isDirectory() || current.isSymbolicLink() || !sameNode(parent.stat, current)) {
      throw new HubError("workspace_files_changed_during_read", 409);
    }
  }
  let current: BigIntStats;
  try {
    current = await lstat(identity.file, { bigint: true });
  } catch {
    throw new HubError("workspace_files_changed_during_read", 409);
  }
  if (current.isSymbolicLink() || !unchanged(identity.leaf, current)) {
    throw new HubError("workspace_files_changed_during_read", 409);
  }
}

async function readBoundedFile(
  identity: FileIdentity,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!isSingleLinkedRegularFile(identity.leaf)) {
    throw new HubError("workspace_files_outside_root", 403);
  }
  signal.throwIfAborted();
  await recheckFileIdentity(identity);
  let handle;
  try {
    handle = await open(identity.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ELOOP") throw new HubError("workspace_files_outside_root", 403);
    if (isNotFoundError(error)) throw new HubError("workspace_files_not_found", 404);
    if (code === "EISDIR" || code === "ENXIO") throw new HubError("workspace_files_not_file", 400);
    if (isAccessError(error)) throw new HubError("workspace_files_unavailable", 409);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!isSingleLinkedRegularFile(before) || !unchanged(identity.leaf, before)) {
      throw new HubError("workspace_files_changed_during_read", 409);
    }
    await recheckFileIdentity(identity);
    const toRead = Math.min(maxBytes, safeInt(before.size > BigInt(maxBytes) ? BigInt(maxBytes) : before.size));
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buf, offset, toRead - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!unchanged(before, after)) {
      throw new HubError("workspace_files_changed_during_read", 409);
    }
    await recheckFileIdentity(identity);
    signal.throwIfAborted();
    return { bytes: buf.subarray(0, offset), truncated: before.size > BigInt(maxBytes) };
  } finally {
    await handle.close();
  }
}

export class HubWorkspaceFiles {
  private readonly inFlightChanged = new Map<string, {
    promise: Promise<ChangedFile[]>;
    controller: AbortController;
    waiters: number;
    done: boolean;
  }>();

  constructor(
    private readonly stateDirectory: (botId: string, remainingMs: number) => Promise<string>,
    private readonly workspaceDiff?: Pick<HubWorkspaceDiff, "list">,
    /** A conversation's own folder (saved workspaces), the same lookup the diff viewer uses. */
    private readonly conversationWorkspace?: (conversationId: string) => Promise<string | undefined> | string | undefined,
  ) {}

  private async resolveWorkspaceRoot(scope: Scope, signal: AbortSignal): Promise<{ root: string; name: string }> {
    signal.throwIfAborted();
    const state = await this.stateDirectory(scope.botId, 8_000);
    signal.throwIfAborted();
    if (!path.isAbsolute(state)) throw new HubError("workspace_files_unavailable", 409);
    let canonicalState: string;
    try {
      canonicalState = await realpath(state);
    } catch {
      throw new HubError("workspace_files_unavailable", 409);
    }
    let config: Record<string, unknown> = {};
    const configPath = path.join(canonicalState, "config.json");
    try {
      const stat = await lstat(configPath, { bigint: true });
      if (isSingleLinkedRegularFile(stat) && stat.size <= BigInt(CONFIG_MAX_BYTES)) {
        const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Missing config falls back to <stateDir>/workspace below.
    }
    const resume = config.resume && typeof config.resume === "object" && !Array.isArray(config.resume)
      ? config.resume as Record<string, unknown>
      : {};
    const pinned = await this.conversationWorkspace?.(scope.conversationId);
    const configured = pinned ?? config.workspacePath ?? resume.workspacePath ?? path.join(canonicalState, "workspace");
    if (typeof configured !== "string" || !path.isAbsolute(configured)) {
      throw new HubError("workspace_files_unavailable", 409);
    }
    let root: string;
    try {
      root = await realpath(configured);
    } catch {
      throw new HubError("workspace_files_unavailable", 409);
    }
    let info: BigIntStats;
    try {
      info = await lstat(root, { bigint: true });
    } catch {
      throw new HubError("workspace_files_unavailable", 409);
    }
    if (root === path.parse(root).root || !info.isDirectory() || info.isSymbolicLink()) {
      throw new HubError("workspace_files_unavailable", 409);
    }
    return { root, name: path.basename(root) || "workspace" };
  }

  /**
   * Resolve a relative path component-by-component inside `root`, rejecting any
   * symlink or traversal that leaves the canonical workspace root.
   */
  private async resolveInsideRoot(root: string, relPath: string): Promise<{ resolved: string; isSymlink: boolean }> {
    const clean = workspaceFilePathSchema.parse(relPath);
    if (!clean) return { resolved: root, isSymlink: false };
    let current = root;
    const segments = clean.split("/");
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const next = path.join(current, segment);
      let stat: BigIntStats;
      try {
        stat = await lstat(next, { bigint: true });
      } catch (error) {
        if (isAccessError(error)) throw new HubError("workspace_files_unavailable", 409);
        throw new HubError("workspace_files_not_found", 404);
      }
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(next);
        } catch {
          throw new HubError("workspace_files_outside_root", 403);
        }
        if (!within(root, target)) {
          throw new HubError("workspace_files_outside_root", 403);
        }
        if (index === segments.length - 1) {
          return { resolved: target, isSymlink: true };
        }
        current = target;
      } else {
        if (!within(root, next)) throw new HubError("workspace_files_outside_root", 403);
        current = next;
      }
    }
    let finalReal: string;
    try {
      finalReal = await realpath(current);
    } catch (error) {
      if (isNotFoundError(error)) throw new HubError("workspace_files_not_found", 404);
      throw new HubError("workspace_files_outside_root", 403);
    }
    if (!within(root, finalReal)) throw new HubError("workspace_files_outside_root", 403);
    return { resolved: finalReal, isSymlink: false };
  }

  private async readChangedFiles(
    scope: Scope,
    root: string,
    signal: AbortSignal,
    authorize: () => Promise<void>,
  ): Promise<ChangedFile[]> {
    if (!this.workspaceDiff) return [];
    signal.throwIfAborted();
    const key = `${scope.conversationId}\0${scope.botId}\0${root}`;
    let flight = this.inFlightChanged.get(key);
    if (!flight) {
      const controller = new AbortController();
      const entry = {
        promise: Promise.resolve<ChangedFile[]>([]),
        controller,
        waiters: 0,
        done: false,
      };
      entry.promise = this.workspaceDiff.list(scope, controller.signal, authorize)
        .then(
          (changes) => changes.items.slice(0, 200).map((item) => ({ path: item.path, status: item.status })),
          () => [],
        )
        .finally(() => {
          entry.done = true;
          if (this.inFlightChanged.get(key) === entry) {
            this.inFlightChanged.delete(key);
          }
        });
      flight = entry;
      this.inFlightChanged.set(key, flight);
    }
    flight.waiters += 1;
    const active = flight;
    return await new Promise<ChangedFile[]>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        active.waiters -= 1;
        return true;
      };
      const onAbort = () => {
        if (!cleanup()) return;
        if (!active.done && active.waiters <= 0) {
          active.controller.abort(new HubError("request_aborted", 499));
        }
        reject(signal.reason ?? new HubError("request_aborted", 499));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      active.promise.then(
        (value) => {
          if (!cleanup()) return;
          resolve(value);
        },
        (error) => {
          if (!cleanup()) return;
          reject(error);
        },
      );
    });
  }

  private async buildDiskEntry(
    root: string,
    resolvedDir: string,
    cleanPath: string,
    entryName: string,
    changedMap: ReadonlyMap<string, WorkspaceChangeBadge>,
    changedDirs: ReadonlySet<string>,
  ): Promise<WorkspaceFileEntry | undefined> {
    if (!entryName || entryName === "." || entryName === ".." || entryName.includes("/") || entryName.includes("\\")) {
      return undefined;
    }
    const entryRel = cleanPath ? `${cleanPath}/${entryName}` : entryName;
    if (!workspaceRequiredPathSchema.safeParse(entryRel).success) return undefined;
    const entryFull = path.join(resolvedDir, entryName);
    let stat: BigIntStats;
    try {
      stat = await lstat(entryFull, { bigint: true });
    } catch {
      return undefined;
    }
    let kind: "dir" | "file" | "symlink";
    let resolvedTargetPath: string | undefined;
    if (stat.isSymbolicLink()) {
      // Only expose symlinks whose real target remains strictly inside the workspace root
      // and points to a directory or regular file (never FIFOs, sockets, or devices).
      try {
        const target = await realpath(entryFull);
        if (!within(root, target)) return undefined;
        const targetStat = await lstat(target, { bigint: true });
        if (targetStat.isDirectory()) {
          kind = "dir";
        } else if (targetStat.isFile()) {
          kind = "symlink";
        } else {
          return undefined;
        }
        resolvedTargetPath = target;
      } catch {
        return undefined;
      }
    } else if (stat.isDirectory()) {
      kind = "dir";
    } else if (stat.isFile()) {
      kind = "file";
    } else {
      return undefined;
    }
    const sensitive = isSensitiveEntry(entryRel, entryFull, resolvedTargetPath);
    const heavy = kind === "dir" && HEAVY_DIRS.has(entryName);
    const changed = changedMap.get(entryRel);
    const hasChangedChildren = kind === "dir" && changedDirs.has(entryRel);
    return {
      name: entryName,
      path: entryRel,
      kind,
      size: kind === "file" ? safeInt(stat.size) : null,
      mtimeMs: safeMtimeMs(stat),
      sensitive,
      heavy,
      ...(changed ? { changed } : {}),
      ...(hasChangedChildren ? { hasChangedChildren: true } : {}),
    };
  }

  async list(
    scope: Scope,
    relPath: string,
    signal: AbortSignal,
    authorize: () => Promise<void>,
    options?: { includeChanges?: boolean },
  ): Promise<WorkspaceTreeResponse> {
    await authorize();
    const cleanPath = workspaceFilePathSchema.parse(relPath);
    const { root, name } = await this.resolveWorkspaceRoot(scope, signal);
    const { resolved } = await this.resolveInsideRoot(root, cleanPath);
    let dirInfo: BigIntStats;
    try {
      dirInfo = await lstat(resolved, { bigint: true });
    } catch (error) {
      if (isNotFoundError(error)) throw new HubError("workspace_files_not_found", 404);
      if (isAccessError(error)) throw new HubError("workspace_files_unavailable", 409);
      throw error;
    }
    if (!dirInfo.isDirectory()) throw new HubError("workspace_files_not_directory", 400);

    const includeChanges = options?.includeChanges ?? true;
    const changedFiles = includeChanges ? await this.readChangedFiles(scope, root, signal, authorize) : [];
    const changedMap = new Map<string, WorkspaceChangeBadge>();
    const changedDirs = new Set<string>();
    for (const item of changedFiles) {
      changedMap.set(item.path, item.status);
      const parts = item.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        changedDirs.add(parts.slice(0, i).join("/"));
      }
    }

    const entries: WorkspaceFileEntry[] = [];
    const seenNames = new Set<string>();
    let scanTruncated = false;
    let handle;
    try {
      handle = await opendir(resolved);
    } catch (error) {
      if (isNotFoundError(error)) throw new HubError("workspace_files_not_found", 404);
      if (isAccessError(error)) throw new HubError("workspace_files_unavailable", 409);
      throw error;
    }
    try {
      for await (const dirent of handle) {
        signal.throwIfAborted();
        if (entries.length >= MAX_SCAN_ENTRIES) {
          scanTruncated = true;
          break;
        }
        const entry = await this.buildDiskEntry(root, resolved, cleanPath, dirent.name, changedMap, changedDirs);
        if (!entry) continue;
        seenNames.add(entry.name);
        entries.push(entry);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (isNotFoundError(error)) throw new HubError("workspace_files_not_found", 404);
      if (isAccessError(error)) throw new HubError("workspace_files_unavailable", 409);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }

    // If the scan hit MAX_SCAN_ENTRIES, still pick up any direct changed children that were skipped.
    if (scanTruncated && changedFiles.length > 0) {
      const prefix = cleanPath ? `${cleanPath}/` : "";
      for (const item of changedFiles) {
        if (prefix && !item.path.startsWith(prefix)) continue;
        const tail = prefix ? item.path.slice(prefix.length) : item.path;
        const slash = tail.indexOf("/");
        const childName = slash < 0 ? tail : tail.slice(0, slash);
        if (!childName || seenNames.has(childName)) continue;
        const entry = await this.buildDiskEntry(root, resolved, cleanPath, childName, changedMap, changedDirs);
        if (entry) {
          seenNames.add(entry.name);
          entries.push(entry);
        }
      }
    }

    // Synthesize read-only rows for deleted Git-tracked entries (and deleted-only parent dirs)
    // so changed counts, ancestor dots, and the "Changed" filter stay consistent with the tree.
    if (includeChanges && changedFiles.length > 0) {
      const prefix = cleanPath ? `${cleanPath}/` : "";
      for (const item of changedFiles) {
        if (item.status !== "deleted") continue;
        if (prefix && !item.path.startsWith(prefix)) continue;
        const tail = prefix ? item.path.slice(prefix.length) : item.path;
        if (!tail) continue;
        const slash = tail.indexOf("/");
        if (slash < 0) {
          if (seenNames.has(tail)) continue;
          if (!workspaceRequiredPathSchema.safeParse(item.path).success) continue;
          seenNames.add(tail);
          entries.push({
            name: tail,
            path: item.path,
            kind: "file",
            size: null,
            mtimeMs: null,
            sensitive: isSensitiveEntry(item.path, path.join(root, item.path)),
            heavy: false,
            changed: "deleted",
          });
        } else {
          const dirName = tail.slice(0, slash);
          const dirRel = cleanPath ? `${cleanPath}/${dirName}` : dirName;
          if (seenNames.has(dirName)) continue;
          if (!workspaceRequiredPathSchema.safeParse(dirRel).success) continue;
          seenNames.add(dirName);
          entries.push({
            name: dirName,
            path: dirRel,
            kind: "dir",
            size: null,
            mtimeMs: null,
            sensitive: false,
            heavy: HEAVY_DIRS.has(dirName),
            hasChangedChildren: true,
          });
        }
      }
    }

    let truncated = scanTruncated;
    if (entries.length > WORKSPACE_FILES_MAX_ENTRIES) {
      truncated = true;
      entries.sort((a, b) => entryTruncationPriority(a) - entryTruncationPriority(b) || compareEntriesDisplay(a, b));
      entries.splice(WORKSPACE_FILES_MAX_ENTRIES);
    }
    entries.sort(compareEntriesDisplay);

    const fingerprint = createHash("sha1")
      .update(`${name}\0${truncated ? 1 : 0}\n`)
      .update(entries.map((entry) => `${entry.path}:${entry.kind}:${entry.size ?? ""}:${entry.mtimeMs ?? ""}:${entry.sensitive ? 1 : 0}:${entry.changed ?? ""}:${entry.hasChangedChildren ? 1 : 0}`).join("\n"))
      .update("\0")
      .update(changedFiles.map((item) => `${item.path}:${item.status}`).join("\n"))
      .digest("hex")
      .slice(0, 20);

    await authorize();
    return workspaceTreeResponseSchema.parse({
      workspaceName: name,
      path: cleanPath,
      entries,
      truncated,
      changedFiles,
      fingerprint,
    });
  }

  async preview(
    scope: Scope,
    relPath: string,
    revealSensitive: boolean,
    signal: AbortSignal,
    authorize: () => Promise<void>,
  ): Promise<WorkspacePreviewResponse> {
    await authorize();
    const cleanPath = workspaceRequiredPathSchema.parse(relPath);
    const { root } = await this.resolveWorkspaceRoot(scope, signal);
    const { resolved } = await this.resolveInsideRoot(root, cleanPath);
    const identity = await identifyCanonicalFile(root, resolved);

    const name = path.posix.basename(cleanPath);
    const size = safeInt(identity.leaf.size);
    const mtimeMs = safeMtimeMs(identity.leaf);
    const sensitive = isSensitiveEntry(cleanPath, path.join(root, cleanPath), resolved);

    if (sensitive && !revealSensitive) {
      return workspacePreviewResponseSchema.parse({ kind: "sensitive", path: cleanPath, name, size, mtimeMs });
    }

    const ext = path.extname(name).toLowerCase();
    const imageMime = IMAGE_MIME[ext];
    if (imageMime) {
      if (identity.leaf.size > BigInt(WORKSPACE_FILES_MAX_IMAGE_BYTES)) {
        return workspacePreviewResponseSchema.parse({ kind: "too_large", path: cleanPath, name, size, mtimeMs });
      }
      const { bytes } = await readBoundedFile(identity, WORKSPACE_FILES_MAX_IMAGE_BYTES, signal);
      await authorize();
      if (bytes.length === 0) {
        return workspacePreviewResponseSchema.parse({ kind: "binary", path: cleanPath, name, size, mtimeMs });
      }
      return workspacePreviewResponseSchema.parse({
        kind: "image",
        path: cleanPath,
        name,
        size,
        mtimeMs,
        mime: imageMime,
        dataUrl: `data:${imageMime};base64,${bytes.toString("base64")}`,
      });
    }

    if (ext === ".pdf") {
      if (identity.leaf.size > BigInt(WORKSPACE_FILES_MAX_PDF_BYTES)) {
        return workspacePreviewResponseSchema.parse({ kind: "too_large", path: cleanPath, name, size, mtimeMs });
      }
      const { bytes } = await readBoundedFile(identity, WORKSPACE_FILES_MAX_PDF_BYTES, signal);
      await authorize();
      if (bytes.length === 0) {
        return workspacePreviewResponseSchema.parse({ kind: "binary", path: cleanPath, name, size, mtimeMs });
      }
      return workspacePreviewResponseSchema.parse({
        kind: "pdf",
        path: cleanPath,
        name,
        size,
        mtimeMs,
        mime: "application/pdf",
        base64: bytes.toString("base64"),
      });
    }

    const { bytes, truncated } = await readBoundedFile(identity, WORKSPACE_FILES_MAX_TEXT_BYTES, signal);
    if (bytes.includes(0)) {
      return workspacePreviewResponseSchema.parse({ kind: "binary", path: cleanPath, name, size, mtimeMs });
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    } catch {
      return workspacePreviewResponseSchema.parse({ kind: "binary", path: cleanPath, name, size, mtimeMs });
    }
    const { language, markdown } = detectLanguage(name);
    const lines = content ? content.split("\n").length : 0;
    await authorize();
    return workspacePreviewResponseSchema.parse({
      kind: "text",
      path: cleanPath,
      name,
      size,
      mtimeMs,
      language,
      markdown,
      sensitive,
      content,
      lines,
      truncated,
    });
  }
}

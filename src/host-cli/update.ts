import { isHubLogFile } from "../hub/log-rotation.js";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat as targetMetadata, statfs, symlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { HubDatabase } from "../hub/database.js";
import { inspectHubService } from "../hub/service.js";
import { acquireInstanceLock, type InstanceLockHandle } from "../state/instance-lock.js";
import { withFileMutex as withStateFileMutex } from "../state/file-mutex.js";
const withFileMutex = <T>(file: string, operation: () => Promise<T>) => withStateFileMutex(file, operation, { waitTimeoutMs: 45_000 });

/** Packages declare the schemas they can OPEN, including the schema they write.
 * A package version is not evidence that an old executable can open new data. */
export const hostUpdateCompatibilitySchema = z.object({
  format: z.literal(1), minHubSchema: z.number().int().positive(), maxHubSchema: z.number().int().positive(),
}).strict().refine(value => value.minHubSchema <= value.maxHubSchema);
const packageSchema = z.object({ name: z.literal("tarobot"), private: z.literal(true), type: z.literal("module"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  engines: z.object({ node: z.string() }), dependencies: z.record(z.string(), z.string()),
  tarobotHostUpdate: hostUpdateCompatibilitySchema,
});
const relativeSchema = z.string().min(1).max(4096).refine(value => !path.isAbsolute(value) && value.split("/").every(part =>
  part && part !== "." && part !== ".." && !/[\\:\x00-\x1f]/.test(part) && !/[. ]$/.test(part)));
const idSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-[a-f0-9]{16}$/);
const fileEntrySchema = z.object({ type: z.literal("file"), path: relativeSchema, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean() }).strict();
const entrySchema = z.discriminatedUnion("type", [
  fileEntrySchema,
  z.object({ type: z.literal("link"), path: relativeSchema, target: z.string().min(1).max(4096) }).strict(),
]);
type FileEntry = z.infer<typeof entrySchema>;
const revisionSchema = z.object({
  format: z.literal(1), id: idSchema, version: packageSchema.shape.version, createdAt: z.string().datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/), minHubSchema: z.number().int().positive(), maxHubSchema: z.number().int().positive(),
  entries: z.array(entrySchema).max(100_000), node: fileEntrySchema, platform: z.string(), arch: z.string(),
}).strict();
type StoredRevision = z.infer<typeof revisionSchema>;
export type HostRuntimeRevision = Omit<StoredRevision, "format" | "entries" | "node"> & { entrypoint: string; executable: string };
export type HostRuntimeListing = HostRuntimeRevision | { id: string; corrupt: true; error: string };
const runtimeSelectionSchema = z.object({
  entrypoint: z.string().refine(path.isAbsolute), executable: z.string().refine(path.isAbsolute), revisionId: idSchema.optional(), version: z.string().optional(),
  minHubSchema: z.number().int().positive().optional(), maxHubSchema: z.number().int().positive().optional(),
  runtimeId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type HostRuntimeSelection = z.infer<typeof runtimeSelectionSchema>;
const selectionSchema = z.object({ format: z.literal(1), transactionId: z.string().uuid(), current: runtimeSelectionSchema, previous: runtimeSelectionSchema }).strict();
const receiptSchema = z.object({
  format: z.literal(1), id: z.string().uuid(), operation: z.enum(["activate", "rollback"]),
  state: z.enum(["prepared", "selected", "healthy"]), createdAt: z.string().datetime(),
  before: runtimeSelectionSchema, after: runtimeSelectionSchema,
  beforeError: z.string().optional(),
  hubSchema: z.number().int().nonnegative(), backupPath: z.string().refine(path.isAbsolute).nullable(),
}).strict();
export type HostUpdateReceipt = z.infer<typeof receiptSchema>;
export type HostUpdateOptions = { currentEntrypoint: string; assertStopped?: () => Promise<void> };

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;
const MAX_ENTRIES = 100_000;
function inside(parent: string, child: string): boolean { const rel = path.relative(parent, child); return rel === "" || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
async function exists(file: string): Promise<boolean> { return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }); }
async function canonical(file: string): Promise<string> {
  try { return await realpath(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(file) === file) throw error;
    return path.join(await canonical(path.dirname(file)), path.basename(file));
  }
}
/** Kept outside host state: full-state backups must not recursively copy runtimes. */
export async function hostRuntimeDirectory(directory: string): Promise<string> { return `${await canonical(path.resolve(directory))}.runtime`; }
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("host_update_directory_not_regular");
  await chmod(directory, 0o700);
}
async function json(file: string): Promise<unknown> {
  await regular(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error("host_update_invalid_metadata");
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
    if (count !== stat.size) throw new Error("host_update_file_changed");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { await handle.close(); }
}
async function atomicJson(file: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(contents) > MAX_JSON_BYTES) throw new Error("host_update_metadata_size_limit");
  const temporary = `${file}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
}
async function selection(directory: string): Promise<z.infer<typeof selectionSchema> | undefined> {
  const file = path.join(await hostRuntimeDirectory(directory), "current.json");
  return await exists(file) ? selectionSchema.parse(await json(file)) : undefined;
}
function compiledSource(input: string): string {
  relativeSchema.parse(input);
  if (!input.endsWith(".ts") || !/^(src|deepseek-harness-plugin\/src)\//.test(input)) throw new Error("host_update_invalid_graph");
  return `dist/${input.replace(/\.ts$/, ".js")}`;
}
async function regular(file: string): Promise<void> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("host_update_missing_file");
    throw error;
  });
  if (!info.isFile()) throw new Error("host_update_regular_file_required");
}
async function packageMetadata(directory: string): Promise<z.infer<typeof packageSchema>> {
  return packageSchema.parse(await json(path.join(directory, "package.json")));
}
function assertStageNodeCompatible(constraint: string): void {
  const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(constraint);
  if (!minimum) throw new Error("host_update_unsupported_node_constraint");
  const current = process.versions.node.split(".").map(Number), required = minimum.slice(1).map(Number);
  for (let i = 0; i < 3; i++) { if (current[i]! < required[i]!) throw new Error(`host_update_node_too_old: ${constraint}`); if (current[i]! > required[i]!) break; }
}
async function validatePackage(directory: string): Promise<z.infer<typeof packageSchema>> {
  const manifest = await packageMetadata(directory);
  // This executable is the one stage freezes. Subsequent reads use the frozen
  // pair, whose compatibility was probed here, never the inspecting CLI's Node.
  assertStageNodeCompatible(manifest.engines.node);
  const graph = z.object({ inputs: z.record(z.string(), z.unknown()) }).parse(await json(path.join(directory, "standalone-graph.json")));
  if (!Object.hasOwn(graph.inputs, "src/index.ts") || Object.keys(graph.inputs).length > MAX_ENTRIES) throw new Error("host_update_invalid_graph");
  for (const source of Object.keys(graph.inputs)) await regular(path.join(directory, compiledSource(source)));
  for (const file of ["dist/relay-runtime.mjs", "client/dist/index.html", "npm-shrinkwrap.json"]) await regular(path.join(directory, file));
  for (const name of Object.keys(manifest.dependencies)) {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error("host_update_invalid_dependency");
    await regular(path.join(directory, "node_modules", name, "package.json"));
  }
  return manifest;
}
async function copyFile(source: string, target: string, member: string): Promise<z.infer<typeof fileEntrySchema>> {
  await regular(source); const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await input.stat(); if (!before.isFile()) throw new Error("host_update_regular_file_required");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const executable = !!(before.mode & 0o100), output = await open(target, "wx", executable ? 0o700 : 0o600);
    const hash = createHash("sha256"); let count = 0;
    try {
      const bytes = Buffer.alloc(256 * 1024);
      for (;;) { const { bytesRead } = await input.read(bytes, 0, bytes.length, null); if (!bytesRead) break;
        count += bytesRead; if (count > before.size) throw new Error("host_update_file_changed");
        hash.update(bytes.subarray(0, bytesRead)); await output.writeFile(bytes.subarray(0, bytesRead)); }
      const after = await input.stat();
      if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("host_update_file_changed");
      await output.sync(); return { type: "file", path: member, size: count, sha256: hash.digest("hex"), executable };
    } finally { await output.close(); }
  } finally { await input.close(); }
}
async function hashFile(file: string, member: string): Promise<z.infer<typeof fileEntrySchema>> {
  await regular(file); const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat(), hash = createHash("sha256"), bytes = Buffer.alloc(256 * 1024); let count = 0;
    for (;;) { const { bytesRead } = await handle.read(bytes, 0, bytes.length, null); if (!bytesRead) break; count += bytesRead; if (count > stat.size) throw new Error("host_update_file_changed"); hash.update(bytes.subarray(0, bytesRead)); }
    const after = await handle.stat(); if (count !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("host_update_file_changed");
    return { type: "file", path: member, size: count, sha256: hash.digest("hex"), executable: !!(stat.mode & 0o100) };
  } finally { await handle.close(); }
}
async function inventory(source: string, destination?: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = []; let total = 0;
  async function walk(member: string): Promise<void> {
    const name = path.posix.basename(member);
    if (name === ".git" || name === ".npmrc" || name === ".env" || name.startsWith(".env.") && !name.endsWith(".example")) return;
    relativeSchema.parse(member); const file = path.join(source, member), stat = await lstat(file);
    if (stat.isDirectory()) {
      if (destination) await mkdir(path.join(destination, member), { recursive: true, mode: 0o700 });
      for (const name of (await readdir(file)).sort()) await walk(`${member}/${name}`);
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = await readlink(file);
      if (path.isAbsolute(target) || !inside(source, await realpath(file))) throw new Error("host_update_external_symlink");
      if (destination) { await mkdir(path.dirname(path.join(destination, member)), { recursive: true, mode: 0o700 }); await symlink(target, path.join(destination, member)); }
      entries.push({ type: "link", path: member, target });
    } else if (stat.isFile()) {
      total += stat.size; if (total > MAX_PACKAGE_BYTES) throw new Error("host_update_package_size_limit");
      if (destination) entries.push(await copyFile(file, path.join(destination, member), member));
      else entries.push(await hashFile(file, member));
    } else throw new Error("host_update_unsupported_file");
    if (entries.length > MAX_ENTRIES) throw new Error("host_update_entry_limit");
  }
  // Only runtime members are copied; never copy .env, a repository worktree,
  // another embedded release, or the developer's local credentials.
  for (const member of ["package.json", "npm-shrinkwrap.json", "standalone-graph.json", "dist/src", "dist/relay-runtime.mjs", "client/dist", "node_modules", "dist/deepseek-harness-plugin", "integrations", "scripts", "docs", "bin"]) {
    if (await exists(path.join(source, member))) await walk(member);
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function digest(entries: FileEntry[]): string { return createHash("sha256").update(JSON.stringify(entries)).digest("hex"); }
function runtimeDigest(entries: FileEntry[], node: z.infer<typeof fileEntrySchema>, platform: string, arch: string): string { return createHash("sha256").update(JSON.stringify({ entries, node, platform, arch })).digest("hex"); }

/** A copied Homebrew/system node can still load mutable libnode/ICU/OpenSSL.
 * Inspect the file, never invoke ldd or execute an unselected binary here. */
export async function inspectFrozenNodeDependencies(executable: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  let libraries: string[];
  if (platform === "darwin") {
    const unverified = () => new Error("host_update_node_libraries_unverified: macOS 无法运行 /usr/bin/otool 验证 Node 动态库。请确认已安装且已选择 Xcode Command Line Tools（xcode-select -p；需要时运行 xcode-select --install），修复后重试；运行时未通过验证，不能冻结。");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("/usr/bin/otool", ["-L", executable], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", overflow = false;
      child.stdout.on("data", data => { output += data.toString(); if (output.length > 128 * 1024) { overflow = true; child.kill(); } });
      child.stderr.resume(); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("error", () => { clearTimeout(timer); reject(unverified()); });
      child.once("close", code => { clearTimeout(timer); code === 0 && !overflow ? resolve(output) : reject(unverified()); });
    });
    libraries = output.split("\n").filter(line => /^\s+\S/.test(line)).map(line => line.trim().replace(/ \(compatibility version .*$/, ""));
    if (!libraries.length) throw new Error("host_update_node_libraries_unverified");
  } else {
    const info = await lstat(executable); if (!info.isFile() || info.size > 512 * 1024 ** 2) throw new Error("host_update_node_libraries_unverified");
    const bytes = await readFile(executable);
    libraries = platform === "linux" ? elfLibraries(bytes) : platform === "win32" ? peLibraries(bytes) : (() => { throw new Error("host_update_unsupported_runtime_platform"); })();
  }
  assertFrozenNodeLibraries(libraries, platform);
}
export function assertFrozenNodeLibraries(libraries: string[], platform: NodeJS.Platform): void {
  const windowsSystem = new Set(["kernel32", "kernelbase", "ntdll", "advapi32", "user32", "ws2_32", "dbghelp", "ole32", "shell32", "iphlpapi", "psapi", "userenv", "version", "winmm", "crypt32", "bcrypt", "ncrypt", "wintrust", "rpcrt4", "shlwapi", "winhttp", "secur32", "msvcrt", "ucrtbase"].map(value => `${value}.dll`));
  for (const library of libraries) {
    const allowed = platform === "darwin" ? path.posix.normalize(library) === library && (library.startsWith("/usr/lib/") || library.startsWith("/System/Library/"))
      : platform === "linux" ? /^(?:lib(?:c|m|stdc\+\+|gcc_s|pthread|dl|rt|resolv)\.so(?:\.[0-9]+)*|ld-linux[-a-zA-Z0-9_.]*\.so(?:\.[0-9]+)*|libc\.musl-[a-zA-Z0-9_-]+\.so\.1)$/.test(library)
      : platform === "win32" && (windowsSystem.has(library.toLowerCase()) || /^(?:api-ms-win|ext-ms-win)-[a-z0-9-]+\.dll$/i.test(library));
    if (!allowed) throw new Error(`host_update_node_external_library: ${library}. 请使用 App 自带 Node 或 nodejs.org 官方构建；不能冻结依赖 Homebrew、libnode 或其他外部库的 Node。`);
  }
}
function elfLibraries(bytes: Buffer): string[] {
  if (bytes.subarray(0, 4).toString("hex") !== "7f454c46" || ![1, 2].includes(bytes[4]!) || ![1, 2].includes(bytes[5]!)) throw new Error("host_update_invalid_node_elf");
  const wide = bytes[4] === 2, little = bytes[5] === 1;
  const uint = (offset: number, size: 2 | 4 | 8): number => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error("host_update_invalid_node_elf");
    const result = size === 8 ? Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)) : size === 4 ? little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset) : little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
    if (!Number.isSafeInteger(result)) throw new Error("host_update_invalid_node_elf"); return result;
  };
  const offset = uint(wide ? 32 : 28, wide ? 8 : 4), size = uint(wide ? 54 : 42, 2), count = uint(wide ? 56 : 44, 2);
  if (size < (wide ? 56 : 32) || count > 4096) throw new Error("host_update_invalid_node_elf");
  const headers = Array.from({ length: count }, (_, index) => { const start = offset + index * size; return { type: uint(start, 4), offset: uint(start + (wide ? 8 : 4), wide ? 8 : 4), address: uint(start + (wide ? 16 : 8), wide ? 8 : 4), size: uint(start + (wide ? 32 : 16), wide ? 8 : 4) }; });
  const readString = (at: number) => { const end = bytes.indexOf(0, at); if (at < 0 || end < at || end - at > 4096) throw new Error("host_update_invalid_node_elf"); return bytes.toString("utf8", at, end); };
  const needed: number[] = []; let strings: number | undefined;
  for (const segment of headers) {
    if (segment.type === 3 && !/^\/lib(?:64)?\/(?:[a-zA-Z0-9_-]+\/)?ld-(?:linux|musl)[a-zA-Z0-9_.-]+$/.test(readString(segment.offset))) throw new Error("host_update_node_external_interpreter");
    if (segment.type !== 2) continue;
    if (segment.size > 1024 * 1024 || segment.offset + segment.size > bytes.length) throw new Error("host_update_invalid_node_elf");
    for (let at = segment.offset; at < segment.offset + segment.size; at += wide ? 16 : 8) {
      const tag = uint(at, wide ? 8 : 4), value = uint(at + (wide ? 8 : 4), wide ? 8 : 4);
      if (tag === 0) break; if (tag === 1) needed.push(value);
      if (tag === 5) strings = value;
      if (tag === 15 || tag === 29 || tag === 0x7fffffff || tag === 0x7ffffffd || tag === 0x6ffffefc || tag === 0x6ffffefb) throw new Error("host_update_node_external_loader_path");
    }
  }
  if (!needed.length) return [];
  const segment = headers.find(value => value.type === 1 && strings !== undefined && strings >= value.address && strings < value.address + value.size);
  if (!segment || strings === undefined) throw new Error("host_update_invalid_node_elf");
  return needed.map(value => readString(segment.offset + strings! - segment.address + value));
}
function peLibraries(bytes: Buffer): string[] {
  const uint = (offset: number, size: 2 | 4 = 4): number => { if (offset < 0 || offset + size > bytes.length) throw new Error("host_update_invalid_node_pe"); return size === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset); };
  if (uint(0, 2) !== 0x5a4d) throw new Error("host_update_invalid_node_pe");
  const header = uint(0x3c); if (uint(header) !== 0x4550) throw new Error("host_update_invalid_node_pe");
  const sectionCount = uint(header + 6, 2), optional = header + 24, optionalSize = uint(header + 20, 2), magic = uint(optional, 2);
  if (![0x10b, 0x20b].includes(magic) || sectionCount > 4096) throw new Error("host_update_invalid_node_pe");
  const table = optional + (magic === 0x20b ? 112 : 96), tableCount = uint(table - 4), sections = Array.from({ length: sectionCount }, (_, index) => { const at = optional + optionalSize + index * 40; return { address: uint(at + 12), size: uint(at + 16), offset: uint(at + 20) }; });
  const fileOffset = (address: number): number => { const section = sections.find(value => address >= value.address && address < value.address + value.size); if (!section) throw new Error("host_update_invalid_node_pe"); return section.offset + address - section.address; };
  const imports: string[] = [];
  for (const [index, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]] as const) {
    if (index >= tableCount) continue; const address = uint(table + index * 8), length = uint(table + index * 8 + 4); if (!address) continue;
    if (length > 1024 * 1024) throw new Error("host_update_invalid_node_pe");
    const start = fileOffset(address);
    for (let offset = 0; offset + stride <= length; offset += stride) {
      const at = start + offset, nameAddress = uint(at + nameOffset); if (!nameAddress) break;
      if (index === 13 && uint(at) !== 1) throw new Error("host_update_invalid_node_pe");
      const name = fileOffset(nameAddress), end = bytes.indexOf(0, name); if (end < name || end - name > 512) throw new Error("host_update_invalid_node_pe");
      imports.push(bytes.toString("ascii", name, end));
    }
  }
  if (!imports.length) throw new Error("host_update_invalid_node_pe"); return imports;
}
async function probePackage(directory: string, executable: string): Promise<void> {
  // Explicit local package selection authorizes executing that candidate. No
  // network fetch, package-manager install, lifecycle script or shell is used.
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  for (const key of Object.keys(env)) if (/^(CODEX_TELEGRAM_|TAROCUB_|TAROBOT_|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$)/.test(key)) delete env[key];
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, overflow = false; const collect = (data: Buffer) => { bytes += data.length; if (bytes > 1024 * 1024) { overflow = true; child.kill(); } };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 && !overflow ? resolve() : reject(new Error("host_update_runtime_probe_failed")); });
  });
  await run([path.join(directory, "dist/src/index.js"), "--help"]);
  await run(["--input-type=module", "-e", "import sqlite from 'sqlite3'; import { z } from 'zod'; z.string().parse('ok'); await new Promise((resolve,reject)=>{const db=new sqlite.Database(':memory:',error=>{if(error)reject(error);else db.close(error=>error?reject(error):resolve());});});"]);
}
async function readRevision(directory: string, id: string, verify = false): Promise<HostRuntimeRevision> {
  idSchema.parse(id); const root = await hostRuntimeDirectory(directory), location = path.join(root, "versions", id);
  for (const folder of [root, path.join(root, "versions")]) if (!(await lstat(folder)).isDirectory()) throw new Error("host_update_revision_not_regular");
  if (!(await lstat(location)).isDirectory()) throw new Error("host_update_revision_not_regular");
  const record = revisionSchema.parse(await json(path.join(location, "revision.json")));
  if (record.id !== id || record.id !== `${record.version}-${record.digest.slice(0, 16)}` || runtimeDigest(record.entries, record.node, record.platform, record.arch) !== record.digest) throw new Error("host_update_invalid_revision");
  let matchingArchitecture = record.arch === process.arch;
  // An x64 CLI under Rosetta may inspect an already validated/frozen native
  // ARM host. Check the hardware, not the inspecting process architecture;
  // Intel Macs and other foreign-architecture combinations still fail closed.
  if (!matchingArchitecture && record.platform === "darwin" && process.platform === "darwin" && process.arch === "x64" && record.arch === "arm64") {
    try { matchingArchitecture = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() === "1"; } catch { /* Keep the platform rejection on an unavailable hardware check. */ }
  }
  if (record.platform !== process.platform || !matchingArchitecture || record.node.path !== (record.platform === "win32" ? "node.exe" : "node")) throw new Error("host_update_wrong_platform");
  const runtime = path.join(location, "package");
  if (!(await lstat(runtime)).isDirectory()) throw new Error("host_update_revision_not_regular");
  const manifest = await packageMetadata(runtime);
  if (record.version !== manifest.version || record.minHubSchema !== manifest.tarobotHostUpdate.minHubSchema || record.maxHubSchema !== manifest.tarobotHostUpdate.maxHubSchema) throw new Error("host_update_invalid_revision");
  const executable = path.join(location, record.node.path); await regular(executable);
  if (!verify) {
    // The complete tree is checked at stage/apply/doctor; every launch checks
    // code entry, native modules and frozen executable without rehashing assets.
    if (JSON.stringify(await hashFile(executable, record.node.path)) !== JSON.stringify(record.node)) throw new Error("host_update_revision_changed");
    for (const entry of record.entries) if (entry.type === "file" && (entry.path === "dist/src/index.js" || entry.path.endsWith(".node") || entry.path === "bin/tarobot-host-launcher.exe")) {
      if (JSON.stringify(await hashFile(path.join(runtime, entry.path), entry.path)) !== JSON.stringify(entry)) throw new Error("host_update_revision_changed");
    }
  }
  if (verify && runtimeDigest(await inventory(runtime), await hashFile(executable, record.node.path), record.platform, record.arch) !== record.digest) throw new Error("host_update_revision_changed");
  const { entries: _entries, format: _format, node: _node, ...metadata } = record;
  return { ...metadata, entrypoint: path.join(runtime, "dist/src/index.js"), executable };
}
export async function stageHostUpdate(directory: string, from: string): Promise<HostRuntimeRevision> {
  directory = await canonical(path.resolve(directory)); const source = await realpath(from), root = await hostRuntimeDirectory(directory);
  if (inside(directory, source) || inside(root, source) || inside(source, directory) || inside(source, root)) throw new Error("host_update_source_overlaps_state");
  await validatePackage(source); await privateDirectory(root); await privateDirectory(path.join(root, "versions"));
  return withFileMutex(path.join(root, "update"), async () => {
    // Only stage owns these names and it holds this lock for its entire life.
    // A previous process may have died before finally; never follow links.
    const versions = path.join(root, "versions");
    for (const name of await readdir(versions)) if (/^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) {
      const abandoned = path.join(versions, name);
      if ((await lstat(abandoned)).isDirectory()) await rm(abandoned, { recursive: true, force: true });
    }
    const temporary = path.join(root, "versions", `.stage-${randomUUID()}`), runtime = path.join(temporary, "package");
    await privateDirectory(runtime);
    try {
      const entries = await inventory(source, runtime), manifest = await validatePackage(runtime);
      const nodeName = process.platform === "win32" ? "node.exe" : "node", executable = path.join(temporary, nodeName);
      const node = await copyFile(await realpath(process.execPath), executable, nodeName);
      await inspectFrozenNodeDependencies(executable);
      await probePackage(runtime, executable);
      // A probe must not mutate its installation; inventory also detects changes
      // made to the source during staging that crossed individual file copies.
      if (digest(await inventory(runtime)) !== digest(entries) || digest(await inventory(source)) !== digest(entries) || JSON.stringify(await hashFile(executable, nodeName)) !== JSON.stringify(node)) throw new Error("host_update_file_changed");
      const checksum = runtimeDigest(entries, node, process.platform, process.arch), id = `${manifest.version}-${checksum.slice(0, 16)}`;
      const record: StoredRevision = { format: 1, id, version: manifest.version, createdAt: new Date().toISOString(), digest: checksum,
        minHubSchema: manifest.tarobotHostUpdate.minHubSchema, maxHubSchema: manifest.tarobotHostUpdate.maxHubSchema, entries, node, platform: process.platform, arch: process.arch };
      const target = path.join(root, "versions", id);
      if (await exists(target)) return await readRevision(directory, id, true);
      await atomicJson(path.join(temporary, "revision.json"), record); await rename(temporary, target);
      return await readRevision(directory, id);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}
export async function listHostUpdates(directory: string): Promise<HostRuntimeListing[]> {
  const versions = path.join(await hostRuntimeDirectory(directory), "versions"); if (!await exists(versions)) return [];
  const result: HostRuntimeListing[] = [];
  for (const name of await readdir(versions)) if (idSchema.safeParse(name).success) {
    try { result.push(await readRevision(directory, name)); }
    catch (error) { result.push({ id: name, corrupt: true, error: errorText(error) }); }
  }
  return result.sort((a, b) => ("createdAt" in b ? b.createdAt : "").localeCompare("createdAt" in a ? a.createdAt : ""));
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
export async function resolveHostRuntime(directory: string, fallbackEntrypoint: string): Promise<HostRuntimeSelection> {
  const selected = await selection(directory);
  if (!selected) return { entrypoint: path.resolve(fallbackEntrypoint), executable: process.execPath };
  if (selected.current.revisionId) {
    const revision = await readRevision(directory, selected.current.revisionId);
    if (revision.entrypoint !== selected.current.entrypoint || revision.executable !== selected.current.executable || revision.version !== selected.current.version || revision.minHubSchema !== selected.current.minHubSchema || revision.maxHubSchema !== selected.current.maxHubSchema || revision.digest !== selected.current.runtimeId) throw new Error("host_update_invalid_selection");
  }
  await regular(selected.current.entrypoint); await regular(selected.current.executable); return selected.current;
}
/** Report the actual running pair, never the version merely selected for next
 * boot. An unselected App/repo executable cannot claim a frozen tree identity. */
export async function identifyHostRuntime(directory: string, entrypoint: string, executable = process.execPath): Promise<string | undefined> {
  const selected = await resolveHostRuntime(directory, entrypoint);
  if (!selected.runtimeId || await realpath(selected.entrypoint) !== await realpath(entrypoint) || await realpath(selected.executable) !== await realpath(executable)) return undefined;
  return selected.runtimeId;
}
async function withStoppedHost<T>(directory: string, options: HostUpdateOptions, task: () => Promise<T>): Promise<T> {
  // Serialize against supervisor start/install/refresh: a closed Hub socket
  // alone does not mean launchd/systemd/Task Scheduler will not restart it.
  return withFileMutex(path.join(directory, "host-service.json"), async () => {
    const manifestFile = path.join(directory, "host-service.json");
    if (await exists(manifestFile)) {
      const manifest = z.object({ enabled: z.boolean() }).parse(await json(manifestFile));
      if (manifest.enabled) throw new Error("host_update_requires_disabled_supervisor");
      const status = await (await import("./service-manager.js")).managedServiceStatus(directory);
      if (!status.configured || status.enabled || status.osEnabled || status.running || status.supervisorRunning || status.error) throw new Error("host_update_requires_stopped_supervisor");
    }
    await options.assertStopped?.();
    if ((await inspectHubService(directory)).running) throw new Error("host_update_requires_stopped_host");
    const locks: InstanceLockHandle[] = [];
    try {
      locks.push(await acquireInstanceLock(directory));
      const bots = path.join(directory, "bots");
      if (await exists(bots)) for (const name of (await readdir(bots)).sort()) {
        const bot = path.join(bots, name); if (name.startsWith(".") || !(await lstat(bot)).isDirectory()) continue;
        locks.push(await acquireInstanceLock(bot));
      }
      await options.assertStopped?.(); return await task();
    } finally { for (const lock of locks.reverse()) await lock.release(); }
  });
}
async function inspectSchema(directory: string, checkRuns = true): Promise<number> {
  if (await exists(path.join(directory, "restore.incomplete.json"))) throw new Error("host_update_incomplete_restore");
  const file = path.join(directory, "hub.sqlite"); if (!await exists(file)) return 0;
  await regular(file); const db = await HubDatabase.snapshot(file);
  try {
    const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'");
    if (!row || !/^[1-9]\d*$/.test(row.value)) throw new Error("host_update_unknown_database_schema");
    if (!checkRuns) return Number(row.value);
    // Queued user deliveries may remain after draining; they have never begun.
    // Unfinished bot output cannot be treated as idle just because its process
    // disappeared. Recovery must resolve it before a normal update can proceed.
    const unfinished = await unfinishedRuns(db);
    if (unfinished.length) throw new Error(`host_update_unfinished_runs: ${JSON.stringify(unfinished)}。主机停止后仍有未结束的 Bot 输出，请先检查这些对话的恢复状态。`);
    return Number(row.value);
  } finally { await db.close(); }
}
export type HostUpdateUnfinishedRun = { botId: string; messageId: string; conversationId: string; status: string; phase: string | null };
const ACTIVE_RUN_PHASES = "('thinking','working','answering','waiting_approval','waiting_answer','stopping','delivering')";
const activePhase = `(SELECT phase.value FROM json_each(m.blocks_json) b,
    json_each(json_array(json_extract(b.value,'$.extra.nativeRun.phase'), json_extract(b.value,'$.extra.scopedRun.phase'))) phase
    WHERE phase.value IN ${ACTIVE_RUN_PHASES} LIMIT 1)`;
async function unfinishedRuns(db: HubDatabase): Promise<HostUpdateUnfinishedRun[]> {
  // Background process cards deliberately have a complete message envelope so
  // they cannot drive the foreground composer, but still own live host work.
  return db.all<HostUpdateUnfinishedRun>(`SELECT m.author_id AS botId, m.id AS messageId, m.conversation_id AS conversationId, m.status,
    ${activePhase} AS phase FROM messages m WHERE m.author_type='bot' AND m.status!='deleted'
    AND (m.status IN ('pending','streaming') OR ${activePhase} IS NOT NULL)
    ORDER BY m.created_at,m.id LIMIT 100`);
}
/** Read-only evidence of known work an older drain cannot protect: its idle
 * report ignores native background work, so foreground work running when drain
 * starts can still launch background work that its shutdown then interrupts.
 * Counts inputs handed to a worker and not yet acknowledged (status
 * "dispatched"; acknowledgement follows the foreground turn), foreground
 * replies, and active run cards, while the Bot has an attached worker and is
 * still a member. Undispatched inputs stay queued during drain. Card age is
 * deliberately not used: a silent card does not prove its native work ended. */
export async function liveHostWork(directory: string): Promise<HostUpdateUnfinishedRun[]> {
  const file = path.join(directory, "hub.sqlite"); if (!await exists(file)) return [];
  const db = await HubDatabase.snapshot(file);
  try {
    // Hosts before durable prompt queues have no dispatch fence: every pending input is in flight.
    const fenced = (await db.all<{ name: string }>("PRAGMA table_info(deliveries)")).some(column => column.name === "dispatched");
    const live = (bot: string) => `EXISTS(SELECT 1 FROM bots b WHERE b.id=${bot} AND b.online=1)
      AND EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.member_type='bot' AND cm.member_id=${bot})`;
    const rows = await db.all<HostUpdateUnfinishedRun & { at: number }>(`SELECT d.bot_id AS botId, d.message_id AS messageId, m.conversation_id AS conversationId,
      'dispatched' AS status, NULL AS phase, m.created_at AS at FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE d.status='pending'${fenced ? " AND d.dispatched=1" : ""} AND ${live("d.bot_id")}
      UNION ALL SELECT m.author_id, m.id, m.conversation_id, m.status, ${activePhase}, m.created_at FROM messages m
      WHERE m.author_type='bot' AND m.status!='deleted' AND (m.status IN ('pending','streaming') OR ${activePhase} IS NOT NULL) AND ${live("m.author_id")}
      ORDER BY at,messageId LIMIT 100`);
    return rows.map(({ at: _at, ...row }) => row);
  } finally { await db.close(); }
}
async function knownSelection(directory: string, fallback: string): Promise<{ runtime: HostRuntimeSelection; error?: string }> {
  // A broken current executable is precisely when a healthy replacement is
  // needed. Record the pointer as evidence without requiring it to boot/hash.
  const current = await selection(directory);
  if (current) {
    try { await resolveHostRuntime(directory, fallback); return { runtime: current.current }; }
    catch (error) { return { runtime: current.current, error: errorText(error) }; }
  }
  const value: HostRuntimeSelection = { entrypoint: path.resolve(fallback), executable: process.execPath };
  // Older installers have no compatibility receipt. They can be preserved as
  // an executable path, but that is not permission to run them after migration.
  const root = path.resolve(path.dirname(value.entrypoint), "../..");
  try {
    const manifest = await packageMetadata(root);
    return { runtime: { ...value, version: manifest.version, minHubSchema: manifest.tarobotHostUpdate.minHubSchema, maxHubSchema: manifest.tarobotHostUpdate.maxHubSchema } };
  } catch { return { runtime: value }; }
}
function compatible(selection: HostRuntimeSelection, schema: number): void {
  if (!selection.minHubSchema || !selection.maxHubSchema) throw new Error("host_update_unknown_schema_compatibility");
  if (schema && (schema < selection.minHubSchema || schema > selection.maxHubSchema)) throw new Error("host_update_schema_incompatible_restore_required");
}
type RecoveryOmission = { path: string; type: string; reason: string };
type RecoveryMember = { path: string; type: "file" | "directory" | "link"; size: number };
const recoveryScope = "host-state-without-workspaces" as const;
function recoveryExclusion(member: string): string | undefined {
  if (/^bots\/[^/]+\/workspace$/.test(member)) return "workspace_preserved_in_place_not_in_update_recovery";
  const name = path.posix.basename(member);
  if (member === "backups" || name === "instance.lock.json" || name.endsWith(".lock") || name.endsWith(".sock") || isHubLogFile(member)) return "excluded_runtime_file";
  return undefined;
}
async function recoveryInventory(directory: string, mode: "online" | "offline"): Promise<{ members: RecoveryMember[]; skipped: RecoveryOmission[]; bytes: number }> {
  const members: RecoveryMember[] = [], skipped: RecoveryOmission[] = []; let bytes = 0;
  async function walk(relative: string): Promise<void> {
    let children: string[];
    try { children = await readdir(path.join(directory, relative)); }
    catch (error) {
      if (mode === "online" && relative && (error as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.push({ path: relative, type: "transient", reason: "disappeared_during_preflight" }); return;
      }
      throw error;
    }
    for (const name of children.sort()) {
      if (members.length + skipped.length >= MAX_ENTRIES) throw new Error(`host_update_backup_entry_limit: 更新恢复副本（已排除工作区）超过 ${MAX_ENTRIES} 个条目。`);
      // These names come from readdir on this filesystem, not package metadata.
      // Colons, whitespace and other native filenames are valid state content.
      const member = relative ? `${relative}/${name}` : name;
      const reason = recoveryExclusion(member);
      if (reason) { skipped.push({ path: member, type: reason.startsWith("workspace_") ? "workspace" : "transient", reason }); continue; }
      const file = path.join(directory, member), stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (mode === "online" && error.code === "ENOENT") return undefined; throw error; });
      // The preflight is online. A removed file will be examined again by the
      // authoritative offline inventory before copying; never follow symlinks.
      if (!stat) continue;
      if (stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) { skipped.push({ path: member, type: stat.isSocket() ? "socket" : stat.isFIFO() ? "fifo" : "device", reason: "ephemeral_special_file" }); continue; }
      if (!stat.isDirectory() && !stat.isSymbolicLink() && !stat.isFile()) throw new Error("host_update_unsafe_state_file");
      const type = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file";
      members.push({ path: member, type, size: stat.isFile() ? stat.size : 0 }); bytes += stat.isFile() ? stat.size : 0;
      if (!Number.isSafeInteger(bytes)) throw new Error("host_update_backup_size_limit");
      if (type === "directory") await walk(member);
    }
  }
  if (mode === "offline" || await exists(directory)) await walk("");
  return { members, skipped, bytes };
}
async function recoveryCapacity(directory: string, inventory: Awaited<ReturnType<typeof recoveryInventory>>): Promise<{ requiredBytes: number; availableBytes: number }> {
  let destination = path.join(await hostRuntimeDirectory(directory), "recovery");
  while (!await exists(destination)) destination = path.dirname(destination);
  if (!(await lstat(destination)).isDirectory()) throw new Error("host_update_directory_not_regular");
  const capacity = await statfs(destination, { bigint: true });
  const availableBytes = Number(capacity.bavail * capacity.bsize);
  // Include directory blocks, the manifest, and room for an online WAL growing
  // before the second, offline check. This is an estimate, never a reservation.
  const requiredBytes = Math.ceil(inventory.bytes * 1.05) + (inventory.members.length + inventory.skipped.length) * 4096 + 16 * 1024 ** 2;
  if (availableBytes < requiredBytes) throw new Error(`host_update_insufficient_space: 更新恢复副本需要约 ${requiredBytes} 字节，可用 ${availableBytes} 字节（工作区已排除）。`);
  return { requiredBytes, availableBytes };
}
export type HostUpdateRecoveryPreflight = { scope: typeof recoveryScope; entries: number; bytes: number; requiredBytes: number; availableBytes: number; excluded: RecoveryOmission[]; unfinishedRuns: HostUpdateUnfinishedRun[] };
/** Read-only online estimate. Unfinished runs are informational until the host
 * has drained: ordinary work must be allowed to finish before the offline gate. */
export async function inspectHostUpdateRecovery(directory: string): Promise<HostUpdateRecoveryPreflight> {
  directory = await canonical(path.resolve(directory)); const inventory = await recoveryInventory(directory, "online");
  const capacity = await recoveryCapacity(directory, inventory); let unfinished: HostUpdateUnfinishedRun[] = [];
  if (await exists(path.join(directory, "hub.sqlite"))) {
    const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
    try { unfinished = await unfinishedRuns(db); } finally { await db.close(); }
  }
  return { scope: recoveryScope, entries: inventory.members.length, bytes: inventory.bytes, ...capacity, excluded: inventory.skipped, unfinishedRuns: unfinished };
}
/** Byte-preserving OFFLINE migration recovery, not a user full backup. SQLite,
 * identity, configuration and sessions are copied; workspaces stay in place.
 * v1 recovery bundles remain readable; v2 explicitly records the narrower scope. */
async function backupStoppedState(directory: string, destination: string): Promise<void> {
  const inventory = await recoveryInventory(directory, "offline"); await recoveryCapacity(directory, inventory);
  await privateDirectory(destination); const entries: FileEntry[] = [];
  await privateDirectory(path.join(destination, "state"));
  for (const member of inventory.members) {
    const file = path.join(directory, member.path), target = path.join(destination, "state", member.path);
    if (member.type === "directory") await mkdir(target, { recursive: true, mode: 0o700 });
    else if (member.type === "link") {
        const link = await readlink(file);
        // Windows directory junctions need their directory type to be recreated.
        // Only inspect target metadata; never walk or copy external contents.
        const type = process.platform === "win32" ? await targetMetadata(file).then(value => value.isDirectory() ? "junction" as const : "file" as const, () => "file" as const) : undefined;
        await symlink(link, target, type); entries.push({ type: "link", path: member.path, target: link });
    }
    else entries.push(await copyFile(file, target, member.path));
  }
  await atomicJson(path.join(destination, "manifest.json"), { format: "tarobot-update-recovery", version: 2, scope: recoveryScope, sourceDirectory: directory, createdAt: new Date().toISOString(), entries, skipped: inventory.skipped });
}
async function selectRuntime(directory: string, after: HostRuntimeSelection, operation: HostUpdateReceipt["operation"], options: HostUpdateOptions, expectedTransactionId?: string): Promise<HostUpdateReceipt> {
  directory = await canonical(path.resolve(directory)); const root = await hostRuntimeDirectory(directory); await privateDirectory(root);
  return withFileMutex(path.join(root, "update"), () => withStoppedHost(directory, options, async () => {
    if (expectedTransactionId && (await selection(directory))?.transactionId !== expectedTransactionId) throw new Error("host_update_selection_changed");
    const previous = await knownSelection(directory, options.currentEntrypoint), before = previous.runtime, hubSchema = await inspectSchema(directory); compatible(after, hubSchema);
    if (after.revisionId) {
      const revision = await readRevision(directory, after.revisionId, true);
      if (revision.entrypoint !== after.entrypoint || revision.executable !== after.executable || revision.minHubSchema !== after.minHubSchema || revision.maxHubSchema !== after.maxHubSchema || revision.version !== after.version || revision.digest !== after.runtimeId) throw new Error("host_update_invalid_selection");
    } else {
      const packageRoot = path.resolve(path.dirname(after.entrypoint), "../.."), manifest = await packageMetadata(packageRoot);
      if (manifest.tarobotHostUpdate.minHubSchema !== after.minHubSchema || manifest.tarobotHostUpdate.maxHubSchema !== after.maxHubSchema || manifest.version !== after.version) throw new Error("host_update_previous_runtime_changed");
    }
    await regular(after.entrypoint); await regular(after.executable);
    await (await import("./service-manager.js")).assertManagedServiceRuntimeCompatible(directory, after);
    if (before.entrypoint === after.entrypoint) throw new Error("host_update_already_selected");
    const id = randomUUID(), transactions = path.join(root, "transactions"); await privateDirectory(transactions);
    const backupPath = hubSchema ? path.join(root, "recovery", id) : null;
    const receipt: HostUpdateReceipt = { format: 1, id, operation, state: "prepared", createdAt: new Date().toISOString(), before, after, ...(previous.error ? { beforeError: previous.error } : {}), hubSchema, backupPath };
    const receiptPath = path.join(transactions, `${id}.json`); await atomicJson(receiptPath, receipt);
    if (backupPath) { try { await backupStoppedState(directory, backupPath); } catch (error) { await rm(backupPath, { recursive: true, force: true }); throw error; } }
    await atomicJson(path.join(root, "current.json"), { format: 1, transactionId: id, current: after, previous: before });
    receipt.state = "selected"; await atomicJson(receiptPath, receipt); return receipt;
  }));
}
export async function activateHostUpdate(directory: string, id: string, options: HostUpdateOptions): Promise<HostUpdateReceipt> {
  const revision = await readRevision(directory, id, true);
  return selectRuntime(directory, { entrypoint: revision.entrypoint, executable: revision.executable, revisionId: revision.id, runtimeId: revision.digest, version: revision.version, minHubSchema: revision.minHubSchema, maxHubSchema: revision.maxHubSchema }, "activate", options);
}
export const applyHostUpdate = activateHostUpdate;
/** Read-only check before asking a live host to drain; the locked apply repeats
 * every compatibility and integrity check after stopping to close races. */
export async function preflightHostUpdate(directory: string, revisionId?: string): Promise<HostRuntimeSelection> {
  let target: HostRuntimeSelection;
  if (revisionId) {
    const revision = await readRevision(directory, revisionId, true);
    target = { entrypoint: revision.entrypoint, executable: revision.executable, revisionId: revision.id, runtimeId: revision.digest, version: revision.version, minHubSchema: revision.minHubSchema, maxHubSchema: revision.maxHubSchema };
  } else {
    const selected = await selection(directory); if (!selected) throw new Error("host_update_no_previous_runtime"); target = selected.previous;
    if (!target.revisionId) throw new Error("host_update_previous_runtime_not_frozen: 上一版来自可变的 App 或源码路径，不能安全自动回滚。请保留旧安装包，并在切换前将其 stage/apply 为冻结基线。");
    await readRevision(directory, target.revisionId, true);
  }
  if ((await selection(directory))?.current.entrypoint === target.entrypoint) throw new Error("host_update_already_selected");
  compatible(target, await inspectSchema(directory, false)); await regular(target.entrypoint); await regular(target.executable);
  await (await import("./service-manager.js")).assertManagedServiceRuntimeCompatible(directory, target);
  await inspectHostUpdateRecovery(directory); return target;
}
export async function rollbackHostUpdate(directory: string, options: HostUpdateOptions): Promise<HostUpdateReceipt> {
  const current = await selection(directory); if (!current) throw new Error("host_update_no_previous_runtime");
  if (!current.previous.revisionId) throw new Error("host_update_previous_runtime_not_frozen: 上一版未冻结，不能自动回滚到可能已被替换的 App 或源码路径。请从保留的安装包显式 stage 所需版本。");
  return selectRuntime(directory, current.previous, "rollback", options, current.transactionId);
}
/** Call only after the caller verifies the new service and SAME host identity.
 * Selection receipts survive crashes even if this acknowledgement never arrives. */
export async function markHostUpdateHealthy(directory: string, transactionId: string): Promise<HostUpdateReceipt> {
  z.string().uuid().parse(transactionId); const root = await hostRuntimeDirectory(directory);
  return withFileMutex(path.join(root, "update"), async () => {
    const current = await selection(directory); if (current?.transactionId !== transactionId) throw new Error("host_update_selection_changed");
    const file = path.join(root, "transactions", `${transactionId}.json`), receipt = receiptSchema.parse(await json(file));
    if (receipt.id !== transactionId || receipt.after.entrypoint !== current.current.entrypoint) throw new Error("host_update_invalid_receipt");
    receipt.state = "healthy"; await atomicJson(file, receipt); return receipt;
  });
}
export async function hostUpdateStatus(directory: string): Promise<{ selected?: HostRuntimeSelection; previous?: HostRuntimeSelection; transaction?: HostUpdateReceipt; incomplete: HostUpdateReceipt[]; revisions: HostRuntimeListing[]; errors: Array<{ path: string; error: string }> }> {
  const errors: Array<{ path: string; error: string }> = [];
  let current: Awaited<ReturnType<typeof selection>>;
  try { current = await selection(directory); } catch (error) { errors.push({ path: "current.json", error: errorText(error) }); }
  const revisions = await listHostUpdates(directory), transactions = path.join(await hostRuntimeDirectory(directory), "transactions");
  const incomplete: HostUpdateReceipt[] = [];
  let transaction: HostUpdateReceipt | undefined;
  if (await exists(transactions)) for (const name of (await readdir(transactions)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    try {
      const receipt = receiptSchema.parse(await json(path.join(transactions, name)));
      if (receipt.id === current?.transactionId) {
        if (receipt.after.entrypoint !== current.current.entrypoint) throw new Error("host_update_invalid_receipt");
        transaction = receipt;
        if (transaction.state === "prepared") transaction.state = "selected";
      } else if (receipt.state === "prepared") incomplete.push(receipt);
    } catch (error) { errors.push({ path: `transactions/${name}`, error: errorText(error) }); }
  }
  if (current && !transaction && !errors.some(error => error.path === `transactions/${current.transactionId}.json`)) errors.push({ path: `transactions/${current.transactionId}.json`, error: "host_update_missing_receipt" });
  return { ...(current ? { selected: current.current, previous: current.previous } : {}), ...(transaction ? { transaction } : {}), incomplete, revisions, errors };
}

export type HostUpdatePruneOptions = { revisionId?: string; transactionId?: string; yes?: boolean };
export type HostUpdatePrunePlan = { dryRun: boolean; deleted: boolean; kind: "revision" | "receipt"; id: string; paths: string[]; retainedRevisionIds: string[]; retainedTransactionIds: string[] };
async function regularDirectory(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) throw new Error("host_update_directory_not_regular");
}
function assertOwnedSelection(root: string, selected: HostRuntimeSelection): void {
  if (!selected.revisionId) return;
  const revision = path.join(root, "versions", selected.revisionId);
  if (selected.entrypoint !== path.join(revision, "package/dist/src/index.js") || selected.executable !== path.join(revision, process.platform === "win32" ? "node.exe" : "node")) throw new Error("host_update_receipt_outside_runtime");
}
async function ownedRecovery(directory: string, root: string, receipt: HostUpdateReceipt): Promise<string | undefined> {
  if (!receipt.backupPath) return;
  const expected = path.join(root, "recovery", receipt.id);
  if (receipt.backupPath !== expected) throw new Error("host_update_receipt_outside_runtime");
  if (!await exists(expected)) return;
  await regularDirectory(path.join(root, "recovery")); await regularDirectory(expected);
  const manifestPath = path.join(expected, "manifest.json");
  // A process can die during copying, before the final manifest is written.
  // Its validated prepared receipt owns this exact directory; it is never
  // considered a usable recovery point and can be explicitly removed.
  if (receipt.state === "prepared" && !await exists(manifestPath)) return expected;
  const manifest = z.object({ format: z.literal("tarobot-update-recovery"), version: z.union([z.literal(1), z.literal(2)]), sourceDirectory: z.string(), scope: z.string().optional() }).parse(await json(manifestPath));
  if (manifest.sourceDirectory !== directory || manifest.version === 2 && manifest.scope !== recoveryScope) throw new Error("host_update_recovery_not_owned");
  return expected;
}
/** Explicit, conservative cleanup. Nothing is removed without yes, and neither
 * this API nor recursive rm follows symlinks into live state or workspaces.
 * Retained receipts keep their referenced revisions until explicitly pruned. */
export async function pruneHostUpdates(directory: string, options: HostUpdatePruneOptions): Promise<HostUpdatePrunePlan> {
  if (Number(!!options.revisionId) + Number(!!options.transactionId) !== 1) throw new Error("host_update_prune_one_target_required");
  const kind = options.revisionId ? "revision" as const : "receipt" as const;
  const id = options.revisionId ? idSchema.parse(options.revisionId) : z.string().uuid().parse(options.transactionId);
  directory = await canonical(path.resolve(directory)); const root = await hostRuntimeDirectory(directory);
  await regularDirectory(root);
  return withFileMutex(path.join(root, "update"), async () => {
    await regularDirectory(root);
    const selected = await selection(directory), retainedRevisions = new Set<string>();
    for (const value of [selected?.current, selected?.previous]) if (value) {
      assertOwnedSelection(root, value); if (value.revisionId) retainedRevisions.add(value.revisionId);
    }
    const transactions = path.join(root, "transactions"), records: Array<{ receipt: HostUpdateReceipt; recovery?: string }> = [];
    if (await exists(transactions)) {
      await regularDirectory(transactions);
      for (const name of (await readdir(transactions)).sort()) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const receipt = receiptSchema.parse(await json(path.join(transactions, name)));
        if (name !== `${receipt.id}.json`) throw new Error("host_update_invalid_receipt");
        assertOwnedSelection(root, receipt.before); assertOwnedSelection(root, receipt.after);
        records.push({ receipt, recovery: await ownedRecovery(directory, root, receipt) });
      }
    }
    const retainedReceipts = new Set<string>(selected ? [selected.transactionId] : []);
    // Keep one additional usable point even if the selected transaction was
    // interrupted or its recovery copy is damaged. Never infer safe DB rollback.
    const previousRecovery = records.filter(value => value.recovery && value.receipt.id !== selected?.transactionId && value.receipt.state !== "prepared")
      .sort((a, b) => b.receipt.createdAt.localeCompare(a.receipt.createdAt) || b.receipt.id.localeCompare(a.receipt.id))[0];
    if (previousRecovery) retainedReceipts.add(previousRecovery.receipt.id);
    let paths: string[];
    if (kind === "revision") {
      if (retainedRevisions.has(id)) throw new Error("host_update_prune_selected_revision");
      const references = records.filter(({ receipt }) => receipt.before.revisionId === id || receipt.after.revisionId === id);
      if (references.length) throw new Error(`host_update_prune_revision_referenced: ${references.map(value => value.receipt.id).join(",")}`);
      const location = path.join(root, "versions", id); await regularDirectory(path.join(root, "versions")); await regularDirectory(location);
      const record = revisionSchema.parse(await json(path.join(location, "revision.json")));
      if (record.id !== id || record.id !== `${record.version}-${record.digest.slice(0, 16)}` || runtimeDigest(record.entries, record.node, record.platform, record.arch) !== record.digest) throw new Error("host_update_invalid_revision");
      const live = await inspectHubService(directory);
      if (live.running && (!live.runtimeId || live.runtimeId === record.digest)) throw new Error("host_update_prune_running_or_unknown_runtime");
      paths = [location];
    } else {
      if (retainedReceipts.has(id)) throw new Error("host_update_prune_required_recovery");
      const record = records.find(value => value.receipt.id === id);
      if (!record) throw new Error("host_update_prune_receipt_not_found");
      paths = [...(record.recovery ? [record.recovery] : []), path.join(transactions, `${id}.json`)];
    }
    const plan: HostUpdatePrunePlan = { dryRun: !options.yes, deleted: false, kind, id, paths, retainedRevisionIds: [...retainedRevisions], retainedTransactionIds: [...retainedReceipts] };
    if (options.yes) {
      // Paths are derived from validated IDs, not manifest entry paths. rm
      // unlinks contained links rather than traversing their external targets.
      for (const target of paths) await rm(target, { recursive: true, force: false });
      plan.deleted = true;
    }
    return plan;
  });
}

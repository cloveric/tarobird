import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ompNativeSessionsDir } from "../runtime/omp-executable.js";
import { samePiWorkspace } from "./pi-session-store.js";

export interface OmpSessionRecord {
  sessionFile?: string;
  cwd?: string;
  title?: string;
  external?: boolean;
  touchedAt?: number;
}

interface OmpStateFile {
  version: 1;
  sessions: Record<string, OmpSessionRecord>;
}

export interface OmpDiscoveredSession {
  sessionId: string;
  path: string;
  cwd: string;
  title?: string;
  updatedAt: string;
  mtimeMs: number;
  origin: "bot" | "native";
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_NAME_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_RECORDS = 1000;

async function readFirstLine(file: string, limit = MAX_HEADER_BYTES): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = createReadStream(file, { start: 0, end: limit - 1 });
    stream.on("data", chunk => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(buffer.subarray(0, newline));
        stream.destroy();
        resolve(Buffer.concat(chunks).toString("utf8"));
        return;
      }
      chunks.push(buffer);
      size += buffer.length;
    });
    stream.on("end", () => resolve(size ? Buffer.concat(chunks).toString("utf8") : undefined));
    stream.on("error", () => resolve(undefined));
  });
}

async function readSessionName(file: string, size: number): Promise<string | undefined> {
  if (!size) return undefined;
  const start = Math.max(0, size - MAX_NAME_SCAN_BYTES);
  return new Promise(resolve => {
    let name: string | undefined;
    let rest = "";
    let first = start > 0;
    const stream = createReadStream(file, { start, encoding: "utf8" });
    const scan = (line: string) => {
      if (!line.includes('"session_info"')) return;
      try {
        const entry = JSON.parse(line) as { type?: unknown; name?: unknown };
        if (entry.type === "session_info") {
          name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 200) : undefined;
        }
      } catch { /* ignore */ }
    };
    stream.on("data", chunk => {
      rest += chunk;
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      if (first && lines.length) { lines.shift(); first = false; }
      for (const line of lines) scan(line);
    });
    stream.on("end", () => { if (!first && rest) scan(rest); resolve(name); });
    stream.on("error", () => resolve(name));
  });
}

export async function readOmpSessionHeader(file: string): Promise<{ id: string; cwd?: string; timestamp?: string; parentSession?: string } | undefined> {
  const line = await readFirstLine(file);
  if (!line) return undefined;
  try {
    const header = JSON.parse(line) as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string" || !header.id) return undefined;
    return {
      id: header.id,
      ...(typeof header.cwd === "string" && header.cwd.trim() ? { cwd: header.cwd.trim() } : {}),
      ...(typeof header.timestamp === "string" ? { timestamp: header.timestamp } : {}),
      ...(typeof header.parentSession === "string" ? { parentSession: header.parentSession } : {}),
    };
  } catch {
    return undefined;
  }
}

export function sanitizeOmpDirSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "default";
}

export class OmpSessionStore {
  readonly rootDir: string;
  readonly sessionsDir: string;
  private readonly statePath: string;
  private state: OmpStateFile | undefined;
  private loading: Promise<OmpStateFile> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: { stateDir: string; childEnv: NodeJS.ProcessEnv; homeDir?: string }) {
    this.rootDir = path.join(options.stateDir, "omp");
    this.sessionsDir = path.join(this.rootDir, "sessions");
    this.statePath = path.join(this.rootDir, "state.json");
  }

  sessionDirFor(sessionKey: string): string {
    return path.join(this.sessionsDir, sanitizeOmpDirSegment(sessionKey));
  }

  private load(): Promise<OmpStateFile> {
    if (this.state) return Promise.resolve(this.state);
    if (this.loading) return this.loading;
    const loading = (async () => {
      let text: string | undefined;
      try { text = await readFile(this.statePath, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let parsed: Partial<OmpStateFile> | undefined;
      try { parsed = text === undefined ? undefined : JSON.parse(text) as Partial<OmpStateFile>; } catch { /* recover */ }
      const sessions: Record<string, OmpSessionRecord> = Object.create(null);
      if (parsed?.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)) {
        for (const [id, raw] of Object.entries(parsed.sessions)) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const r = raw as Record<string, unknown>;
          sessions[id] = {
            ...(typeof r.sessionFile === "string" && r.sessionFile.trim() ? { sessionFile: r.sessionFile } : {}),
            ...(typeof r.cwd === "string" && r.cwd.trim() ? { cwd: r.cwd } : {}),
            ...(typeof r.title === "string" && r.title.trim() ? { title: r.title } : {}),
            ...(r.external === true ? { external: true } : {}),
            ...(typeof r.touchedAt === "number" ? { touchedAt: r.touchedAt } : {}),
          };
        }
      }
      this.state = { version: 1, sessions };
      return this.state;
    })();
    this.loading = loading;
    void loading.catch(() => { if (this.loading === loading) this.loading = undefined; });
    return loading;
  }

  private save(): Promise<void> {
    const next = this.writeChain.then(async () => {
      const state = await this.load();
      const ids = Object.keys(state.sessions);
      if (ids.length > MAX_SESSION_RECORDS) {
        ids.sort((a, b) => (state.sessions[a]?.touchedAt ?? 0) - (state.sessions[b]?.touchedAt ?? 0));
        for (const id of ids.slice(0, ids.length - MAX_SESSION_RECORDS)) delete state.sessions[id];
      }
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.statePath);
    });
    this.writeChain = next.catch(() => {});
    return next;
  }

  async getRecord(sessionKey: string): Promise<OmpSessionRecord | undefined> {
    const state = await this.load();
    const rec = state.sessions[sessionKey];
    return rec ? { ...rec } : undefined;
  }

  async setRecord(sessionKey: string, patch: Partial<OmpSessionRecord>): Promise<OmpSessionRecord> {
    const state = await this.load();
    const merged: OmpSessionRecord = { ...(state.sessions[sessionKey] ?? {}), ...patch, touchedAt: Date.now() };
    for (const key of Object.keys(merged) as Array<keyof OmpSessionRecord>) {
      if (merged[key] === undefined) delete merged[key];
    }
    state.sessions[sessionKey] = merged;
    await this.save();
    return { ...merged };
  }

  async resolvePersistedSessionFile(sessionKey: string): Promise<string | undefined> {
    const rec = await this.getRecord(sessionKey);
    if (rec?.sessionFile) {
      const st = await stat(rec.sessionFile).catch(() => null);
      if (st?.isFile()) return rec.sessionFile;
    }
    const dir = this.sessionDirFor(sessionKey);
    const files = await readdir(dir).catch(() => [] as string[]);
    let latest: { full: string; mtimeMs: number } | undefined;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = path.join(dir, file);
      const st = await stat(full).catch(() => null);
      if (!st?.isFile()) continue;
      if (!latest || st.mtimeMs > latest.mtimeMs) latest = { full, mtimeMs: st.mtimeMs };
    }
    return latest?.full;
  }

  /**
   * Relocate a newly forked session file out of the source conversation's directory
   * into the fork's own directory so `open_session(sourceDir)` can never hijack
   * the source conversation onto a newer fork file after a restart.
   */
  async relocateForkedFile(forkedFile: string, sourceDir: string, newSessionId: string): Promise<string> {
    const resolvedFork = path.resolve(forkedFile);
    const resolvedSourceDir = path.resolve(sourceDir);
    const insideSource = path.dirname(resolvedFork) === resolvedSourceDir;
    if (!insideSource) return resolvedFork;
    const st = await stat(resolvedFork).catch(() => null);
    if (!st?.isFile()) return resolvedFork;
    const targetDir = this.sessionDirFor(newSessionId);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const targetFile = path.join(targetDir, path.basename(resolvedFork));
    if (path.resolve(targetFile) === resolvedFork) return resolvedFork;
    try {
      await rename(resolvedFork, targetFile);
      return targetFile;
    } catch {
      try {
        await copyFile(resolvedFork, targetFile);
        await unlink(resolvedFork).catch(() => undefined);
        return targetFile;
      } catch {
        return resolvedFork;
      }
    }
  }

  private async collectJsonlFiles(root: string): Promise<Array<{ file: string; parentName: string }>> {
    const found: Array<{ file: string; parentName: string }> = [];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push({ file: full, parentName: path.basename(root) });
      } else if (entry.isDirectory()) {
        const sub = await readdir(full, { withFileTypes: true }).catch(() => []);
        for (const child of sub) {
          if (child.isFile() && child.name.endsWith(".jsonl")) {
            found.push({ file: path.join(full, child.name), parentName: entry.name });
          }
        }
      }
    }
    return found;
  }

  async listSessions(input: { defaultWorkspace: string; cwd?: string; limit?: number }): Promise<OmpDiscoveredSession[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 500));
    const home = this.options.homeDir
      ?? (process.platform === "win32" ? this.options.childEnv.USERPROFILE ?? this.options.childEnv.HOME : this.options.childEnv.HOME ?? this.options.childEnv.USERPROFILE)
      ?? os.homedir();
    const nativeDir = ompNativeSessionsDir(this.options.childEnv, home, input.cwd ?? input.defaultWorkspace);

    const roots: Array<{ root: string; origin: "bot" | "native" }> = [
      { root: this.sessionsDir, origin: "bot" },
      { root: nativeDir, origin: "native" },
    ];

    const candidates: Array<{ file: string; parentName: string; origin: "bot" | "native"; mtimeMs: number; size: number }> = [];
    const seenFiles = new Set<string>();
    for (const { root, origin } of roots) {
      for (const item of await this.collectJsonlFiles(root)) {
        const resolved = path.resolve(item.file);
        if (seenFiles.has(resolved)) continue;
        seenFiles.add(resolved);
        const st = await stat(resolved).catch(() => null);
        if (!st?.isFile()) continue;
        candidates.push({ file: resolved, parentName: item.parentName, origin, mtimeMs: st.mtimeMs, size: st.size });
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const results: OmpDiscoveredSession[] = [];
    const seenIds = new Set<string>();

    for (const candidate of candidates) {
      if (results.length >= limit) break;
      const header = await readOmpSessionHeader(candidate.file);
      const sessionId = header?.id ?? path.basename(candidate.file, ".jsonl");
      if (seenIds.has(sessionId)) continue;
      const sessionCwd = header?.cwd ?? input.defaultWorkspace;
      if (input.cwd && header?.cwd && !samePiWorkspace(header.cwd, input.cwd)) continue;
      const name = await readSessionName(candidate.file, candidate.size);
      seenIds.add(sessionId);
      results.push({
        sessionId,
        path: candidate.file,
        cwd: sessionCwd,
        ...(name ? { title: name } : candidate.origin === "bot" ? { title: candidate.parentName } : {}),
        updatedAt: new Date(candidate.mtimeMs).toISOString(),
        mtimeMs: candidate.mtimeMs,
        origin: candidate.origin,
      });
    }
    return results;
  }
}

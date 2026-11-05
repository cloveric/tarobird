import { readdir, readFile, stat, lstat, open } from "node:fs/promises";
import { constants, existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

function resolveHomeDir(): string {
  if (process.platform === "win32") {
    return process.env.USERPROFILE ?? process.env.HOME ?? "/";
  }
  return process.env.HOME ?? process.env.USERPROFILE ?? "/";
}

function resolveAntigravityLogDir(): string {
  return path.join(resolveHomeDir(), ".gemini", "antigravity-cli", "log");
}

function resolveClaudeProjectsDir(): string {
  const explicitClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (explicitClaudeConfigDir) {
    return path.join(explicitClaudeConfigDir, "projects");
  }

  return path.join(resolveHomeDir(), ".claude", "projects");
}

export interface ScannedSession {
  sessionId: string;
  dirName: string;
  workspacePath: string | null;
  modifiedAt: Date;
  displayName: string;
}

type ExistingDirPredicate = (p: string) => boolean;

export const MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS = 20;
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Read bounded transcript metadata, never the whole (potentially GiB) session.
// Do not stat guessed cwd paths: they can be on an unavailable external disk,
// blocking all commands in the Bot while the OS waits for access approval.
async function claudeWorkspace(file: string, sessionId: string): Promise<string | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const bytes = 256 * 1024;
    for (const offset of [...new Set([0, Math.max(0, info.size - bytes)])]) {
      const buffer = Buffer.alloc(Math.min(bytes, info.size));
      const result = await handle.read(buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, result.bytesRead).toString("utf8").split("\n");
      if (offset) lines.shift(); // First tail line may begin mid-JSON.
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId !== sessionId || typeof entry.cwd !== "string" || entry.cwd.includes("\0")) continue;
          if (path.isAbsolute(entry.cwd) || path.win32.isAbsolute(entry.cwd)) return entry.cwd;
        } catch { /* Partial or unrelated lines are not metadata. */ }
      }
    }
    return null;
  } finally { await handle.close(); }
}

/** Exact local ID lookup has no recency window and never follows caller paths. */
export async function findClaudeSession(sessionId: string): Promise<ScannedSession | null> {
  if (!CLAUDE_SESSION_ID.test(sessionId)) return null;
  const root = resolveClaudeProjectsDir();
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let found: ScannedSession | null = null;
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
    const file = path.join(root, dir.name, `${sessionId.toLowerCase()}.jsonl`);
    try {
      const info = await lstat(file);
      if (!info.isFile()) continue;
      const workspacePath = await claudeWorkspace(file, sessionId.toLowerCase());
      if (found) throw new Error("claude_session_ambiguous");
      found = { sessionId: sessionId.toLowerCase(), dirName: dir.name, workspacePath, modifiedAt: info.mtime, displayName: extractDisplayName(dir.name) };
    } catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
  return found;
}

function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function joinDecodedPath(current: string, segment: string): string {
  if (!current) {
    return `/${segment}`;
  }
  return current.endsWith("/") ? `${current}${segment}` : `${current}/${segment}`;
}

/**
 * Decode a Claude project directory name back to the original workspace path.
 *
 * Claude encodes workspace paths by replacing `/` and `.` with `-`.
 * Decoding is ambiguous (e.g. `foo-bar` could be `foo/bar` or literal
 * `foo-bar`).  We prefer the **longest** dash-joined match at each step
 * so that project names containing dashes (e.g. `cc-telegram-bridge`) are
 * resolved correctly even when shorter sub-paths also exist on disk.
 *
 * Windows drive-letter workspaces are encoded without a leading slash
 * (e.g. `E:/claude` -> `E--claude`), so they need a separate root seed.
 */
export function tryDecodeWorkspacePath(dirName: string, existingDir: ExistingDirPredicate = isExistingDir): string | null {
  const windowsDriveMatch = /^([A-Za-z])--/.exec(dirName);
  const isWindowsDrivePath = Boolean(windowsDriveMatch);
  if (!dirName.startsWith("-") && !isWindowsDrivePath) return null;

  const parts = isWindowsDrivePath ? dirName.slice(3).split("-") : dirName.slice(1).split("-");
  if (parts.length === 0) return null;

  let current = isWindowsDrivePath ? `${windowsDriveMatch![1]}:/` : "";
  let i = 0;

  while (i < parts.length) {
    const segment = parts[i]!;

    // Claude encodes dots as dashes too, including ordinary names such as
    // `taro-tmp.noindex`. Resolve against actual names without trying every
    // dot/dash permutation. Prefer the longest existing component, and the
    // literal dash spelling when two names have the same encoding.
    if (existingDir === isExistingDir) {
      const remaining = parts.slice(i).join("-");
      try {
        const names = readdirSync(current || "/", { withFileTypes: true })
          .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
          .map(entry => ({ name: entry.name, encoded: entry.name.replace(/\./g, "-") }))
          .filter(entry => remaining === entry.encoded || remaining.startsWith(`${entry.encoded}-`))
          .sort((a, b) => b.encoded.length - a.encoded.length || Number(a.name !== a.encoded) - Number(b.name !== b.encoded));
        const match = names.find(entry => existingDir(joinDecodedPath(current, entry.name)));
        if (match) { current = joinDecodedPath(current, match.name); i += match.encoded.split("-").length; continue; }
      } catch { /* Keep the bounded legacy fallback for inaccessible ancestors. */ }
    }

    if (segment === "" && i + 1 < parts.length) {
      // Double dash → original was a dot-prefixed name (e.g. .cctb, .foo-bar)
      // Try longest dash-joined match starting with dot prefix
      i++;
      let dotFound = false;
      for (let j = parts.length - 1; j >= i; j--) {
        const dotJoined = "." + parts.slice(i, j + 1).join("-");
        const candidate = joinDecodedPath(current, dotJoined);
        if (existingDir(candidate)) {
          current = candidate;
          i = j + 1;
          dotFound = true;
          break;
        }
      }
      if (!dotFound) {
        if (isWindowsDrivePath) {
          // Windows drive roots also encode `E:/foo/bar` as `E--foo-bar`.
          // If the dot-prefixed candidate does not exist, treat the extra
          // dash as the drive separator rather than inventing `/.bar`.
          continue;
        }
        current = joinDecodedPath(current, `.${parts[i]!}`);
        i++;
      }
      continue;
    }

    // Try longest dash-joined match first (e.g. "cc-telegram-bridge"),
    // then progressively shorter ones, then bare single segment.
    // This prevents "foo-bar" being split into "foo/bar" when a real
    // directory named "foo-bar" exists.
    let found = false;
    for (let j = parts.length - 1; j > i; j--) {
      const joined = parts.slice(i, j + 1).join("-");
      const candidate = joinDecodedPath(current, joined);
      if (existingDir(candidate)) {
        current = candidate;
        i = j + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      // Single segment — accept as slash-separated path component
      current = joinDecodedPath(current, segment);
      i++;
    }
  }

  return existingDir(current) ? current : null;
}

function extractDisplayName(dirName: string): string {
  const parts = dirName.slice(1).split("-").filter(Boolean);
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && projectsIdx < parts.length - 1) {
    return parts.slice(projectsIdx + 1).join("-");
  }
  return parts[parts.length - 1] ?? dirName;
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m ago`;
}

export function formatSessionList(sessions: ScannedSession[], locale: "en" | "zh"): string {
  if (sessions.length === 0) {
    return locale === "zh"
      ? "最近 1 小时内没有找到本地 session。"
      : "No local sessions found in the last hour.";
  }

  const header = locale === "zh" ? "最近的本地 session：" : "Recent local sessions:";
  const lines = sessions.map((s, i) => {
    const ago = formatTimeAgo(Date.now() - s.modifiedAt.getTime());
    const name = s.displayName;
    const idShort = s.sessionId.slice(0, 8);
    return `${i + 1}. [${name}] ${idShort}… (${ago})`;
  });
  const footer = locale === "zh"
    ? "\n回复 /resume <编号> 继续该 session。"
    : "\nReply /resume <number> to continue that session.";

  return [header, ...lines, footer].join("\n");
}

export function formatAntigravityConversationList(sessions: ScannedSession[], locale: "en" | "zh"): string {
  if (sessions.length === 0) {
    return locale === "zh"
      ? "最近 24 小时内没有找到 Antigravity conversation。"
      : "No Antigravity conversations found in the last 24 hours.";
  }

  const header = locale === "zh" ? "最近的 Antigravity conversation：" : "Recent Antigravity conversations:";
  const visibleSessions = sessions.slice(0, MAX_FORMATTED_ANTIGRAVITY_CONVERSATIONS);
  const lines = visibleSessions.map((s, i) => {
    const ago = formatTimeAgo(Date.now() - s.modifiedAt.getTime());
    return `${i + 1}. [${s.displayName}] ${s.sessionId.slice(0, 8)}… (${ago})`;
  });
  if (sessions.length > visibleSessions.length) {
    lines.push(locale === "zh"
      ? `…仅显示最近 ${visibleSessions.length} / ${sessions.length} 个。`
      : `…showing ${visibleSessions.length} of ${sessions.length} most recent.`);
  }
  const footer = locale === "zh"
    ? "\n回复 /resume <编号> 绑定该 conversation。"
    : "\nReply /resume <number> to attach that conversation.";

  return [header, ...lines, footer].join("\n");
}

/**
 * Scan ~/.claude/projects/ for .jsonl session files modified within the given
 * time window.  Returns results sorted by modification time (newest first).
 */
export async function scanRecentClaudeSessions(hoursAgo: number = 1): Promise<ScannedSession[]> {
  const projectsDir = resolveClaudeProjectsDir();

  if (!existsSync(projectsDir)) {
    return [];
  }

  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  const results: ScannedSession[] = [];

  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const directory of projectDirs) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const dirName = directory.name;
    const dirPath = path.join(projectsDir, dirName);

    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = path.join(dirPath, file);
      try {
        const fileStat = await lstat(filePath);
        if (fileStat.mtimeMs < cutoff) continue;

        const sessionId = file.slice(0, -6); // strip .jsonl
        if (!fileStat.isFile()) continue;
        const workspacePath = await claudeWorkspace(filePath, sessionId);
        const displayName = extractDisplayName(dirName);

        results.push({ sessionId, dirName, workspacePath, modifiedAt: fileStat.mtime, displayName });
      } catch {
        continue;
      }
    }
  }

  results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return results;
}

function extractAntigravityConversationIds(content: string): string[] {
  const ids: string[] = [];
  const matches = content.matchAll(/\bconversation=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/g);
  for (const match of matches) {
    const id = match[1]?.toLowerCase();
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Scan Antigravity CLI logs for recent conversation IDs. Antigravity does not
 * expose a structured conversation index yet, so the bridge uses the same
 * conversation=... log line it already relies on for automatic binding.
 */
export async function scanRecentAntigravityConversations(hoursAgo: number = 24): Promise<ScannedSession[]> {
  const logDir = resolveAntigravityLogDir();
  if (!existsSync(logDir)) {
    return [];
  }

  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  const byId = new Map<string, ScannedSession>();

  let files: string[];
  try {
    files = await readdir(logDir);
  } catch {
    return [];
  }

  for (const file of files) {
    if (!file.startsWith("cli-") || !file.endsWith(".log")) {
      continue;
    }

    const filePath = path.join(logDir, file);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile() || fileStat.mtimeMs < cutoff) {
        continue;
      }

      const ids = extractAntigravityConversationIds(await readFile(filePath, "utf8"));
      for (const sessionId of ids) {
        const existing = byId.get(sessionId);
        if (existing && existing.modifiedAt.getTime() >= fileStat.mtime.getTime()) {
          continue;
        }
        byId.set(sessionId, {
          sessionId,
          dirName: "antigravity",
          workspacePath: null,
          modifiedAt: fileStat.mtime,
          displayName: `conversation ${sessionId.slice(0, 8)}`,
        });
      }
    } catch {
      continue;
    }
  }

  return [...byId.values()].sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

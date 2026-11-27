import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EngineTask, SwarmMember, SwarmMemberState, SwarmPost, SwarmSnapshot } from "../client-protocol/engine-tasks.js";

const MAX_MEMBERS_FILE_BYTES = 1024 * 1024;
const MAX_BOARD_READ_BYTES = 2 * 1024 * 1024;
const MAX_SWARM_MEMBERS = 64;
const MAX_SWARM_POSTS = 200;

export type SwarmFileSignature = {
  mtimeMs: number;
  size: number;
  hash: string;
};

export type SwarmBoardFileCache = {
  membersMtimeMs: number;
  membersSize: number;
  boardMtimeMs: number;
  boardSize: number;
  parsed: ParsedSwarmFiles;
};

export type AcpSwarmMember = SwarmMember & {
  startedAt?: number;
  conversationId?: string;
  /** True when the member's state was inferred solely from a generic tool call rather than explicit swarm state. */
  inferredState?: boolean;
};

export type AcpSwarmState = {
  active: boolean;
  stoppedByUser: boolean;
  timedOut?: boolean;
  title?: string;
  startedAt: number;
  updatedAt: number;
  /** Snapshot of any pre-existing members.json file when this swarm started, to ignore stale files from earlier swarms. */
  baselineMembersSig?: SwarmFileSignature;
  members: Map<string, AcpSwarmMember>;
  posts: SwarmPost[];
};

export type ParsedSwarmFiles = {
  found: boolean;
  formatUnknown: boolean;
  active: boolean;
  explicitlyStopped?: boolean;
  title?: string;
  members: AcpSwarmMember[];
  posts: SwarmPost[];
  updatedAt: number;
  fileMtimeMs?: number;
  membersMtimeMs?: number;
  membersSize?: number;
  membersHash?: string;
};

export function emptyParsedSwarmFiles(now = Date.now()): ParsedSwarmFiles {
  return { found: false, formatUnknown: false, active: false, members: [], posts: [], updatedAt: now };
}

/** Matches only exact Antigravity swarm management tool names (never broad /board/i tools like whiteboard/clipboard/dashboard). */
export function isSwarmToolName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim().toLowerCase();
  return trimmed === "swarm" || /^swarm[_.:/-]/.test(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return asNumber < 1e12 ? Math.round(asNumber * 1000) : Math.round(asNumber);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

export function isSwarmHelperRole(role?: string, name?: string): boolean {
  const normalizedRole = role?.trim().toLowerCase() ?? "";
  const normalizedName = name?.trim().toLowerCase().replace(/^@/, "") ?? "";
  return normalizedRole === "monitor" || normalizedRole === "narrator"
    || normalizedName === "monitor" || normalizedName === "narrator";
}

export function normalizeSwarmMemberState(raw: unknown): SwarmMemberState {
  if (typeof raw !== "string") return "unknown";
  const value = raw.trim().toLowerCase();
  if (!value) return "unknown";
  if (["working", "running", "active", "in_progress", "busy", "started"].includes(value)) return "working";
  if (["waiting", "idle", "asleep", "sleeping", "sleep", "blocked", "pending"].includes(value)) return "waiting";
  if (["killed", "stopped", "cancelled", "canceled", "terminated", "dead", "aborted"].includes(value)) return "killed";
  if (["done", "completed", "finished", "complete", "succeeded", "success"].includes(value)) return "done";
  if (["paused", "quota_paused", "quota_exhausted", "rate_limited"].includes(value)) return "paused";
  return "unknown";
}

export function swarmStateToEngineStatus(state: SwarmMemberState): EngineTask["status"] {
  switch (state) {
    case "working":
    case "waiting":
    case "paused":
      return "running";
    case "killed":
      return "stopped";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

export function isSwarmMemberActive(state: SwarmMemberState): boolean {
  return state === "working" || state === "waiting" || state === "paused";
}

/** True only when swarm work is genuinely executing (`working` primary workers, or freshly launched empty roster).
 * Permanently `paused` (quota-exhausted) or all-`waiting` idle swarms are NOT actively executing. */
export function hasActiveSwarmExecution(snapshot: SwarmSnapshot | undefined): boolean {
  if (!snapshot?.active) return false;
  if (snapshot.members.length === 0) return true;
  const primary = snapshot.members.filter((m) => !m.helper);
  const pool = primary.length > 0 ? primary : snapshot.members;
  return pool.some((m) => m.state === "working");
}

export function swarmTaskId(sessionId: string, name: string): string {
  return `sw_${createHash("sha256").update(`${sessionId}\0${name}`).digest("hex").slice(0, 24)}`;
}

export function resolveAntigravityBrainDir(env?: NodeJS.ProcessEnv, explicitBrainDir?: string): string {
  if (explicitBrainDir?.trim()) return path.resolve(explicitBrainDir.trim());
  const home = process.platform === "win32"
    ? (env?.USERPROFILE ?? env?.HOME ?? os.homedir())
    : (env?.HOME ?? env?.USERPROFILE ?? os.homedir());
  return path.join(home, ".gemini", "antigravity-cli", "brain");
}

function resolveSwarmDir(brainDir: string, sessionId: string): string | null {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId === "." || sessionId === "..") return null;
  const root = path.resolve(brainDir);
  const target = path.resolve(root, sessionId, ".system_generated", "swarm");
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

type BoundedFileRead = {
  text: string;
  truncated: boolean;
  mtimeMs: number;
  size: number;
  hash: string;
};

async function readBoundedText(filePath: string, maxBytes: number, fromTail = false, includeHash = false): Promise<BoundedFileRead | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.size === 0) {
      return {
        text: "",
        truncated: false,
        mtimeMs: info.mtimeMs,
        size: 0,
        hash: includeHash ? createHash("sha256").update("").digest("hex") : "",
      };
    }
    const length = Math.min(info.size, maxBytes);
    const offset = fromTail ? Math.max(0, info.size - length) : 0;
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, offset);
    const slice = buffer.subarray(0, result.bytesRead);
    return {
      text: slice.toString("utf8"),
      truncated: info.size > maxBytes,
      mtimeMs: info.mtimeMs,
      size: info.size,
      hash: includeHash ? createHash("sha256").update(slice).digest("hex") : "",
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function readBoundedTextSync(filePath: string, maxBytes: number, fromTail = false, includeHash = false): BoundedFileRead | null {
  let fd: number | undefined;
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return null;
    if (info.size === 0) {
      return {
        text: "",
        truncated: false,
        mtimeMs: info.mtimeMs,
        size: 0,
        hash: includeHash ? createHash("sha256").update("").digest("hex") : "",
      };
    }
    fd = openSync(filePath, "r");
    const length = Math.min(info.size, maxBytes);
    const offset = fromTail ? Math.max(0, info.size - length) : 0;
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    const slice = buffer.subarray(0, bytesRead);
    return {
      text: slice.toString("utf8"),
      truncated: info.size > maxBytes,
      mtimeMs: info.mtimeMs,
      size: info.size,
      hash: includeHash ? createHash("sha256").update(slice).digest("hex") : "",
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function hasMemberFields(record: Record<string, unknown>): boolean {
  return record.state !== undefined
    || record.status !== undefined
    || record.role !== undefined
    || record.model !== undefined
    || record.modelId !== undefined
    || record.latestActivity !== undefined
    || record.activity !== undefined
    || record.lastActivity !== undefined
    || record.statusText !== undefined
    || record.lastMessage !== undefined
    || record.conversationId !== undefined
    || record.sessionId !== undefined;
}

export function snapshotSwarmMembersFileSync(brainDir: string, sessionId: string): SwarmFileSignature | undefined {
  const swarmDir = resolveSwarmDir(brainDir, sessionId);
  if (!swarmDir) return undefined;
  const raw = readBoundedTextSync(path.join(swarmDir, "members.json"), MAX_MEMBERS_FILE_BYTES, false, true);
  if (!raw) return undefined;
  return { mtimeMs: raw.mtimeMs, size: raw.size, hash: raw.hash };
}

function normalizeMemberName(raw: string): string {
  return raw.trim().replace(/^@+/, "").slice(0, 128);
}

function normalizeMemberEntry(raw: unknown, fallbackName?: string, now = Date.now()): AcpSwarmMember | null {
  const record = asRecord(raw);
  if (!record) return null;
  const rawName = nonEmptyString(record.name, 128)
    ?? nonEmptyString(record.member, 128)
    ?? nonEmptyString(record.worker, 128)
    ?? nonEmptyString(record.agent, 128)
    ?? nonEmptyString(record.id, 128)
    ?? fallbackName;
  const name = rawName ? normalizeMemberName(rawName) : "";
  if (!name) return null;
  const role = nonEmptyString(record.role, 64) ?? nonEmptyString(record.type, 64);
  const state = normalizeSwarmMemberState(record.state ?? record.status);
  const model = nonEmptyString(record.model, 160) ?? nonEmptyString(record.modelId, 160);
  const latestActivity = nonEmptyString(record.latestActivity, 2000)
    ?? nonEmptyString(record.activity, 2000)
    ?? nonEmptyString(record.lastActivity, 2000)
    ?? nonEmptyString(record.statusText, 2000)
    ?? nonEmptyString(record.lastMessage, 2000)
    ?? nonEmptyString(record.summary, 2000)
    ?? nonEmptyString(record.task, 2000);
  const conversationId = nonEmptyString(record.conversationId, 128) ?? nonEmptyString(record.sessionId, 128);
  const updatedAt = parseTimestamp(record.updatedAt ?? record.updated_at ?? record.lastSeenAt ?? record.timestamp, now);
  const startedAt = record.startedAt !== undefined || record.started_at !== undefined || record.createdAt !== undefined
    ? parseTimestamp(record.startedAt ?? record.started_at ?? record.createdAt, updatedAt)
    : undefined;
  const helper = isSwarmHelperRole(role, name);
  return {
    name,
    ...(role ? { role } : {}),
    ...(helper ? { helper: true } : {}),
    state,
    ...(model ? { model } : {}),
    ...(latestActivity ? { latestActivity } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    updatedAt,
  };
}

function extractMentions(text: string, rawMentions?: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (value: string) => {
    const clean = normalizeMemberName(value);
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    result.push(clean);
  };
  if (Array.isArray(rawMentions)) {
    for (const item of rawMentions) if (typeof item === "string") push(item);
  }
  for (const match of text.matchAll(/(?:^|[\s(])@([A-Za-z0-9._-]{1,64})/g)) {
    if (match[1]) push(match[1]);
  }
  return result.slice(0, 32);
}

function normalizePostEntry(raw: unknown, index: number, fallbackTime: number): SwarmPost | null {
  const record = asRecord(raw);
  if (!record) return null;
  const content = nonEmptyString(record.content, 16_000)
    ?? nonEmptyString(record.body, 16_000)
    ?? nonEmptyString(record.text, 16_000)
    ?? nonEmptyString(record.message, 16_000)
    ?? nonEmptyString(record.summary, 16_000);
  const title = nonEmptyString(record.title, 300) ?? nonEmptyString(record.subject, 300);
  if (!content && !title) return null;
  const authorRaw = nonEmptyString(record.author, 128)
    ?? nonEmptyString(record.from, 128)
    ?? nonEmptyString(record.sender, 128)
    ?? nonEmptyString(record.member, 128)
    ?? nonEmptyString(record.worker, 128)
    ?? nonEmptyString(record.name, 128)
    ?? "system";
  const author = normalizeMemberName(authorRaw) || "system";
  const createdAt = parseTimestamp(record.createdAt ?? record.created_at ?? record.timestamp ?? record.ts ?? record.time, fallbackTime + index);
  const id = nonEmptyString(record.id, 128)
    ?? nonEmptyString(record.postId, 128)
    ?? `post_${createHash("sha256").update(`${author}\0${createdAt}\0${title ?? ""}\0${(content ?? "").slice(0, 200)}`).digest("hex").slice(0, 16)}`;
  const body = content ?? title ?? "";
  const mentions = extractMentions(body, record.mentions ?? record.to);
  const kind = nonEmptyString(record.kind, 64) ?? nonEmptyString(record.type, 64);
  return {
    id,
    author,
    ...(mentions.length ? { mentions } : {}),
    ...(title && title !== body ? { title } : {}),
    content: body,
    ...(kind ? { kind } : {}),
    createdAt,
  };
}

function parseSwarmBoardContents(membersRaw: BoundedFileRead | null, boardRaw: BoundedFileRead | null, now = Date.now()): ParsedSwarmFiles {
  if (!membersRaw && !boardRaw) return emptyParsedSwarmFiles(now);

  let formatUnknown = false;
  let title: string | undefined;
  let explicitStatus: string | undefined;
  const members: AcpSwarmMember[] = [];
  let maxTimestamp = 0;
  const memberFallbackTime = membersRaw?.mtimeMs ? Math.round(membersRaw.mtimeMs) : now;
  const boardFallbackTime = boardRaw?.mtimeMs ? Math.round(boardRaw.mtimeMs) : now;

  if (membersRaw && membersRaw.text.trim()) {
    try {
      const parsed = JSON.parse(membersRaw.text) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const member = normalizeMemberEntry(item, undefined, memberFallbackTime);
          if (member) members.push(member);
        }
        if (parsed.length > 0 && members.length === 0) formatUnknown = true;
      } else {
        const record = asRecord(parsed);
        if (!record) {
          formatUnknown = true;
        } else {
          title = nonEmptyString(record.title, 300) ?? nonEmptyString(record.goal, 300) ?? nonEmptyString(record.topic, 300);
          explicitStatus = nonEmptyString(record.status, 64)?.toLowerCase() ?? nonEmptyString(record.state, 64)?.toLowerCase();
          const list = Array.isArray(record.members) ? record.members
            : Array.isArray(record.workers) ? record.workers
              : Array.isArray(record.roster) ? record.roster
                : undefined;
          if (list) {
            for (const item of list) {
              const member = normalizeMemberEntry(item, undefined, memberFallbackTime);
              if (member) members.push(member);
            }
            if (list.length > 0 && members.length === 0) formatUnknown = true;
          } else {
            const explicitMap = asRecord(record.members) ?? asRecord(record.workers) ?? asRecord(record.roster);
            if (explicitMap) {
              for (const [key, value] of Object.entries(explicitMap)) {
                const entryRecord = asRecord(value);
                if (!entryRecord) continue;
                const member = normalizeMemberEntry(entryRecord, key, memberFallbackTime);
                if (member) members.push(member);
              }
              if (Object.keys(explicitMap).length > 0 && members.length === 0) formatUnknown = true;
            } else {
              for (const [key, value] of Object.entries(record)) {
                if (["title", "goal", "topic", "status", "state", "updatedAt", "createdAt", "updated_at", "created_at"].includes(key)) continue;
                const entryRecord = asRecord(value);
                if (entryRecord && hasMemberFields(entryRecord)) {
                  const member = normalizeMemberEntry(entryRecord, key, memberFallbackTime);
                  if (member) members.push(member);
                }
              }
              if (Object.keys(record).length > 0 && members.length === 0) formatUnknown = true;
            }
          }
        }
      }
    } catch {
      formatUnknown = true;
    }
  }

  const posts: SwarmPost[] = [];
  if (boardRaw && boardRaw.text.trim()) {
    const lines = boardRaw.text.split("\n");
    if (boardRaw.truncated) lines.shift();
    let nonEmptyLines = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      nonEmptyLines++;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const record = asRecord(parsed);
        if (record && !title) {
          title = nonEmptyString(record.swarmTitle, 300) ?? nonEmptyString(record.goal, 300);
        }
        const post = normalizePostEntry(parsed, posts.length, boardFallbackTime);
        if (post) {
          posts.push(post);
          if (post.createdAt > maxTimestamp) maxTimestamp = post.createdAt;
        }
      } catch {
        // Ignore individual malformed lines.
      }
    }
    if (nonEmptyLines > 0 && posts.length === 0) formatUnknown = true;
  }

  const latestByAuthor = new Map<string, SwarmPost>();
  for (const post of posts) {
    const prev = latestByAuthor.get(post.author.toLowerCase());
    if (!prev || post.createdAt >= prev.createdAt) latestByAuthor.set(post.author.toLowerCase(), post);
  }
  for (const member of members) {
    const updated = member.updatedAt ?? 0;
    if (updated > maxTimestamp) maxTimestamp = updated;
    const latest = latestByAuthor.get(member.name.toLowerCase());
    if (latest) {
      if (!member.latestActivity) member.latestActivity = (latest.title ? `${latest.title}: ${latest.content}` : latest.content).slice(0, 2000);
      if (latest.createdAt > updated) member.updatedAt = latest.createdAt;
    }
  }

  const hasLiveMember = members.some((m) => isSwarmMemberActive(m.state));
  const explicitlyStopped = explicitStatus !== undefined && ["done", "completed", "stopped", "killed", "finished"].includes(explicitStatus);
  const explicitlyActive = explicitStatus !== undefined && ["running", "active", "working"].includes(explicitStatus);
  const active = explicitlyStopped ? false : (hasLiveMember || (explicitlyActive && members.length === 0));
  const fileMtimeMs = Math.max(membersRaw?.mtimeMs ?? 0, boardRaw?.mtimeMs ?? 0) || undefined;

  return {
    found: true,
    formatUnknown,
    active,
    ...(explicitlyStopped ? { explicitlyStopped: true } : {}),
    ...(title ? { title } : {}),
    members: members.slice(0, MAX_SWARM_MEMBERS),
    posts: posts.slice(-MAX_SWARM_POSTS),
    updatedAt: maxTimestamp || (fileMtimeMs ? Math.round(fileMtimeMs) : now),
    ...(fileMtimeMs !== undefined ? { fileMtimeMs } : {}),
    ...(membersRaw ? { membersMtimeMs: membersRaw.mtimeMs, membersSize: membersRaw.size, membersHash: membersRaw.hash } : {}),
  };
}

export async function readSwarmBoardFiles(brainDir: string, sessionId: string): Promise<ParsedSwarmFiles> {
  const now = Date.now();
  const swarmDir = resolveSwarmDir(brainDir, sessionId);
  if (!swarmDir) return emptyParsedSwarmFiles(now);

  const [membersRaw, boardRaw] = await Promise.all([
    readBoundedText(path.join(swarmDir, "members.json"), MAX_MEMBERS_FILE_BYTES, false, true),
    readBoundedText(path.join(swarmDir, "board.jsonl"), MAX_BOARD_READ_BYTES, true, false),
  ]);
  return parseSwarmBoardContents(membersRaw, boardRaw, now);
}

/**
 * Synchronous mtime/size-cached board file reader for synchronous lifecycle checks
 * (`hasPendingNativeWork`, `requestStop`, and resumed session initialization).
 */
export function readSwarmBoardFilesSync(
  brainDir: string,
  sessionId: string,
  previousCache?: SwarmBoardFileCache,
): { cache: SwarmBoardFileCache | undefined; parsed: ParsedSwarmFiles } {
  const now = Date.now();
  const swarmDir = resolveSwarmDir(brainDir, sessionId);
  if (!swarmDir) return { cache: undefined, parsed: emptyParsedSwarmFiles(now) };

  const membersPath = path.join(swarmDir, "members.json");
  const boardPath = path.join(swarmDir, "board.jsonl");
  let membersStat: Stats | undefined;
  let boardStat: Stats | undefined;
  try { membersStat = statSync(membersPath); } catch { /* missing */ }
  try { boardStat = statSync(boardPath); } catch { /* missing */ }
  const hasMembers = Boolean(membersStat?.isFile());
  const hasBoard = Boolean(boardStat?.isFile());
  if (!hasMembers && !hasBoard) return { cache: undefined, parsed: emptyParsedSwarmFiles(now) };

  const membersMtimeMs = hasMembers ? membersStat!.mtimeMs : -1;
  const membersSize = hasMembers ? membersStat!.size : -1;
  const boardMtimeMs = hasBoard ? boardStat!.mtimeMs : -1;
  const boardSize = hasBoard ? boardStat!.size : -1;
  if (
    previousCache
    && previousCache.membersMtimeMs === membersMtimeMs
    && previousCache.membersSize === membersSize
    && previousCache.boardMtimeMs === boardMtimeMs
    && previousCache.boardSize === boardSize
  ) {
    return { cache: previousCache, parsed: previousCache.parsed };
  }

  const membersRaw = hasMembers ? readBoundedTextSync(membersPath, MAX_MEMBERS_FILE_BYTES, false, true) : null;
  const boardRaw = hasBoard ? readBoundedTextSync(boardPath, MAX_BOARD_READ_BYTES, true, false) : null;
  const parsed = parseSwarmBoardContents(membersRaw, boardRaw, now);
  return {
    cache: parsed.found ? { membersMtimeMs, membersSize, boardMtimeMs, boardSize, parsed } : undefined,
    parsed,
  };
}

export function mergeSwarmSnapshots(
  acpSwarm: AcpSwarmState | undefined,
  fileSwarm: ParsedSwarmFiles,
  options: { sessionId?: string } = {},
): SwarmSnapshot | undefined {
  if (!acpSwarm && !fileSwarm.found) return undefined;

  const terminated = Boolean(acpSwarm?.stoppedByUser || acpSwarm?.timedOut);
  const byName = new Map<string, AcpSwarmMember>();
  for (const member of fileSwarm.members) {
    byName.set(member.name.toLowerCase(), { ...member });
  }
  if (acpSwarm) {
    for (const member of acpSwarm.members.values()) {
      const key = member.name.toLowerCase();
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { ...member });
      } else {
        const memberUpdated = member.updatedAt ?? 0;
        const existingUpdated = existing.updatedAt ?? 0;
        const acpNewer = memberUpdated > existingUpdated;
        byName.set(key, {
          name: existing.name || member.name,
          role: (acpNewer ? member.role : existing.role) ?? member.role ?? existing.role,
          ...(existing.helper || member.helper ? { helper: true } : {}),
          state: terminated && isSwarmMemberActive(existing.state)
            ? "killed"
            : member.inferredState && existing.state !== "unknown"
              ? existing.state
              : (acpNewer && member.state !== "unknown" ? member.state : existing.state !== "unknown" ? existing.state : member.state),
          model: (acpNewer ? member.model : existing.model) ?? member.model ?? existing.model,
          latestActivity: (acpNewer ? member.latestActivity : existing.latestActivity) ?? member.latestActivity ?? existing.latestActivity,
          startedAt: existing.startedAt ?? member.startedAt,
          updatedAt: Math.max(existingUpdated, memberUpdated),
        });
      }
    }
  }

  const members = [...byName.values()].map((m): SwarmMember => {
    const state = terminated && isSwarmMemberActive(m.state) ? "killed" : m.state;
    return {
      name: m.name,
      ...(m.role ? { role: m.role } : {}),
      ...(m.helper || isSwarmHelperRole(m.role, m.name) ? { helper: true } : {}),
      state,
      ...(m.model ? { model: m.model } : {}),
      ...(m.latestActivity ? { latestActivity: m.latestActivity.slice(0, 2000) } : {}),
      updatedAt: m.updatedAt,
    };
  }).slice(0, MAX_SWARM_MEMBERS);

  const postMap = new Map<string, SwarmPost>();
  for (const post of fileSwarm.posts) postMap.set(post.id, post);
  if (acpSwarm) for (const post of acpSwarm.posts) postMap.set(post.id, post);
  const posts = [...postMap.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_SWARM_POSTS);

  const hasLiveMember = members.some((m) => isSwarmMemberActive(m.state));
  const active = terminated
    ? false
    : Boolean(hasLiveMember || fileSwarm.active || (acpSwarm?.active && members.length === 0));
  const title = fileSwarm.title ?? acpSwarm?.title;
  const source: SwarmSnapshot["source"] = acpSwarm && fileSwarm.found ? "merged" : fileSwarm.found ? "files" : "acp";
  const updatedAt = Math.max(
    fileSwarm.updatedAt,
    acpSwarm?.updatedAt ?? 0,
    ...members.map((m) => m.updatedAt ?? 0),
    ...posts.map((p) => p.createdAt),
  ) || Date.now();
  const statusText = acpSwarm?.stoppedByUser
    ? "Stopped by user"
    : acpSwarm?.timedOut
      ? "Swarm timed out"
      : active
        ? (members.length ? undefined : "Swarm running")
        : undefined;

  void options.sessionId;
  return {
    active,
    ...(title ? { title } : {}),
    ...(statusText ? { statusText } : {}),
    source,
    ...(fileSwarm.formatUnknown ? { formatUnknown: true } : {}),
    members,
    posts,
    updatedAt,
  };
}

export function swarmMembersToEngineTasks(sessionId: string, snapshot: SwarmSnapshot | undefined, fallbackStartedAt?: number): EngineTask[] {
  if (!snapshot) return [];
  return snapshot.members
    .filter((m) => m.name.toLowerCase() !== "system")
    .map((m): EngineTask => ({
      id: swarmTaskId(sessionId, m.name),
      label: m.name,
      kind: "subagent",
      mode: "background",
      status: swarmStateToEngineStatus(m.state),
      canStop: false,
      startedAt: fallbackStartedAt,
      updatedAt: m.updatedAt ?? snapshot.updatedAt,
      ...(m.latestActivity ? { progress: m.latestActivity } : {}),
      owner: "bound",
      ...(m.role ? { role: m.role } : {}),
      swarmState: m.state,
      ...(m.model ? { model: m.model } : {}),
      ...(m.helper ? { helper: true } : {}),
    }));
}

export function extractWorkerAttribution(params: unknown, trackedWorkerName?: string): string | undefined {
  const root = asRecord(params);
  const meta = asRecord(root?._meta);
  const toolCall = asRecord(root?.toolCall);
  const toolMeta = asRecord(toolCall?._meta);
  const rawInput = asRecord(toolCall?.rawInput);

  const candidates: Array<unknown> = [
    meta?.workerName, meta?.memberName, meta?.agentName, meta?.subagentName, meta?.worker, meta?.member, meta?.sender, meta?.agent, meta?.author,
    toolMeta?.workerName, toolMeta?.memberName, toolMeta?.agentName, toolMeta?.subagentName, toolMeta?.worker, toolMeta?.member, toolMeta?.sender, toolMeta?.agent, toolMeta?.author,
    toolCall?.workerName, toolCall?.memberName, toolCall?.agentName, toolCall?.subagentName, toolCall?.actor,
    rawInput?.workerName, rawInput?.memberName, rawInput?.agentName,
    trackedWorkerName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const normalized = normalizeMemberName(candidate);
      if (normalized && normalized.toLowerCase() !== "system") return normalized;
    }
  }
  const title = nonEmptyString(toolCall?.title, 200);
  if (title) {
    const atPrefix = title.match(/^@([A-Za-z0-9._-]{1,64})(?::|\s+[-–—]\s+)/);
    if (atPrefix?.[1] && atPrefix[1].toLowerCase() !== "system") return atPrefix[1];
    const bracketPrefix = title.match(/^\[([A-Za-z0-9._-]{1,64})\]\s+/);
    if (bracketPrefix?.[1] && bracketPrefix[1].toLowerCase() !== "system") return bracketPrefix[1];
  }
  return undefined;
}

export function applySwarmAcpUpdate(
  swarm: AcpSwarmState,
  update: Record<string, unknown>,
  now = Date.now(),
  options: { hasOtherOpenWorkerTools?: boolean } = {},
): void {
  const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  const meta = asRecord(update._meta);
  const rawInput = asRecord(update.rawInput);
  const rawOutput = asRecord(update.rawOutput);
  const toolName = (nonEmptyString(update.name, 128) ?? "").toLowerCase();

  // Explicit swarm-specific ACP updates if emitted by agy.
  if (kind.startsWith("swarm")) {
    swarm.updatedAt = now;
    const title = nonEmptyString(update.title, 300) ?? nonEmptyString(update.goal, 300);
    if (title) swarm.title = title;
    const status = nonEmptyString(update.status, 64)?.toLowerCase();
    const hasExplicitStatus = Boolean(status);
    if (status && ["done", "completed", "stopped", "killed", "finished"].includes(status)) swarm.active = false;
    else if (status && ["running", "active", "working"].includes(status)) swarm.active = true;

    let updatedMembers = false;
    if (Array.isArray(update.members)) {
      updatedMembers = true;
      for (const item of update.members) {
        const m = normalizeMemberEntry(item, undefined, now);
        if (m) swarm.members.set(m.name.toLowerCase(), { ...m, inferredState: false });
      }
    }
    const singleMember = normalizeMemberEntry(update.member ?? (update.name && (update.state || update.status) ? update : undefined), undefined, now);
    if (singleMember) {
      updatedMembers = true;
      swarm.members.set(singleMember.name.toLowerCase(), { ...singleMember, inferredState: false });
    }
    if (updatedMembers && !hasExplicitStatus && swarm.members.size > 0) {
      swarm.active = [...swarm.members.values()].some((m) => isSwarmMemberActive(m.state));
    }

    const post = normalizePostEntry(update.post ?? (update.content && update.author ? update : undefined), swarm.posts.length, now);
    if (post && !swarm.posts.some((existing) => existing.id === post.id)) {
      swarm.posts.push(post);
      if (swarm.posts.length > MAX_SWARM_POSTS) swarm.posts.splice(0, swarm.posts.length - MAX_SWARM_POSTS);
    }
    return;
  }

  const toolFinished = update.status === "completed" || update.status === "failed";

  // Explicit swarm management tool calls (never broad /board/i matches).
  if (isSwarmToolName(toolName)) {
    swarm.updatedAt = now;
    const action = nonEmptyString(rawInput?.action, 64)?.toLowerCase();
    if (action === "title") {
      const title = nonEmptyString(rawInput?.title, 300);
      if (title) swarm.title = title;
      return;
    }
    if (action === "status" || action === "models") return;
    const candidateName = nonEmptyString(rawInput?.name, 128) ?? nonEmptyString(rawInput?.worker, 128) ?? nonEmptyString(rawInput?.member, 128);
    if (candidateName) {
      const clean = normalizeMemberName(candidateName);
      if (clean && clean.toLowerCase() !== "system") {
        const existing = swarm.members.get(clean.toLowerCase());
        const role = nonEmptyString(rawInput?.role, 64) ?? existing?.role;
        const model = nonEmptyString(rawInput?.model, 160) ?? existing?.model;
        const isKill = action === "kill" || toolName.includes("kill") || toolName.includes("stop");
        const explicitState = rawInput?.state ?? rawOutput?.state;
        const state = isKill
          ? "killed"
          : explicitState !== undefined
            ? normalizeSwarmMemberState(explicitState)
            : update.status === "failed" && !existing
              ? "done"
              : (existing?.state ?? "working");
        const activity = nonEmptyString(rawInput?.brief, 500) ?? nonEmptyString(rawInput?.task, 500) ?? nonEmptyString(rawInput?.prompt, 500) ?? nonEmptyString(update.title, 500) ?? existing?.latestActivity;
        swarm.members.set(clean.toLowerCase(), {
          name: existing?.name ?? clean,
          ...(role ? { role } : {}),
          ...(isSwarmHelperRole(role, clean) ? { helper: true } : {}),
          state,
          inferredState: false,
          ...(model ? { model } : {}),
          ...(activity ? { latestActivity: activity } : {}),
          startedAt: existing?.startedAt ?? now,
          updatedAt: now,
        });
        if (isKill && swarm.members.size > 0 && ![...swarm.members.values()].some((m) => isSwarmMemberActive(m.state))) {
          swarm.active = false;
        }
      }
    }
    return;
  }

  // Tool call or metadata hints from ACP when a swarm already exists.
  const workerName = extractWorkerAttribution({ _meta: meta, toolCall: update });
  if (workerName) {
    const existing = swarm.members.get(workerName.toLowerCase());
    const model = nonEmptyString(meta?.model, 160) ?? nonEmptyString(rawInput?.model, 160) ?? existing?.model;
    const role = nonEmptyString(meta?.role, 64) ?? nonEmptyString(rawInput?.role, 64) ?? existing?.role;
    const explicitState = meta?.state ?? rawOutput?.state;
    let state: SwarmMemberState;
    let inferredState: boolean;
    if (explicitState !== undefined) {
      state = normalizeSwarmMemberState(explicitState);
      inferredState = false;
    } else if (toolFinished) {
      if (!options.hasOtherOpenWorkerTools && (!existing || existing.inferredState)) {
        state = "done";
        inferredState = true;
      } else {
        state = existing?.state ?? "working";
        inferredState = existing?.inferredState ?? true;
      }
    } else {
      state = !existing || existing.inferredState ? "working" : existing.state;
      inferredState = !existing || Boolean(existing.inferredState);
    }
    const activity = nonEmptyString(update.title, 500) ?? nonEmptyString(rawInput?.CommandLine, 500) ?? existing?.latestActivity;
    swarm.members.set(workerName.toLowerCase(), {
      name: existing?.name ?? workerName,
      ...(role ? { role } : {}),
      ...(isSwarmHelperRole(role, workerName) ? { helper: true } : {}),
      state,
      inferredState,
      ...(model ? { model } : {}),
      ...(activity ? { latestActivity: activity } : {}),
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    });
    swarm.updatedAt = now;
  }
}

export function renderSwarmBoardSummary(snapshot: SwarmSnapshot | undefined, locale: "en" | "zh"): string {
  if (!snapshot) {
    return locale === "en"
      ? "No swarm is active or recorded in this conversation yet. Start one with `/swarm <task>`."
      : "当前会话还没有进行中或已记录的 Swarm。可发送 `/swarm <任务>` 启动。";
  }
  const title = snapshot.title ? `Swarm · ${snapshot.title}` : "Swarm";
  const status = snapshot.active
    ? (locale === "en" ? "Active" : "进行中")
    : (snapshot.statusText === "Stopped by user"
      ? (locale === "en" ? "Stopped" : "已停止")
      : snapshot.statusText === "Swarm timed out"
        ? (locale === "en" ? "Timed out" : "已超时")
        : (locale === "en" ? "Finished" : "已结束"));
  const lines = [`**${title}** (${status})`];
  if (snapshot.members.length) {
    lines.push("", locale === "en" ? "**Members**" : "**成员状态**");
    for (const m of snapshot.members) {
      const model = m.model ? ` · \`${m.model}\`` : "";
      const role = m.role ? ` (${m.role})` : "";
      const activity = m.latestActivity ? ` — ${m.latestActivity.slice(0, 120)}` : "";
      lines.push(`- \`@${m.name}\`${role} [${m.state}]${model}${activity}`);
    }
  } else if (snapshot.formatUnknown) {
    lines.push("", locale === "en" ? "Swarm is running (board file format not recognized)." : "Swarm 正在运行（看板文件格式暂无法解析）。");
  }
  if (snapshot.posts.length) {
    lines.push("", locale === "en" ? "**Recent board posts**" : "**最近看板动态**");
    for (const post of snapshot.posts.slice(-5)) {
      const excerpt = post.content.replace(/\s+/g, " ").slice(0, 180);
      lines.push(`- **${post.author}**: ${excerpt}`);
    }
  }
  return lines.join("\n");
}

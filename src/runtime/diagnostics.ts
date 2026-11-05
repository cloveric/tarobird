import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { diagnosticQuerySchema, type DiagnosticEvent, type DiagnosticPage, type DiagnosticQuery } from "../client-protocol/diagnostics.js";
import { AuditEventSchema } from "../state/audit-log-schema.js";
import { TimelineEventSchema } from "../state/timeline-log-schema.js";
import { summarizeTimelineEvents, type TimelineEvent } from "../state/timeline-log.js";
import { redactLogMetadata } from "../state/log-redaction.js";
import { redactSecrets } from "../runtime/secret-redaction.js";
import { DEFAULT_ROTATE_OPTIONS } from "../state/log-rotation.js";

// Display limits keep a 50-row page comfortably below the 1 MiB RPC frame.
// Redact the complete value before shortening it; never cut a secret assignment
// in half before the shared scrubber has seen it.
export function diagnosticEvent(raw: Record<string, unknown>, id: string): DiagnosticEvent {
  let truncated = false;
  const text = (value: unknown, max = 240) => {
    const clean = Buffer.from(redactSecrets(String(value ?? "")), "utf8").toString("utf8").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ");
    if (clean.length > max) truncated = true;
    const end = clean.charCodeAt(max - 1);
    return clean.slice(0, clean.length > max && end >= 0xd800 && end <= 0xdbff ? max - 1 : max);
  };
  const metadata = raw.metadata && typeof raw.metadata === "object" ? redactLogMetadata(raw.metadata) : {};
  const conversation = text(raw.conversationKey ?? raw.chatId, 200);
  const event = { id, timestamp: text(raw.timestamp, 40), type: text(raw.type, 160), outcome: text(raw.outcome, 80),
    channel: conversation.startsWith("lark:gw_") ? "gateway" : text(raw.channel, 40),
    conversation, chatId: text(raw.chatId, 40), actor: text(raw.actor ?? raw.userId, 120), detail: text(raw.detail, 1800),
    metadata: text(JSON.stringify(metadata), 2000), truncated: false };
  event.truncated = truncated; return event;
}

export class DiagnosticAccumulator {
  readonly warnings: string[] = [];
  private total = 0; private matched = 0; private eligible = 0; private reached = false;
  private rows: DiagnosticEvent[] = []; private counts: Record<string, number> = {};
  private types = new Set<string>(); private outcomes = new Set<string>(); private channels = new Set<string>();
  private lastSuccessAt?: string; private lastErrorAt?: string;
  constructor(private readonly query: DiagnosticQuery) {}
  add(event: DiagnosticEvent, timeline?: TimelineEvent, searchable?: string): void {
    this.total++; if (this.types.size < 200) this.types.add(event.type); if (event.outcome && this.outcomes.size < 200) this.outcomes.add(event.outcome); if (event.channel && this.channels.size < 200) this.channels.add(event.channel);
    const isAnchor = event.id === this.query.before; if (isAnchor) this.reached = true;
    const q = this.query, timestamp = Date.parse(event.timestamp);
    if (q.type && event.type !== q.type || q.outcome && event.outcome !== q.outcome || q.channel && event.channel !== q.channel
      || q.chat && event.conversation !== q.chat && event.chatId !== q.chat || q.from && (!Number.isFinite(timestamp) || timestamp < Date.parse(q.from)) || q.to && (!Number.isFinite(timestamp) || timestamp > Date.parse(q.to))
      || q.search && !(searchable ?? [event.type, event.outcome, event.conversation, event.actor, event.detail, event.metadata].join(" ")).toLocaleLowerCase().includes(q.search.toLocaleLowerCase())) return;
    this.matched++;
    if (event.outcome === "success" && event.timestamp) this.lastSuccessAt = event.timestamp;
    if (event.outcome === "error" && event.timestamp) this.lastErrorAt = event.timestamp;
    if (timeline) for (const [key, value] of Object.entries(summarizeTimelineEvents([timeline]))) {
      if (typeof value === "number" && key !== "totalEvents") this.counts[key] = (this.counts[key] ?? 0) + value;
    }
    if (!this.reached) { this.eligible++; this.rows.push(event); if (this.rows.length > q.limit) this.rows.shift(); }
  }
  finish(missing = false): DiagnosticPage {
    const expired = !!this.query.before && !this.reached;
    const events = expired ? [] : this.rows.reverse();
    return { events, next: !expired && this.eligible > events.length ? events.at(-1)!.id : null,
      generatedAt: new Date().toISOString(), total: this.total, matched: this.matched, counts: this.counts,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}), ...(this.lastErrorAt ? { lastErrorAt: this.lastErrorAt } : {}),
      types: [...this.types].sort(), outcomes: [...this.outcomes].sort(), channels: [...this.channels].sort(),
      warnings: this.warnings, missing, cursorExpired: expired };
  }
}

/** Read retained files through fixed handles, bounded chunks/lines and no child
 * symlinks. Appends after opening belong to the next refresh. Keep only one page
 * in memory; summaries still include every valid retained event. */
export async function readBotDiagnostics(stateDir: string, raw: unknown): Promise<DiagnosticPage> {
  const query = diagnosticQuerySchema.parse(raw), result = new DiagnosticAccumulator(query);
  const base = path.join(stateDir, `${query.source}.log.jsonl`);
  const files: { handle: FileHandle; identity: string; size: number }[] = [];
  const seen = new Set<string>(); let invalid = 0, oversized = 0, incomplete = 0;
  try {
    for (let i = 0; i <= DEFAULT_ROTATE_OPTIONS.keepCount; i++) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(i ? `${base}.${i}` : base, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat(); if (!stat.isFile()) throw new Error("not_regular");
        const identity = `${stat.dev}:${stat.ino}`;
        if (seen.has(identity)) { await handle.close(); continue; }
        seen.add(identity); files.push({ handle, identity, size: stat.size }); handle = undefined;
      } catch (error) {
        await handle?.close();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(`无法读取${i ? `轮转日志 ${i}` : "当前日志"}，统计可能不完整。`);
      }
    }
    for (const file of files.reverse()) {
      try {
        const buffer = Buffer.alloc(64 * 1024); let carry = Buffer.alloc(0), offset = 0, lineStart = 0, skipping = false;
        while (offset < file.size) {
          const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
          if (!bytesRead) { incomplete++; break; }
          let start = 0;
          for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] !== 10) continue;
            if (!skipping) {
              const line = Buffer.concat([carry, buffer.subarray(start, i)]);
              if (line.length > 256 * 1024) oversized++;
              else if (line.toString("utf8").trim()) {
                try {
                  const parsed = JSON.parse(line.toString("utf8"));
                  const valid = (query.source === "timeline" ? TimelineEventSchema : AuditEventSchema).safeParse(parsed);
                  if (!valid.success) invalid++;
                  else {
                    const id = createHash("sha256").update(`${file.identity}:${lineStart}:`).update(line).digest("hex").slice(0, 32);
                    result.add(diagnosticEvent(valid.data, id), query.source === "timeline" ? valid.data as TimelineEvent : undefined, query.search ? JSON.stringify(redactLogMetadata(valid.data)) : undefined);
                  }
                } catch { invalid++; }
              }
            }
            carry = Buffer.alloc(0); skipping = false; start = i + 1; lineStart = offset + start;
          }
          if (!skipping) {
            carry = Buffer.concat([carry, buffer.subarray(start, bytesRead)]);
            if (carry.length > 256 * 1024) { oversized++; carry = Buffer.alloc(0); skipping = true; }
          }
          offset += bytesRead;
        }
        if (carry.length || skipping) incomplete++;
      } catch { result.warnings.push("读取日志时发生错误，统计可能不完整。"); }
    }
  } finally { await Promise.allSettled(files.map(({ handle }) => handle.close())); }
  if (invalid) result.warnings.push(`已跳过 ${invalid} 条格式损坏的记录。`);
  if (oversized) result.warnings.push(`已跳过 ${oversized} 条超过 256 KiB 的记录。`);
  if (incomplete) result.warnings.push(`有 ${incomplete} 处记录尚未写完或日志读取中发生变化，请刷新。`);
  return result.finish(files.length === 0);
}

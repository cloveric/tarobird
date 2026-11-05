import type { RunEntry } from "../client-protocol/run.js";
import type { WorkspaceDiffHunk, WorkspaceDiffLine } from "../client-protocol/workspace-diff.js";
import { isCredentialStylePath } from "../runtime/credential-files.js";

const utf8 = new TextEncoder();
export const generatedChange = (file: string) => /(?:^|[\\/])(?:node_modules|dist|build|coverage|vendor)[\\/]/i.test(file) || /(?:^|[\\/])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$|\.(?:min\.(?:js|css)|map|generated\.[^/]+)$/i.test(file);
/** Native add/delete receipts contain the complete side, not a unified patch. */
export function wholeFilePatch(text: string, side: "add" | "delete"): string {
  const lines = text ? text.replace(/\r\n/g, "\n").split("\n") : [];
  if (text.endsWith("\n")) lines.pop();
  const header = side === "add" ? `@@ -0,0 +${lines.length ? 1 : 0},${lines.length} @@` : `@@ -${lines.length ? 1 : 0},${lines.length} +0,0 @@`;
  return [header, ...lines.map(line => (side === "add" ? "+" : "-") + line), ...(text && !text.endsWith("\n") ? ["\\ No newline at end of file"] : [])].join("\n");
}
export type RecordedPatch = { format: "unified" | "signed" | "raw" | "empty" | "binary"; hunks: WorkspaceDiffHunk[]; additions: number | null; deletions: number | null; partial: boolean; rows: number; bytes: number };
/** Engine evidence only. Never opens a path, executes Git, or invents coordinates. */
export function parseRecordedPatch(text: string, limit = 1000): RecordedPatch {
  const result: RecordedPatch = { format: "empty", hunks: [], additions: null, deletions: null, partial: false, rows: 0, bytes: utf8.encode(text).length };
  if (!text) return result;
  if (text.includes("\0") || /(?:^|\n)(?:Binary files |GIT binary patch)/.test(text)) return { ...result, format: "binary" };
  const lines = text.replace(/\r\n/g, "\n").split("\n"); if (lines.at(-1) === "") lines.pop();
  const hasHeaders = lines.some(line => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
  if (!hasHeaders) {
    const signed = lines.every(line => /^[ +\\-]/.test(line)); result.format = signed ? "signed" : "raw";
    // Legacy ACP receipts can be whole old/new sides, not a minimal line diff.
    // Prefixes describe presentation only; counting them would overstate edits.
    result.additions = null; result.deletions = null;
    result.rows = lines.length + 1;
    result.hunks = [{ header: "", oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines: lines.slice(0, Math.max(0, limit - 1)).map(line => ({
      kind: signed ? line[0] === "+" ? "add" : line[0] === "-" ? "delete" : "context" : "meta",
      text: (signed ? line.slice(1) : line).slice(0, 4096), clipped: (signed ? line.length - 1 : line.length) > 4096, oldLine: null, newLine: null,
    })) }];
    return result;
  }
  result.format = "unified"; result.additions = 0; result.deletions = 0;
  let hunk: WorkspaceDiffHunk | undefined, old = 0, fresh = 0, oldLeft = 0, newLeft = 0, lastOld = 0, lastNew = 0;
  const finish = () => { if (hunk && (oldLeft !== 0 || newLeft !== 0)) result.partial = true; };
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      finish(); old = Number(header[1]); fresh = Number(header[3]); oldLeft = Number(header[2] ?? 1); newLeft = Number(header[4] ?? 1);
      if (![old, fresh, oldLeft, newLeft, old + oldLeft, fresh + newLeft].every(Number.isSafeInteger)) {
        // A corrupt upstream coordinate is text, not an unbounded line number.
        return { ...parseRecordedPatch(text.replace(/^@@/gm, "@ @"), limit), partial: true };
      }
      if (old < lastOld || fresh < lastNew || oldLeft > 0 && old === 0 || newLeft > 0 && fresh === 0) result.partial = true;
      lastOld = old + oldLeft; lastNew = fresh + newLeft;
      hunk = { header: line.slice(0, 4096), oldStart: old, oldLines: oldLeft, newStart: fresh, newLines: newLeft, lines: [] };
      if (++result.rows <= limit) result.hunks.push(hunk); continue;
    }
    if (!hunk) { if (!/^(?:diff |index |--- |\+\+\+ |$)/.test(line)) result.partial = true; continue; }
    if (line.startsWith("\\")) { if (!line.startsWith("\\ No newline")) result.partial = true; continue; }
    if (!/^[ +\-]/.test(line)) { result.partial = true; continue; }
    const kind = line[0] === "+" ? "add" : line[0] === "-" ? "delete" : "context";
    const row: WorkspaceDiffLine = { kind, text: line.slice(1, 4097), clipped: line.length > 4097, oldLine: null, newLine: null };
    if (kind !== "add") { row.oldLine = old++; oldLeft--; }
    if (kind !== "delete") { row.newLine = fresh++; newLeft--; }
    if (kind === "add") result.additions!++; if (kind === "delete") result.deletions!++;
    if (++result.rows <= limit) hunk.lines.push(row);
  }
  finish();
  if (result.partial) for (const h of result.hunks) for (const row of h.lines) { row.oldLine = null; row.newLine = null; }
  return result;
}
const patchStats = new WeakMap<object, RecordedPatch>();
export function recordedPatchStats(change: { diff: string }): RecordedPatch {
  let value = patchStats.get(change); if (!value) { value = parseRecordedPatch(change.diff, 0); patchStats.set(change, value); } return value;
}
export type RecordedEdit = { entry: RunEntry; index: number; path: string; diff: string; partial: boolean; stats: RecordedPatch };
export function recordedEdits(entries: RunEntry[]): { edits: RecordedEdit[]; unavailable: number; childEdits: number; partial: boolean } {
  const edits: RecordedEdit[] = []; let unavailable = 0, childEdits = 0, partial = false;
  for (const entry of entries) {
    if (entry.scope) { childEdits += entry.changes?.length ?? 0; continue; }
    if (entry.status !== "done") { if (entry.changes?.length) unavailable += entry.changes.length; continue; }
    if (!entry.changes?.length) { if (entry.kind === "tool" && /^(?:Edit|Write|apply_patch|write_file|edit_file)$/i.test(entry.name ?? "")) unavailable++; continue; }
    partial ||= entry.truncated === true;
    if (entry.truncated && entry.changes.length >= 20) unavailable++;
    entry.changes.forEach((change, index) => {
      if (!change.path || change.path.length >= 2048 || /[\x00-\x1f\x7f]/.test(change.path)) { unavailable++; partial = true; return; }
      const protectedPath = isCredentialStylePath(change.path);
      const stats = protectedPath ? { format: "empty" as const, hunks: [], additions: null, deletions: null, partial: false, rows: 0, bytes: 0 } : recordedPatchStats(change);
      // Capture-budget exhaustion can retain proposal content with a final
      // status. No step in a truncated entry is a trusted annotation anchor.
      edits.push({ entry, index, ...change, partial: stats.partial || !!entry.truncated, stats });
    });
  }
  return { edits, unavailable, childEdits, partial };
}
/** Relative paths may refer to different shell directories: never merge them. */
export function recordedFileIdentity(edit: RecordedEdit): string {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(edit.path) ? edit.path : `${edit.entry.seq}\0${edit.path}`;
}
export function summarizeRecordedChanges(entries: RunEntry[]) {
  const result = recordedEdits(entries), files = new Set(result.edits.map(recordedFileIdentity));
  return { files: files.size, edits: result.edits.length, additions: result.edits.some(edit => edit.stats.additions === null) ? null : result.edits.reduce((n, edit) => n + edit.stats.additions!, 0),
    deletions: result.edits.some(edit => edit.stats.deletions === null) ? null : result.edits.reduce((n, edit) => n + edit.stats.deletions!, 0),
    unavailable: result.unavailable, childEdits: result.childEdits, partial: result.partial || result.edits.some(edit => edit.partial) };
}

import type { WorkspaceChangeBadge, WorkspaceFileEntry } from "../../src/client-protocol/workspace-files.js";
import { t } from "./i18n.js";

export type WorkspaceEntryVisualKind =
  | "dir"
  | "sensitive"
  | "image"
  | "sheet"
  | "pdf"
  | "doc"
  | "code"
  | "file";

/** Plain-language change status pill text for a workspace file entry. */
export function changeBadgeLabel(status: WorkspaceChangeBadge): string {
  switch (status) {
    case "added": return t("新增");
    case "modified": return t("改过");
    case "deleted": return t("已删");
    case "untracked": return t("新文件");
    case "conflicted": return t("有冲突");
    case "type_changed": return t("变更");
  }
}

/** Accessible tooltip describing a file's Git status in plain words. */
export function changeBadgeTitle(status: WorkspaceChangeBadge): string {
  switch (status) {
    case "added": return t("新增文件");
    case "modified": return t("已修改");
    case "deleted": return t("已删除");
    case "untracked": return t("未跟踪文件");
    case "conflicted": return t("存在冲突");
    case "type_changed": return t("类型变更");
  }
}

/** Classify a workspace entry into a color-coded visual file-type category. */
export function classifyWorkspaceEntry(
  entry: Pick<WorkspaceFileEntry, "kind" | "name" | "sensitive">,
): WorkspaceEntryVisualKind {
  if (entry.kind === "dir") return "dir";
  if (entry.sensitive) return "sensitive";
  const lower = entry.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(lower)) return "image";
  if (/\.(csv|tsv|xlsx|xls|ods)$/.test(lower)) return "sheet";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(md|markdown|txt|doc|docx|rtf)$/.test(lower)) return "doc";
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cpp|cc|h|hpp|css|scss|less|html|htm|json|yaml|yml|toml|sh|bash|zsh|sql|xml|vue|svelte)$/.test(lower)) {
    return "code";
  }
  return "file";
}

export function entryToneClass(kind: WorkspaceEntryVisualKind): string {
  switch (kind) {
    case "dir": return "is-dir";
    case "sensitive": return "is-sensitive";
    case "image": return "is-img";
    case "sheet": return "is-sheet";
    case "pdf": return "is-pdf";
    case "doc": return "is-doc";
    case "code": return "is-code";
    case "file": return "is-file";
  }
}

/** Format a workspace relative path as an inline-code mention so group-chat Bot
 * recipient parsing never treats filenames, folders, or spaces as unknown Bots. */
export function formatWorkspaceFileMention(relativePath: string): string {
  const raw = `@${relativePath}`;
  if (!raw.includes("`")) return `\`${raw}\``;
  const runs = raw.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(...runs.map((run) => run.length)) + 1);
  const pad = raw.startsWith("`") || raw.endsWith("`") ? " " : "";
  return `${fence}${pad}${raw}${pad}${fence}`;
}

/** Extract a compact, path-free error hint code for secondary display under friendly messages. */
export function formatSafeWorkspaceErrorHint(error: unknown, fallbackCode: string): string {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600) {
    return `HTTP ${status}`;
  }
  const message = error instanceof Error ? error.message.trim() : "";
  if (message && /^[a-z0-9_.-]{3,40}$/i.test(message)) {
    return message;
  }
  return fallbackCode;
}

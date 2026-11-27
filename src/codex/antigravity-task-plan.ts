import { MAX_RUN_PLAN_ITEM_CHARS, MAX_RUN_PLAN_ITEMS } from "../client-protocol/run-plan.js";

export type AntigravityTodoStatus = "pending" | "in_progress" | "completed";

export interface AntigravityTodoItem {
  content: string;
  status: AntigravityTodoStatus;
}

export interface AntigravityTaskPlanSummary {
  todos: AntigravityTodoItem[];
  total: number;
  completed: number;
  truncated: boolean;
}

export interface AntigravityTaskPlanExtraction {
  isTaskArtifact: boolean;
  markdown?: string;
  todos: AntigravityTodoItem[];
  total?: number;
  completed?: number;
  truncated?: boolean;
}

export interface ExtractAntigravityTaskPlanOptions {
  toolKind?: string;
  toolName?: string;
  toolTitle?: string;
  toolStatus?: string;
  toolRawInput?: unknown;
  toolDiffNewText?: string;
  alreadyTaskArtifact?: boolean;
}

const MAX_TODOS = MAX_RUN_PLAN_ITEMS;
const MAX_TODO_CHARS = MAX_RUN_PLAN_ITEM_CHARS;
const TASK_ARTIFACT_EDIT_TOOLS = new Set(["write_file", "edit_file"]);
const ANTIGRAVITY_BRAIN_TASK_RE = /(?:^|[\/\s])\.gemini\/antigravity(?:-cli)?\/brain\/[^/\s]+\/task\.md$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizePath(raw: string): string {
  return raw.replaceAll("\\", "/");
}

function isTaskEditTool(kind: string | undefined, name: string | undefined): boolean {
  const normalizedKind = kind?.trim().toLowerCase();
  if (normalizedKind) return normalizedKind === "edit";
  const normalizedName = name?.trim().toLowerCase();
  return Boolean(normalizedName && TASK_ARTIFACT_EDIT_TOOLS.has(normalizedName));
}

function isTaskArtifactPath(candidate: string, sessionId: string, hasArtifactMetadata: boolean): boolean {
  const normalized = normalizePath(candidate).trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  const isTaskFile = lower.endsWith("/task.md") || lower === "task.md" || (hasArtifactMetadata && /\stask\.md$/.test(lower));
  if (!isTaskFile) return false;
  const cleanSession = normalizePath(sessionId).trim().toLowerCase();
  if (cleanSession && lower.endsWith(`/${cleanSession}/task.md`)) return true;
  if (ANTIGRAVITY_BRAIN_TASK_RE.test(lower)) return true;
  return hasArtifactMetadata;
}

/**
 * Parse Markdown task list items and total/completed counts from Antigravity's
 * `task.md` artifact, ignoring fenced code blocks.
 */
export function parseAntigravityTaskMarkdownSummary(markdown: string): AntigravityTaskPlanSummary {
  const todos: AntigravityTodoItem[] = [];
  let total = 0;
  let completed = 0;
  let inFence = false;
  let fenceChar = "";
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) { inFence = true; fenceChar = marker; }
      else if (fenceChar === marker) { inFence = false; fenceChar = ""; }
      continue;
    }
    if (inFence) continue;
    const match = rawLine.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX/~-])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const mark = match[1]!;
    const content = match[2]!.replace(/\s*<!--[\s\S]*?-->\s*/g, " ").trim().slice(0, MAX_TODO_CHARS);
    if (!content) continue;
    const status: AntigravityTodoStatus =
      mark === "x" || mark === "X" ? "completed"
        : mark === "/" || mark === "~" || mark === "-" ? "in_progress"
          : "pending";
    total++;
    if (status === "completed") completed++;
    if (todos.length < MAX_TODOS) todos.push({ content, status });
  }
  return { todos, total, completed, truncated: total > todos.length };
}

/**
 * Parse Markdown task list items from Antigravity's `task.md` artifact.
 * Supports `- [ ]` (pending), `- [/]` / `- [-]` / `- [~]` (in_progress),
 * and `- [x]` / `- [X]` (completed), while ignoring fenced code blocks.
 */
export function parseAntigravityTaskMarkdown(markdown: string): AntigravityTodoItem[] {
  return parseAntigravityTaskMarkdownSummary(markdown).todos;
}

/** Parse native ACP `plan` sessionUpdate entries with exact total/completed counts. */
export function parseAcpPlanSummary(entries: unknown): AntigravityTaskPlanSummary {
  if (!Array.isArray(entries)) return { todos: [], total: 0, completed: 0, truncated: false };
  const todos: AntigravityTodoItem[] = [];
  let total = 0;
  let completed = 0;
  for (const raw of entries) {
    const entry = asRecord(raw);
    const text = typeof entry?.content === "string" ? entry.content.trim() : typeof entry?.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    const rawStatus = typeof entry?.status === "string" ? entry.status.toLowerCase() : "pending";
    const status: AntigravityTodoStatus =
      rawStatus === "completed" || rawStatus === "done" ? "completed"
        : rawStatus === "in_progress" || rawStatus === "inprogress" || rawStatus === "running" ? "in_progress"
          : "pending";
    total++;
    if (status === "completed") completed++;
    if (todos.length < MAX_TODOS) todos.push({ content: text.slice(0, MAX_TODO_CHARS), status });
  }
  return { todos, total, completed, truncated: total > todos.length };
}

/** Parse native ACP `plan` sessionUpdate entries if a future `agy` CLI emits them. */
export function parseAcpPlanEntries(entries: unknown): AntigravityTodoItem[] {
  return parseAcpPlanSummary(entries).todos;
}

/**
 * Inspect an ACP `tool_call` / `tool_call_update` payload for Antigravity's
 * internal `task.md` artifact updates (written via `write_file` / `edit_file`).
 */
export function extractAntigravityTaskPlan(
  update: Record<string, unknown>,
  sessionId: string,
  previousMarkdown?: string,
  options?: ExtractAntigravityTaskPlanOptions,
): AntigravityTaskPlanExtraction | undefined {
  const effectiveKind = typeof update.kind === "string" && update.kind.trim() ? update.kind : options?.toolKind;
  const effectiveName = typeof update.name === "string" && update.name.trim() ? update.name : options?.toolName;
  if (options?.alreadyTaskArtifact) {
    const normalizedKind = effectiveKind?.trim().toLowerCase();
    if (normalizedKind && normalizedKind !== "edit") return undefined;
  } else if (!isTaskEditTool(effectiveKind, effectiveName)) {
    return undefined;
  }

  const rawInput = asRecord(update.rawInput) ?? asRecord(options?.toolRawInput);
  const hasArtifactMetadata = Boolean(asRecord(rawInput?.ArtifactMetadata));
  const candidatePaths: string[] = [];
  let diffNewText: string | undefined;

  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      const rec = asRecord(item);
      if (typeof rec?.path === "string") candidatePaths.push(rec.path);
      if (rec?.type === "diff" && typeof rec.newText === "string") diffNewText = rec.newText;
    }
  }
  if (Array.isArray(update.locations)) {
    for (const item of update.locations) {
      const rec = asRecord(item);
      if (typeof rec?.path === "string") candidatePaths.push(rec.path);
    }
  }
  if (typeof rawInput?.Path === "string") candidatePaths.push(rawInput.Path);
  if (typeof rawInput?.path === "string") candidatePaths.push(rawInput.path);
  if (typeof update.title === "string") candidatePaths.push(update.title);
  if (typeof options?.toolTitle === "string") candidatePaths.push(options.toolTitle);

  const isTaskArtifact = Boolean(options?.alreadyTaskArtifact)
    || candidatePaths.some((candidate) => isTaskArtifactPath(candidate, sessionId, hasArtifactMetadata));
  if (!isTaskArtifact) return undefined;

  const rawStatus = typeof update.status === "string" ? update.status : options?.toolStatus;
  const effectiveStatus = rawStatus?.trim().toLowerCase();
  if (effectiveStatus !== undefined && effectiveStatus !== "completed") {
    return { isTaskArtifact: true, todos: [] };
  }

  let markdown = diffNewText ?? options?.toolDiffNewText;
  if (markdown === undefined && typeof rawInput?.Content === "string") {
    markdown = rawInput.Append === true && previousMarkdown !== undefined
      ? `${previousMarkdown}${rawInput.Content}`
      : rawInput.Content;
  }
  if (
    markdown === undefined &&
    previousMarkdown !== undefined &&
    typeof rawInput?.Target === "string" &&
    typeof rawInput?.Replacement === "string" &&
    rawInput.Target.length > 0 &&
    previousMarkdown.includes(rawInput.Target)
  ) {
    const replacement = rawInput.Replacement;
    markdown = previousMarkdown.replaceAll(rawInput.Target, () => replacement);
  }
  if (markdown === undefined) return { isTaskArtifact: true, todos: [] };
  const parsed = parseAntigravityTaskMarkdownSummary(markdown);
  return {
    isTaskArtifact: true,
    markdown,
    todos: parsed.todos,
    ...(parsed.truncated ? { total: parsed.total, completed: parsed.completed, truncated: true } : {}),
  };
}

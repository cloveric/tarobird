import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  AtSign,
  ChevronRight,
  Code2,
  Eye,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GripVertical,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  WORKSPACE_FILES_MAX_ENTRIES,
  workspacePreviewResponseSchema,
  workspaceTreeResponseSchema,
  type WorkspaceChangeBadge,
  type WorkspaceFileEntry,
  type WorkspacePreviewResponse,
  type WorkspaceTreeResponse,
} from "../../src/client-protocol/workspace-files.js";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { DiffCounts } from "./DiffCounts.js";
import { DiffViewerTrigger } from "./DiffViewerTrigger.js";
import { SidePanelResize } from "./SidePanelResize.js";
import { useRunChangeFiles } from "./use-run-change-files.js";
import { MarkdownText } from "./MarkdownText.js";
import { CodeBlock } from "./CodeBlock.js";
import { t, useLocale } from "./i18n.js";
import { formatFileLimit } from "./files.js";
import { useBackAction } from "./back-navigation.js";
import {
  changeBadgeLabel,
  changeBadgeTitle,
  classifyWorkspaceEntry,
  entryToneClass,
  formatSafeWorkspaceErrorHint,
  formatWorkspaceFileMention,
} from "./workspace-files-meta.js";
import "./workspace-files.css";

const PdfPreview = lazy(() => import("./PdfPreview.js"));

export const WORKSPACE_FILE_DRAG_MIME = "application/x-tarobird-workspace-file";

export { changeBadgeLabel, classifyWorkspaceEntry, formatWorkspaceFileMention } from "./workspace-files-meta.js";

function combineSignals(a?: AbortSignal, b?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const sources = [a, b].filter((item): item is AbortSignal => Boolean(item));
  const onAbort = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason ?? new DOMException("Aborted", "AbortError"));
    }
  };
  const listeners: Array<{ source: AbortSignal; handler: () => void }> = [];
  for (const source of sources) {
    if (source.aborted) {
      onAbort(source);
      return { signal: controller.signal, dispose: () => undefined };
    }
    const handler = () => onAbort(source);
    source.addEventListener("abort", handler, { once: true });
    listeners.push({ source, handler });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { source, handler } of listeners) {
        source.removeEventListener("abort", handler);
      }
    },
  };
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error as { name?: string } | undefined)?.name === "AbortError";
}

function compareEntriesDisplay(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
  const aDir = a.kind === "dir" ? 0 : 1;
  const bDir = b.kind === "dir" ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function entryIcon(entry: WorkspaceFileEntry, open: boolean) {
  const kind = classifyWorkspaceEntry(entry);
  const toneClass = entryToneClass(kind);
  switch (kind) {
    case "dir":
      return { icon: open ? <FolderOpen size={15}/> : <Folder size={15}/>, toneClass };
    case "sensitive":
      return { icon: <Lock size={14}/>, toneClass };
    case "image":
      return { icon: <FileImage size={14}/>, toneClass };
    case "sheet":
      return { icon: <FileSpreadsheet size={14}/>, toneClass };
    case "pdf":
    case "doc":
      return { icon: <FileText size={14}/>, toneClass };
    case "code":
      return { icon: <FileCode2 size={14}/>, toneClass };
    case "file":
      return { icon: <File size={14}/>, toneClass };
  }
}

/** Friendly spot illustrations for Workspace Files empty, error, and sensitive states. */
function WorkspaceFileStateArt({ kind }: { kind: "changed" | "search" | "empty" | "error" | "sensitive" | "file" }) {
  if (kind === "changed") {
    return (
      <svg className="wf-state-art is-changed" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M16 9a3.5 3.5 0 0 1 3.5-3.5h15l9 9V38.5a3.5 3.5 0 0 1-3.5 3.5h-20.5A3.5 3.5 0 0 1 16 38.5V9Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <path d="M34.5 5.5v9h9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M24.5 26.5l4.2 4.2 8.8-8.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (kind === "search") {
    return (
      <svg className="wf-state-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M13 13a4 4 0 0 1 4-4h9l3.5 3.5H45a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4V13Z" fill="currentColor" fillOpacity="0.09" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <circle cx="31" cy="24.5" r="6.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.6"/>
        <path d="M35.8 29.3l4.7 4.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg className="wf-state-art is-error" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <circle cx="32" cy="24" r="16" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.6"/>
        <path d="M32 16v10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/>
        <circle cx="32" cy="31.5" r="1.6" fill="currentColor"/>
      </svg>
    );
  }
  if (kind === "sensitive") {
    return (
      <svg className="wf-state-art is-sensitive" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M32 6.5 18 12v11.5c0 9.2 5.9 16.5 14 19 8.1-2.5 14-9.8 14-19V12L32 6.5Z" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <rect x="26.5" y="21.5" width="11" height="9.5" rx="2.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M29 21.5v-2.8a3 3 0 0 1 6 0v2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="32" cy="26.3" r="1.1" fill="currentColor"/>
      </svg>
    );
  }
  if (kind === "file") {
    return (
      <svg className="wf-state-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M18 8.5a3.5 3.5 0 0 1 3.5-3.5h14l9 9v25.5a3.5 3.5 0 0 1-3.5 3.5h-19.5A3.5 3.5 0 0 1 18 39.5V8.5Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <path d="M35.5 5v9h9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M25 25.5h14M25 31h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
      </svg>
    );
  }
  return (
    <svg className="wf-state-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
      <path d="M12 14a4 4 0 0 1 4-4h10l4 4h18a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V14Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
      <path d="M24 26h16M24 31h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.7"/>
      <circle cx="48" cy="11" r="2.2" fill="currentColor" fillOpacity="0.5"/>
    </svg>
  );
}

/** "~/a/b/c/d" → "~/…/c/d": the start says whose tree it is, the end which project; the full path is in the title. */
export function shortDisplayPath(value: string): string {
  const parts = value.split("/");
  return parts.length > 4 ? [parts[0], "…", ...parts.slice(-2)].join("/") : value;
}

function decodeBase64Blob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function WorkspaceFilesPanel({
  id,
  connection,
  conversationId,
  botId,
  visible,
  phone,
  turnVersion,
  onMentionFile,
  onClose,
  changesMessage,
  focusChanges,
}: {
  id: string;
  connection: HubConnection;
  conversationId: string;
  botId: string;
  visible: boolean;
  phone: boolean;
  /** Increments when new messages/turns arrive so the tree auto-refreshes. */
  turnVersion: number;
  onMentionFile: (relativePath: string) => void;
  onClose: () => void;
  /** The reply whose recorded run is shown as 「这轮改动」: the latest one, or the one whose 「本轮改动」 opened the panel. */
  changesMessage?: Message;
  /** Changes when a reply's 「本轮改动」 opens the panel: the panel shows the tree and scrolls to 「这轮改动」. */
  focusChanges?: number;
}) {
  useLocale();
  const panelRef = useRef<HTMLElement>(null);
  const [workspaceName, setWorkspaceName] = useState("workspace");
  const [displayPath, setDisplayPath] = useState<string>();
  const runFiles = useRunChangeFiles(connection, changesMessage, visible);
  const changesSection = useRef<HTMLElement>(null);
  const [nodes, setNodes] = useState<ReadonlyMap<string, WorkspaceFileEntry[]>>(() => new Map());
  const [truncatedDirs, setTruncatedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [changedFiles, setChangedFiles] = useState<WorkspaceTreeResponse["changedFiles"]>([]);
  const [changedOnly, setChangedOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const [rootError, setRootError] = useState("");
  const [rootErrorHint, setRootErrorHint] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<WorkspacePreviewResponse | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewErrorHint, setPreviewErrorHint] = useState("");
  const [rawMarkdown, setRawMarkdown] = useState(false);

  const scopeGenRef = useRef(0);
  const scopeAbortRef = useRef<AbortController | null>(null);
  const manualRefreshAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewSeqRef = useRef(0);
  const activeRefreshCountRef = useRef(0);

  const expandedRef = useRef<ReadonlySet<string>>(expanded);
  const nodesRef = useRef<ReadonlyMap<string, WorkspaceFileEntry[]>>(nodes);
  nodesRef.current = nodes;
  const selectedRef = useRef<string | undefined>(selectedPath);
  const virtualDirsRef = useRef<Set<string>>(new Set());
  const fingerprints = useRef(new Map<string, string>());

  const updateExpanded = useCallback((updater: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
    const next = updater(expandedRef.current);
    expandedRef.current = next;
    setExpanded(next);
  }, []);

  const pruneDeletedDir = useCallback((dirPath: string) => {
    const prefix = `${dirPath}/`;
    const isUnder = (candidate: string) => candidate === dirPath || candidate.startsWith(prefix);
    updateExpanded((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const item of prev) {
        if (isUnder(item)) changed = true;
        else next.add(item);
      }
      return changed ? next : prev;
    });
    for (const key of [...fingerprints.current.keys()]) {
      if (isUnder(key)) fingerprints.current.delete(key);
    }
    for (const key of [...virtualDirsRef.current]) {
      if (isUnder(key)) virtualDirsRef.current.delete(key);
    }
    setNodes((prev) => {
      let changed = false;
      const next = new Map<string, WorkspaceFileEntry[]>();
      for (const [key, value] of prev) {
        if (isUnder(key)) changed = true;
        else next.set(key, value);
      }
      if (changed) nodesRef.current = next;
      return changed ? next : prev;
    });
    setTruncatedDirs((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const item of prev) {
        if (isUnder(item)) changed = true;
        else next.add(item);
      }
      return changed ? next : prev;
    });
  }, [updateExpanded]);

  const closePreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewSeqRef.current += 1;
    selectedRef.current = undefined;
    setSelectedPath(undefined);
    setPreview(undefined);
    setPreviewLoading(false);
    setPreviewError("");
    setPreviewErrorHint("");
    setRawMarkdown(false);
  }, []);

  const fetchDir = useCallback(async (dirPath: string, callerSignal?: AbortSignal) => {
    const gen = scopeGenRef.current;
    const { signal, dispose } = combineSignals(scopeAbortRef.current?.signal, callerSignal);
    if (signal.aborted) {
      dispose();
      return undefined;
    }
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const qs = new URLSearchParams({
        botId,
        path: dirPath,
        ...(dirPath !== "" ? { changes: "0" } : {}),
        ...(dirPath === "" && connection.state.workspaceFilesDisplayPathAvailable ? { display: "1" } : {}),
      });
      const raw = await connection.http<unknown>(`/api/conversations/${conversationId}/workspace-files/tree?${qs}`, { signal });
      if (scopeGenRef.current !== gen || signal.aborted) return undefined;
      const parsed = workspaceTreeResponseSchema.parse(raw);
      if (scopeGenRef.current !== gen || signal.aborted) return undefined;
      const unchangedFingerprint = fingerprints.current.get(dirPath) === parsed.fingerprint && nodesRef.current.has(dirPath);
      if (dirPath === "") setDisplayPath(parsed.displayPath);
      if (dirPath === "") {
        setRootError("");
        setRootErrorHint("");
      }
      if (!unchangedFingerprint) {
        fingerprints.current.set(dirPath, parsed.fingerprint);
        for (const entry of parsed.entries) {
          if (entry.kind === "dir" && entry.mtimeMs !== null) {
            virtualDirsRef.current.delete(entry.path);
          }
        }
        if (dirPath === "") {
          setWorkspaceName(parsed.workspaceName);
          setChangedFiles(parsed.changedFiles);
        }
        setNodes((prev) => {
          const next = new Map(prev);
          next.set(dirPath, parsed.entries);
          nodesRef.current = next;
          return next;
        });
        setTruncatedDirs((prev) => {
          const has = prev.has(dirPath);
          if (has === parsed.truncated) return prev;
          const next = new Set(prev);
          if (parsed.truncated) next.add(dirPath);
          else next.delete(dirPath);
          return next;
        });
      }
      return parsed;
    } catch (error) {
      if (scopeGenRef.current !== gen || isAbortError(error, signal)) return undefined;
      const status = (error as { status?: unknown } | undefined)?.status;
      if (dirPath !== "" && status === 404) {
        pruneDeletedDir(dirPath);
        return undefined;
      }
      if (dirPath === "") {
        setRootError(t("暂时读不到工作区文件，可以点一下重试。"));
        setRootErrorHint(formatSafeWorkspaceErrorHint(error, "tree_unavailable"));
      }
      return undefined;
    } finally {
      dispose();
      if (scopeGenRef.current === gen) {
        setLoadingDirs((prev) => {
          if (!prev.has(dirPath)) return prev;
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    }
  }, [botId, connection, conversationId, pruneDeletedDir]);

  const fetchPreview = useCallback(async (filePath: string, reveal = false) => {
    const gen = scopeGenRef.current;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const seq = ++previewSeqRef.current;
    const { signal, dispose } = combineSignals(scopeAbortRef.current?.signal, controller.signal);

    selectedRef.current = filePath;
    setSelectedPath(filePath);
    setPreview(undefined);
    setPreviewLoading(true);
    setPreviewError("");
    setPreviewErrorHint("");
    setRawMarkdown(false);
    try {
      const qs = new URLSearchParams({ botId, path: filePath, ...(reveal ? { reveal: "1" } : {}) });
      const raw = await connection.http<unknown>(`/api/conversations/${conversationId}/workspace-files/preview?${qs}`, { signal });
      if (scopeGenRef.current !== gen || previewSeqRef.current !== seq || signal.aborted) return;
      const parsed = workspacePreviewResponseSchema.parse(raw);
      if (scopeGenRef.current !== gen || previewSeqRef.current !== seq || signal.aborted) return;
      setPreview(parsed);
    } catch (error) {
      if (scopeGenRef.current !== gen || previewSeqRef.current !== seq || isAbortError(error, signal)) return;
      setPreview(undefined);
      setPreviewError(t("暂时打不开这个文件预览，可以点一下重试。"));
      setPreviewErrorHint(formatSafeWorkspaceErrorHint(error, "preview_unavailable"));
    } finally {
      dispose();
      if (scopeGenRef.current === gen && previewSeqRef.current === seq) {
        setPreviewLoading(false);
        if (previewAbortRef.current === controller) {
          previewAbortRef.current = null;
        }
      }
    }
  }, [botId, connection, conversationId]);

  const refreshExpanded = useCallback(async (callerSignal?: AbortSignal) => {
    const gen = scopeGenRef.current;
    activeRefreshCountRef.current += 1;
    setRefreshing(true);
    try {
      const dirs = ["", ...[...expandedRef.current].filter((dir) => dir !== "" && !virtualDirsRef.current.has(dir))];
      await Promise.all(dirs.map((dir) => fetchDir(dir, callerSignal)));
    } finally {
      if (scopeGenRef.current === gen) {
        activeRefreshCountRef.current = Math.max(0, activeRefreshCountRef.current - 1);
        if (activeRefreshCountRef.current === 0) setRefreshing(false);
      }
    }
  }, [fetchDir]);

  const triggerManualRefresh = useCallback(() => {
    manualRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    manualRefreshAbortRef.current = controller;
    void refreshExpanded(controller.signal).finally(() => {
      if (manualRefreshAbortRef.current === controller) {
        manualRefreshAbortRef.current = null;
      }
    });
  }, [refreshExpanded]);

  // Reset state synchronously and cancel all in-flight requests when switching conversation, bot, or connection.
  // Declared BEFORE the load effect so expandedRef is reset in the same commit before refreshExpanded reads it.
  useEffect(() => {
    scopeGenRef.current += 1;
    scopeAbortRef.current?.abort();
    const scopeController = new AbortController();
    scopeAbortRef.current = scopeController;
    manualRefreshAbortRef.current?.abort();
    manualRefreshAbortRef.current = null;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewSeqRef.current += 1;
    activeRefreshCountRef.current = 0;

    const initialExpanded = new Set([""]);
    const emptyNodes = new Map<string, WorkspaceFileEntry[]>();
    expandedRef.current = initialExpanded;
    nodesRef.current = emptyNodes;
    selectedRef.current = undefined;
    virtualDirsRef.current.clear();
    fingerprints.current.clear();

    setWorkspaceName("workspace");
    setDisplayPath(undefined);
    setNodes(emptyNodes);
    setTruncatedDirs(new Set());
    setExpanded(initialExpanded);
    setLoadingDirs(new Set());
    setChangedFiles([]);
    setSelectedPath(undefined);
    setPreview(undefined);
    setPreviewLoading(false);
    setPreviewError("");
    setPreviewErrorHint("");
    setRootError("");
    setRootErrorHint("");
    setRefreshing(false);
    setFilter("");
    setChangedOnly(false);
    setRawMarkdown(false);

    return () => {
      scopeGenRef.current += 1;
      scopeController.abort();
      if (scopeAbortRef.current === scopeController) scopeAbortRef.current = null;
      manualRefreshAbortRef.current?.abort();
      manualRefreshAbortRef.current = null;
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
      previewSeqRef.current += 1;
    };
  }, [conversationId, botId, connection]);

  // Initial load & refresh on new turns while visible
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void refreshExpanded(controller.signal);
    return () => controller.abort();
  }, [visible, conversationId, botId, turnVersion, refreshExpanded]);

  // Periodic background auto-refresh while visible & foregrounded
  useEffect(() => {
    if (!visible) return;
    let pollController: AbortController | null = null;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      pollController?.abort();
      const controller = new AbortController();
      pollController = controller;
      void refreshExpanded(controller.signal).finally(() => {
        if (pollController === controller) pollController = null;
      });
    }, 5000);
    return () => {
      window.clearInterval(timer);
      pollController?.abort();
      pollController = null;
    };
  }, [visible, refreshExpanded]);

  // Android / mobile Back navigates Preview -> File tree -> Chat cleanly.
  useBackAction(panelRef, () => {
    if (!visible || !phone) return false;
    if (selectedRef.current) {
      closePreview();
      return;
    }
    onClose();
  });

  const { changedMap, changedDirs } = useMemo(() => {
    const map = new Map<string, WorkspaceChangeBadge>();
    const dirs = new Set<string>();
    for (const item of changedFiles) {
      map.set(item.path, item.status);
      const parts = item.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    return { changedMap: map, changedDirs: dirs };
  }, [changedFiles]);

  const getEffectiveEntries = useCallback((dirPath: string): WorkspaceFileEntry[] | undefined => {
    const diskList = nodes.get(dirPath);
    const isVirtual = virtualDirsRef.current.has(dirPath);
    if (!diskList && !isVirtual) return undefined;

    const merged: WorkspaceFileEntry[] = [];
    const seen = new Set<string>();

    if (diskList) {
      for (const entry of diskList) {
        const liveChanged = changedMap.get(entry.path);
        const liveHasChangedChildren = entry.kind === "dir" && changedDirs.has(entry.path);
        // Drop previously synthesized virtual entries if Git no longer reports them.
        if (entry.mtimeMs === null) {
          if (entry.kind === "dir" && !liveHasChangedChildren) continue;
          if (entry.kind !== "dir" && liveChanged !== "deleted") continue;
        }
        seen.add(entry.name);
        const { changed: _oldChanged, hasChangedChildren: _oldHasChildren, ...base } = entry;
        merged.push({
          ...base,
          ...(liveChanged ? { changed: liveChanged } : {}),
          ...(liveHasChangedChildren ? { hasChangedChildren: true } : {}),
        });
      }
    }

    const prefix = dirPath ? `${dirPath}/` : "";
    for (const item of changedFiles) {
      if (item.status !== "deleted") continue;
      if (prefix && !item.path.startsWith(prefix)) continue;
      const tail = prefix ? item.path.slice(prefix.length) : item.path;
      if (!tail) continue;
      const slash = tail.indexOf("/");
      if (slash < 0) {
        if (seen.has(tail)) continue;
        seen.add(tail);
        merged.push({
          name: tail,
          path: item.path,
          kind: "file",
          size: null,
          mtimeMs: null,
          sensitive: false,
          heavy: false,
          changed: "deleted",
        });
      } else {
        const dirName = tail.slice(0, slash);
        const dirRel = dirPath ? `${dirPath}/${dirName}` : dirName;
        if (seen.has(dirName)) continue;
        seen.add(dirName);
        merged.push({
          name: dirName,
          path: dirRel,
          kind: "dir",
          size: null,
          mtimeMs: null,
          sensitive: false,
          heavy: false,
          hasChangedChildren: true,
        });
      }
    }

    merged.sort(compareEntriesDisplay);
    return merged;
  }, [changedDirs, changedFiles, changedMap, nodes]);

  const toggleDir = (entry: WorkspaceFileEntry) => {
    const isOpen = expandedRef.current.has(entry.path);
    if (isOpen) {
      updateExpanded((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
    } else {
      updateExpanded((prev) => new Set(prev).add(entry.path));
      if (entry.mtimeMs === null) {
        virtualDirsRef.current.add(entry.path);
      } else {
        virtualDirsRef.current.delete(entry.path);
        if (!nodesRef.current.has(entry.path)) void fetchDir(entry.path);
      }
    }
  };

  const openPathFromBreadcrumb = (targetPath: string) => {
    if (!targetPath) {
      closePreview();
      return;
    }
    const parts = targetPath.split("/");
    const ancestors = new Set(expandedRef.current);
    ancestors.add("");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      ancestors.add(prefix);
      if (!nodesRef.current.has(prefix) && !virtualDirsRef.current.has(prefix)) {
        void fetchDir(prefix);
      }
    }
    expandedRef.current = ancestors;
    setExpanded(ancestors);
    if (targetPath !== selectedRef.current) {
      closePreview();
    }
  };

  const breadcrumbs = useMemo(() => {
    const active = selectedPath ?? "";
    const segments = active ? active.split("/") : [];
    return segments.map((label, index) => ({
      label,
      path: segments.slice(0, index + 1).join("/"),
      isLast: index === segments.length - 1,
    }));
  }, [selectedPath]);

  const pdfBlob = useMemo(() => {
    if (preview?.kind !== "pdf") return undefined;
    try { return decodeBase64Blob(preview.base64, preview.mime); } catch { return undefined; }
  }, [preview]);

  const normalizedFilter = filter.trim().toLowerCase();

  const dirHasLoadedMatch = (dirPath: string): boolean => {
    const children = getEffectiveEntries(dirPath);
    if (!children) return false;
    return children.some((child) => {
      if (changedOnly && !child.changed && !child.hasChangedChildren) return false;
      if (child.name.toLowerCase().includes(normalizedFilter) || child.path.toLowerCase().includes(normalizedFilter)) {
        return true;
      }
      return child.kind === "dir" && expanded.has(child.path) && dirHasLoadedMatch(child.path);
    });
  };

  const renderDir = (dirPath: string, depth: number) => {
    const list = getEffectiveEntries(dirPath);
    if (!list) return null;
    const isTruncated = truncatedDirs.has(dirPath);
    const visibleEntries = list.filter((entry) => {
      if (changedOnly && !entry.changed && !entry.hasChangedChildren) return false;
      if (normalizedFilter) {
        if (entry.kind === "dir") {
          return (
            entry.name.toLowerCase().includes(normalizedFilter)
            || entry.path.toLowerCase().includes(normalizedFilter)
            || (expanded.has(entry.path) && dirHasLoadedMatch(entry.path))
          );
        }
        return entry.name.toLowerCase().includes(normalizedFilter) || entry.path.toLowerCase().includes(normalizedFilter);
      }
      return true;
    });
    if (!visibleEntries.length && depth === 0) {
      const emptyKind = normalizedFilter ? "search" : changedOnly ? "changed" : "empty";
      return (
        <div className="wf-state-card" role="status">
          <WorkspaceFileStateArt kind={emptyKind}/>
          <p className="wf-state-title">
            {normalizedFilter ? t("没有匹配的文件") : changedOnly ? t("本轮暂无改动文件") : t("当前目录为空")}
          </p>
          <p className="wf-state-detail">
            {normalizedFilter
              ? t("试试换个关键词，或清空筛选查看全部文件。")
              : changedOnly
                ? t("Bot 新建或修改文件后，这里会自动标出变化。")
                : t("工作区里新增文件后，点一下刷新就会出现在这里。")}
          </p>
          {normalizedFilter && (
            <button type="button" className="wf-secondary-btn" onClick={() => setFilter("")}>
              {t("清空筛选")}
            </button>
          )}
          {!normalizedFilter && changedOnly && (
            <button type="button" className="wf-secondary-btn" onClick={() => setChangedOnly(false)}>
              {t("查看全部文件")}
            </button>
          )}
        </div>
      );
    }
    if (!visibleEntries.length && depth > 0 && !changedOnly && !normalizedFilter) {
      return <div className="wf-empty-sub" style={{ paddingInlineStart: `${30 + depth * 15}px` }}>{t("空文件夹")}</div>;
    }
    return <>
      <ul className="wf-tree-list" role={depth === 0 ? "tree" : "group"}>
        {visibleEntries.map((entry) => {
          const isDir = entry.kind === "dir";
          const isOpen = isDir && expanded.has(entry.path);
          const isLoading = isDir && loadingDirs.has(entry.path);
          const isDeletedUnavailable = !isDir && entry.changed === "deleted" && entry.mtimeMs === null;
          const isSelected = !isDir && selectedPath === entry.path;
          const { icon, toneClass } = entryIcon(entry, isOpen);
          return <li key={entry.path} role="treeitem" aria-expanded={isDir ? isOpen : undefined} aria-selected={isSelected}>
            <div
              className={`wf-row${isSelected ? " is-selected" : ""}${entry.heavy ? " is-heavy" : ""}${entry.sensitive ? " is-sensitive" : ""}${isDeletedUnavailable ? " is-deleted" : ""}`}
              style={{ paddingInlineStart: `${10 + depth * 15}px` }}
              draggable={!phone}
              onDragStart={(event) => {
                event.dataTransfer.setData(WORKSPACE_FILE_DRAG_MIME, entry.path);
                event.dataTransfer.setData("text/plain", formatWorkspaceFileMention(entry.path));
                event.dataTransfer.effectAllowed = "copy";
              }}
            >
              <button
                type="button"
                className="wf-row-main"
                aria-disabled={isDeletedUnavailable || undefined}
                onClick={() => {
                  if (isDir) toggleDir(entry);
                  else if (!isDeletedUnavailable) void fetchPreview(entry.path, false);
                }}
                title={isDeletedUnavailable ? t("文件已删除，无法预览") : entry.path}
              >
                <span className={`wf-caret${isDir ? "" : " is-leaf"}${isOpen ? " is-open" : ""}`} aria-hidden="true">
                  {isLoading ? <LoaderCircle size={12} className="spin"/> : isDir ? <ChevronRight size={13}/> : !phone ? <GripVertical size={12} className="wf-drag-grip"/> : null}
                </span>
                <span className={`wf-icon ${toneClass}`} aria-hidden="true">{icon}</span>
                <span className="wf-name">{entry.name}</span>
                {entry.sensitive && <span className="wf-tag is-sensitive" title={t("可能包含敏感凭据")}>{t("敏感")}</span>}
                {entry.changed && <span className={`wf-git-badge is-${entry.changed}`} title={changeBadgeTitle(entry.changed)}>{changeBadgeLabel(entry.changed)}</span>}
                {!entry.changed && entry.hasChangedChildren && <span className="wf-git-dot" title={t("包含改动文件")} aria-label={t("包含改动文件")}/>}
              </button>
              {!phone && !isDir && !isDeletedUnavailable && <button
                type="button"
                className="wf-preview-btn"
                aria-label={t("预览文件：{0}", entry.path)}
                title={t("预览")}
                onClick={(event) => { event.stopPropagation(); void fetchPreview(entry.path, false); }}
              >
                <Eye size={13}/>
              </button>}
              <button
                type="button"
                className="wf-mention-btn"
                aria-label={t("引用文件：{0}", entry.path)}
                title={phone ? t("引用给 Bot") : t("引用给 Bot（也可直接拖到输入框）")}
                onClick={(event) => { event.stopPropagation(); onMentionFile(entry.path); }}
              >
                <AtSign size={13}/>
              </button>
            </div>
            {isDir && isOpen && renderDir(entry.path, depth + 1)}
          </li>;
        })}
      </ul>
      {isTruncated && (
        <div className="wf-truncated-dir" role="status" style={{ paddingInlineStart: `${30 + depth * 15}px` }}>
          {t("目录项较多，仅展示前 {0} 项", WORKSPACE_FILES_MAX_ENTRIES)}
        </div>
      )}
    </>;
  };

  // A reply's 「本轮改动」 opened the panel: clear the tree filters and bring the recorded changes into view.
  useEffect(() => {
    if (focusChanges === undefined) return;
    setSelectedPath(undefined); setPreview(undefined); setChangedOnly(false); setFilter("");
  }, [focusChanges]);

  useEffect(() => {
    if (focusChanges === undefined || !visible || !changesSection.current) return;
    const frame = requestAnimationFrame(() => changesSection.current?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [focusChanges, visible, selectedPath, changedOnly, filter]);

  const showingPreview = Boolean(selectedPath);

  return <aside
    ref={panelRef}
    id={id}
    className={`workspace-files-panel${phone ? " workspace-files-phone" : " conversation-side-panel"}`}
    hidden={!visible}
    inert={!visible || undefined}
    aria-label={t("工作区文件")}
  >
    {!phone && <SidePanelResize panel={panelRef} visible={visible} controls={id} label={t("调整文件面板宽度")}/>}
    <header className="wf-header">
      <div className="wf-header-title">
        <Folder size={16} aria-hidden="true"/>
        <h2>{t("文件")}</h2>
        <span className="wf-readonly-badge">{t("只读")}</span>
      </div>
      <div className="wf-header-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={t("刷新文件树")}
          title={t("刷新文件树")}
          onClick={triggerManualRefresh}
        >
          <RefreshCw size={15} className={refreshing ? "spin" : undefined}/>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t("关闭文件面板")}
          title={t("关闭")}
          onClick={onClose}
        >
          <X size={16}/>
        </button>
      </div>
    </header>

    <nav className="wf-breadcrumbs" aria-label={t("文件路径")}>
      <button type="button" className={`wf-crumb wf-crumb-root${!selectedPath ? " is-current" : ""}${displayPath ? " is-path" : ""}`} title={displayPath ? `${t("Bot 的工作目录")}：${displayPath}` : t("Bot 的工作目录")} onClick={() => openPathFromBreadcrumb("")}>
        {displayPath ? shortDisplayPath(displayPath) : workspaceName}
      </button>
      {!selectedPath && <span className="wf-root-note">{t("Bot 的工作目录")}</span>}
      {breadcrumbs.map((crumb) => <span key={crumb.path} className="wf-crumb-sep-wrap">
        <ChevronRight size={12} aria-hidden="true"/>
        <button
          type="button"
          className={`wf-crumb${crumb.isLast ? " is-current" : ""}`}
          onClick={() => !crumb.isLast && openPathFromBreadcrumb(crumb.path)}
          disabled={crumb.isLast}
        >
          {crumb.label}
        </button>
      </span>)}
    </nav>

    {!showingPreview && <div className="wf-toolbar">
      <label className="wf-search">
        <Search size={13} aria-hidden="true"/>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("筛选文件…")}
          aria-label={t("筛选文件")}
        />
      </label>
      <button
        type="button"
        className={`wf-filter-pill${changedOnly ? " is-active" : ""}`}
        aria-pressed={changedOnly}
        onClick={() => setChangedOnly((value) => !value)}
        title={t("仅显示有改动的文件")}
      >
        <GitBranch size={12} aria-hidden="true"/>
        <span>{changedFiles.length ? t("只看改动的 · {0}", changedFiles.length) : t("只看改动的")}</span>
      </button>
    </div>}

    <div className="wf-body">
      {!showingPreview ? (
        <>
          {!changedOnly && !normalizedFilter && changesMessage && runFiles.summary && runFiles.summary.files > 0 && <section className="wf-run-changes" ref={changesSection} aria-label={t("这轮改动")}>
            <h3 className="wf-section-title">
              <span>{t("这轮改动 · {0} 个文件", runFiles.summary.files)}</span>
              <DiffViewerTrigger connection={connection} message={changesMessage}><span className="wf-section-link">{t("看全部变更")}<ChevronRight size={12} aria-hidden="true"/></span></DiffViewerTrigger>
            </h3>
            <div className="wf-run-changes-list">
              {runFiles.files
                ? runFiles.files.slice(0, 8).map(file => <DiffViewerTrigger key={file.key} connection={connection} message={changesMessage}>
                  <span className="wf-run-change" title={file.path}>
                    <File size={13} aria-hidden="true"/>
                    <span className="wf-run-change-name">{file.path.split(/[\\/]/).filter(Boolean).pop() ?? file.path}</span>
                    <span className="wf-run-change-dir">{file.path.split(/[\\/]/).filter(Boolean).slice(-3, -1).join("/")}</span>
                    <DiffCounts additions={file.additions} deletions={file.deletions} className="wf-run-change-counts"/>
                  </span>
                </DiffViewerTrigger>)
                : <DiffViewerTrigger connection={connection} message={changesMessage}>
                  <span className="wf-run-change">
                    <File size={13} aria-hidden="true"/>
                    <span className="wf-run-change-name">{t("改动 {0} 个文件", runFiles.summary.files)}</span>
                    <DiffCounts additions={runFiles.summary.additions} deletions={runFiles.summary.deletions} className="wf-run-change-counts"/>
                  </span>
                </DiffViewerTrigger>}
              {runFiles.files && runFiles.files.length > 8 && <p className="wf-run-change-more">{t("还有 {0} 个文件", runFiles.files.length - 8)}</p>}
            </div>
          </section>}
        {rootError ? (
          <div className="wf-state-card is-error" role="alert">
            <WorkspaceFileStateArt kind="error"/>
            <p className="wf-state-title">{rootError}</p>
            <p className="wf-state-detail">{t("请确认 Bot 在线并且工作区目录可访问。")}</p>
            <button type="button" className="wf-retry-btn" onClick={triggerManualRefresh}>{t("重试")}</button>
            {rootErrorHint && <small className="wf-error-code">{rootErrorHint}</small>}
          </div>
        ) : !nodes.has("") ? (
          <div className="wf-state-box" role="status">
            <LoaderCircle size={18} className="spin" aria-hidden="true"/>
            <span>{t("正在加载工作区文件…")}</span>
          </div>
        ) : <>
          {!changedOnly && !normalizedFilter && changesMessage && runFiles.summary && runFiles.summary.files > 0 && <h3 className="wf-section-title"><span>{t("全部文件")}</span></h3>}
          {renderDir("", 0)}
        </>}
        </>
      ) : (
        <div className="wf-preview">
          <div className="wf-preview-bar">
            <button type="button" className="wf-back-btn" onClick={closePreview}>
              <ArrowLeft size={14}/>
              <span>{t("返回目录")}</span>
            </button>
            <div className="wf-preview-bar-actions">
              {preview?.kind === "text" && preview.markdown && (
                <button type="button" className="wf-mini-btn" onClick={() => setRawMarkdown((value) => !value)}>
                  {rawMarkdown ? <Eye size={13}/> : <Code2 size={13}/>}
                  <span>{rawMarkdown ? t("渲染") : t("源码")}</span>
                </button>
              )}
              <button type="button" className="wf-mini-btn is-primary" onClick={() => selectedPath && onMentionFile(selectedPath)}>
                <AtSign size={13}/>
                <span>{t("引用给 Bot")}</span>
              </button>
            </div>
          </div>

          {previewLoading && <div className="wf-state-box" role="status"><LoaderCircle size={18} className="spin"/><span>{t("正在加载预览…")}</span></div>}
          {previewError && (
            <div className="wf-state-card is-error" role="alert">
              <WorkspaceFileStateArt kind="error"/>
              <p className="wf-state-title">{previewError}</p>
              <p className="wf-state-detail">{t("文件可能已经被移动、删除，或超出了当前工作区范围。")}</p>
              {selectedPath && (
                <button type="button" className="wf-retry-btn" onClick={() => void fetchPreview(selectedPath, false)}>
                  {t("重试")}
                </button>
              )}
              {previewErrorHint && <small className="wf-error-code">{previewErrorHint}</small>}
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "sensitive" && (
            <div className="wf-state-card is-sensitive">
              <WorkspaceFileStateArt kind="sensitive"/>
              <h3 className="wf-state-title">{t("此文件可能包含敏感凭据")}</h3>
              <p className="wf-state-detail">{t("为避免意外暴露密钥或令牌，{0} 默认不直接预览内容。", preview.name)}</p>
              <button type="button" className="wf-retry-btn" onClick={() => void fetchPreview(preview.path, true)}>
                {t("确认查看内容")}
              </button>
              <small className="wf-state-hint">{t("仅在本地只读查看，不会自动发送给其他人。")}</small>
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "text" && (
            <div className="wf-preview-content">
              <div className="wf-preview-meta">
                <span>{formatFileLimit(preview.size)}</span>
                <span>·</span>
                <span>{t("{0} 行", preview.lines)}</span>
                {preview.truncated && <span className="wf-truncated-note">{t("文件较大，仅展示前 512 KB")}</span>}
              </div>
              {preview.markdown && !rawMarkdown
                ? <div className="wf-markdown-body"><MarkdownText text={preview.content}/></div>
                : <CodeBlock text={preview.content} language={preview.language} className="wf-code-block" copyLabel={t("复制内容")}/>}
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "image" && (
            <div className="wf-preview-content wf-preview-image">
              <div className="wf-preview-meta"><span>{preview.mime}</span><span>·</span><span>{formatFileLimit(preview.size)}</span></div>
              <img src={preview.dataUrl} alt={preview.name}/>
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "pdf" && pdfBlob && (
            <div className="wf-preview-content wf-preview-pdf">
              <Suspense fallback={<div className="wf-state-box"><LoaderCircle size={18} className="spin"/></div>}>
                <PdfPreview blob={pdfBlob} name={preview.name}/>
              </Suspense>
            </div>
          )}

          {!previewLoading && !previewError && (preview?.kind === "binary" || preview?.kind === "too_large") && (
            <div className="wf-state-card">
              <WorkspaceFileStateArt kind="file"/>
              <p className="wf-state-title">{preview.kind === "too_large" ? t("文件过大，暂不支持直接预览。") : t("此二进制文件暂不支持文本预览。")}</p>
              <p className="wf-state-detail">{preview.kind === "too_large" ? t("仅支持直接预览 4 MB 以内的图片和 10 MB 以内的 PDF 文件。") : t("你可以先把它引用给 Bot，由 Bot 在工作区里读取或处理。")}</p>
              <small className="wf-error-code">{formatFileLimit(preview.size)}</small>
            </div>
          )}
        </div>
      )}
    </div>
  </aside>;
}

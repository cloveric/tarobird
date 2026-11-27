import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Folder, FolderOpen, FolderPlus, Home, LoaderCircle, Plus, Search, Trash2, X } from "lucide-react";
import {
  addSavedWorkspaceResultSchema,
  savedWorkspaceListSchema,
  workspaceBrowseSchema,
  workspaceDisplayName,
  type SavedWorkspace,
  type WorkspaceBrowseResult,
} from "../../src/client-protocol/saved-workspaces.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import "./workspace-picker.css";

export function useSavedWorkspaces(connection: HubConnection, enabled: boolean) {
  const [items, setItems] = useState<SavedWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const reloadSeq = useRef(0);
  const reloadAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { reloadAbort.current?.abort(); }, []);
  const reload = useCallback(async () => {
    if (!enabled) return;
    reloadAbort.current?.abort();
    const controller = new AbortController();
    reloadAbort.current = controller;
    const seq = ++reloadSeq.current;
    setLoading(true);
    setError("");
    try {
      const data = savedWorkspaceListSchema.parse(await connection.http("/api/workspaces", { signal: controller.signal }));
      if (reloadSeq.current !== seq) return;
      setItems(data.items);
    } catch (e) {
      if (controller.signal.aborted || reloadSeq.current !== seq) return;
      setError(e instanceof HubHttpError && e.status === 404 ? t("当前主机暂不支持常用工作区，请更新主机。") : t("暂时无法读取常用工作区列表。"));
    } finally {
      if (reloadSeq.current === seq) setLoading(false);
    }
  }, [connection, enabled]);
  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);
  const add = useCallback(async (folderPath: string, name?: string) => {
    reloadAbort.current?.abort();
    reloadSeq.current++;
    setError("");
    const result = addSavedWorkspaceResultSchema.parse(await connection.http("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ path: folderPath, ...(name?.trim() ? { name: name.trim() } : {}) }),
    }));
    setItems(result.items);
    return result.workspace;
  }, [connection]);
  const remove = useCallback(async (id: string) => {
    reloadAbort.current?.abort();
    reloadSeq.current++;
    setError("");
    try {
      const result = savedWorkspaceListSchema.parse(await connection.http(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }));
      setItems(result.items);
    } catch {
      setError(t("移除常用工作区失败，请稍后重试。"));
    }
  }, [connection]);
  return { items, loading, error, reload, add, remove };
}

export function WorkspaceAddForm({
  connection,
  disabled = false,
  onAdded,
  onCancel,
}: {
  connection: HubConnection;
  disabled?: boolean;
  onAdded: (workspace: SavedWorkspace) => void | Promise<void>;
  onCancel?: () => void;
}) {
  useLocale();
  const [folderPath, setFolderPath] = useState("");
  const [alias, setAlias] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [browseData, setBrowseData] = useState<WorkspaceBrowseResult>();
  const [browseLoading, setBrowseLoading] = useState(false);
  const browseSeq = useRef(0);
  const browseAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { browseAbort.current?.abort(); }, []);

  const loadBrowse = useCallback(async (targetPath?: string) => {
    browseAbort.current?.abort();
    const controller = new AbortController();
    browseAbort.current = controller;
    const seq = ++browseSeq.current;
    setBrowseLoading(true);
    setError("");
    try {
      const qs = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
      const data = workspaceBrowseSchema.parse(await connection.http(`/api/workspaces/browse${qs}`, { signal: controller.signal }));
      if (browseSeq.current !== seq) return;
      setBrowseData(data);
    } catch {
      if (controller.signal.aborted || browseSeq.current !== seq) return;
      setError(t("无法浏览主机上的该目录，请检查路径或权限。"));
    } finally {
      if (browseSeq.current === seq) setBrowseLoading(false);
    }
  }, [connection]);

  const toggleBrowse = () => {
    if (browsing) {
      browseAbort.current?.abort();
      browseSeq.current++;
      setBrowseLoading(false);
      setBrowsing(false);
      return;
    }
    setBrowsing(true);
    void loadBrowse(folderPath.trim() || undefined);
  };

  const savePath = async (targetPath: string, targetName?: string) => {
    const cleaned = targetPath.trim();
    if (!cleaned || saving || disabled) return;
    setSaving(true);
    setError("");
    try {
      const res = addSavedWorkspaceResultSchema.parse(await connection.http("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ path: cleaned, ...(targetName?.trim() ? { name: targetName.trim() } : {}) }),
      }));
      setFolderPath("");
      setAlias("");
      setBrowsing(false);
      await onAdded(res.workspace);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setError(code === "workspace_unavailable" ? t("主机上不存在此文件夹，请输入有效的绝对路径。") : code === "saved_workspaces_limit" ? t("常用工作区数量已达上限，请先移除不再使用的目录。") : t("添加工作区失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="workspace-add-box">
      <div className="workspace-add-row">
        <input
          type="text"
          value={folderPath}
          disabled={disabled || saving}
          placeholder={t("输入主机上的文件夹绝对路径")}
          aria-label={t("文件夹路径")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={e => setFolderPath(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void savePath(folderPath, alias); } }}
        />
        <button type="button" className="workspace-browse-toggle" disabled={disabled || saving} onClick={toggleBrowse}>
          <FolderOpen size={15} aria-hidden="true" />
          <span>{browsing ? t("收起目录") : t("浏览目录")}</span>
        </button>
      </div>
      <div className="workspace-add-meta">
        <input
          type="text"
          value={alias}
          maxLength={128}
          disabled={disabled || saving}
          placeholder={t("显示名称（可选，默认使用文件夹名）")}
          aria-label={t("工作区名称")}
          onChange={e => setAlias(e.target.value)}
        />
        <div className="workspace-add-actions">
          {onCancel && <button type="button" disabled={saving} onClick={onCancel}>{t("取消")}</button>}
          <button
            type="button"
            className="primary"
            disabled={disabled || saving || !folderPath.trim()}
            onClick={() => void savePath(folderPath, alias)}
          >
            {saving ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            <span>{t("添加")}</span>
          </button>
        </div>
      </div>
      {browsing && (
        <div className="workspace-browser" aria-busy={browseLoading || undefined}>
          <div className="workspace-browser-bar">
            <button
              type="button"
              className="icon-button"
              aria-label={t("回到主目录")}
              title={t("回到主目录")}
              disabled={browseLoading}
              onClick={() => void loadBrowse(browseData?.home)}
            >
              <Home size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("返回上一级目录")}
              title={t("返回上一级目录")}
              disabled={browseLoading || !browseData?.parent}
              onClick={() => browseData?.parent && void loadBrowse(browseData.parent)}
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
            <span className="workspace-browser-path" title={browseData?.path ?? ""}>
              {browseLoading && !browseData ? t("正在读取目录…") : browseData?.path ?? ""}
            </span>
            <button
              type="button"
              className="workspace-browser-use"
              disabled={disabled || saving || !browseData}
              onClick={() => browseData && void savePath(browseData.path, alias)}
            >
              <Check size={13} aria-hidden="true" />
              <span>{t("选择此目录")}</span>
            </button>
          </div>
          <div className="workspace-browser-entries" role="list">
            {browseLoading && <p className="muted workspace-browser-empty">{t("正在读取目录…")}</p>}
            {!browseLoading && browseData && !browseData.entries.length && (
              <p className="muted workspace-browser-empty">{t("此目录下没有子文件夹")}</p>
            )}
            {!browseLoading && browseData?.entries.map(entry => (
              <div className="workspace-browser-entry" role="listitem" key={entry.path}>
                <button
                  type="button"
                  className="workspace-browser-open"
                  onClick={() => void loadBrowse(entry.path)}
                  title={entry.path}
                >
                  <Folder size={14} aria-hidden="true" />
                  <span>{entry.name}</span>
                </button>
                <button
                  type="button"
                  className="workspace-browser-pick"
                  disabled={disabled || saving}
                  onClick={() => void savePath(entry.path)}
                >
                  {t("添加")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {error && <p role="alert" className="error-text workspace-error">{error}</p>}
    </div>
  );
}

export function SavedWorkspaceList({
  items,
  selectedPath,
  disabled = false,
  onSelect,
  onRemove,
  emptyText,
}: {
  items: SavedWorkspace[];
  selectedPath?: string;
  disabled?: boolean;
  onSelect: (workspace: SavedWorkspace) => void;
  onRemove?: (id: string) => void;
  emptyText?: string;
}) {
  useLocale();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? items.filter(item => item.name.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle))
    : items;

  if (!items.length) {
    return emptyText ? <p className="muted workspace-empty">{emptyText}</p> : null;
  }

  return (
    <div className="workspace-list-wrap">
      {items.length > 4 && (
        <div className="workspace-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={filter}
            placeholder={t("筛选工作区…")}
            aria-label={t("筛选工作区")}
            onChange={e => setFilter(e.target.value)}
          />
          {filter && (
            <button type="button" className="icon-button" aria-label={t("清空筛选")} onClick={() => setFilter("")}>
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      <div className="workspace-list" role="list">
        {visible.map(item => {
          const active = selectedPath === item.path;
          const missing = item.exists === false;
          return (
            <div className={`workspace-item${active ? " is-active" : ""}${missing ? " is-missing" : ""}`} role="listitem" key={item.id}>
              <button
                type="button"
                className="workspace-item-select"
                disabled={disabled || missing}
                aria-pressed={active}
                title={item.path}
                onClick={() => onSelect(item)}
              >
                <Folder size={15} aria-hidden="true" />
                <span className="workspace-item-copy">
                  <strong>{item.name || workspaceDisplayName(item.path)}</strong>
                  <small>{missing ? t("目录不存在：{0}", item.path) : item.path}</small>
                </span>
                {active && <Check size={15} className="workspace-item-check" aria-hidden="true" />}
              </button>
              {onRemove && (
                <button
                  type="button"
                  className="icon-button workspace-item-remove"
                  disabled={disabled}
                  aria-label={t("移除常用工作区「{0}」", item.name)}
                  title={t("从常用列表移除")}
                  onClick={() => onRemove(item.id)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
        {!visible.length && <p className="muted workspace-empty">{t("没有匹配的常用工作区")}</p>}
      </div>
    </div>
  );
}

export { FolderPlus };

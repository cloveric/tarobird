import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderPlus, RotateCcw } from "lucide-react";
import {
  botWorkspaceSettingsSchema,
  workspaceDisplayName,
  type SavedWorkspace,
} from "../../src/client-protocol/saved-workspaces.js";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useBotSettingsRequest } from "./bot-settings-request.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import { SavedWorkspaceList, useSavedWorkspaces, WorkspaceAddForm } from "./WorkspacePicker.js";
import "./workspace-picker.css";

function workspaceErrorText(error: unknown): string {
  if (error instanceof HubHttpError && error.status === 404) return t("此主机尚不支持在设置中切换默认工作区，请更新主机版本。");
  switch (error instanceof Error ? error.message : "") {
    case "workspace_conflict": return t("其他设备或本机已修改默认工作区，请重新读取后再切换。");
    case "workspace_unavailable": return t("主机上不存在此文件夹，请选择其他有效目录。");
    case "workspace_config_unreadable": return t("无法读取 Bot 配置文件，请检查主机上的配置。");
    case "bot_offline": return t("Bot 当前离线，上线后再切换默认工作区。");
    default: return t("切换默认工作区失败，请重新读取后重试。");
  }
}

export function BotWorkspaceControl({
  connection,
  bot,
  online,
  owner,
}: {
  connection: HubConnection;
  bot: Bot;
  online: boolean;
  owner: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!owner) setOpen(false); }, [owner]);
  const label = bot.workspacePath ? workspaceDisplayName(bot.workspacePath) : t("默认工作区");
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="header-effort bot-workspace-trigger"
        aria-label={t("切换 Bot 默认工作区：{0}", label)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={!owner ? t("仅拥有者可修改 Bot 设置") : bot.workspacePath || t("切换此 Bot 的默认工作区")}
        disabled={!owner || !online}
        onClick={() => setOpen(true)}
      >
        <Folder size={13} aria-hidden="true" />
        <span className="workspace-trigger-label">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && owner && (
        <BotWorkspaceDialog
          connection={connection}
          bot={bot}
          online={online}
          close={() => setOpen(false)}
          returnFocus={trigger}
        />
      )}
    </>
  );
}

function BotWorkspaceDialog({
  connection,
  bot,
  online,
  close,
  returnFocus,
}: {
  connection: HubConnection;
  bot: Bot;
  online: boolean;
  close: () => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  useLocale();
  const { data, busy, saving, error, saved, load, save } = useBotSettingsRequest(
    connection,
    bot.id,
    "workspace",
    botWorkspaceSettingsSchema,
    true,
  );
  const workspaces = useSavedWorkspaces(connection, online);
  const [adding, setAdding] = useState(false);

  const selectPath = async (nextPath: string) => {
    if (!data || busy || !online) return;
    if (nextPath && nextPath === data.workspacePath) return;
    await save({ revision: data.revision, workspacePath: nextPath });
    void workspaces.reload();
  };

  const handleAdded = async (workspace: SavedWorkspace) => {
    setAdding(false);
    await workspaces.reload();
    if (data && online) {
      await save({ revision: data.revision, workspacePath: workspace.path });
    }
  };

  const usingBotDefault = !!data && data.workspacePath === data.defaultWorkspacePath;

  return (
    <CreationDialog
      mobilePage
      title={t("默认工作区")}
      closeLabel={t("关闭默认工作区设置")}
      close={close}
      busy={saving}
      returnFocus={returnFocus}
      className="workspace-settings-dialog"
    >
      <div className="workspace-dialog-body">
        <p className="effort-scope">
          <strong>{bot.name}</strong>
          <span>{t("切换默认工作区仅影响此后新建的对话；已有对话会继续留在原文件夹中。")}</span>
        </p>

        {data && (
          <div className="workspace-current-card">
            <div className="workspace-current-head">
              <span className="workspace-current-label">{t("当前默认工作区")}</span>
              {!usingBotDefault && (
                <button
                  type="button"
                  className="text-button workspace-reset-btn"
                  disabled={busy || !online}
                  onClick={() => void selectPath("")}
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  <span>{t("恢复 Bot 自带目录")}</span>
                </button>
              )}
            </div>
            <div className="workspace-current-path" title={data.workspacePath}>
              <Folder size={15} aria-hidden="true" />
              <div>
                <strong>{usingBotDefault ? t("Bot 自带工作区") : workspaceDisplayName(data.workspacePath)}</strong>
                <small>{data.workspacePath}</small>
              </div>
            </div>
          </div>
        )}

        <div className="workspace-section-head">
          <h4>{t("常用工作区")}</h4>
          <button
            type="button"
            className="workspace-add-trigger"
            disabled={busy || !online}
            onClick={() => setAdding(value => !value)}
          >
            <FolderPlus size={14} aria-hidden="true" />
            <span>{adding ? t("收起") : t("添加文件夹")}</span>
          </button>
        </div>

        {adding && (
          <WorkspaceAddForm
            connection={connection}
            disabled={busy || !online}
            onAdded={handleAdded}
            onCancel={() => setAdding(false)}
          />
        )}

        <SavedWorkspaceList
          items={workspaces.items}
          selectedPath={data?.workspacePath}
          disabled={busy || !online}
          onSelect={item => void selectPath(item.path)}
          onRemove={id => void workspaces.remove(id)}
          emptyText={workspaces.error || workspaces.loading ? undefined : t("还没有常用工作区。点击「添加文件夹」保存一次，之后一键切换。")}
        />
        {workspaces.error && <p role="alert" className="error-text">{workspaces.error}</p>}

        {saved && data && (
          <p role="status" className="dashboard-notice">
            {t("已切换默认工作区为「{0}」，新对话将在此目录运行。", workspaceDisplayName(data.workspacePath))}
          </p>
        )}
        {busy && !saving && <p role="status" className="muted">{t("正在读取…")}</p>}
        {saving && <p role="status" className="muted">{t("正在切换…")}</p>}
        {!online && <p role="status" className="muted">{t("连接恢复后即可操作")}</p>}
        {error !== undefined && <p role="alert" className="error-text">{workspaceErrorText(error)}</p>}
        {(!data || error !== undefined || !!workspaces.error) && !busy && (
          <button type="button" disabled={!online} onClick={() => { void load(); void workspaces.reload(); }}>
            {t("重新读取")}
          </button>
        )}
      </div>
    </CreationDialog>
  );
}

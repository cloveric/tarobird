import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backupSettingsSchema, MAX_BACKUP_DAYS, type BackupSettingsState } from "../../src/client-protocol/backup-settings.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { timeoutSignal } from "./abort-signals.js";
import type { HubConnection } from "./connection.js";
import { t, useLocale } from "./i18n.js";
import "./backup-settings.css";

export function BackupSettings({ connection, active, onDirty, onBusy }: { connection: HubConnection; active: boolean; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void }) {
  useLocale();
  const host = useContext(RuntimeHostContext), state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const owner = state.user?.role === "owner", online = state.status === "online", supported = state.backupSettingsAvailable === true;
  const [view, setView] = useState<BackupSettingsState>(), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(false), [saved, setSaved] = useState(false);
  const generation = useRef(0), flight = useRef(false), loaded = useRef(false);
  const dirty = !!view && draft !== String(view.retentionDays);
  const valid = /^(0|[1-9]\d*)$/.test(draft) && Number(draft) <= MAX_BACKUP_DAYS;
  const bytes = view?.snapshots.bytes ?? 0, size = bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  const read = async (requestId?: string) => backupSettingsSchema.parse(await connection.http(`/api/settings/backups${requestId ? `?requestId=${requestId}` : ""}`, { signal: timeoutSignal(20_000) }));
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => () => { generation.current++; }, [connection]);
  async function load(replaceDraft = false) {
    if (flight.current) return;
    const scope = generation.current;
    flight.current = true; setBusy(true); setSaved(false);
    try {
      const next = await read();
      if (scope !== generation.current) return;
      setView(next); if (replaceDraft || !loaded.current) setDraft(String(next.retentionDays));
      loaded.current = true; setError(false);
    } catch { if (scope === generation.current) setError(true); }
    finally { flight.current = false; if (scope === generation.current) setBusy(false); }
  }
  useEffect(() => { if (active && owner && online && supported) void load(!dirty); }, [active, owner, online, supported, connection]);
  async function save() {
    if (!view || !valid || !dirty || !online || !owner || connection.isReadOnly || error || flight.current) return;
    const scope = generation.current, command = { retentionDays: Number(draft), revision: view.revision, requestId: crypto.randomUUID() };
    flight.current = true; setBusy(true); setSaved(false);
    try {
      await connection.http("/api/settings/backups", { method: "PUT", signal: timeoutSignal(20_000), body: JSON.stringify(command) });
      const current = await read(command.requestId);
      if (scope !== generation.current) return;
      setView(current);
      if (current.receipt?.requestId !== command.requestId || current.receipt.revision !== current.revision || current.retentionDays !== command.retentionDays) throw new Error("changed");
      setDraft(String(current.retentionDays)); setError(false); setSaved(true);
    } catch { if (scope === generation.current) setError(true); }
    finally { flight.current = false; if (scope === generation.current) setBusy(false); }
  }
  return <div className="backup-settings">
    <SettingsGroupHeading scope="host" host={host}>{t("自动备份")}</SettingsGroupHeading>
    <p className="settings-lede">{t("每天保存一份主机数据库快照，用于恢复聊天记录、设备授权、Bot 记录和网络配置等数据库状态。")}</p>
    {!owner ? <p className="settings-note muted">{t("仅主机所有者可以管理自动备份。")}</p> : <>
      <div className="settings-group"><div className="settings-row">
        <div className="settings-row-text"><label htmlFor="backup-retention-days">{t("保留天数")}</label><small id="backup-retention-hint">{t("默认 1 天；0 天关闭自动备份。")}</small></div>
        {view ? <div className="backup-days"><input id="backup-retention-days" type="number" inputMode="numeric" min={0} max={MAX_BACKUP_DAYS} step={1} value={draft} disabled={busy || !online || error || connection.isReadOnly} aria-describedby="backup-retention-hint backup-retention-effect" aria-invalid={!valid} onChange={event => { setDraft(event.target.value); setSaved(false); }}/><span>{t("天")}</span></div>
          : <span className="muted" role="status">{!online ? t("连接恢复后即可操作") : !supported ? t("请更新主机以使用此设置。") : error ? t("读取失败") : t("正在读取…")}</span>}
      </div></div>
      <p id="backup-retention-effect" className="settings-note muted">{t("缩短保留天数会清理过期自动快照；设为 0 会清理全部自动快照。聊天记录本身不会被删除，手动备份和升级恢复副本不受影响。")}</p>
      {view && <>
        {!valid && <p className="settings-warning" role="alert">{t("请输入 0 到 {0} 的整数。", MAX_BACKUP_DAYS)}</p>}
        <div className="quick-actions"><button type="button" className="primary" disabled={!dirty || !valid || busy || !online || error || connection.isReadOnly} onClick={() => void save()}>{t("保存备份设置")}</button><button type="button" disabled={busy || !online} onClick={() => void load(true)}>{t("重新读取")}</button></div>
        <p className="settings-note backup-storage">{t("已保留 {0} 份自动快照，共 {1}。", view.snapshots.count, size)}{view.snapshots.latestDay && <> {t("最近快照：{0}（UTC）。", view.snapshots.latestDay)}</>}</p>
      </>}
      {busy && <p className="settings-note" role="status">{t("正在核实设置…")}</p>}
      {saved && !error && <p className="settings-note" role="status">{t("已保存并核实，自动备份将在下一次维护时按新设置运行，通常不超过 1 分钟。")}</p>}
      {error && <p className="settings-warning" role="alert">{t("未能确认当前设置，请重新读取后再操作。")}{!view && <button type="button" disabled={busy || !online} onClick={() => void load(true)}>{t("重新读取")}</button>}</p>}
    </>}
    <details className="settings-note muted"><summary>{t("备份包含什么？")}</summary><p>{t("自动快照只保存数据库，不包含附件原文件、Bot 工作区、引擎登录信息或主机身份密钥。恢复整台主机需要完整备份。")}</p><p>{t("保留期按 UTC 日期计算。只有新快照成功保存后，才会清理过期快照；关闭自动备份时除外。")}</p></details>
  </div>;
}

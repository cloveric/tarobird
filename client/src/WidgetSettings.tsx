import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { widgetSettingsSchema, type WidgetSettingsState } from "../../src/client-protocol/widget-settings.js";
import type { HubConnection } from "./connection.js";
import { timeoutSignal } from "./abort-signals.js";
import { t, useLocale } from "./i18n.js";

/** Immediate host setting with verified read-back. Unknown outcomes never cause
 * an automatic second write; refresh reads the authoritative state. */
export function WidgetSettings({ connection, active, onBusy }: { connection: HubConnection; active: boolean; onBusy: (busy: boolean) => void }) {
  useLocale();
  const host = useContext(RuntimeHostContext);
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const owner = state.user?.role === "owner";
  const online = state.status === "online", supported = state.widgetSettingsAvailable === true;
  const [view, setView] = useState<WidgetSettingsState>(), [busy, setBusy] = useState(false), [error, setError] = useState(false), [saved, setSaved] = useState(false);
  const flight = useRef(false), generation = useRef(0);
  const read = async (requestId?: string) => widgetSettingsSchema.parse(await connection.http(`/api/settings/widgets${requestId ? `?requestId=${requestId}` : ""}`, { signal: timeoutSignal(15_000) }));
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => {
    const current = ++generation.current;
    if (!owner || !active || !online || !supported || flight.current) return;
    setView(undefined); setError(false); setSaved(false);
    void read().then(value => { if (current === generation.current) setView(value); }).catch(() => { if (current === generation.current) setError(true); });
    return () => { generation.current++; };
  }, [connection, active, online, supported, owner]);
  async function refresh() {
    if (flight.current) return;
    flight.current = true; setBusy(true); setSaved(false);
    try { setView(await read()); setError(false); } catch { setError(true); }
    finally { flight.current = false; setBusy(false); }
  }
  async function toggle(recover = false) {
    if (!view || flight.current || !online || error) return;
    flight.current = true; setBusy(true); setSaved(false);
    const command = { enabled: recover ? false : !view.enabled, revision: view.revision, requestId: crypto.randomUUID() };
    try {
      await connection.http("/api/settings/widgets", { method: "PUT", signal: timeoutSignal(15_000), body: JSON.stringify(command) });
      const current = await read(command.requestId);
      setView(current);
      if (current.receipt?.requestId !== command.requestId || current.receipt.revision !== current.revision || current.enabled !== command.enabled) throw new Error("changed");
      setError(false); setSaved(true);
    } catch { setError(true); }
    finally { flight.current = false; setBusy(false); }
  }
  if (!owner) return <div className="widget-settings"><SettingsGroupHeading scope="host" host={host}>{t("可视化回复")}</SettingsGroupHeading><p className="settings-note muted">{t("仅主机所有者可以配置可视化回复。")}</p></div>;
  return <div className="widget-settings">
    <SettingsGroupHeading scope="host" host={host}>{t("可视化回复")}</SettingsGroupHeading>
    <div className="settings-group"><div className="settings-row">
      <div className="settings-row-text"><span id="widget-setting-label">{t("生成交互图形")}</span><small id="widget-setting-description">{view?.enabled === false ? t("已关闭，历史图形仍可查看。") : t("用图表、时间线直观展示信息。")}</small></div>
      {view ? <button type="button" role="switch" className="model-brand-toggle" aria-labelledby="widget-setting-label" aria-describedby="widget-setting-description" aria-checked={view.enabled} disabled={busy || !online || error || view.recoveryRequired} onClick={() => void toggle()}><span className="model-brand-toggle-track" aria-hidden="true"/></button> : <span className="muted" role="status">{!online ? t("连接恢复后即可操作") : !supported ? t("请更新主机以使用此设置。") : error ? t("读取失败") : t("正在读取…")}</span>}
    </div></div>
    {view?.recoveryRequired && <p role="alert" className="settings-warning">{t("图形设置已损坏，已暂停新图形发布。可以先恢复为关闭状态，再按需要开启。")}{" "}<button type="button" disabled={busy || !online || error} onClick={() => void toggle(true)}>{t("恢复为关闭状态")}</button></p>}
    {!!view?.workersNeedingUpdate.length && <p role="status" className="settings-warning">{t("这些 Bot 需要更新后才能停用图形指引：{0}。主机已按开关限制新图形发布。", view.workersNeedingUpdate.map(bot => bot.name).join("、"))}</p>}
    {busy && <p className="settings-note" role="status">{t("正在核实设置…")}</p>}
    {saved && !error && <p className="settings-note" role="status">{t("已保存并核实。")}</p>}
    {error && <p className="settings-warning" role="alert">{t("未能确认当前设置，请重新读取后再操作。")}{" "}<button type="button" disabled={!online || busy} onClick={() => void refresh()}>{t("重新读取")}</button></p>}
  </div>;
}

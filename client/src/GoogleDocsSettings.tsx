import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";
import { googleDocsStatusSchema, type GoogleDocsStatus } from "../../src/client-protocol/google-docs.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { timeoutSignal } from "./abort-signals.js";
import { googleDocsErrorText } from "./google-docs-errors.js";
import { nativePlatform } from "./native.js";
import { t, useLocale } from "./i18n.js";
import "./google-docs-settings.css";

export function GoogleDocsSettings({ connection, phone }: { connection: HubConnection; phone: boolean }) {
  useLocale(); const host = useContext(RuntimeHostContext);
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [view, setView] = useState<GoogleDocsStatus>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const generation = useRef(0), flight = useRef(false);
  useEffect(() => { generation.current++; setView(undefined); setError(""); setBusy(false); flight.current = false; return () => { generation.current++; }; }, [connection, state.user?.id, state.user?.role]);
  async function check() {
    if (flight.current) return;
    const token = generation.current; flight.current = true; setBusy(true); setError("");
    try {
      const result = googleDocsStatusSchema.parse(await connection.http("/api/gdocs/status", { signal: timeoutSignal(20_000) }));
      if (token === generation.current) setView(result);
    } catch (e) { if (token === generation.current) { setView(undefined); setError(e instanceof Error ? e.message : "unknown"); } }
    finally { if (token === generation.current) { flight.current = false; setBusy(false); } }
  }
  const owner = state.user?.role === "owner";
  const platform = nativePlatform();
  const mobile = platform === "ios" || platform === "android" || (platform === "web" && phone);
  if (mobile) return <div className="google-docs-settings">
    <SettingsGroupHeading scope="host" host={host}>{t("Google 文档")}</SettingsGroupHeading>
    <p className="settings-note muted">{owner
      ? t("请在主机的桌面版完成配置，配置后即可在手机上导出。")
      : t("请联系主机所有者在桌面版完成配置。")}</p>
  </div>;
  return <div className="google-docs-settings">
    <SettingsGroupHeading scope="host" host={host}>{t("Google 文档")}</SettingsGroupHeading>
    <p className="settings-note muted">{t("把消息导出到主机授权的 Google 账号。需要 OAuth 登录授权，不使用普通 API Key。")}</p>
    {owner ? <>
      <button type="button" disabled={busy || state.status !== "online"} onClick={() => void check()}>{busy ? t("正在检查…") : t("检查 Google 文档配置")}</button>
      {view && <p role="status" className="settings-note">{view.error ? googleDocsErrorText(view.error, "status") : view.authorized ? t("授权已保存；实际可用性将在导出时验证。") : t("配置文件已导入，尚未完成 Google 授权。")}</p>}
      {error && <p role="alert" className="settings-note error-text">{googleDocsErrorText(error, "status")}</p>}
    </> : <p className="settings-note muted">{t("请联系主机所有者配置 Google 文档。")}</p>}
    <details className="google-docs-guide settings-note">
      <summary>{t("如何配置 Google 文档")}</summary>
      <p>{t("配置在当前连接的主机上完成；手机或其他电脑无需各自配置。当前入口提供状态检查和步骤，OAuth 登录仍在主机终端发起。")}</p>
      <ol>
        <li>{t("在 Google Cloud 创建或选择项目，启用 Google Docs API，并设置 OAuth 同意屏幕；测试模式下添加自己的 Google 账号。")}</li>
        <li>{t("创建「桌面应用」类型的 OAuth 客户端，下载 JSON 文件到主机。")}</li>
        <li>{t("在主机终端导入文件，再发起授权：")}<pre><code>{'tarobot gdocs configure --client-file "/absolute/path/client.json"\ntarobot gdocs auth\ntarobot gdocs status'}</code></pre></li>
        <li>{t("用同一台主机的浏览器打开终端给出的链接，登录并授权，然后返回这里检查配置。")}</li>
      </ol>
      <p>{t("如果主机使用自定义数据目录，请为每条命令加上 --state-dir。配置文件保存在主机，授权令牌保存在系统钥匙串；不要把它们发送到聊天。")}</p>
      <p>{t("当前支持 Mac 或配有 Secret Service 的 Linux 主机；Windows 主机暂不支持此授权方式。")}</p>
      <a href="https://developers.google.com/workspace/docs/api/quickstart/python#authorize_credentials_for_a_desktop_application" target="_blank" rel="noopener noreferrer">{t("Google 官方配置说明")}</a>
    </details>
  </div>;
}

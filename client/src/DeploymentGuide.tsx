import { t } from "./i18n.js";

/** Route setup is independent of the computer or server hosting the Bot. */
export function DeploymentGuide() {
  return <details className="deployment-guide deployment-security"><summary>{t("直连和中转怎么选？")}</summary>
    <p><strong>{t("直连主机")}</strong> — {t("填写运行 Bot 的电脑或服务器地址，例如局域网、Tailscale 或公网 HTTPS 地址。")}</p>
    <p><strong>{t("中转线路")}</strong> — {t("填写已经部署好的中转入口。它必须通向同一台主机；多台主机共用云服务器时，各自需要独立入口。")}</p>
    <p>{t("可以同时保留直连和中转，也可以只使用中转。直连优先，其余线路按顺序备用。")}</p>
    <p>{t("这里只保存连接地址，不会部署中转、安装 Bot 或迁移数据。运行 Bot 的主机仍需保持在线。")}</p>
    <p>{t("公网连接必须使用 HTTPS。新设备仍需配对确认，每次连接验证主机和设备身份；知道地址并不代表能使用 Bot。")}</p>
    <p>{t("主机保存工作区、聊天和引擎登录信息，主机管理员可访问这些数据。内置中转只转发加密连接，不保存聊天或离线文件；中转管理员仍可看到连接时间和流量大小。")}</p>
  </details>;
}

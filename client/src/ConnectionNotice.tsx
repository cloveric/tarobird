import { ChevronDown, RefreshCw, WifiOff } from "lucide-react";
import { t } from "./i18n.js";
import "./connection-notice.css";

/** Phone reading space is scarce. Keep routine connectivity in one disclosure;
 * permission, trust and message errors retain their separate actionable alert. */
export function ConnectionNotice({ host, pending, retrying }: { host: string; pending: number; retrying: boolean }) {
  return <details className="phone-connection-notice">
    <summary>
      {retrying ? <RefreshCw size={14} aria-hidden="true"/> : <WifiOff size={14} aria-hidden="true"/>}
      <span className="connection-notice-host" role="status">{retrying ? t("正在连接「{0}」", host) : t("与「{0}」已断开", host)}</span>
      <span className="connection-notice-action">{retrying ? t("正在重连…") : t("查看详情")}</span>
      <ChevronDown size={14} aria-hidden="true"/>
    </summary>
    <div>
      <p>{t("与「{0}」的连接已断开，已缓存的消息仍可阅读。", host)}</p>
      <p>{t("手机断开连接不会取消已提交给主机的任务。")}</p>
      {pending > 0 && <p>{t("{0} 条消息将在重连后发送。", pending)}</p>}
    </div>
  </details>;
}

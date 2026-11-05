import { LocalAsrSetup } from "./LocalAsrSetup.js";
import type { HubConnection } from "./connection.js";
import { useId, useState } from "react";
import { t, useLocale } from "./i18n.js";
import "./integration-recommendations.css";

export type IntegrationFeature = "asr" | "search" | "cloud-asr";

/** Optional guidance only. Choosing features does not install or send anything. */
export function IntegrationRecommendations({ prepare, disabled = false, connection, active = true }: { connection?: HubConnection; prepare: (features: IntegrationFeature[]) => void; disabled?: boolean; active?: boolean }) {
  useLocale();
  const id = useId();
  const [asr, setAsr] = useState(true), [search, setSearch] = useState(true), [cloud, setCloud] = useState(false);
  const features: IntegrationFeature[] = [...(asr ? ["asr" as const] : []), ...(search ? ["search" as const] : []), ...(cloud ? ["cloud-asr" as const] : [])];
  return <section className="integration-recommendations" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t("语音与搜索建议")}</h3>
    <p>{t("可选增强，稍后也能在 Skills 与 MCP 中配置。")}</p>
    <label><input type="checkbox" checked={asr} onChange={event => setAsr(event.target.checked)}/><span><strong>Qwen3-ASR 0.6B</strong><small>{t("在主机本地转写语音，需要下载模型并预留存储空间。")}</small></span></label>
    <label><input type="checkbox" checked={search} onChange={event => setSearch(event.target.checked)}/><span><strong>Tavily + Brave</strong><small>{t("为 Bot 配置联网搜索，需使用你自己的 API 密钥。")}</small></span></label>
    <label><input type="checkbox" checked={cloud} onChange={event => setCloud(event.target.checked)}/><span><strong>{t("通义听悟 · 长语音")}</strong><small>{t("长录音可使用云端转写，需阿里云配置并可能产生费用。接入后在「设置 → 语音转写」启用。")}</small></span></label>
    <button type="button" className="primary" disabled={disabled || !features.length} onClick={() => prepare(features)}>{t("让 Bot 协助配置")}</button>
    <p className="integration-help">{t("先生成配置消息，由你确认发送。已有配置会先检查，无需重复安装。")}</p>
    {connection && active && <LocalAsrSetup key={connection.identity.hubPublicKey} connection={connection}/>}
  </section>;
}

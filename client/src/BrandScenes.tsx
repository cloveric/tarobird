import { useId } from "react";
import { ShieldCheck } from "lucide-react";
import { t, useLocale } from "./i18n.js";
import taroBotMark from "./brand/tarobot.png";

/** Shared product identity for the pairing, welcome and loading screens. */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return <span className="wordmark" data-brand-context="scene"><img className="wordmark-icon wordmark-icon-colour" src={taroBotMark} width={32} height={32} alt="" aria-hidden="true" draggable={false}/><span className="wordmark-icon wordmark-icon-flat" aria-hidden="true"/>{!compact && <span className="wordmark-text">TaroBird</span>}</span>;
}

/** Sidebar product name: text only, without the mascot used by full-screen scenes. */
export function BrandName() {
  return <span className="wordmark" data-brand-context="sidebar"><span className="wordmark-text">TaroBird</span></span>;
}

/** The real pairing flow, step by step; it makes no claim about Hub reachability. */
export function PairingIntro({ companion = false }: { companion?: boolean }) {
  useLocale(); const id = useId();
  return <section className="pairing-intro" aria-labelledby={id}>
    <h2 id={id}>{t("如何连接")}</h2>
    <ol className="pairing-steps">
      <li><span className="pairing-step-index" aria-hidden="true">1</span><div><strong>{companion ? t("先准备运行 Bot 的主机") : t("确认已有主机在线")}</strong><p>{companion ? t("在 Mac 版 TaroBird 中创建主机，或使用已经部署好的服务器。") : t("运行 Bot 的电脑或 CLI 主机保持开机联网；有已配对手机即可继续。")}</p></div></li>
      {/* Where the QR code comes from: the step new users miss. */}
      <li className="pairing-step-key"><span className="pairing-step-index" aria-hidden="true">2</span><div><strong>{t("用已配对手机或电脑分享连接信息")}</strong><p>{t("打开「设备与网络 → 添加设备」，直接显示连接二维码，也可以复制连接信息。")}</p></div></li>
      <li><span className="pairing-step-index" aria-hidden="true">3</span><div><strong>{t("用已配对设备确认")}</strong><p>{t("在已配对手机或电脑上核对 8 位配对码。主机保持在线即可，无需人在主机旁。")}</p></div></li>
    </ol>
    <p className="pairing-security"><ShieldCheck size={14} aria-hidden="true"/><span>{t("每台设备持有独立密钥；扫码配对会校验 Hub 身份，撤销授权会立即断开该设备。")}</span></p>
  </section>;
}

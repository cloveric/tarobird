import { useState } from "react";
import { Copy, RotateCw } from "lucide-react";
import { BrandMark } from "./BrandScenes.js";
import { nativePlatform } from "./native.js";
import { t } from "./i18n.js";
import type { StartupAttempt } from "./startup-diagnostics.js";
import { version } from "../package.json";
import "./startup-failure.css";

/** Available before the workspace loads, including failed native startup. */
export function StartupFailure({ message, attempts }: { message: string; attempts?: StartupAttempt[] }) {
  const [copyStatus, setCopyStatus] = useState("");
  const diagnostics = JSON.stringify({ app: "TaroBird", version, platform: nativePlatform(),
    stage: attempts ? "local_controller" : "local_data", ...(attempts ? { attempts } : {}) }, null, 2);
  return <main className="startup-failure"><section className="startup-failure-card" aria-labelledby="startup-failure-title">
    <BrandMark/>
    <h1 id="startup-failure-title">{t("TaroBird 暂时无法启动")}</h1>
    <p role="alert">{message}</p>
    <p className="startup-failure-hint">{t("未清除原有授权或聊天记录。请重试，或复制诊断信息以便排查。")}</p>
    <div className="startup-failure-actions">
      <button type="button" className="primary" onClick={() => location.reload()}><RotateCw size={16}/>{t("重新尝试")}</button>
      <button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(diagnostics); setCopyStatus(t("诊断信息已复制")); }
        catch { setCopyStatus(t("复制失败，请选择文字后复制。")); }
      }}><Copy size={16}/>{t("复制诊断信息")}</button>
    </div>
    <span className="startup-failure-copy" role="status">{copyStatus}</span>
    <details><summary>{t("查看诊断信息")}</summary><pre tabIndex={0}>{diagnostics}</pre></details>
  </section></main>;
}

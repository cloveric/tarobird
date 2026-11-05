import { useEffect, useState } from "react";
import { isElectron, electronBridge, invoke } from "./desktop-bridge.js";
import { recoverDesktopTransport } from "./transport.js";
import { t } from "./i18n.js";
import "./desktop-recovery.css";

/** Recovery never reloads the document or unmounts editable UI. In particular,
 * attachment File objects and unsubmitted queue edits are retained in memory. */
export function DesktopRecovery() {
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  useEffect(() => {
    if (!isElectron()) return;
    let active = true, revision = 0;
    const receive = (payload: unknown) => {
      revision++;
      if (active && payload && typeof payload === "object" && "failed" in payload && payload.failed === true) setFailed(true);
    };
    let stop: (() => void) | undefined;
    try {
      stop = electronBridge().on("native-state", receive);
      const current = revision;
      void invoke("desktop_native_state").then(value => { if (current === revision) receive(value); }, () => { if (active) setFailed(true); });
    } catch { setFailed(true); }
    return () => { active = false; stop?.(); };
  }, []);
  if (!failed) return null;
  const recover = async () => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await recoverDesktopTransport(() => invoke("desktop_recover")); setFailed(false); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <aside className="desktop-recovery" role="alert">
    <span>{error ? t("恢复失败，编辑中的内容仍保留，请重试。") : t("桌面连接服务已停止，编辑中的内容仍保留。")}</span>
    <button type="button" disabled={busy} onClick={() => void recover()}>{busy ? t("正在恢复…") : t("恢复连接")}</button>
  </aside>;
}

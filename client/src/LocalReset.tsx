import { useEffect, useRef, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { completeLocalReset, type ResetStep } from "./local-reset.js";
import { cache } from "./storage.js";
import { clearShareInbox } from "./share-inbox.js";
import { clearLocalPush } from "./notifications.js";
import { deleteNativeIdentity } from "./native.js";
import { t } from "./i18n.js";
import { clearLocalBrowserData } from "./workbench-reset.js";

export function LocalReset({ complete }: { complete: () => void }) {
  const [step, setStep] = useState<ResetStep>("shared"), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  useEffect(() => {
    if (running.current) return;
    running.current = true; setError(false);
    const reset = () => completeLocalReset({ pending: () => cache.pendingReset(), shared: clearShareInbox, push: clearLocalPush,
      browser: async () => { const identity = await cache.identity(); await clearLocalBrowserData(identity?.hubPublicKey, identity?.hubPublicKey ? await cache.workbenchBrowserScopes(identity.hubPublicKey) : []); },
      key: deleteNativeIdentity, finish: () => cache.finishReset() }, setStep);
    // Coordinate multiple browser tabs; every page re-reads the durable record
    // inside the lock, so a late tab cannot unregister a newly paired device.
    const work = navigator.locks ? navigator.locks.request("tarocub-local-reset", reset) : reset();
    void work.then(complete, () => setError(true)).finally(() => { running.current = false; });
  }, [attempt, complete]);
  const steps = { shared: t("共享文件"), push: t("推送注册"), browser: t("网页登录数据"), key: t("设备密钥"), cache: t("本地缓存") };
  return <main className="pairing-page"><div className="pairing-card" aria-busy={!error}><ShieldCheck size={32}/><h1>{t("正在断开此设备")}</h1><p>{t("清理完成后可重新配对。主机中的历史消息会保留。")}</p>
    {error ? <><p role="alert" className="error-text">{t("未能清理{0}。旧连接已停止，请重试；重新打开应用也会继续清理。", steps[step])}</p><button className="primary full" onClick={() => setAttempt((value) => value + 1)}>{t("重试清理")}</button></> : <><p role="status"><LoaderCircle className="spin" size={18}/>{t("正在清理{0}…", steps[step])}</p>{step === "key" && <p>{t("系统可能正在等待钥匙串或安全存储确认。请查看系统提示，确认删除此设备的密钥；若取消，可返回这里重试。旧连接已停止，清理完成后才会开放重新配对。")}</p>}</>}
  </div></main>;
}

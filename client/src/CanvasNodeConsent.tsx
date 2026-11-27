import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { NodeConsent } from "./canvas-node-host.js";
import { t } from "./i18n.js";

export function useCanvasNodeConsent(frameKey: string) {
  const [review, setReview] = useState<NodeConsent>();
  const pending = useRef<((ok: boolean) => void) | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const finish = useCallback((ok: boolean) => {
    const resolve = pending.current;
    pending.current = undefined;
    setReview(undefined);
    resolve?.(ok);
  }, []);
  useLayoutEffect(() => () => finish(false), [frameKey, finish]);
  useLayoutEffect(() => {
    if (!review) return;
    const current = dialog.current;
    current?.showModal();
    return () => current?.close();
  }, [review]);
  const confirm = useCallback((request: NodeConsent): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    return new Promise(resolve => { pending.current = resolve; setReview(request); });
  }, []);
  const title = review?.kind === "enable" ? t("允许第三方画布节点") : t("安装第三方画布节点");
  return { confirm, dialog: review && (
    <dialog ref={dialog} role="alertdialog" aria-label={title} className="plugin-consent-box canvas-node-consent"
      onCancel={event => { event.preventDefault(); finish(false); }}>
      <h3>{title}</h3>
      {review.kind === "enable" ? <p>{t("第三方作者提供的脚本会处理你交给该节点的文字和标题。请只安装你信任的来源。节点在独立沙箱内运行，无法读取画布密钥或其他节点。")}</p>
        : <><p>{t("确认将以下版本保存到这台设备。以后运行它时会使用相同的脚本。")}</p>
          <p><strong>{review.node.title}</strong></p><p><code>{review.node.url}</code></p>
          <p>SHA-256 <code>{review.node.sha256}</code></p></>}
      <div className="plugin-consent-actions">
        <button type="button" className="secondary" autoFocus onClick={() => finish(false)}>{t("取消")}</button>
        <button type="button" className="primary" onClick={() => finish(true)}>{review.kind === "enable" ? t("允许") : t("确认安装")}</button>
      </div>
    </dialog>) };
}

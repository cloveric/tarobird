import { useEffect, useState, useSyncExternalStore } from "react";
import { t, useLocale } from "./i18n.js";
import { androidUpdater, isAndroidUpdater, startAndroidUpdateChecks } from "./android-updates.js";
import { GitHubUpdateLoginController } from "./github-update-backend.js";
import { updateErrorMessage } from "./DesktopUpdates.js";
import { CreationDialog } from "./CreationDialog.js";

export function AndroidUpdates() {
  useLocale(); const state = useSyncExternalStore(androidUpdater.subscribe, androidUpdater.snapshot);
  const [login] = useState(() => new GitHubUpdateLoginController({ invoke: androidUpdater.invoke, open: () => androidUpdater.bridge.openLogin(), authorized: () => androidUpdater.check() }));
  const loginState = useSyncExternalStore(login.subscribe, login.snapshot);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!isAndroidUpdater()) return; const close = startAndroidUpdateChecks(); void androidUpdater.refresh(); return () => { close(); void login.cancel(); }; }, [login]);
  if (!isAndroidUpdater()) return null;
  const busy = ["checking", "downloading", "verifying", "install-pending"].includes(state.phase);
  const signingIn = loginState.phase === "starting" || loginState.phase === "waiting";
  const installable = state.nextVersion && (state.authenticated || state.downloaded) && ["available", "ready", "error"].includes(state.phase);
  return <section className="desktop-updates android-updates"><h3>{t("应用更新")}</h3><p>TaroBird {state.version ?? ""}</p>
    {state.phase === "disabled" ? <p className="muted">{t("此开发版本尚未配置签名更新源。")}</p> : <>
      {state.authenticated ? <><p>{t("已登录 GitHub：{0}", state.login ?? "GitHub")}</p><button disabled={busy || signingIn} onClick={() => { void androidUpdater.logout(); }}>{t("退出 GitHub 登录")}</button></> : <>
        <p className="muted">{t("登录 GitHub 后可检查和安装私有更新。")}</p>
        {!signingIn && <button disabled={busy} onClick={() => { void login.start(); }}>{t("登录 GitHub")}</button>}
        {loginState.phase === "starting" && <p role="status">{t("正在准备 GitHub 登录…")}</p>}
        {loginState.phase === "waiting" && <div className="github-update-login"><p>{t("在 GitHub 验证页面输入以下验证码，然后在浏览器中批准登录。")}</p><p><code aria-label={t("GitHub 验证码")}>{loginState.userCode}</code></p><button onClick={() => { void login.openAuthorization(); }}>{t("打开 GitHub 验证页面")}</button><p role="status">{t("等待 GitHub 授权…")}</p></div>}
        {signingIn && <button onClick={() => { void login.cancel(); }}>{t("取消 GitHub 登录")}</button>}
        {loginState.error && <p role="alert" className="error-text">{updateErrorMessage(loginState.error)}</p>}
      </>}
      {state.authenticated && <button disabled={busy || signingIn} onClick={() => { void androidUpdater.check(); }}>{state.phase === "checking" ? t("检查中…") : t("检查更新")}</button>}
      {state.phase === "current" && <p>{t("已是最新版本")}</p>}
      {state.nextVersion && <p>{t("新版本 {0}", state.nextVersion)}</p>}
      {state.notes && <details><summary>{t("更新说明")}</summary><pre className="update-notes">{state.notes}</pre></details>}
      {installable && <button className="primary" onClick={() => setConfirm(true)}>{state.downloaded ? t("继续安装") : t("下载并安装")}</button>}
      {confirm && installable && <CreationDialog title={t("安装 TaroBird {0}", state.nextVersion ?? "")} close={() => setConfirm(false)} closeLabel={t("取消")} showHost={false} className="confirmation-dialog"><p>{t("下载并校验后，由 Android 确认安装。聊天记录和配对会保留；首次可能需要允许 TaroBird 安装应用。")}</p><footer><button onClick={() => setConfirm(false)}>{t("稍后再说")}</button><button className="primary" onClick={() => { setConfirm(false); void androidUpdater.install(); }}>{t("开始更新")}</button></footer></CreationDialog>}
      {state.phase === "downloading" && <><p role="status">{t("正在下载更新…")}{state.total ? " " + Math.min(100, Math.round((state.bytes ?? 0) / state.total * 100)) + "%" : ""}</p><button onClick={() => { void androidUpdater.cancel(); }}>{t("取消下载")}</button></>}
      {state.phase === "verifying" && <p role="status">{t("正在校验安装包、签名和版本…")}</p>}
      {state.phase === "install-pending" && <p role="status">{t("请在系统页面确认安装。打开安装页面不代表更新已完成。")}</p>}
      {state.phase === "ready" && <p className="muted">{t("安装包已校验并保存在此设备，可继续安装，无需重新下载。")}</p>}
      {state.error && <p role="alert" className="error-text">{state.error === "github_update_permissions" ? t("尚未允许安装应用。点击“继续安装”后，在系统设置中允许 TaroBird 安装应用。") : updateErrorMessage(state.error)}</p>}
    </>}
  </section>;
}

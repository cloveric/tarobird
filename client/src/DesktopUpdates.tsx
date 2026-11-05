import { useEffect, useState, useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { t, useLocale } from "./i18n.js";
import { githubUpdateError, UpdateController, type UpdateEvent } from "./update-controller.js";
import { createDesktopUpdateBackend, GitHubUpdateLoginController } from "./github-update-backend.js";
import { createElectronUpdateBackend } from "./electron-update-backend.js";
import { invoke, isDesktop, isElectron, openDesktopUrl } from "./desktop-bridge.js";
import { CreationDialog } from "./CreationDialog.js";
import { isAndroidUpdater, startAndroidUpdateChecks } from "./android-updates.js";

const updater = new UpdateController(isElectron() ? createElectronUpdateBackend()
  : createDesktopUpdateBackend({ invoke, channel: () => new Channel<UpdateEvent>(), publicCheck: async () => (await import("@tauri-apps/plugin-updater")).check({ timeout: 15_000 }) }));
export function updateErrorMessage(error: string) {
  switch (error) {
    case "design_not_saved": return t("设计尚未保存，更新尚未开始。请保留设计页面并重试保存。");
    case "github_update_login_required": return t("GitHub 登录已失效，请重新登录后检查更新。");
    case "github_update_denied": return t("已拒绝 GitHub 登录，可重新尝试。");
    case "github_update_expired": return t("GitHub 验证码已过期，请重新登录。");
    case "github_update_network": return t("无法连接 GitHub，请检查网络后重试。");
    case "github_update_configuration": return t("此版本的 GitHub 更新配置不完整，请联系发布者。");
    case "github_update_repo_unavailable": return t("当前 GitHub 账号无法读取更新仓库，请确认账号有访问权限。");
    case "github_update_signature": return t("更新签名验证失败，未安装更新。请重试或联系发布者。");
    case "github_update_invalid_offer": return t("此更新已失效，请重新检查更新。");
    case "github_update_cancelled": return t("GitHub 更新操作已取消，请重试。");
    case "github_update_browser": return t("未能打开浏览器，请点击“打开 GitHub 验证页面”重试。");
    case "github_update_response": case "github_update_manifest": case "github_update_bounds": return t("GitHub 更新信息无效，请稍后重试或联系发布者。");
    case "github_update_keychain": return t("无法访问系统安全凭据存储，请检查系统权限后重试。");
    case "github_update_installed_host_failed": return t("应用文件已更新，但本机主机恢复尚未确认。请重新启动 TaroBird，原有数据和恢复备份已保留。");
    case "github_update_host": return t("本机任务尚未完成或主机恢复未确认，请检查任务状态后重试。原有数据已保留。");
    case "github_update_permissions": return t("无法写入应用所在目录，请将 TaroBird 安装到你有写入权限的位置后重试。");
    case "github_update_recovery": return t("更新恢复未完成，旧版应用备份已保留。请联系支持，不要清理应用数据。");
    case "github_update_install": return t("未能完成更新安装，请重试。");
    case "github_update_busy": return t("另一个 GitHub 更新操作正在进行，请稍后重试。");
    case "github_update_failed": return t("GitHub 更新操作失败，请重试。");
    default: return error;
  }
}
export function startDesktopUpdateChecks(): () => void {
  if (isAndroidUpdater()) return startAndroidUpdateChecks();
  if (!isDesktop()) return () => undefined;
  void updater.check(); const timer = setInterval(() => { void updater.check(); }, 86_400_000);
  return () => clearInterval(timer);
}
export function DesktopUpdates() {
  useLocale(); const state = useSyncExternalStore(updater.subscribe, updater.snapshot);
  const [login] = useState(() => new GitHubUpdateLoginController({ invoke, open: openDesktopUrl, authorized: () => updater.check() }));
  const loginState = useSyncExternalStore(login.subscribe, login.snapshot);
  const [accountBusy, setAccountBusy] = useState(false), [accountError, setAccountError] = useState<string>();
  const [confirmInstall, setConfirmInstall] = useState(false);
  useEffect(() => () => { void login.cancel(); }, [login]);
  if (!isDesktop()) return null;
  const busy = state.phase === "checking" || state.phase === "installing" || accountBusy;
  const restartRequired = state.phase === "installed" || state.phase === "restart-required";
  const updateBlocked = restartRequired || state.phase === "recovery-required";
  const signingIn = loginState.phase === "starting" || loginState.phase === "waiting";
  const logout = async () => {
    setAccountBusy(true); setAccountError(undefined);
    try { await login.cancel(); await invoke("github_update_logout"); await updater.check(); }
    catch (error) { setAccountError(githubUpdateError(error)); }
    finally { setAccountBusy(false); }
  };
  return <section className="desktop-updates"><h3>{t("应用更新")}</h3><p>TaroBird {state.version ?? ""}</p>
    {state.phase === "disabled" ? <p className="muted">{t("此开发版本尚未配置签名更新源。")}</p> : <>
      {state.provider === "github" && <>
        {state.authenticated ? <><p>{t("已登录 GitHub：{0}", state.login ?? "GitHub")}</p><button disabled={busy || updateBlocked} onClick={() => { void logout(); }}>{t("退出 GitHub 登录")}</button></> : <>
          <p className="muted">{t("登录 GitHub 后可检查和安装私有更新。")}</p>
          {!signingIn && <button disabled={busy || updateBlocked} onClick={() => { setAccountError(undefined); void login.start(); }}>{t("登录 GitHub")}</button>}
          {loginState.phase === "starting" && <p role="status">{t("正在准备 GitHub 登录…")}</p>}
          {loginState.phase === "waiting" && <div className="github-update-login">
            <p>{t("在 GitHub 验证页面输入以下验证码，然后在浏览器中批准登录。")}</p>
            <p><code aria-label={t("GitHub 验证码")}>{loginState.userCode}</code></p>
            <button onClick={() => { void login.openAuthorization(); }}>{t("打开 GitHub 验证页面")}</button>
            <p role="status">{t("等待 GitHub 授权…")}</p>
          </div>}
          {signingIn && <button onClick={() => { void login.cancel(); }}>{t("取消 GitHub 登录")}</button>}
          {loginState.error && <p className="error-text" role="alert">{updateErrorMessage(loginState.error)}</p>}
        </>}
      </>}
      {!(state.provider === "github" && !state.authenticated) && <button disabled={busy || updateBlocked} onClick={() => { void updater.check(); }}>{state.phase === "checking" ? t("检查中…") : t("检查更新")}</button>}
      {state.phase === "current" && <p>{t("已是最新版本")}</p>}
      {state.nextVersion && <p>{t("新版本 {0}", state.nextVersion)}</p>}
      {state.notes && <pre className="update-notes">{state.notes}</pre>}
      {state.phase === "available" && <button className="primary" onClick={() => setConfirmInstall(true)}>{t("下载并安装")}</button>}
      {confirmInstall && state.phase === "available" && <CreationDialog title={t("安装 TaroBird {0}", state.nextVersion ?? "")} close={() => setConfirmInstall(false)} closeLabel={t("取消")} showHost={false} className="confirmation-dialog">
        <p>{t("更新会替换应用，保留聊天记录、Bot 和配对。请先保存当前操作，安装后重新启动应用。")}</p>
        <footer><button onClick={() => setConfirmInstall(false)}>{t("稍后再说")}</button><button className="primary" onClick={() => { setConfirmInstall(false); void updater.install(); }}>{t("开始更新")}</button></footer>
      </CreationDialog>}
      {state.phase === "installing" && <p role="status">{state.installStage === "waiting" ? t("正在等待 Bot 任务结束，未开始的消息会保留…") : state.installStage === "replacing" ? t("正在安装更新，聊天记录和配对会保留…") : state.installStage === "restarting" ? t("正在恢复本机主机并核对数据…") : t("正在下载并验证签名…")}{state.installStage === "downloading" && state.total ? ` ${Math.min(100, Math.round((state.bytes ?? 0) / state.total * 100))}%` : ""}</p>}
      {state.phase === "installing" && state.installStage === "waiting" && <button onClick={() => { void updater.cancelInstall(); }}>{t("取消更新，继续任务")}</button>}
      {state.phase === "installing" && state.provider === "github" && state.installStage === "downloading" && <button onClick={() => { void updater.cancelInstall(); }}>{t("取消下载")}</button>}
      {state.phase === "installed" && <p>{t("更新已安装，重新启动后生效。")}</p>}
      {restartRequired && <button className="primary" onClick={() => { void updater.restart(); }}>{t("重新启动 TaroBird")}</button>}
      {state.error && <p className="error-text" role="alert">{updateErrorMessage(state.error)}</p>}
      {accountError && <p className="error-text" role="alert">{updateErrorMessage(accountError)}</p>}
    </>}</section>;
}

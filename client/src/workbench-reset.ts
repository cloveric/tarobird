import { invoke, isElectron } from "./desktop-bridge.js";
import { t } from "./i18n.js";
import { PERSONAL_BROWSER_SCOPE } from "../shared/personal-browser.mjs";
import type { BrowserScope } from "./workbench-browser.js";

/** Only an explicit local host-removal/reset calls this App-only IPC. Never
 * expose it through Bot browser actions or infer a global reset from no host. */
export async function clearWorkbenchBrowserData(host: string, scopes: BrowserScope[]): Promise<void> {
  if (!isElectron()) return;
  try {
    const result = await invoke<{ cleared: number; failed: string[] }>("workbench_browser_reset", { host, scopes });
    if (!result || !Number.isInteger(result.cleared) || result.cleared < 0 || !Array.isArray(result.failed) || result.failed.length) throw new Error("browser_reset_incomplete");
  } catch {
    throw new Error(t("网页登录数据未能完全清除。旧连接已停止，请重试清理。"));
  }
}

/** A complete device disconnect includes the independent personal profile, even
 * when no Host identity remains. Removing one Host uses the scoped helper above. */
export async function clearLocalBrowserData(host?: string, scopes: BrowserScope[] = []): Promise<void> {
  await clearWorkbenchBrowserData(PERSONAL_BROWSER_SCOPE.host, [PERSONAL_BROWSER_SCOPE]);
  if (host) await clearWorkbenchBrowserData(host, scopes);
  try { sessionStorage.removeItem("tarobot.personal-browser.active"); } catch { /* optional preference */ }
}

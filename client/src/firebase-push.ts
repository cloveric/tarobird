import { UnifiedPush } from "./unifiedpush.js";
import { t } from "./i18n.js";

/** Android's generic registration events are retained broadcasts with no request
 * identity. The native method returns only this Firebase Task's receipt. */
export async function registerFirebasePush(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      UnifiedPush.registerFirebase(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("firebase_registration_timeout")), 25_000); }),
    ]);
    if (typeof result?.token !== "string" || !result.token || result.token.length > 4096) throw new Error("firebase_registration_failed");
    return result.token;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "";
    if (code === "UNIMPLEMENTED" || code === "UNAVAILABLE" || error instanceof TypeError) throw new Error(t("请更新 Android 客户端后重试系统推送注册。"));
    if (code === "firebase_not_configured") throw new Error(t("此安装包未配置 Google 推送服务，请使用已配置的安装包，或在下方连接 UnifiedPush 分发器。"));
    if (code === "firebase_registration_timeout") throw new Error(t("推送注册超时，请检查网络和手机推送服务配置。"));
    if (code === "firebase_cleanup_pending") throw new Error(t("设备推送清理尚未完成，请完成清理后重试。"));
    if (code === "firebase_busy") throw new Error(t("推送服务正忙，请稍后重试。"));
    throw new Error(t("无法连接 Google 推送服务，请检查网络和 Google 服务；也可以使用下方 UnifiedPush 配置。"));
  } finally { clearTimeout(timer); }
}

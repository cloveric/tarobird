import { Capacitor } from "@capacitor/core";
import { ListenerScope, removeListenerSafely } from "./listener-scope.js";
import { registerFirebasePush } from "./firebase-push.js";
import { t } from "./i18n.js";

// This read-only snapshot is written by AppDelegate before it posts Capacitor's
// APNs broadcasts. Retained JS events are hints, never token receipts.
import { shareInbox as apns } from "./share-inbox-bridge.js";
let pending: Promise<string> | undefined;
let pendingController: AbortController | undefined;
let resetRevision = 0;
export function systemPushResetRevision(): number { return resetRevision; }
export function cancelSystemPushTokenRead(): void { ++resetRevision; pendingController?.abort(); }
async function readApns(refresh: boolean, signal: AbortSignal): Promise<string> {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  signal.throwIfAborted();
  const baseline = await apns.pushTokenSnapshot().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "UNIMPLEMENTED" || code === "UNAVAILABLE" || error instanceof TypeError) throw new Error(t("请更新 iOS 客户端后重试系统推送注册。"));
    throw new Error(t("无法注册推送服务。"));
  });
  signal.throwIfAborted();
  if (!refresh) {
    if (!baseline.token || baseline.failed) throw new Error(t("无法注册推送服务。"));
    return baseline.token;
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false, requested = false;
    const cleanups: (() => Promise<void>)[] = [];
    const finish = (token?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", aborted); cleanups.forEach(removeListenerSafely);
      token ? resolve(token) : reject(new Error(t("无法注册推送服务。")));
    };
    const aborted = () => finish();
    const timer = setTimeout(() => finish(), 20_000);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { finish(); return; }
    const changed = () => {
      if (!requested || settled) return;
      void apns.pushTokenSnapshot().then((snapshot) => {
        if (!settled && snapshot.revision > baseline.revision) finish(snapshot.failed ? undefined : snapshot.token);
      }, () => finish());
    };
    void (async () => {
      for (const event of ["registration", "registrationError"] as const) {
        const listener = await (event === "registration" ? PushNotifications.addListener("registration", changed) : PushNotifications.addListener("registrationError", changed));
        if (settled) { removeListenerSafely(() => listener.remove()); return; }
        cleanups.push(() => listener.remove());
      }
      requested = true; await PushNotifications.register(); changed();
    })().catch(() => finish());
  });
}
/** Share an in-flight device read, never permanently cache an OS token. A hint
 * reads the APNs snapshot without re-registering (which would emit a new hint). */
export function currentSystemPushToken(refresh = true): Promise<string> {
  if (pending) return pending;
  const controller = new AbortController(); pendingController = controller;
  const job = (async () => {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    controller.signal.throwIfAborted();
    if ((await PushNotifications.checkPermissions()).receive !== "granted") throw new Error(t("通知权限未开启。"));
    controller.signal.throwIfAborted();
    return Capacitor.getPlatform() === "ios" ? readApns(refresh, controller.signal) : registerFirebasePush();
  })();
  let timer: ReturnType<typeof setTimeout>;
  pending = Promise.race([job, new Promise<never>((_resolve, reject) => {
    const aborted = () => reject(new Error(t("推送注册超时，请检查网络和手机推送服务配置。")));
    controller.signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => controller.abort(), 25_000);
  })]).finally(() => { clearTimeout(timer); controller.abort(); pending = undefined; pendingController = undefined; });
  return pending;
}
const observers = new Set<() => void>();
let scope: ListenerScope | undefined;
export function observeSystemPushToken(changed: () => void): () => void {
  observers.add(changed);
  if (!scope) {
    scope = new ListenerScope();
    // Error broadcasts must not start another failing registration loop.
    scope.listen(async (emit, active) => {
      const { PushNotifications } = await import("@capacitor/push-notifications"); if (!active()) return;
      const listener = await PushNotifications.addListener("registration", () => emit(undefined));
      return () => listener.remove();
    }, () => { for (const observer of observers) observer(); });
  }
  return () => { observers.delete(changed); if (!observers.size) { scope?.close(); scope = undefined; } };
}

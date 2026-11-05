import type { ConnectionVerificationFailure } from "../../src/client-protocol/routes.js";
import { t } from "./i18n.js";

/** Identity/storage failures must never suggest clearing a valid pairing. */
export function deviceStorageErrorMessage(error: unknown): string | undefined {
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (["device_storage_unavailable", "device_storage_failed"].includes(code)) return t("无法访问设备安全存储，请解锁设备后重试；仍失败时请检查系统存储权限。请勿清除应用数据。");
  if (["device_key_write_failed", "device_key_delete_failed"].includes(code)) return t("设备身份存储操作未完成，请检查系统安全存储和可用空间后重试。请勿清除应用数据。");
  if (["device_storage_invalid", "device_key_migration_conflict"].includes(code)) return t("设备身份数据校验未通过，已暂停身份操作。请保留应用数据并联系支持，不要删除或重新配对。");
  return undefined;
}

/** Native IPC rejects with strings as well as Errors. Never expose a raw
 * implementation code (or validation dump) as the user's recovery guidance. */
export function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "QuotaExceededError") return t("本机存储空间不足，已暂停同步。请释放空间后重新打开 TaroBird，配对和草稿仍保留。");
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (code === "device_pairing_required") return t("此安装不能使用旧的设备授权。请在「设备与网络」中移除此主机连接，再扫描主机上的二维码重新绑定。主机上的聊天记录不会删除。");
  const storage = deviceStorageErrorMessage(error); if (storage) return storage;
  const verified = connectionVerificationMessage(connectionVerificationFailure(error), "paired");
  if (verified) return verified;
  if (code === "system_keychain_busy") return t("设备安全存储正忙，正在自动重试。配对和草稿仍保留。");
  if (code === "device_signature_pending") return t("正在等待系统确认设备身份。请查看钥匙串授权提示；完成后会自动连接，配对和草稿仍保留。");
  if (["sync_lineage_mismatch", "snapshot_lineage_mismatch"].includes(code)) return t("聊天记录已恢复，正在重新同步。");
  if (code === "local_cache_preparation_timeout") return t("本地消息缓存准备超时，请退出并重新打开 TaroBird。历史消息和草稿仍保留。");
  if (["local_cache_unavailable", "local_cache_closed"].includes(code)) return t("本地消息缓存已关闭，自动重连已停止。请关闭其他 TaroBird 窗口后重新打开应用；不要清除应用数据。");
  if (["device_key_unavailable", "device_key_invalid", "system_keychain_unavailable"].includes(code)) return t("无法读取此设备的配对密钥，请解锁系统钥匙串后重试；仍无法连接时，请重新配对。");
  if (["native_document_retired", "native_document_unavailable", "native_view_unavailable"].includes(code)) return t("连接组件已失效，请重新打开 TaroBird。配对信息和草稿仍保留。");
  if (["native_socket_timeout", "native_request_timeout", "connection_handshake_timeout"].includes(code)) return t("主机响应超时，正在自动重试。请确认主机仍在运行。");
  if (code && code.length < 240 && !/^[a-z_]+$/.test(code) && !code.startsWith("[")) return code;
  return t("连接中断，正在自动重试。请检查主机和网络状态。");
}

/** Keep native diagnostics machine-readable; translate only at the UI boundary. */
export function connectionVerificationFailure(error: unknown): ConnectionVerificationFailure | undefined {
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (code === "tls_identity_mismatch") return "identity-mismatch";
  if (code === "hub_tls_identity_required") return "verification-unavailable";
  if (code === "invalid_hub_key" || code === "trusted_hub_key_required") return "invalid-key";
  return undefined;
}
export function connectionVerificationMessage(failure: ConnectionVerificationFailure | undefined, context: "pairing" | "paired" = "pairing"): string | undefined {
  if (context === "paired" && failure === "identity-mismatch") return t("主机身份校验未通过，请先核对连接地址。若确认主机已重装或更换身份，请重新配对。");
  if (context === "paired" && failure === "invalid-key") return t("已保存的主机身份公钥缺失或无效，请重新配对此设备。");
  if (failure === "identity-mismatch") return t("主机身份校验未通过，请核对连接地址和主机身份公钥。");
  if (failure === "verification-unavailable") return t("暂时无法完成主机安全验证，请检查主机是否运行、版本是否支持，并核对连接地址。");
  if (failure === "invalid-key") return t("主机身份公钥格式不正确，请重新从主机或已信任设备复制。");
  return undefined;
}
export function preferredVerificationFailure(failures: (ConnectionVerificationFailure | undefined)[]): ConnectionVerificationFailure | undefined {
  return failures.find((value) => value === "invalid-key") ?? failures.find((value) => value === "identity-mismatch") ?? failures.find((value) => value === "verification-unavailable");
}
export function connectionVerificationLabel(failure: ConnectionVerificationFailure | undefined): string | undefined {
  if (failure === "identity-mismatch") return t("主机身份不匹配");
  if (failure === "verification-unavailable") return t("主机安全验证不可用");
  if (failure === "invalid-key") return t("请检查主机公钥");
  return undefined;
}

/** UI format check only; trust and signature verification stay in native transport. */
export function validHubPublicKey(value: string): boolean {
  try { return value.length === 60 && value.startsWith("MCowBQYDK2VwAyEA") && atob(value).length === 44 && btoa(atob(value)) === value; }
  catch { return false; }
}

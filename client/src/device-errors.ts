import { HubHttpError } from "./http-error.js";
import { t } from "./i18n.js";

/** Resolve at render time, so switching language also updates an existing error. */
export function deviceOperationError(error: unknown): string {
  if (!(error instanceof HubHttpError) || error.status < 400 || error.status >= 500 || error.status === 408) return t("未能确认操作结果。请核对更新后的设备列表，再决定是否重试。");
  if (["device_action_proof_required", "device_action_unavailable"].includes(error.code)) return t("请更新主机和 App 后再管理设备；当前版本无法完成安全确认。");
  if (error.code === "device_action_expired") return t("本次安全确认已过期，请重新确认操作。");
  if (error.code === "device_action_target_changed") return t("目标设备的信息已变化，请刷新列表后重新确认。");
  if (error.code === "device_action_cancelled") return t("连接或登录状态已变化，本次操作未发送。请重新确认。");
  if (["device_action_invalid", "device_action_signing_failed"].includes(error.code)) return t("设备签名未通过校验，操作已拒绝。请检查 App 的设备密钥后重试。");
  if (error.code === "pairing_expired_or_invalid") return t("请先核对两边的主机身份尾号和 8 位配对码；若都一致但已过期，请在新设备重新获取。");
  if (error.code === "device_not_found") return t("设备已不存在，请刷新设备列表。");
  if (error.code === "host_device_name_managed") return t("这台电脑使用主机名称，请到「设备与网络」中修改主机名称。");
  if (error.status === 401) return t("设备授权或登录状态已失效，请重新连接主机。");
  if (error.status === 403) return t("当前设备没有执行此操作的权限。");
  if (error.status === 429) return t("操作过于频繁，请稍后重试。");
  return t("操作未完成，请检查输入内容后重试。");
}

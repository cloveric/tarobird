import { t } from "./i18n.js";

export function pairingInviteError(code?: string): string | undefined {
  switch (code?.replace(/^pairing_/, "")) {
    case "invite_required": return t("首次配对需要有效的限时连接码。请在已配对设备上重新生成，再扫描或粘贴完整连接信息。");
    case "invite_expired":
    case "invite_invalid":
    case "invite_closed":
    case "invite_revoked": return t("此连接码已过期或失效。请在已配对设备上重新生成连接码。");
    case "invite_used":
    case "invite_bound": return t("此连接码已用于另一份设备申请。请重新生成连接码；已配对设备不受影响。");
    case "invite_limit":
    case "invites_full":
    case "invite_capacity": return t("有效连接码数量已达上限，请关闭不用的连接码或稍后重试。");
  }
  return undefined;
}

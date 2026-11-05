import { t } from "./i18n.js";

export function googleDocsErrorText(code: string, purpose: "export" | "status" = "export"): string {
  switch (code) {
    case "google_docs_not_configured": return t("尚未配置 Google 文档。请到「设置 → 通用 → Google 文档」查看配置步骤。");
    case "google_docs_config_invalid": return t("Google OAuth 配置无效，请导入「桌面应用」类型的 JSON 文件。");
    case "google_docs_config_unreadable": return t("主机无法读取 Google OAuth 配置，请检查文件权限。");
    case "google_docs_authorization_required": return t("Google 文档尚未授权，请在主机上运行 tarobot gdocs auth。");
    case "google_docs_authorization_invalid": case "google_docs_authorization_failed": return t("Google 授权不可用，请在主机上重新运行 tarobot gdocs auth。");
    case "google_docs_keychain_unavailable": return t("无法访问主机的系统钥匙串，请在主机上检查访问权限。");
    case "google_docs_platform_unsupported": return t("当前 Google 文档授权仅支持 Mac 或配有 Secret Service 的 Linux 主机。");
    case "google_docs_service_failed": return t("Google 文档服务暂时拒绝了请求，请检查 Docs API、授权和网络。");
    case "google_docs_partial_write": return t("Google 文档已创建，但内容尚未验证。请先在 Google 文档中核对，避免重复创建。");
    case "google_export_outcome_unknown_check_google_docs": return t("上次创建结果尚未确认，请先检查 Google 文档，避免重复创建。");
    case "invalid_document_url": return t("文档链接无效");
    case "owner_required": return t("此操作仅主机所有者可执行。");
    default:
      if (purpose === "status") return code === "not_found" ? t("请更新主机以查看 Google 文档配置状态。") : t("无法检查 Google 文档配置，请确认主机在线后重试。");
      return t("Google 文档导出未完成，请检查主机端配置、授权和连接后重试。");
  }
}

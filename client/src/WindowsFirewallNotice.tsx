import { useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";
import type { WindowsFirewallStatus } from "../../src/client-protocol/network-candidates.js";
import { writeClipboardText } from "./clipboard-write.js";
import { isDesktop, openWindowsNetworkSettings } from "./desktop-bridge.js";
import { t, useLocale } from "./i18n.js";

export function WindowsFirewallNotice({
  status,
  hasFallback = false,
}: {
  status?: WindowsFirewallStatus;
  hasFallback?: boolean;
}) {
  useLocale();
  const [copied, setCopied] = useState(false);
  const [openingSettings, setOpeningSettings] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  if (!status?.supported) return null;
  if (status.networkCategory === "domain") return null;

  const isPublic = status.networkCategory === "public";
  const blocked = status.blockingRuleDetected;
  const needsRule = !isPublic && status.privateFirewallEnabled && (!status.ruleAllowed || blocked);
  if (!isPublic && !needsRule) return null;

  const command = status.recommendedCommand
    ?? `New-NetFirewallRule -DisplayName "TaroBird Hub" -Direction Inbound -Protocol TCP -LocalPort ${status.port} -Profile Private -Action Allow`;

  const copyCommand = async () => {
    try {
      await writeClipboardText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const openNetworkSettings = async () => {
    if (openingSettings) return;
    setOpeningSettings(true);
    setOpenFailed(false);
    try {
      await openWindowsNetworkSettings();
    } catch {
      setOpenFailed(true);
    } finally {
      setOpeningSettings(false);
    }
  };

  return (
    <div className="windows-firewall-notice" role="status">
      <div className="windows-firewall-notice-head">
        <AlertTriangle size={16} aria-hidden="true" />
        <strong>
          {isPublic
            ? t("Windows 当前将此网络标记为「公用网络」")
            : blocked
              ? t("Windows 防火墙规则可能正在拦截手机连接")
              : t("允许手机通过 Windows 防火墙连接")}
        </strong>
      </div>
      <p>
        {isPublic
          ? t("公用网络通常会拦截局域网内的手机访问。请先在 Windows「设置 → 网络和 Internet」中将当前 Wi-Fi 或以太网改为「专用网络」。")
          : blocked
            ? t("检测到阻止入站连接的防火墙规则（TCP 端口 {0}）。请移除冲突的阻止规则，或以管理员身份运行下方 PowerShell 命令放行专用网络入站。", status.port)
            : t("如果手机扫码后无法连上这台电脑，Windows 防火墙可能拦截了 TCP 端口 {0}。请以管理员身份运行下方 PowerShell 命令放行专用网络入站。", status.port)}
      </p>
      {hasFallback && (
        <p className="muted">
          {t("已配置 Tailscale 或 VPS 中转时仍可继续配对；放行防火墙后可优先走更快的局域网直连。")}
        </p>
      )}
      {isPublic ? (
        isDesktop() && (
          <>
            <button
              type="button"
              className="secondary"
              disabled={openingSettings}
              onClick={() => void openNetworkSettings()}
            >
              <ExternalLink size={14} aria-hidden="true" />
              {openingSettings ? t("正在打开…") : t("打开 Windows 网络设置")}
            </button>
            {openFailed && (
              <p className="muted" role="alert">
                {t("无法自动打开设置，请手动打开 Windows「设置 → 网络和 Internet」并将当前网络改为「专用网络」。")}
              </p>
            )}
          </>
        )
      ) : (
        <div className="windows-firewall-command">
          <code>{command}</code>
          <button type="button" className="secondary" onClick={() => void copyCommand()}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? t("已复制") : t("复制命令")}
          </button>
        </div>
      )}
    </div>
  );
}

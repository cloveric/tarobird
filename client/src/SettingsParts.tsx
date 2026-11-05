import { Globe, Monitor, MonitorSmartphone, RefreshCw, Server, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "./i18n.js";

/** Where a setting takes effect. Shown beside group headings so display choices
 * kept on this device are never mistaken for host-wide or synced settings. */
export type SettingsScopeKind = "device" | "synced" | "host";
export function SettingsScope({ kind, host }: { kind: SettingsScopeKind; host?: string }) {
  const Icon = kind === "device" ? MonitorSmartphone : kind === "synced" ? RefreshCw : Server;
  const label = kind === "device" ? t("仅此设备") : kind === "synced" ? t("同步到你的其他设备") : host ? t("主机「{0}」", host) : t("当前主机");
  return <span className="settings-scope" data-scope={kind}><Icon size={13} aria-hidden="true"/>{label}</span>;
}
export function SettingsGroupHeading({ children, scope, host }: { children: ReactNode; scope?: SettingsScopeKind; host?: string }) {
  return <div className="settings-group-heading"><h4>{children}</h4>{scope && <SettingsScope kind={scope} host={host}/>}</div>;
}

/** Pairing records store the protocol platform ID; people read product names. */
export function platformName(platform: string): string {
  switch (platform) {
    case "web": return t("浏览器或其他客户端");
    case "macos": return "Mac";
    case "windows": return "Windows";
    case "ios": return "iPhone / iPad";
    case "android": return "Android";
    default: return t("其他设备");
  }
}
export function PlatformIcon({ platform }: { platform: string }) {
  const Icon = platform === "ios" || platform === "android" ? Smartphone : platform === "web" ? Globe : Monitor;
  return <Icon size={18} aria-hidden="true"/>;
}

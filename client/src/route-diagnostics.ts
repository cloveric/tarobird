import type { ConnectionVerificationFailure, Route, RouteHealth, RouteTransportFailure } from "../../src/client-protocol/routes.js";
import { connectionVerificationFailure, connectionVerificationLabel, connectionVerificationMessage, preferredVerificationFailure } from "./connection-verification.js";
import { t } from "./i18n.js";

export type RouteKind = "loopback" | "tailscale" | "lan" | "vps" | "public";

export type RouteDiagnosisCode =
  | ConnectionVerificationFailure
  | "local-network-denied"
  | "client-offline"
  | "tailscale-unreachable"
  | "tailscale-refused"
  | "tailscale-dns-failed"
  | "lan-unreachable"
  | "lan-refused"
  | "lan-and-tailscale-unreachable"
  | "lan-and-vps-unreachable"
  | "vps-unreachable"
  | "vps-refused"
  | "loopback-unreachable"
  | "dns-failed"
  | "tls-untrusted"
  | "multi-route-unreachable";

export type RouteDiagnosisSnapshot = {
  context: "pairing" | "paired";
  hostName?: string;
  online: boolean;
  verificationFailure?: ConnectionVerificationFailure;
  attempts: ReadonlyArray<{ kind: RouteKind; reason: RouteTransportFailure }>;
  unprobedTailscale: boolean;
  unprobedVps: boolean;
};

export type RouteDiagnosis = {
  code: RouteDiagnosisCode;
  message: string;
  actionRequired: boolean;
  snapshot?: RouteDiagnosisSnapshot;
};

export type RouteFailureAttempt = {
  route: Pick<Route, "name" | "url">;
  error: unknown;
};

function ipv4Octets(host: string): number[] | undefined {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return undefined;
  const parts = host.split(".").map(Number);
  return parts.every((value) => value >= 0 && value <= 255) ? parts : undefined;
}

function parseHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isTailscaleIp(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ip = ipv4Octets(bare);
  if (ip) return ip[0] === 100 && ip[1]! >= 64 && ip[1]! <= 127;
  return bare.startsWith("fd7a:115c:a1e0:");
}

function isPrivateLanHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const ip = ipv4Octets(bare);
  if (ip) {
    return ip[0] === 10
      || (ip[0] === 192 && ip[1] === 168)
      || (ip[0] === 172 && ip[1]! >= 16 && ip[1]! <= 31)
      || (ip[0] === 169 && ip[1] === 254);
  }
  if (/^(?:fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(bare) && !bare.startsWith("fd7a:115c:a1e0:")) return true;
  return /\.(?:local|lan)$/i.test(bare);
}

/** Classify the network kind of a configured or manually entered route. */
export function classifyRouteKind(route: Pick<Route, "name" | "url">): RouteKind {
  const host = parseHostname(route.url);
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "localhost" || bare === "::1" || /^127\./.test(bare)) return "loopback";
  if (route.name === "Tailscale" || host.endsWith(".ts.net") || isTailscaleIp(host)) return "tailscale";
  if (isPrivateLanHost(host)) return "lan";
  if (route.name === "VPS") return "vps";
  return "public";
}

/** Classify a transport/network failure without assuming unchecked causes. */
export function classifyRouteTransportFailure(error: unknown, route?: Pick<Route, "name" | "url">): RouteTransportFailure {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = message.trim();

  if (
    code === "local_network_permission_denied"
    || /local network (?:prohibited|permission denied)|nslocalnetwork|kdnsserviceerr_policydenied|-65555/i.test(code)
  ) {
    return route && classifyRouteKind(route) !== "lan" ? "host-unreachable" : "local-network-denied";
  }
  if (
    code === "native_network_offline"
    || /not connected to the internet|internet ?disconnected|err_internet_disconnected|network is down|\benetdown\b/i.test(code)
  ) {
    return "client-offline";
  }
  if (
    code === "native_tls_untrusted"
    || code === "native_tls_challenge_rejected"
    || code === "tls_certificate_unavailable"
    || /sslhandshake|cert_authority_invalid|certificate.*untrusted|self[- ]signed certificate/i.test(code)
  ) {
    return "tls-untrusted";
  }
  if (
    code === "native_connection_refused"
    || /\beconnrefused\b|connection refused|err_connection_refused/i.test(code)
  ) {
    return "connection-refused";
  }
  if (
    code === "native_dns_failed"
    || /\b(?:enotfound|eai_again|eai_noname)\b|unable to resolve host|cannot find host|dns lookup failed|err_name_not_resolved/i.test(code)
  ) {
    return "dns-failed";
  }
  if (
    code === "native_host_unreachable"
    || /\b(?:ehostunreach|enetunreach|ehostdown)\b|no route to host|network is unreachable|host is unreachable|err_address_unreachable/i.test(code)
  ) {
    return "host-unreachable";
  }
  if (
    name === "TimeoutError"
    || name === "AbortError"
    || code === "native_request_timeout"
    || code === "native_socket_timeout"
    || code === "connection_handshake_timeout"
    || code === "native_response_idle_timeout"
    || /\betimedout\b|timed ?out|timeout/i.test(code)
  ) {
    return "timeout";
  }
  return "unreachable";
}

export function routeTransportFailureLabel(reason: RouteTransportFailure | undefined): string | undefined {
  switch (reason) {
    case "local-network-denied": return t("缺少本地网络权限");
    case "client-offline": return t("设备未联网");
    case "connection-refused": return t("主机未运行或端口未监听");
    case "timeout": return t("连接超时");
    case "dns-failed": return t("域名无法解析");
    case "tls-untrusted": return t("证书不受信任");
    case "host-unreachable": return t("网络不可达");
    default: return undefined;
  }
}

export function routeHealthStatusLabel(health: RouteHealth): { label: string; tone: "ok" | "bad" | "warn" } {
  const verificationLabel = connectionVerificationLabel(health.failure);
  if (verificationLabel) return { label: verificationLabel, tone: "bad" };
  if (health.status === "reachable") return { label: t("可达 · 待连接验证"), tone: "ok" };
  if (health.status === "wrong-hub") return { label: t("主机身份不匹配"), tone: "bad" };
  if (health.status === "cooldown") return { label: t("连接失败，稍后重试"), tone: "warn" };
  return { label: routeTransportFailureLabel(health.reason) ?? t("暂不可用"), tone: "bad" };
}

function refusedMessage(kind: RouteKind, context: "pairing" | "paired", hostName: string): { code: RouteDiagnosisCode; message: string } {
  if (kind === "tailscale") {
    return {
      code: "tailscale-refused",
      message: context === "pairing"
        ? t("已连通 Tailscale 地址，但主机拒绝了连接。请确认主机电脑上的 TaroBird 正在运行，且已开启 Tailscale 访问。")
        : t("已连通「{0}」的 Tailscale 地址，但主机拒绝了连接，正在自动重试。请确认电脑上的 TaroBird 正在运行，且已开启 Tailscale 访问。", hostName),
    };
  }
  if (kind === "lan") {
    return {
      code: "lan-refused",
      message: context === "pairing"
        ? t("已找到局域网设备，但主机拒绝了连接。请确认主机电脑上的 TaroBird 正在运行，且局域网地址与端口没有变化。")
        : t("已找到局域网中的「{0}」，但连接被拒绝，正在自动重试。请确认电脑上的 TaroBird 正在运行，且局域网地址没有变化。", hostName),
    };
  }
  if (kind === "loopback") {
    return {
      code: "loopback-unreachable",
      message: t("无法连接到本机 TaroBird 主机，请确认这台电脑上的 TaroBird 正在运行。"),
    };
  }
  return {
    code: "vps-refused",
    message: t("已找到中转或公网地址，但连接被拒绝。请确认主机或中转服务正在运行，且端口没有变化。"),
  };
}

function lanUnreachableMessage(
  context: "pairing" | "paired",
  hostName: string,
  unprobedTailscale: boolean,
  unprobedVps: boolean,
): string {
  if (unprobedTailscale && unprobedVps) {
    return context === "pairing"
      ? t("无法连接到该局域网地址。这台设备似乎不在同一 Wi-Fi / 局域网内，或者主机处于休眠、未运行 TaroBird。你也可以改用已配置的 Tailscale 或 VPS 中转线路。")
      : t("无法通过局域网连接「{0}」，正在自动重试。你似乎已离开该 Wi-Fi / 局域网，或主机处于休眠、未运行 TaroBird；也可以尝试已配置的 Tailscale 或 VPS 中转线路。", hostName);
  }
  if (unprobedTailscale) {
    return context === "pairing"
      ? t("无法连接到该局域网地址。这台设备似乎不在同一 Wi-Fi / 局域网内，或者主机处于休眠、未运行 TaroBird。你也可以改用已配置的 Tailscale 线路。")
      : t("无法通过局域网连接「{0}」，正在自动重试。你似乎已离开该 Wi-Fi / 局域网，或主机处于休眠、未运行 TaroBird；也可以切换到已配置的 Tailscale 线路。", hostName);
  }
  if (unprobedVps) {
    return context === "pairing"
      ? t("无法连接到该局域网地址。这台设备似乎不在同一 Wi-Fi / 局域网内，或者主机处于休眠、未运行 TaroBird。你也可以改用已配置的 VPS 中转线路。")
      : t("无法通过局域网连接「{0}」，正在自动重试。你似乎已离开该 Wi-Fi / 局域网，或主机处于休眠、未运行 TaroBird；也可以切换到已配置的 VPS 中转线路。", hostName);
  }
  return context === "pairing"
    ? t("无法连接到该局域网地址。这台设备似乎不在同一 Wi-Fi / 局域网内（例如正在使用手机流量或连接了其他网络），或者主机处于休眠、未运行 TaroBird。如果在外面使用，请在主机改用「Tailscale 异地连接」生成连接码，或添加 VPS 中转。")
    : t("无法通过局域网连接「{0}」，正在自动重试。你似乎已离开该 Wi-Fi / 局域网，或主机处于休眠、未运行 TaroBird。外出使用可在主机开启 Tailscale 后扫码添加，或在「编辑线路」中配置 VPS 中转。", hostName);
}

function resolveRouteDiagnosis(
  snapshot: RouteDiagnosisSnapshot,
  hostNameOverride?: string,
): { code: RouteDiagnosisCode; message: string; actionRequired: boolean } {
  const hostName = hostNameOverride?.trim() || snapshot.hostName?.trim() || t("此主机");
  const context = snapshot.context;
  const parsed = snapshot.attempts;

  if (snapshot.verificationFailure) {
    return {
      code: snapshot.verificationFailure,
      message: connectionVerificationMessage(snapshot.verificationFailure, context)!,
      actionRequired: true,
    };
  }

  if (parsed.some((entry) => entry.reason === "local-network-denied" && entry.kind === "lan")) {
    const hasNonLan = parsed.some((entry) => entry.kind !== "lan" && entry.kind !== "loopback");
    return {
      code: "local-network-denied",
      message: hasNonLan
        ? t("TaroBird 没有获得“本地网络”权限，无法访问局域网主机，且其他已尝试线路也未连接成功。请在设备的「设置 → 隐私与安全性 → 本地网络」中允许 TaroBird，或检查远程线路与主机状态。")
        : t("TaroBird 没有获得“本地网络”权限，无法访问局域网主机。请在设备的「设置 → 隐私与安全性 → 本地网络」中允许 TaroBird，然后重试。"),
      actionRequired: true,
    };
  }

  if (parsed.length > 0 && parsed.every((entry) => entry.reason === "tls-untrusted")) {
    return {
      code: "tls-untrusted",
      message: t("主机证书不受信任，无法建立安全连接。请重新扫描主机上的二维码，或核对连接地址与证书设置。"),
      actionRequired: true,
    };
  }

  const refused = parsed.find((entry) => entry.reason === "connection-refused");
  if (refused) {
    const result = refusedMessage(refused.kind, context, hostName);
    return { ...result, actionRequired: false };
  }

  const allLoopback = parsed.length > 0 && parsed.every((entry) => entry.kind === "loopback");
  const hasPeerEvidence = parsed.some((entry) => entry.reason === "tls-untrusted" || entry.reason === "connection-refused");
  if (!allLoopback && !hasPeerEvidence && (!snapshot.online || (parsed.length > 0 && parsed.every((entry) => entry.reason === "client-offline")))) {
    return {
      code: "client-offline",
      message: context === "pairing"
        ? t("当前设备未连接到网络（Wi-Fi 或蜂窝网络未开启）。请先联网后再试。")
        : t("当前设备未连接到网络，暂时无法连接「{0}」。请检查 Wi-Fi 或蜂窝网络后重试。", hostName),
      actionRequired: false,
    };
  }

  if (parsed.length > 0 && parsed.every((entry) => entry.reason === "dns-failed")) {
    if (parsed.some((entry) => entry.kind === "tailscale")) {
      return {
        code: "tailscale-dns-failed",
        message: t("无法解析主机的 Tailscale 域名。请确认这台设备与主机都已开启 Tailscale 并登录同一网络，或改用 Tailscale IP 地址重试。"),
        actionRequired: false,
      };
    }
    return {
      code: "dns-failed",
      message: t("无法解析主机或中转地址的域名，请检查地址拼写与网络 DNS 设置。"),
      actionRequired: false,
    };
  }

  if (allLoopback) {
    return {
      code: "loopback-unreachable",
      message: t("无法连接到本机 TaroBird 主机，请确认这台电脑上的 TaroBird 正在运行。"),
      actionRequired: false,
    };
  }

  const kinds = new Set(parsed.map((entry) => entry.kind));
  const hasTailscale = kinds.has("tailscale");
  const hasLan = kinds.has("lan");
  const hasRemote = kinds.has("vps") || kinds.has("public");

  if (hasTailscale && !hasLan && !hasRemote) {
    return {
      code: "tailscale-unreachable",
      message: context === "pairing"
        ? t("无法通过 Tailscale 连接到主机。这台设备当前访问不到目标 Tailscale 地址：请确认两端都已开启 Tailscale、登录同一个 Tailscale 网络且访问规则允许连接，并确认主机电脑未休眠、TaroBird 正在运行。")
        : t("无法通过 Tailscale 连接「{0}」，正在自动重试。请确认本机和主机都已开启 Tailscale 并登录同一个 Tailscale 网络，且主机未休眠、TaroBird 正在运行。", hostName),
      actionRequired: false,
    };
  }

  if (hasLan && !hasTailscale && !hasRemote) {
    return {
      code: "lan-unreachable",
      message: lanUnreachableMessage(
        context,
        hostName,
        snapshot.unprobedTailscale,
        snapshot.unprobedVps,
      ),
      actionRequired: false,
    };
  }

  if (hasLan && hasTailscale && !hasRemote) {
    return {
      code: "lan-and-tailscale-unreachable",
      message: context === "pairing"
        ? t("局域网和 Tailscale 线路均无法连接主机。请确认主机电脑未休眠且 TaroBird 正在运行；如果不在同一 Wi-Fi 下，请确认两端都已开启 Tailscale 并登录同一个 Tailscale 网络。")
        : t("局域网和 Tailscale 线路均无法连接「{0}」，正在自动重试。请确认主机未休眠且 TaroBird 正在运行；如果不在同一 Wi-Fi 下，请检查两端 Tailscale 是否已连接同一网络。", hostName),
      actionRequired: false,
    };
  }

  if (hasLan && !hasTailscale && hasRemote) {
    return {
      code: "lan-and-vps-unreachable",
      message: context === "pairing"
        ? t("局域网和备用中转均无法连接主机。请确认主机电脑未休眠、TaroBird 正在运行，并检查 VPS 中转是否在线。")
        : t("局域网和备用中转均无法连接「{0}」，正在自动重试。请确认主机未休眠、TaroBird 正在运行，并检查中转服务是否在线。", hostName),
      actionRequired: false,
    };
  }

  if (!hasLan && !hasTailscale && hasRemote) {
    return {
      code: "vps-unreachable",
      message: context === "pairing"
        ? t("无法通过中转或公网地址连接主机。请核对地址是否正确、VPS 中转是否在线，以及主机电脑是否开机并运行 TaroBird。")
        : t("无法通过中转或公网地址连接「{0}」，正在自动重试。请确认主机未休眠、TaroBird 正在运行，且中转服务在线。", hostName),
      actionRequired: false,
    };
  }

  return {
    code: "multi-route-unreachable",
    message: context === "pairing"
      ? t("已尝试的所有线路均无法连接主机。请确认主机电脑未休眠且 TaroBird 正在运行，并检查两端 Tailscale 或 VPS 中转状态。")
      : t("已尝试的所有线路均无法连接「{0}」，正在自动重试。请确认主机未休眠、TaroBird 正在运行，并检查 Tailscale 或中转服务状态。", hostName),
    actionRequired: false,
  };
}

/** Format a stored route diagnosis in the active UI locale. */
export function routeDiagnosisMessage(diagnosis: RouteDiagnosis | undefined, hostName?: string): string | undefined {
  if (!diagnosis) return undefined;
  return diagnosis.snapshot ? resolveRouteDiagnosis(diagnosis.snapshot, hostName).message : diagnosis.message;
}

/** Produce an actionable, evidence-based failure reason from the actually
 * attempted routes and their observed errors. Never blames an unchecked cause. */
export function diagnoseRouteFailures(
  attempts: readonly RouteFailureAttempt[],
  options: {
    context: "pairing" | "paired";
    hostName?: string;
    configuredRoutes?: readonly Pick<Route, "name" | "url">[];
    online?: boolean;
  },
): RouteDiagnosis {
  const online = options.online ?? (typeof navigator === "undefined" ? true : navigator.onLine);
  const verificationFailure = preferredVerificationFailure(attempts.map((attempt) => connectionVerificationFailure(attempt.error)));
  const parsed = attempts.map((attempt) => ({
    kind: classifyRouteKind(attempt.route),
    reason: classifyRouteTransportFailure(attempt.error, attempt.route),
  }));
  const attemptedUrls = new Set(attempts.map((attempt) => attempt.route.url));
  const unprobed = (options.configuredRoutes ?? []).filter((route) => !attemptedUrls.has(route.url));
  const snapshot: RouteDiagnosisSnapshot = {
    context: options.context,
    hostName: options.hostName?.trim() || undefined,
    online,
    verificationFailure,
    attempts: parsed,
    unprobedTailscale: unprobed.some((route) => classifyRouteKind(route) === "tailscale"),
    unprobedVps: unprobed.some((route) => classifyRouteKind(route) === "vps"),
  };
  return { ...resolveRouteDiagnosis(snapshot), snapshot };
}

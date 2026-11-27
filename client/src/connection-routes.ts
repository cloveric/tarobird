import { cloudflareOriginSchema } from "../../src/client-protocol/cloudflare.js";
import { type Deployment, type Route, routesSchema, localRoutesSchema, deploymentMatchesRoutes } from "../../src/client-protocol/routes.js";
import { validateRoute } from "./identity.js";
import { t } from "./i18n.js";

function assertCloudflareOrigin(route: Pick<Route, "name">, url: string): void {
  if (route.name === "Cloudflare" && !cloudflareOriginSchema.safeParse(url).success) {
    throw new Error(t("Cloudflare Tunnel 必须使用公网 HTTPS 地址（不能使用 HTTP 或本机回环地址）。"));
  }
}

export function connectionRoutes(deployment: Deployment | undefined, address: string, relays: Route[], legacyDirect?: Route): Route[] {
  const routes: Route[] = [];
  if (deployment !== "vps-relay" && address.trim()) {
    const url = validateRoute(address);
    routes.push({ name: legacyDirect?.url === url ? legacyDirect.name : "Direct", url, ...(legacyDirect?.url === url && legacyDirect.label ? { label: legacyDirect.label } : {}), ...(legacyDirect?.url === url && legacyDirect.certificateAuthority ? { certificateAuthority: legacyDirect.certificateAuthority } : {}) });
  }
  if (deployment === "vps-direct" && !routes.length) throw new Error(t("请填写运行 Bot 的 VPS 主机 HTTPS 地址。"));
  for (const relay of relays) {
    // An untouched optional first relay is harmless. Partly filled rows must be fixed.
    if (relays.length === 1 && !relay.url.trim() && !relay.label?.trim()) continue;
    if (!relay.url.trim()) throw new Error(t("请填写每个 VPS 的地址，或移除空白线路。"));
    const url = validateRoute(relay.url);
    assertCloudflareOrigin(relay, url);
    const { certificateAuthority, ...rest } = relay;
    routes.push({ ...rest, ...(relay.name !== "Cloudflare" && certificateAuthority ? { certificateAuthority } : {}), url, label: relay.label?.trim() || undefined });
  }
  if (deployment === "vps-relay" && !routes.length) throw new Error(t("请添加至少一台中转 VPS，并填写它的 HTTPS 入口。"));
  if (!routes.length) throw new Error(t("至少填写一条线路。"));
  const parsed = routesSchema.safeParse(routes);
  if (!parsed.success) throw new Error(t("线路地址不能重复，最多添加 8 个 VPS。"));
  return parsed.data;
}

/** Edit addresses without inferring where Bots run. Preserve compatible legacy
 * QR metadata, but never let it silently discard a newly entered route. */
export function connectionConfiguration(address: string, relays: Route[], previousDeployment?: Deployment, legacyDirect?: Route): { routes: Route[]; deployment?: Deployment } {
  const routes = connectionRoutes(undefined, address, relays, legacyDirect);
  return { routes, deployment: deploymentMatchesRoutes(previousDeployment, routes) ? previousDeployment : undefined };
}

/** All access types are edited together. A CA belongs to an origin, never to
 * the row position: editing a URL cannot copy its old CA to a new endpoint. */
export function multipathConfiguration(direct: Route[], relays: Route[], previous: readonly Route[], previousDeployment?: Deployment): { routes: Route[]; deployment?: Deployment } {
  const entered = [...direct, ...relays].filter(route => route.url.trim() || route.label?.trim());
  const routes = entered.map(route => {
    if (!route.url.trim()) throw new Error(t("请填写每条线路的地址，或移除空白线路。"));
    const url = validateRoute(route.url), trusted = previous.find(value => value.url === url);
    assertCloudflareOrigin(route, url);
    return { name: route.name, url, ...(route.label?.trim() ? { label: route.label.trim() } : {}),
      ...(route.name !== "Cloudflare" && trusted?.certificateAuthority ? { certificateAuthority: trusted.certificateAuthority } : {}) };
  });
  if (!routes.length) throw new Error(t("至少填写一条线路。"));
  const parsed = localRoutesSchema.safeParse(routes);
  if (!parsed.success) throw new Error(t("线路地址不能重复；局域网与 Tailscale 合计最多 4 条，中转最多 8 条。"));
  return { routes: parsed.data, deployment: deploymentMatchesRoutes(previousDeployment, parsed.data) ? previousDeployment : undefined };
}

import { useEffect, useRef, useState } from "react";
import { invoke } from "./desktop-bridge.js";
import { mergeNetworkInviteRoute } from "./network-routes.js";
import type { HubConnection } from "./connection.js";
import type { Route } from "./storage.js";
import { HOST_ROUTES_PATH, hostRoutesViewSchema } from "../../src/client-protocol/host-routes.js";
import { routesSchema } from "../../src/client-protocol/routes.js";
import { t } from "./i18n.js";

/** Shared explicit listener preparation for invitations and connection settings. */
export function useDesktopHostAccess({ hubKey, connection, purpose, disabled = false, busyChange, onReady }: { hubKey: string; connection?: HubConnection; purpose: "pairing" | "network" | "connection"; disabled?: boolean; busyChange?: (busy: boolean) => void; onReady?: (route: Route, unavailableRouteCount?: number) => void }) {
  const [method, setMethod] = useState<"network" | "tailscale">("network");
  const [routes, setRoutes] = useState<Route[]>([]), [selected, setSelected] = useState(-1);
  const [unavailableRouteCount, setUnavailableRouteCount] = useState(0);
  const [publishedRoute, setPublishedRoute] = useState("");
  const [publishingRoute, setPublishingRoute] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // Publish only after the owner explicitly opens LAN/Tailscale access.
  // Wait for the restarted local Hub before signing its shareable routes.
  useEffect(() => {
    setPublishingRoute(false);
    if (!connection || !routes[selected]) return;
    let disposed = false, publishing = false, published = false, failed = false;
    const timeout = setTimeout(() => { if (!disposed && !published) { setError(t("网络线路仍在同步，完成后会自动更新，请稍候。")); } }, 20000);
    const publish = () => {
      if (disposed || publishing || published || failed || connection.state.status !== "online") return;
      // Pairing remains available on older hosts without network sync. The
      // listener is ready; there is no directory publication to wait for.
      if (purpose !== "network" && connection.state.networkAvailable === false) {
        published = true; clearTimeout(timeout); setPublishedRoute(routes[selected]!.url); setError(""); return;
      }
      if (!connection.state.networkAvailable) return;
      publishing = true; setPublishingRoute(true);
      void (async () => {
        const view = await connection.refreshNetwork();
        if (disposed) return false;
        if (!view) throw new Error("network_view_unavailable");
        const merged = mergeNetworkInviteRoute(view.host.routes, routes[selected]!);
        if (!merged.some(route => route.url === routes[selected]!.url) && !connection.state.hostRoutesAvailable) throw new Error("network_route_preserved");
        await connection.networkCommand({ operation:"routes", routes:merged });
        if (disposed) return false;
        if (!merged.some(route => route.url === routes[selected]!.url)) {
          const own = hostRoutesViewSchema.parse(await connection.http(HOST_ROUTES_PATH));
          if (own.hostPublicKey !== hubKey || !own.routes.some(entry => entry.route.url === routes[selected]!.url
            && entry.route.certificateAuthority === routes[selected]!.certificateAuthority)) throw new Error("host_route_not_published");
        }
        return !disposed;
      })().then(ok => { if (ok) { clearTimeout(timeout); published = true; if (!disposed) { setPublishedRoute(routes[selected]!.url); setError(""); } } }).catch(cause => { clearTimeout(timeout); failed = true; if (!disposed) setError(purpose === "connection" ? t("本机入口已准备，但地址尚未同步。请重试；已配对设备的授权不会改变。") : cause instanceof Error && cause.message === "network_route_preserved" ? t("连接码已生成。自动同步局域网与 Tailscale 多条线路需要先更新本机主机。") : cause instanceof Error && cause.message === "host_route_not_published" ? t("连接码已生成，但此地址尚未自动共享。请在其他设备扫码添加这条线路。") : t("连接码已生成，但网络线路尚未同步。请刷新连接码重试。")); }).finally(() => { publishing = false; if (!disposed) setPublishingRoute(false); });
    };
    const stop = connection.subscribe(publish); publish();
    return () => { disposed = true; clearTimeout(timeout); stop(); };
  }, [connection, routes, selected, purpose]);
  const announced = useRef("");
  useEffect(() => {
    const route = routes[selected];
    if (purpose === "pairing" && route && publishedRoute === route.url && announced.current !== route.url) { announced.current = route.url; onReady?.(route, unavailableRouteCount); }
  }, [purpose, routes, selected, publishedRoute, unavailableRouteCount, onReady]);
  const operationBusy = busy || publishingRoute || !!routes[selected] && publishedRoute !== routes[selected]!.url && !error && !!connection;
  useEffect(() => { busyChange?.(operationBusy); return () => busyChange?.(false); }, [operationBusy, busyChange]);
  const operation = useRef(0), preparing = useRef(false);
  useEffect(() => { setRoutes([]); setSelected(-1); setUnavailableRouteCount(0); setError(""); setBusy(false); preparing.current = false; return () => { ++operation.current; }; }, [hubKey]);
  async function prepare() {
    if (preparing.current || operationBusy || disabled) return;
    preparing.current = true; const current = ++operation.current;
    setBusy(true); setError(""); setRoutes([]); setSelected(-1); setUnavailableRouteCount(0); setPublishedRoute("");
    try {
      const local = await invoke<{ running: boolean; publicKey?: string }>("desktop_host", { action: "status" });
      if (current !== operation.current) return;
      if (!local.running || local.publicKey !== hubKey) throw new Error("not_local_host");
      const result = await invoke<{ running: boolean; publicKey: string; routes: Route[]; unavailableRouteCount?: number }>("desktop_host", { action: method });
      if (current !== operation.current) return;
      if (!result.running || result.publicKey !== hubKey || !result.routes.length) throw new Error("invalid_host");
      const readyRoutes = result.routes.map((route) => routesSchema.parse([route])[0]!);
      setRoutes(readyRoutes);
      // OS enumeration order does not identify the phone's network. Opening
      // LAN access is not consent to publish an arbitrary first interface.
      const omitted = Number.isSafeInteger(result.unavailableRouteCount) && result.unavailableRouteCount! > 0 ? result.unavailableRouteCount! : 0;
      setSelected(method === "network" && (readyRoutes.length > 1 || omitted > 0) ? -1 : 0);
      setUnavailableRouteCount(omitted);
    } catch (cause) {
      if (current !== operation.current) return;
      setError(cause instanceof Error && ["not_local_host", "invalid_host"].includes(cause.message)
        ? t("请先启动当前电脑上的主机，并确认正在为这台主机添加设备。")
        : method === "tailscale" ? t("未能建立 Tailscale 连接。请确认电脑已安装并连接 Tailscale，然后重试。") : t("未能建立局域网连接。请确认电脑已连接 Wi-Fi 或有线网络，然后重试。"));
    } finally { if (current === operation.current) { preparing.current = false; setBusy(false); } }
  }
  function chooseMethod(value: "network" | "tailscale") {
    if (operationBusy || disabled || value === method) return;
    setMethod(value); setRoutes([]); setSelected(-1); setUnavailableRouteCount(0); setPublishedRoute(""); setError("");
  }
  function chooseRoute(index: number) {
    if (busy || publishingRoute || disabled || !Number.isInteger(index) || !routes[index] || index === selected) return;
    setError(""); setSelected(index); setPublishedRoute("");
  }
  return { method, chooseMethod, routes, selected, setSelected: chooseRoute, unavailableRouteCount, publishedRoute, busy, publishingRoute, operationBusy, error, prepare };
}

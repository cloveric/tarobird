import { QrCode, ScanLine } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { deploymentMatchesRoutes, localRoutesSchema, type Deployment } from "../../src/client-protocol/routes.js";
import { CreationDialog } from "./CreationDialog.js";
import { PairingScanner, type PairingPayload } from "./PairingCode.js";
import { routeTitle } from "./RouteFields.js";
import { t, useLocale } from "./i18n.js";
import type { HubConnection } from "./connection.js";
import type { Identity, Route } from "./storage.js";

const loopback = (url: string) => { const host = new URL(url).hostname; return host === "localhost" || host === "[::1]" || host.startsWith("127."); };
const privateLan = (url: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(url).hostname);
export type RouteRepair = { routes: Route[]; deployment?: Deployment; direct: Route; replaced?: Route; relays: number; certificateChanged: boolean };

/** Refresh one access type from a QR of the same Hub key. The other access
 * types and paired device identity stay; undefined means nothing changes. */
export function repairRoutes(identity: Pick<Identity, "hubPublicKey" | "routes" | "deployment">, payload: PairingPayload): RouteRepair | undefined {
  if (payload.kind !== "connect") throw new Error(t("请扫描已信任设备显示的 Hub 二维码"));
  if (!identity.hubPublicKey || payload.hubPublicKey !== identity.hubPublicKey) throw new Error(t("这不是当前主机的二维码。请扫描此主机显示的连接二维码。"));
  const scanned = payload.routes.find((route) => route.name !== "VPS");
  if (!scanned) throw new Error(t("此二维码不含直连地址。如需修改中转，请使用「编辑线路」。"));
  if (loopback(scanned.url)) throw new Error(t("二维码中的地址只能在主机本机使用。请在主机上开启局域网配对后重新扫描。"));
  const managedMatches = identity.routes.filter(route => route.name === scanned.name
    && !!scanned.certificateAuthority && route.certificateAuthority === scanned.certificateAuthority
    && new URL(route.url).port === new URL(scanned.url).port
    && (scanned.name === "Tailscale" || privateLan(route.url) && privateLan(scanned.url)));
  // A public HTTPS host can also be called Direct. A route label/type alone
  // cannot identify a stale LAN address; append when ownership is ambiguous.
  const replaced = identity.routes.find(route => route.name === scanned.name && route.url === scanned.url)
    ?? (managedMatches.length === 1 ? managedMatches[0] : undefined);
  const relays = identity.routes.filter((route) => route.name === "VPS");
  // A refreshed address keeps the user's own name for the same origin.
  const direct: Route = { ...scanned, ...(!scanned.label && replaced?.url === scanned.url && replaced.label ? { label: replaced.label } : {}) };
  // Only the address and its trust anchor matter; a differing display name alone is no repair.
  if (replaced?.url === direct.url && replaced.certificateAuthority === direct.certificateAuthority) return undefined;
  const parsed = localRoutesSchema.safeParse([direct, ...identity.routes.filter(route => route !== replaced)]);
  if (!parsed.success) throw new Error(t("无法添加此地址：地址重复或线路数量已达上限。请使用「编辑线路」调整。"));
  const routes = parsed.data, deployment = payload.deployment ?? (deploymentMatchesRoutes(identity.deployment, routes) ? identity.deployment : undefined);
  if (!deploymentMatchesRoutes(deployment, routes)) throw new Error(t("二维码中的连接方式与已保存的线路不一致，请使用「编辑线路」调整。"));
  return { routes, deployment, direct: routes[0]!, replaced, relays: relays.length, certificateChanged: replaced?.url === direct.url && replaced.certificateAuthority !== direct.certificateAuthority };
}

export function RepairHostRoute({ connection, online, busyChange }: { connection: HubConnection; online: boolean; busyChange?: (busy: boolean) => void }) {
  useLocale();
  const [scan, setScan] = useState(false), [proposal, setProposal] = useState<{ payload: PairingPayload; repair: RouteRepair }>();
  const [status, setStatus] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const busyRef = useRef(false), button = useRef<HTMLButtonElement>(null), titleId = useId();
  useLayoutEffect(() => { busyChange?.(busy); }, [busy, busyChange]);
  useLayoutEffect(() => () => { busyChange?.(false); }, [busyChange]);
  const identity = connection.identity, current = identity.routes.find((route) => route.name !== "VPS");
  // The host's own loopback connection never needs a LAN address.
  if (!identity.hubPublicKey || (current && loopback(current.url))) return null;
  const unchanged = () => online ? t("已保存的地址与二维码一致，无需更新。") : t("已保存的地址与二维码一致，无需更新。如仍无法连接，请确认此设备与主机在同一网络，且主机正在运行。");
  // Throwing keeps the scanner open with the reason, so the right code can be scanned next.
  const receive = (payload: PairingPayload) => {
    const repair = repairRoutes(connection.identity, payload);
    setError("");
    if (repair) { setStatus(""); setProposal({ payload, repair }); } else setStatus(unchanged());
  };
  const cancel = () => { if (busyRef.current) return; setProposal(undefined); setError(""); };
  const apply = () => {
    if (!proposal || busyRef.current) return;
    // Recheck against the identity as it is now; another save may have landed meanwhile.
    let repair: RouteRepair | undefined;
    try { repair = repairRoutes(connection.identity, proposal.payload); } catch (e) { setError(e instanceof Error ? e.message : t("更新失败")); return; }
    if (!repair) { setProposal(undefined); setStatus(unchanged()); return; }
    if (JSON.stringify([repair.routes, repair.deployment]) !== JSON.stringify([proposal.repair.routes, proposal.repair.deployment])) { setProposal({ payload: proposal.payload, repair }); setError(t("已保存的线路刚刚有变化，请确认后再更新。")); return; }
    busyRef.current = true; setBusy(true); setError("");
    void connection.updateRoutes(repair.routes, { deployment: repair.deployment, expected: connection.identity.routes, reason: "user" })
      .then(() => { setProposal(undefined); setStatus(t("连接已更新。已保留其他线路，将检测新地址并自动选择连接。")); })
      .catch(() => setError(t("未能更新连接，已保存的线路没有改变。请重试。")))
      .finally(() => { busyRef.current = false; setBusy(false); });
  };
  const shown = proposal?.repair, moved = !!shown?.replaced && shown.replaced.url !== shown.direct.url;
  return <>
    <div className="device-add">
      <span className="device-add-icon" aria-hidden="true"><QrCode size={20}/></span>
      <div className="device-add-text"><strong id={titleId}>{t("主机换了网络或地址？")}</strong><small>{t("在电脑或其他已连接的设备上打开「设备与网络 → 添加设备」，扫描连接二维码即可更新。无需重新配对，聊天记录保持不变。")}</small></div>
      <button ref={button} type="button" className={online ? "secondary" : "primary"} aria-haspopup="dialog" aria-describedby={titleId} disabled={busy} onClick={(event) => { event.currentTarget.focus(); setStatus(""); setError(""); setScan(true); }}><ScanLine size={16}/>{t("扫描二维码更新连接")}</button>
    </div>
    {status && <p role="status" className="settings-feedback">{status}</p>}
    {scan && <PairingScanner close={() => setScan(false)} receive={receive}/>}
    {shown && <CreationDialog title={t("更新此主机的连接？")} close={cancel} busy={busy} closeLabel={t("关闭确认")} returnFocus={button}>
      <p className="muted">{t("二维码来自同一台主机。只更新此设备的直连地址，无需重新配对，聊天记录保持不变。")}</p>
      <dl className="device-facts">
        <div><dt>{t("主机身份")}</dt><dd>{t("已核对，尾号 {0}", identity.hubPublicKey.slice(-8))}</dd></div>
        <div><dt>{t("直连地址")}</dt><dd>{shown.direct.url}</dd></div>
        {moved && <div><dt>{t("原地址")}</dt><dd>{shown.replaced!.url}</dd></div>}
        {shown.certificateChanged && <div><dt>{t("主机证书")}</dt><dd>{shown.direct.certificateAuthority ? t("使用二维码中的证书") : t("改用系统证书")}</dd></div>}
        {shown.relays > 0 && <div><dt>{t("备用中转")}</dt><dd>{t("保留 {0} 条", shown.relays)}</dd></div>}
      </dl>
      {moved && !privateLan(shown.replaced!.url) && <p className="settings-warning">{t("「{0}」不是局域网地址，可能用于外网连接。更新后此设备不再使用它。", routeTitle(shown.replaced!, identity.routes, identity.deployment))}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="quick-actions"><button type="button" disabled={busy} onClick={cancel}>{t("取消")}</button><button type="button" className="primary" disabled={busy} onClick={apply}>{busy ? t("正在更新…") : t("更新连接")}</button></div>
    </CreationDialog>}
  </>;
}

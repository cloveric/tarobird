import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { PAIRING_INVITES_PATH, PAIRING_INVITE_REVOKE_PATH, pairingInviteIssuedSchema, pairingInviteListSchema, type PairingInviteIssued } from "../../src/client-protocol/pairing-invites.js";
import type { HubConnection } from "./connection.js";
import { randomNonce } from "./identity.js";
import { timeoutSignal } from "./abort-signals.js";
import { PairingCode, type PairingPayload } from "./PairingCode.js";
import { pairingInviteError } from "./pairing-invite-errors.js";
import { t, useLocale } from "./i18n.js";

type ConnectPayload = Extract<PairingPayload, { kind: "connect" }>;
/** Route preparation and invitation issuance are independent: this component
 * never prepares listeners or changes network settings. No static-QR fallback. */
export function ConnectionInviteCode({ connection, payload }: { connection?: HubConnection; payload: ConnectPayload }) {
  useLocale();
  return connection ? <ConnectedInvite key={connection.identity.deviceId + payload.hubPublicKey} connection={connection} payload={payload}/> : <p role="status" className="settings-note">{t("连接主机并取得管理权限后，才能生成限时连接码。")}</p>;
}
function ConnectedInvite({ connection, payload }: { connection: HubConnection; payload: ConnectPayload }) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const available = state.status === "online" && state.user?.role === "owner" && !!state.pairingInvitesAvailable && connection.identity.hubPublicKey === payload.hubPublicKey;
  const [issued, setIssued] = useState<PairingInviteIssued & { received: number; mono: number }>();
  const [phase, setPhase] = useState<"available" | "claimed" | "expired">("available");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const lifetime = useRef<{ active: boolean; issuing: boolean; id?: string; requestId: string } | undefined>(undefined);
  const close = (id: string) => connection.http(PAIRING_INVITE_REVOKE_PATH, { method: "POST", body: JSON.stringify({ id }), signal: timeoutSignal(8000) }).catch(() => undefined);
  async function issue(scope: NonNullable<typeof lifetime.current>) {
    if (!scope.active || scope.issuing) return;
    scope.issuing = true; setBusy(true); setError("");
    const started = { received: Date.now(), mono: performance.now() };
    try {
      const mint = (replaces?: string) => connection.http(PAIRING_INVITES_PATH, { method: "POST", body: JSON.stringify({ requestId: scope.requestId, ...(replaces ? { replaces } : {}) }), signal: timeoutSignal(10_000) });
      let raw;
      try { raw = await mint(scope.id); }
      catch (e) {
        // A restart or expiry may have removed the old record. Only this
        // definitive rejection permits issuance without `replaces`.
        if (!(e instanceof Error) || e.message !== "pairing_invite_not_found") throw e;
        raw = await mint();
      }
      const next = pairingInviteIssuedSchema.parse(raw);
      if (!scope.active) { void close(next.id); return; }
      scope.id = next.id; scope.requestId = randomNonce();
      setIssued({ ...next, ...started }); setPhase("available");
    } catch (e) {
      if (scope.active) setError(pairingInviteError(e instanceof Error ? e.message : undefined) ?? t("未能生成二维码，请重试。现有设备的连接不会改变。"));
    } finally { scope.issuing = false; if (scope.active) setBusy(false); }
  }
  useEffect(() => {
    setIssued(undefined); setError(""); setBusy(false); setPhase("available");
    const scope = { active: true, issuing: false, id: undefined as string | undefined, requestId: randomNonce() };
    lifetime.current = scope;
    return () => { scope.active = false; if (scope.id) void close(scope.id); if (lifetime.current === scope) lifetime.current = undefined; };
    // A new authenticated connection owns a separate invitation lifetime.
  }, [connection]);
  useEffect(() => {
    const scope = lifetime.current;
    if (available && scope && !scope.id) void issue(scope);
    // Reconnect keeps the same invitation and retry key. It never silently
    // extends a code already copied to another device.
  }, [connection, available]);
  useEffect(() => {
    if (!issued || !available || phase !== "available") return;
    let live = true, polling = false;
    const timer = setInterval(() => setTick(value => value + 1), 1000);
    const check = () => {
      if (polling) return; polling = true;
      void connection.http(PAIRING_INVITES_PATH, { signal: timeoutSignal(8000) }).then(raw => {
        if (!live) return;
        const status = pairingInviteListSchema.parse(raw).invites.find(item => item.id === issued.id);
        if (status?.state === "claimed") setPhase("claimed");
        else if (!status || status.state !== "available") setPhase("expired");
      }).catch(() => { /* offline state hides the QR; the Host always checks TTL */ }).finally(() => { polling = false; });
    };
    check();
    const poll = setInterval(check, 4000);
    return () => { live = false; clearInterval(timer); clearInterval(poll); };
  }, [connection, issued, available, phase]);
  // Wall time accounts for sleeping; monotonic time prevents a clock rollback
  // from extending the displayed lifetime. The Host is the final authority.
  void tick;
  const secondsLeft = (value: typeof issued) => value ? Math.max(0, Math.ceil((value.expiresAt - value.serverTime - Math.max(Date.now() - value.received, performance.now() - value.mono)) / 1000)) : 0;
  const remaining = secondsLeft(issued);
  // Checked at the moment a save is requested, not from the last render.
  const live = useRef<() => boolean>(() => false);
  live.current = () => !!issued && available && !busy && !error && phase === "available" && lifetime.current?.id === issued.id && !lifetime.current.issuing && secondsLeft(issued) > 0;
  if (!available) return <p role="status" className="settings-note">{state.status !== "online" ? t("请先恢复主机连接，再生成限时连接码。") : state.user?.role !== "owner" ? t("需要主机所有者权限才能生成连接码。") : t("请先更新此主机，才能使用限时连接码配对新设备。")}</p>;
  return <div className="connection-invite-code">
    {!busy && !error && issued && phase === "available" && remaining > 0 && <PairingCode payload={{ ...payload, invite: issued.invite }} save={{ key: issued.id, valid: () => live.current() }}/>}
    <div className="invite-validity">
      <p role="status" className="settings-note">{busy ? <><LoaderCircle size={15} className="spin" aria-hidden="true"/> {t("正在生成二维码…")}</> : phase === "claimed" ? t("已有新设备提交申请，请核对它的 8 位配对码后确认。") : issued && (phase === "expired" || remaining === 0) ? t("二维码已过期或失效，请重新生成。") : issued ? t("二维码有效时间 {0}:{1} · 仅限一台新设备", Math.floor(remaining / 60), String(remaining % 60).padStart(2, "0")) : t("二维码有效期 5 分钟，扫码后仍需确认新设备。")}</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => { if (lifetime.current) void issue(lifetime.current); }}><RefreshCw size={15} aria-hidden="true"/>{issued ? t("重新生成二维码") : t("生成二维码")}</button>
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
  </div>;
}

import { anySignal, timeoutSignal } from "./abort-signals.js";
import { pairingClockOffset, pairingRemaining } from "./pairing-time.js";
import { defaultDeviceName } from "./device-presentation.js";
import { isDirectRoute, isRelayRoute } from "../../src/client-protocol/routes.js";
import { rememberRouteTrust } from "./route-trust.js";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowLeft, ChevronLeft, ClipboardPaste, ImagePlus, LoaderCircle, Monitor, QrCode, ShieldCheck, Smartphone } from "lucide-react";
import type { BrowserPairingImport, PairingProps } from "./HostApp.js";
import type { HubConnection } from "./connection.js";
import { BrandMark, PairingIntro } from "./BrandScenes.js";
import { connectionConfiguration, multipathConfiguration } from "./connection-routes.js";
import { orderedRoutes, type Deployment } from "../../src/client-protocol/routes.js";
import { createIdentity, randomNonce } from "./identity.js";
import { cache, type Route, type Identity, type PendingPairing } from "./storage.js";
import { nativePlatform, deleteNativeIdentity } from "./native.js";
import { t, useLocale } from "./i18n.js";
import { hubFetch, usesPinnedTransport } from "./transport.js";
import { connectionDiagnosticCode, connectionErrorMessage, connectionVerificationFailure, connectionVerificationMessage, nativeLifecycleErrorCode, preferredVerificationDiagnostic, validHubPublicKey } from "./connection-verification.js";
import { classifyRouteKind, diagnoseRouteFailures, routeDiagnosisMessage, type RouteDiagnosis, type RouteFailureAttempt } from "./route-diagnostics.js";
import { pairingInviteError } from "./pairing-invite-errors.js";
import { inspectBrowserPairingHash, stripBrowserPairingHash, type ConnectPayload } from "./web-browser.js";
import { PairingCandidateRaceError, racePairingCandidates, type PairingProbeSuccess } from "./pairing-candidate-race.js";

const PairingCode = lazy(() => import("./PairingCode.js").then(module => ({ default: module.PairingCode })));
const PairingScanner = lazy(() => import("./PairingCode.js").then(module => ({ default: module.PairingScanner })));
const PairingRouteOptions = lazy(() => import("./PairingRouteOptions.js").then(module => ({ default: module.PairingRouteOptions })));
const DesktopWelcome = lazy(() => import("./DesktopWelcome.js").then(module => ({ default: module.DesktopWelcome })));
const RepairHostRoute = lazy(() => import("./RepairHostRoute.js").then(module => ({ default: module.RepairHostRoute })));

class PairingRequestError extends Error { constructor(readonly code: string, message: string) { super(message); } }
class PairingDiagnosticError extends Error { constructor(message: string, readonly diagnostic?: string) { super(message); } }
const idle = { status: "offline" as const, error: undefined as string | undefined, routeDiagnosis: undefined as RouteDiagnosis | undefined, awaitingApproval: false };
const noopSubscribe = () => () => undefined;
export function Pairing({ connected, save, beforePair, discard, cancel, pendingConnection, manage, manageConnections, existingHostStatus, browserImport, consumeBrowserImport, localHostReady = false }: PairingProps) {
  useLocale();
  const [preparedLocal, setPreparedLocal] = useState<Identity>();
  const saveLocal = async (identity: Identity, name: string) => { if (save) await save(identity, name); else await cache.saveIdentity(identity); setPreparedLocal(identity); setName(name); };
  const platform = nativePlatform(), desktop = platform === "macos" || platform === "windows", phone = platform === "ios" || platform === "android";
  const [remote, setRemote] = useState(!!pendingConnection?.identity.pendingPairing), [manual, setManual] = useState(platform === "web");
  const [hostName, setHostName] = useState(t("我的主机"));
  const [scan, setScan] = useState(false), [inputMode, setInputMode] = useState<"scan" | "text" | "image">("scan"), [optionsOpen, setOptionsOpen] = useState(false), [expectedKey, setExpectedKey] = useState<string>();
  const [invite, setInvite] = useState<string>();
  const [requestError, setRequestError] = useState<string>();
  const [manualKey, setManualKey] = useState(""); const trustedKey = expectedKey ?? (manualKey.replace(/\s/g, "") || undefined);
  const [deployment, setDeployment] = useState<Deployment>(), [legacyDirect, setLegacyDirect] = useState<Route>(), [importedDirects, setImportedDirects] = useState<Route[]>([]), [importedRoutes, setImportedRoutes] = useState<Route[]>([]);
  const [address, setAddress] = useState(nativePlatform() === "web" && location.origin.startsWith("http") ? location.origin : ""), [relays, setRelays] = useState<Route[]>([]);
  const [name, setName] = useState(() => defaultDeviceName(platform));
  const [fromBrowserLink, setFromBrowserLink] = useState(false);
  const pairButton = useRef<HTMLButtonElement>(null), imported = useRef(false), failure = useRef<HTMLParagraphElement>(null);
  const handledBrowserImport = useRef(0);
  useEffect(() => {
    if (scan || !imported.current) return;
    imported.current = false;
    // The scanner restores its previous focus while closing. Reveal the next
    // explicit action afterwards, without opening the keyboard or submitting.
    const frame = requestAnimationFrame(() => {
      pairButton.current?.focus({ preventScroll: true });
      pairButton.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [scan, expectedKey, invite, fromBrowserLink]);
  const [createdIdentity, setIdentity] = useState<Identity>(), [alert, setAlert] = useState<{ message: string; diagnostic?: string }>(), [routeFailure, setRouteFailure] = useState<{ attempts: RouteFailureAttempt[]; configuredRoutes: Route[]; online: boolean; pendingConfirm?: boolean }>(), [busy, setBusy] = useState(false);
  const error = alert?.message ?? "", diagnostic = alert?.diagnostic;
  const clearError = () => setAlert(undefined);
  const showError = (message: string, diagnosticCode?: string) => setAlert(message ? { message, diagnostic: diagnosticCode } : undefined);
  const displayedError = routeFailure
    ? `${routeFailure.pendingConfirm ? `${t("配对申请结果待确认，请核对上次申请，不要重复创建设备。")} ` : ""}${diagnoseRouteFailures(routeFailure.attempts, { context: "pairing", configuredRoutes: routeFailure.configuredRoutes, online: routeFailure.online }).message}`
    : error;
  // On a short phone screen or desktop viewport the action sits near the bottom edge,
  // so a refusal below it would look like nothing happened. Reveal it; focus stays put.
  const revealFailure = () => { failure.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); };
  useEffect(() => { if (displayedError) revealFailure(); }, [displayedError]);
  // "Connect a different host" sets the unanswered request aside without
  // touching it; the page only uses a pending connection of the shown identity.
  const [another, setAnother] = useState(false);
  const identity = createdIdentity ?? (another ? undefined : pendingConnection?.identity);
  const connection = pendingConnection && identity && pendingConnection.identity.deviceId === identity.deviceId ? pendingConnection : undefined;
  const joiningDesktop = desktop && (localHostReady || !!preparedLocal);
  const pending = identity?.pendingPairing;
  // Native phones: connection details were read, nothing is connected yet.
  // Derived only; the user still starts pairing and approves it elsewhere.
  const reviewing = phone && !!expectedKey && !pending;
  const trimmedAddress = address.trim();
  const parsedAddress = (() => { try { return trimmedAddress ? new URL(trimmedAddress) : undefined; } catch { return undefined; } })();
  const matchedLegacyDirect = legacyDirect && parsedAddress && legacyDirect.url === parsedAddress.origin ? legacyDirect : undefined;
  const directHost = parsedAddress?.hostname ?? "";
  const directRouteKind = trimmedAddress ? classifyRouteKind({ name: matchedLegacyDirect?.name ?? "Direct", url: trimmedAddress }) : undefined;
  const routeHosts = [
    ...(address ? [directHost || address] : []),
    ...relays.map((route) => { try { return new URL(route.url).hostname || route.url; } catch { return route.url; } }).filter(Boolean),
  ].filter((host, index, all) => all.indexOf(host) === index);
  const routeSummary = routeHosts.length ? routeHosts.join(" · ") : t("VPS 中转");
  const existingStatus = expectedKey && !pending ? existingHostStatus?.(expectedKey) : undefined;
  const tailscaleRoute = matchedLegacyDirect?.name === "Tailscale" || directRouteKind === "tailscale";
  const lanRoute = directRouteKind === "lan";
  const status = useSyncExternalStore(connection ? (notify) => connection.subscribe(notify) : noopSubscribe, () => connection?.state ?? idle);
  const statusError = routeDiagnosisMessage(status.routeDiagnosis) ?? status.error;
  const [now, setNow] = useState(Date.now), completing = useRef(false), admission = useRef(false);
  const remaining = pending ? pairingRemaining(pending.expiresAt, now, pending.serverTimeOffset) : 0;
  useEffect(() => { if (!pending) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [pending]);
  const renewPendingConnection = (targetConnection: HubConnection, targetPending: PendingPairing, payload: ConnectPayload) => {
    if (payload.hubPublicKey !== targetConnection.identity.hubPublicKey) throw new Error(t("这不是当前主机的二维码。请扫描此主机显示的连接二维码。"));
    if (admission.current) throw new Error(t("正在核对上一份申请，请稍候。"));
    admission.current = true; setBusy(true); clearError(); setRouteFailure(undefined); setRequestError(undefined);
    const next: PendingPairing = { code: "", expiresAt: 0, request: { invite: payload.invite!, requestId: randomNonce() } };
    void (async () => {
      const snapshot = { ...targetConnection.identity };
      const scannedDirects = payload.routes.filter(isDirectRoute);
      const unchanged = !scannedDirects.length || scannedDirects.every(direct =>
        snapshot.routes.some(route => isDirectRoute(route) && route.url === direct.url && route.certificateAuthority === direct.certificateAuthority)
      );
      let repair;
      if (!unchanged) {
        const { renewedPairingRoutes } = await import("./RepairHostRoute.js");
        repair = renewedPairingRoutes(snapshot, payload);
      }
      await targetConnection.updateRoutes(repair?.routes ?? snapshot.routes, {
        expected: snapshot.routes, deployment: repair ? repair.deployment : snapshot.deployment, reason: "user",
        pairing: { next, expected: { code: targetPending.code, requestId: targetPending.request?.requestId } },
      });
    })()
      .then(() => { setAnother(false); setFromBrowserLink(false); setIdentity(targetConnection.identity); setNow(Date.now()); targetConnection.refreshCache(); })
      .catch(cause => showError(cause instanceof Error && cause.message === "pairing_route_confirmation_required" ? t("新连接码包含不同的公网地址或证书。请先通过「更新主机地址」核对并保存，再扫描此连接码。") : t("配对状态已变化，请重新检查连接。")))
      .finally(() => { admission.current = false; setBusy(false); });
  };
  const applyBrowserImport = (item: BrowserPairingImport) => {
    if (item.error) { showError(item.error); return; }
    const payload = item.payload;
    if (!payload) return;
    const activePendingConnection = connection?.identity.pendingPairing ? connection : pendingConnection?.identity.pendingPairing ? pendingConnection : undefined;
    if (activePendingConnection?.identity.pendingPairing) {
      if (payload.hubPublicKey === activePendingConnection.identity.hubPublicKey) {
        try { renewPendingConnection(activePendingConnection, activePendingConnection.identity.pendingPairing, payload); }
        catch (e) { showError(e instanceof Error ? e.message : t("连接失败")); }
        return;
      }
      // Switch cleanly to the new-host flow without wiping the imported payload.
      setAnother(true); setIdentity(undefined); setRequestError(undefined);
    }
    imported.current = true;
    setFromBrowserLink(true);
    setInvite(payload.invite);
    setDeployment(payload.deployment);
    // Same bookkeeping as a scanned code: the candidate list always belongs to
    // the details shown, never to an earlier scan of another host.
    const directRoutes = payload.routes.filter(isDirectRoute);
    setImportedRoutes(payload.routes);
    setImportedDirects(directRoutes);
    setLegacyDirect(directRoutes[0]);
    setAddress(directRoutes[0]?.url ?? "");
    setRelays(payload.routes.filter(isRelayRoute));
    setExpectedKey(payload.hubPublicKey);
    setManual(false);
    setOptionsOpen(false);
    clearError();
  };
  const applyBrowserImportRef = useRef(applyBrowserImport);
  applyBrowserImportRef.current = applyBrowserImport;
  useEffect(() => {
    if (!browserImport || handledBrowserImport.current === browserImport.serial) return;
    handledBrowserImport.current = browserImport.serial;
    consumeBrowserImport?.(browserImport.serial);
    applyBrowserImportRef.current(browserImport);
  }, [browserImport, consumeBrowserImport]);
  useEffect(() => {
    if (platform !== "web" || consumeBrowserImport) return;
    const capture = () => {
      const result = inspectBrowserPairingHash(window.location.hash, window.location.origin);
      if (result.kind === "none") return;
      stripBrowserPairingHash();
      if (result.kind === "valid") applyBrowserImportRef.current({ serial: 0, payload: result.payload });
      else if (result.kind === "origin_mismatch") applyBrowserImportRef.current({ serial: 0, error: t("此浏览器配对链接与当前访问地址不匹配，请使用目标主机生成的链接。") });
      else applyBrowserImportRef.current({ serial: 0, error: t("浏览器配对链接无效或不完整，请在已配对设备重新生成并打开。") });
    };
    capture();
    window.addEventListener("hashchange", capture);
    return () => window.removeEventListener("hashchange", capture);
  }, [platform, consumeBrowserImport]);
  // Actual authenticated readiness is the only success signal. Keep the code
  // durable across backgrounding/reload, and never enter a disconnected chat.
  useEffect(() => {
    // Returning to the start screen keeps enrollment intact, but a late host
    // approval must not pull the user out of their newly selected setup flow.
    if (desktop && !remote) return;
    if (status.status !== "online") { completing.current = false; return; }
    if (!identity || !pending || completing.current) return;
    completing.current = true;
    void Promise.resolve(connected(identity)).catch((e: unknown) => { showError(e instanceof Error ? e.message : t("连接失败")); });
  }, [identity, pending, status.status, connected, desktop, remote]);

  const requestPair = async (device: Identity, route: Route, key: string, request: NonNullable<PendingPairing["request"]>): Promise<PendingPairing> => {
    const response = await hubFetch(route.url, "/api/pair", key, { method: "POST", signal: timeoutSignal(usesPinnedTransport() ? 15_000 : 10_000), body: JSON.stringify({ deviceId: device.deviceId, name: device.name, platform: device.platform ?? "web", publicKey: device.publicKey, ...request }) });
    const result = await response.json() as { code: string; expiresAt: number; hubPublicKey: string; serverTime?: number; error?: string };
    if (!response.ok) {
      const invitationError = pairingInviteError(result.error); if (invitationError) throw new PairingRequestError(result.error!, invitationError);
      if (result.error === "pairing_already_pending") throw new PairingRequestError(result.error, t("主机上仍有这台设备的申请，但这里尚未收到配对码。旧申请最多 5 分钟后过期；请稍后重新扫码，或先用「核对上次申请」重试。"));
      if (response.status === 429) throw new PairingRequestError("rate_limited", t("操作过于频繁，请稍后重试。"));
      throw new PairingRequestError(result.error ?? "pair_failed", result.error === "device_already_registered" ? result.error : t("配对请求失败"));
    }
    if (key !== result.hubPublicKey) throw new Error("tls_identity_mismatch");
    if (!/^\d{8}$/.test(result.code) || !Number.isFinite(result.expiresAt)) throw new Error(t("配对请求失败"));
    return { code: result.code, expiresAt: result.expiresAt, request: { requestId: request.requestId }, serverTimeOffset: Number.isFinite(result.serverTime) ? result.serverTime! - Date.now() : pairingClockOffset(response.headers.get("date"), Date.now()) };
  };
  const probeHealth = async (route: Route, key: string | undefined, signal?: AbortSignal) => {
    const response = await hubFetch(route.url, "/health", key, {
      // Pinned native probes run the 12 s TLS identity check first; stay above it.
      signal: signal ? anySignal([signal, timeoutSignal(usesPinnedTransport() ? 15_000 : 4000)]) : timeoutSignal(usesPinnedTransport() ? 15_000 : 4000),
      cache: "no-store",
    });
    const health = await response.json() as { ok?: boolean; publicKey?: string; pairingInvites?: number };
    if (!response.ok || health.ok !== true || typeof health.publicKey !== "string") throw new Error("hub_unavailable");
    if (key && health.publicKey !== key) throw new Error("tls_identity_mismatch");
    return { route, publicKey: health.publicKey, supportsInvites: health.pairingInvites === 1 };
  };
  const pair = async (event: FormEvent) => {
    event.preventDefault(); if (admission.current) return; admission.current = true; setBusy(true); clearError(); setRouteFailure(undefined); let created: Identity | undefined, persisted = false;
    try {
      if (!invite) throw new Error(pairingInviteError("invite_required"));
      const keepImportedDirects = importedDirects.length > 1
        && address.trim() === (legacyDirect?.url ?? "")
        && deployment !== "vps-relay";
      const { routes, deployment: routeDeployment } = keepImportedDirects
        ? multipathConfiguration(importedDirects, relays, importedRoutes, deployment)
        : connectionConfiguration(address, relays, deployment, legacyDirect);
      if (usesPinnedTransport() && routes.some((route) => route.url.startsWith("https:")) && !trustedKey) throw new Error(t("请扫描可信设备上的 Hub 二维码，或填写主机身份公钥。"));
      if (usesPinnedTransport() && trustedKey && !validHubPublicKey(trustedKey)) throw new Error("invalid_hub_key");
      rememberRouteTrust(routes, trustedKey);
      const pageOrigin = platform === "web" && location.origin.startsWith("http") ? location.origin : undefined;
      const ordered = orderedRoutes(routes);
      const pageOriginIndex = pageOrigin ? ordered.findIndex((route) => {
        try { return new URL(route.url).origin === pageOrigin; } catch { return false; }
      }) : -1;
      if (fromBrowserLink && (!pageOrigin || pageOriginIndex < 0)) {
        throw new Error(t("此浏览器配对链接与当前访问地址不匹配，请使用目标主机生成的链接。"));
      }
      let available: PairingProbeSuccess;
      if (pageOriginIndex >= 0) {
        // A browser page served by one of the routes pairs through that route
        // or not at all, so there is nothing to race: every probe is awaited
        // and the page's own address decides.
        const probes = await Promise.allSettled(ordered.map((route) => probeHealth(route, trustedKey)));
        const pageProbe = probes[pageOriginIndex];
        if (!pageProbe || pageProbe.status !== "fulfilled") {
          const reason = pageProbe?.status === "rejected" ? pageProbe.reason : undefined;
          throw new PairingDiagnosticError(connectionVerificationMessage(connectionVerificationFailure(reason)) ?? t("当前页面的主机地址不可用或身份不匹配，已阻止切换到其他地址。"), connectionDiagnosticCode(reason));
        }
        if (fromBrowserLink) {
          const mismatch = probes.find((result) => result.status === "rejected" && connectionVerificationFailure(result.reason) === "identity-mismatch");
          if (mismatch && mismatch.status === "rejected") throw mismatch.reason;
        }
        available = pageProbe.value;
      } else {
        try {
          available = await racePairingCandidates(ordered, {
            probe: (route, signal) => probeHealth(route, trustedKey, signal),
          });
        } catch (raceError) {
          if (!(raceError instanceof PairingCandidateRaceError)) throw raceError;
          // No candidate answered as this host. The race kept what each one
          // failed with, so the reason shown is the one that was observed.
          const attempts: RouteFailureAttempt[] = [...raceError.attempts];
          const localCode = attempts.map((attempt) => nativeLifecycleErrorCode(attempt.error)).find(Boolean);
          if (localCode) throw new Error(connectionErrorMessage(localCode));
          const online = typeof navigator === "undefined" ? true : navigator.onLine;
          const diagnosis = diagnoseRouteFailures(attempts, { context: "pairing", configuredRoutes: routes, online });
          setRouteFailure({ attempts, configuredRoutes: routes, online });
          throw new PairingDiagnosticError(diagnosis.message, preferredVerificationDiagnostic(attempts.map((attempt) => attempt.error)).code);
        }
      }
      if (!available.supportsInvites) throw new Error(t("请先更新此主机，才能使用限时连接码配对新设备。"));
      await beforePair?.(available.publicKey);
      const identityRoutes = [available.route, ...routes.filter(route => route.url !== available.route.url)];
      const device = await createIdentity(name.trim(), identityRoutes); device.deployment = routeDeployment; device.hubPublicKey = available.publicKey; created = device;
      device.pendingPairing = { code: "", expiresAt: 0, request: { invite, requestId: randomNonce() } };
      if (save) await save(device, hostName); else await cache.saveIdentity(device);
      persisted = true;
      setIdentity(device); setNow(Date.now());
    } catch (e) {
      if (created && !persisted) { if (discard) await discard(created).catch(() => undefined); else if (created.keyRef) await deleteNativeIdentity(created.keyRef).catch(() => undefined); }
      if (e instanceof PairingDiagnosticError) showError(e.message, e.diagnostic);
      else showError(connectionVerificationMessage(connectionVerificationFailure(e)) ?? (e instanceof Error ? e.message : t("连接失败")), connectionDiagnosticCode(e));
    } finally { admission.current = false; setBusy(false); }
  };
  const submitPending = async () => {
    const pendingConnection = connection;
    if (!identity?.hubPublicKey || !pendingConnection || admission.current || pendingConnection.identity.deviceId !== identity.deviceId || pendingConnection.identity.hubPublicKey !== identity.hubPublicKey) return;
    const request = identity.pendingPairing?.request; if (!request) return;
    const expected = { requestId: request.requestId, code: identity.pendingPairing!.code };
    admission.current = true; setBusy(true); clearError(); setRouteFailure(undefined); setRequestError(undefined);
    const failedAttempts: RouteFailureAttempt[] = [];
    try {
      const active = identity.routes.find(route => route.url === pendingConnection.state.route?.url && route.certificateAuthority === pendingConnection.state.route?.certificateAuthority);
      const ordered = orderedRoutes(identity.routes);
      let fastWinner: Route | undefined;
      if (!active && ordered.length > 1) {
        fastWinner = await racePairingCandidates(ordered, {
          probe: (route, signal) => probeHealth(route, identity.hubPublicKey, signal),
        }).then(winner => winner.route, () => undefined);
      }
      const routes = [active, fastWinner, ...ordered].filter((route): route is Route => !!route);
      let next: PendingPairing | undefined, failure: unknown;
      for (const route of routes.filter((route, index) => routes.findIndex(other => other.url === route.url) === index)) {
        try { next = await requestPair(identity, route, identity.hubPublicKey, request); break; }
        catch (e) { if (e instanceof PairingRequestError) throw e; failure = e; failedAttempts.push({ route, error: e }); }
      }
      if (!next) throw failure ?? new Error("pairing_response_unknown");
      await pendingConnection.cache.savePendingPairing(identity, next, expected);
      identity.pendingPairing = next; pendingConnection.identity.pendingPairing = next;
      setNow(Date.now()); pendingConnection.refreshCache(); pendingConnection.resume(true);
    } catch (e) {
      if (e instanceof Error && e.message === "device_already_registered") { showError(t("已批准，正在重新连接。无需再次配对。")); pendingConnection.resume(true); }
      else if (!(e instanceof Error && e.message === "pairing_request_changed")) {
        if (e instanceof PairingRequestError && ["pairing_invite_invalid", "pairing_invite_expired", "pairing_invite_used"].includes(e.code)) {
          const cleared = { ...identity.pendingPairing!, request: { requestId: request.requestId } };
          try {
            await pendingConnection.cache.savePendingPairing(identity, cleared, expected);
            identity.pendingPairing = cleared; pendingConnection.identity.pendingPairing = cleared;
            pendingConnection.refreshCache();
          } catch { return; /* A newer request or approval must never be overwritten. */ }
        }
        setRequestError(e instanceof PairingRequestError ? e.code : undefined);
        const verification = connectionVerificationMessage(connectionVerificationFailure(e));
        if (verification) showError(verification, connectionDiagnosticCode(e));
        else if (e instanceof PairingRequestError) showError(e.message);
        else if (failedAttempts.length) {
          const localCode = failedAttempts.map((attempt) => nativeLifecycleErrorCode(attempt.error)).find(Boolean);
          if (localCode) {
            showError(connectionErrorMessage(localCode));
          } else {
            const online = typeof navigator === "undefined" ? true : navigator.onLine;
            const diagnosis = diagnoseRouteFailures(failedAttempts, { context: "pairing", configuredRoutes: identity.routes, online });
            setRouteFailure({ attempts: failedAttempts, configuredRoutes: identity.routes, online, pendingConfirm: true });
            showError(`${t("配对申请结果待确认，请核对上次申请，不要重复创建设备。")} ${diagnosis.message}`, preferredVerificationDiagnostic(failedAttempts.map((attempt) => attempt.error)).code);
          }
        } else {
          showError(t("配对申请结果待确认，请核对上次申请，不要重复创建设备。"), connectionDiagnosticCode(e));
        }
      }
    } finally { admission.current = false; setBusy(false); }
  };
  const attempted = useRef(new Set<string>()), submitRef = useRef(submitPending); submitRef.current = submitPending;
  useEffect(() => {
    const requestId = pending?.request?.requestId;
    if (!busy && !admission.current && !(desktop && !remote) && connection?.identity.deviceId === identity?.deviceId && connection?.identity.hubPublicKey === identity?.hubPublicKey && !pending?.code && requestId && !attempted.current.has(requestId)) {
      attempted.current.add(requestId); void submitRef.current();
    }
  }, [connection, pending?.code, pending?.request?.requestId, busy, desktop, remote]);
  // A different host starts from an empty form: details read for this request
  // (its invite, address and key) must not be submitted for another host.
  const startAnother = () => {
    setAnother(true); setIdentity(undefined); clearError(); setRouteFailure(undefined); setRequestError(undefined);
    setFromBrowserLink(false);
    setInvite(undefined); setExpectedKey(undefined); setManualKey(""); setDeployment(undefined); setLegacyDirect(undefined); setImportedDirects([]); setImportedRoutes([]); setRelays([]);
    setAddress(nativePlatform() === "web" && location.origin.startsWith("http") ? location.origin : ""); setManual(platform === "web"); setOptionsOpen(false); setHostName(t("我的主机"));
  };
  const relaySummary = (() => {
    const hasCf = relays.some(route => route.name === "Cloudflare");
    const hasVps = relays.some(route => route.name === "VPS");
    if (hasCf && hasVps) return t("VPS 中转 · Cloudflare Tunnel");
    if (hasCf) return "Cloudflare Tunnel";
    return t("VPS 中转");
  })();
  const routeHint = expectedKey && (tailscaleRoute || lanRoute) && <p className="pairing-route-hint">{tailscaleRoute ? t("此连接使用 Tailscale。这台设备也需连接同一 Tailscale 网络，并允许访问目标主机；仅复制地址不会自动建立连接。") : t("此连接包含局域网地址。人在外面时需有可用的 Tailscale 或 VPS 线路；家里的 Wi-Fi 地址通常无法从外部直接访问。")}</p>;
  if (desktop && !remote) return <Suspense fallback={<div className="loading-screen"><BrandMark/><LoaderCircle className="spin" size={16}/></div>}><DesktopWelcome localHostReady={localHostReady || !!preparedLocal} connected={connected} save={saveLocal} beforePair={beforePair} discard={discard} cancel={cancel ?? (preparedLocal ? () => { void Promise.resolve(connected(preparedLocal)).catch(e => showError(String(e))); } : undefined)} pending={!!pending} remote={() => setRemote(true)}/></Suspense>;
  return <main className="pairing-page"><div className="pairing-layout"><div className={`pairing-card${!pending && phone ? " pairing-phone-welcome" : ""}`}>
    {(desktop || cancel || another && !createdIdentity && !!pendingConnection?.identity.pendingPairing) && <nav className="pairing-navigation">
      {desktop && <button type="button" className="pairing-host-cancel" disabled={busy} onClick={() => { setRemote(false); clearError(); setRouteFailure(undefined); }}><ChevronLeft size={16}/>{t("返回开始")}</button>}
      {another && !createdIdentity && pendingConnection?.identity.pendingPairing && <button type="button" className="pairing-host-cancel" disabled={busy} onClick={() => { setAnother(false); clearError(); setRouteFailure(undefined); }}><ChevronLeft size={16}/>{t("返回配对申请")}</button>}
      {cancel && <button type="button" className="pairing-host-cancel pairing-return-conversations" disabled={busy} onClick={cancel}><ArrowLeft size={16} aria-hidden="true"/>{t("返回会话")}</button>}
    </nav>}
    <BrandMark/>{joiningDesktop && <ol className="pairing-journey" aria-label={t("加入步骤")}><li>{t("准备电脑")}</li><li aria-current="step">{t("手机确认连接")}</li><li>{t("确认加入网络")}</li></ol>}<h1>{pending ? t("用已配对设备确认") : t("连接你的 TaroBird")}</h1>
    {pending ? <section className="pairing-waiting">
      <p>{!pending.code ? t("正在核对这台设备的配对申请。回执丢失时会复用原申请，设备身份不会重新生成。") : joiningDesktop ? t("打开已配对手机的「设备与网络 › 输入配对码确认」，输入下方 8 位配对码。手机确认后，这里会继续设置本机线路并确认加入网络。") : t("打开已配对手机或电脑的「设备与网络」，选择「输入配对码确认」，输入下方 8 位配对码。无需回到主机旁，确认后这里会自动进入聊天。")}</p>
      {identity?.hubPublicKey && <p className="muted">{t("目标主机身份尾号：{0}。请与手机上显示的尾号核对。", identity.hubPublicKey.slice(-8))}</p>}
      <p className="muted">{t("新设备：{0}", identity?.name ?? name)}</p>
      {pending.code && <><div className="pair-code" aria-label={t("配对码")}>{pending.code}</div>
      <p className="pairing-countdown">{remaining ? t("有效时间 {0}:{1}", Math.floor(remaining / 60), String(remaining % 60).padStart(2, "0")) : t("配对码已过期，请扫描新的限时连接码。")}</p></>}
      <div role="status" className="pairing-connection-status">{remaining > 0 && <LoaderCircle className="spin" size={18}/>}<span>{status.status === "online" ? joiningDesktop ? t("已连接，正在继续加入网络…") : t("已连接，正在打开聊天…") : !pending.code ? busy ? t("正在核对申请…") : ["pairing_invite_invalid", "pairing_invite_expired", "pairing_invite_used", "pairing_invite_required"].includes(requestError ?? "") ? t("连接码无效或已过期，请重新获取。") : t("配对申请结果待确认，请核对上次申请。") : !remaining ? t("配对码已过期，请扫描新的限时连接码。") : status.awaitingApproval ? t("等待已配对设备确认…") : t("正在连接主机…")}</span></div>
      {statusError && <p className="error-text" role="alert">{statusError}</p>}
      {displayedError && <p ref={failure} role="alert" className="error-text">{displayedError}</p>}
      {displayedError && diagnostic && <details className="pairing-options pairing-diagnostic"><summary>{t("技术诊断")}</summary><p className="muted">{t("诊断码：{0}", diagnostic)}</p></details>}
      <button className="secondary full" disabled={busy || status.status === "connecting"} onClick={() => { clearError(); setRouteFailure(undefined); completing.current = false; connection?.resume(true); }}>{t("重新检查连接")}</button>
      {!pending.code && pending.request && <button className="primary full" disabled={busy} onClick={() => void submitPending()}>{busy ? t("正在核对申请…") : t("核对上次申请")}</button>}
      {((!!pending.code && !remaining) || ["pairing_invite_invalid", "pairing_invite_expired", "pairing_invite_used", "pairing_invite_required"].includes(requestError ?? "")) && <>
        <button className="secondary full" disabled={busy} onClick={() => { setInputMode("scan"); setScan(true); }}>{t("扫描新的连接码")}</button>
        <button className="secondary full" disabled={busy} onClick={() => { setInputMode("text"); setScan(true); }}>{t("粘贴连接信息")}</button>
      </>}
      {/* Pairing another host never cancels or renews this request. The desktop
          network-join journey keeps its own guided steps. */}
      {!joiningDesktop && <button className="secondary full" disabled={busy} onClick={startAnother}>{t("连接其他主机")}</button>}
      {!pending.code && requestError && <p className="settings-note">{t("若主机地址也已改变，请先在下方「无法连接？更新主机地址」更新线路。")}</p>}
      {pending.code && <details className="pairing-options"><summary>{t("其他确认方式")}</summary>
        {remaining > 0 && identity?.hubPublicKey && <Suspense fallback={null}><PairingCode payload={{ v: 1, kind: "approve", code: pending.code, hubPublicKey: identity.hubPublicKey }}/></Suspense>}
        <p className="muted">{t("也可以用已配对手机扫描此码，核对后点「确认配对」。")}</p>
        <p className="muted">{t("CLI 主机也支持手机确认；没有已配对设备时，可在主机终端运行 tarobot devices approve 加上上方的配对码。")}</p>
      </details>}
      {connection && <details className="pairing-options"><summary>{t("无法连接？更新主机地址")}</summary><Suspense fallback={null}><RepairHostRoute connection={connection} online={status.status === "online"} busyChange={setBusy}/></Suspense>{manage && <button type="button" disabled={busy} onClick={manage}>{t("设备与网络")}</button>}</details>}
    </section> : <>
      {/* New users look for the QR code here; say where it comes from in the eye line, not only in the side guide. */}
      {!reviewing && !fromBrowserLink && <div className="pairing-qr-source" role="note"><Smartphone size={20} aria-hidden="true"/><div>
        <strong>{t("先在已连接的手机或电脑上打开「设备与网络 → 添加设备」")}</strong>
        <p>{t("那里会显示连接二维码，用下方「扫描连接二维码」扫它；也可以复制那里的连接信息，点「粘贴连接信息」。")}</p>
      </div></div>}
      {/* A repeated identical refusal leaves `error` unchanged, so the effect
          above stays quiet: reveal the message after every attempt as well. */}
      <form className={reviewing ? "pairing-review" : undefined} onSubmit={(e) => { void pair(e).then(revealFailure); }}>
        {/* Phone review step: the entry points give way to the summary below;
            "Change connection details" reopens the same scanner dialog. */}
        {!reviewing && !fromBrowserLink && <div className="pairing-import-actions">
        <button type="button" className="primary full" disabled={busy} onClick={() => { setInputMode("text"); setScan(true); }}><ClipboardPaste size={18}/>{t("粘贴连接信息")}</button>
        <button type="button" className="pairing-scan full" disabled={busy} onClick={() => { setInputMode("image"); setScan(true); }}><ImagePlus size={18}/>{t("导入二维码图片")}</button>
        <button type="button" className="pairing-scan full" disabled={busy} onClick={(event) => { event.currentTarget.focus(); setInputMode("scan"); setScan(true); }}><QrCode size={20} aria-hidden="true"/>{t("扫描连接二维码")}</button>
        </div>}
        {expectedKey && <div className="pairing-import" role="status"><Monitor size={18}/><div><strong>{fromBrowserLink ? t("已读取浏览器配对链接") : t("已读取主机信息")}</strong><p className="muted">{importedDirects.length > 1 ? t("{0} 等 {1} 个候选地址{2}", directHost || address, importedDirects.length, relays.length ? t(" + 中转") : "") : routeSummary}</p>{(reviewing || fromBrowserLink) && <p className="pairing-import-state">{fromBrowserLink ? t("点击下方「配对此设备」，再在已配对设备上确认 8 位配对码。") : t("尚未连接，请继续完成下方配对。")}</p>}</div><button type="button" disabled={busy} onClick={() => { setInputMode("text"); setScan(true); }}>{t("更换连接信息")}</button></div>}
        {existingStatus && <div className="pairing-existing-host" role="status"><p>{existingStatus === "revoked" ? t("此浏览器在该主机上的旧授权已失效。请先在「此设备的连接」中移除旧连接，再点击下方「配对此设备」。") : t("此浏览器已配对这台主机。如需重新配对，请先在「此设备的连接」中移除旧连接，或返回会话继续使用。")}</p>{manageConnections && <button type="button" className="secondary" disabled={busy} onClick={manageConnections}>{t("打开此设备的连接")}</button>}</div>}
        {!reviewing && routeHint}
        {(manual || expectedKey) && <>
          <label>{t("设备名称")}<input value={name} required maxLength={100} disabled={busy} aria-describedby="pairing-device-name-help" onChange={(e) => setName(e.target.value)}/></label><p id="pairing-device-name-help" className="settings-note muted">{t("确认一个其他设备也能认出的名称，例如 MacBook Pro 或 vivo 手机。")}</p>
          <details className="pairing-options" open={manual} onToggle={(e) => setManual(e.currentTarget.open)}><summary>{t("手动连接与高级选项")}</summary>
            {save && <label>{t("主机名称")}<input value={hostName} required maxLength={100} disabled={busy} onChange={(e) => setHostName(e.target.value)}/></label>}
            <label>{t("Hub 地址")}<input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} value={address} placeholder="https://192.168.1.100:8788" onChange={(e) => { setFromBrowserLink(false); setAddress(e.target.value); }}/></label>
            {usesPinnedTransport() && !expectedKey && <label>{t("主机身份公钥")}<input disabled={busy} value={manualKey} maxLength={120} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setManualKey(e.target.value)} placeholder="MCowBQYDK2VwAyEA…"/></label>}
            <details className="pairing-options" open={optionsOpen} onToggle={(e) => setOptionsOpen(e.currentTarget.open)}><summary>{t("连接选项与备用中转（可选）")}</summary>{optionsOpen && <Suspense fallback={null}><PairingRouteOptions relays={relays} busy={busy} setRelays={setRelays}/></Suspense>}</details>
          </details>
          {reviewing && <p id="pairing-next-help" className="pairing-next-hint">{t("之后会显示 8 位配对码，需在已连接的手机或电脑上确认，才会完成连接。")}</p>}
          <button ref={pairButton} className="primary full" disabled={busy} aria-describedby={reviewing ? "pairing-next-help" : undefined}>{busy ? <LoaderCircle className="spin" size={17}/> : <ShieldCheck size={17}/>}{busy ? t("正在请求连接…") : reviewing ? t("下一步：配对此设备") : t("配对此设备")}</button>
        </>}
        {!manual && !expectedKey && <button type="button" className="pairing-manual full" disabled={busy} onClick={() => setManual(true)}>{t("手动连接与高级选项")}</button>}
      </form>
    </>}
    {!pending && displayedError && <p ref={failure} role="alert" className="error-text">{displayedError}</p>}
    {!pending && displayedError && diagnostic && <details className="pairing-options pairing-diagnostic"><summary>{t("技术诊断")}</summary><p className="muted">{t("诊断码：{0}", diagnostic)}</p></details>}
    {!pending && reviewing && !displayedError && routeHint}
    <footer><ShieldCheck size={13} aria-hidden="true"/>{t("只有经过你确认的设备才能访问 Bot。")}</footer>
  </div>{!pending && <PairingIntro/>}</div>
  {scan && <Suspense fallback={null}><PairingScanner initialMode={inputMode} close={() => setScan(false)} receive={(payload) => {
    if (payload.kind !== "connect") throw new Error(t("请扫描已信任设备显示的 Hub 二维码"));
    if (!payload.invite) throw new Error(pairingInviteError("invite_required"));
    const pendingConnection = connection;
    if (pending && identity && pendingConnection) {
      renewPendingConnection(pendingConnection, pending, payload);
      return;
    }
    imported.current = true;
    setFromBrowserLink(false);
    const directRoutes = payload.routes.filter(isDirectRoute);
    setInvite(payload.invite);
    setDeployment(payload.deployment); setImportedRoutes(payload.routes); setImportedDirects(directRoutes); setLegacyDirect(directRoutes[0]); setAddress(directRoutes[0]?.url ?? ""); setRelays(payload.routes.filter(isRelayRoute)); setExpectedKey(payload.hubPublicKey); setManual(false); setOptionsOpen(false); clearError(); setRouteFailure(undefined);
  }}/></Suspense>}</main>;
}

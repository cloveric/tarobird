import { WidgetStateSession, restoredWidgetState, widgetStateFailed, subscribeWidgetStateOwners, widgetStateOwnerRetiring } from "./widget-state-lifecycle.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { Capacitor } from "@capacitor/core";
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { isDesktop, isElectron } from "./desktop-bridge.js";
import type { Widget as WidgetData } from "../../src/client-protocol/widget.js";
import { widgetDocument, widgetTheme } from "./widget-document.js";
import { useMessageReader } from "./message-overlay.js";
import { useBackAction } from "./back-navigation.js";
import { t, useLocale } from "./i18n.js";
import "./widget.css";
import { WidgetComposeContext, widgetComposeText } from "./widget-compose.js";
import { widgetDiagnostic, widgetRepairDraft } from "./widget-repair.js";
import widgetRuntime from "virtual:widget-runtime";
import { widgetFingerprint, widgetStopReason, stopWidget, retryWidget, type WidgetStopReason } from "./widget-quarantine.js";

const subscribeVisibility = (notify: () => void) => { document.addEventListener("visibilitychange", notify); return () => document.removeEventListener("visibilitychange", notify); };
const pageVisible = () => document.visibilityState !== "hidden";

export function Widget({ widget, instanceKey = "0", showHeader = true, onReady, onRenderError }: { widget: WidgetData; instanceKey?: string; showHeader?: boolean; onReady?: () => void; onRenderError?: () => void }) {
  useLocale();
  let supported = true;
  if (Capacitor.isNativePlatform()) {
    supported = !!document.querySelector('meta[name="tarobot-widget-guard"][content="1"]');
    if (["android", "ios"].includes(Capacitor.getPlatform())) {
      try { supported &&= (window as unknown as { tarobotWidgetIsolation?: { supported(): boolean } }).tarobotWidgetIsolation?.supported() === true; } catch { supported = false; }
    }
  }
  return supported ? <InteractiveWidget widget={widget} instanceKey={instanceKey} showHeader={showHeader} onReady={onReady} onRenderError={onRenderError}/> : <section className="widget-unavailable" aria-label={widget.title}>{showHeader && <strong>{widget.title}</strong>}<p>{widget.summary}</p><small>{t("当前版本不支持交互组件，请更新 App 或系统后重试。")}</small></section>;
}
function InteractiveWidget({ widget, instanceKey, showHeader, onReady, onRenderError }: { widget: WidgetData; instanceKey: string; showHeader: boolean; onReady?: () => void; onRenderError?: () => void }) {
  useLocale();
  const interaction = useContext(WidgetComposeContext);
  const compose = interaction?.compose;
  const scope = interaction ? `${interaction.scope}:${instanceKey}` : undefined;
  const owner = interaction?.owner ?? "standalone";
  const authorized = interaction?.active !== false;
  const ownerRetiring = useSyncExternalStore(subscribeWidgetStateOwners, () => widgetStateOwnerRetiring(owner));
  const composeRef = useRef(compose); composeRef.current = compose;
  const [stateWarning, setStateWarning] = useState(false);
  const lease = useRef<WidgetStateSession | undefined>(undefined);
  const [runtime, setRuntime] = useState<{ key: string; widget: WidgetData; scope?: string; fingerprint: string; attempt: number; owner: string }>();
  const [composed, setComposed] = useState<boolean>();
  const [repairAccepted, setRepairAccepted] = useState(false);
  const repairPending = useRef(false);
  useEffect(() => {
    if (composed === undefined) return;
    const timer = setTimeout(() => setComposed(undefined), 5000);
    return () => clearTimeout(timer);
  }, [composed]);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(320);
  const [inlineHeight, setInlineHeight] = useState<number>();
  const container = useRef<HTMLElement>(null);
  const [ready, setReady] = useState(false);
  const readyCallback = useRef({ onReady, onRenderError, html: widget.html }); readyCallback.current = { onReady, onRenderError, html: widget.html };
  const [runtimeRetiring, setRuntimeRetiring] = useState(false);
  const [error, setError] = useState<"loading" | "warning" | "runtime">();
  const [diagnostic, setDiagnostic] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { repairPending.current = false; setRepairAccepted(false); }, [scope, widget.html, attempt]);
  const [identity, setIdentity] = useState<{html: string; hash: string}>();
  const [stopped, setStopped] = useState<WidgetStopReason>();
  const fingerprint = identity?.html === widget.html ? identity.hash : undefined;
  useEffect(() => {
    let current = true; setStopped(undefined);
    void widgetFingerprint(widget.html).then(hash => { if (current) { setStopped(widgetStopReason(hash)); setIdentity({html: widget.html, hash}); } }).catch(() => { if (current) setError("runtime"); });
    return () => { current = false; };
  }, [widget.html]);
  const [summaryOpen, setSummaryOpen] = useState(false);
  useEffect(() => { setError(undefined); setDiagnostic(undefined); setComposed(undefined); }, [widget.html]);
  const frame = useRef<HTMLIFrameElement>(null), panel = useRef<HTMLDialogElement>(null), expand = useRef<HTMLButtonElement>(null);
  const source = isElectron() ? "tarobot-widget://sandbox/widget-sandbox.html" : isDesktop() ? navigator.userAgent.includes("Windows") ? "http://widget.localhost/widget-sandbox.html" : "widget://localhost/widget-sandbox.html" : new URL("widget-sandbox.html", document.baseURI).href;
  const active = useContext(RuntimeHostActiveContext);
  const visiblePage = useSyncExternalStore(subscribeVisibility, pageVisible);
  const [inViewport, setInViewport] = useState(false);
  // Virtualized rows include overscan and hidden workspaces retain their drafts.
  // Neither is a reason to keep executing guest timers, animations or scripts.
  useEffect(() => {
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(entries => {
      // A scroll/layout change can queue both entering and leaving in one
      // delivery. Only the newest observation describes whether to keep running.
      const entry = entries.at(-1);
      if (entry) {
        clearTimeout(leaveTimer);
        const intersects = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
        if (intersects) setInViewport(true);
        // Brief layout compensation/rotation is not an intent to leave. Only
        // geometric exit is debounced; permission/page/Host loss stays immediate.
        else leaveTimer = setTimeout(() => setInViewport(false), 150);
      }
      // An edge-touching target intersects with zero area. With only the 0
      // threshold, scrolling it into view would deliver no newer observation.
    }, { threshold: [0, 0.01] });
    if (container.current) observer.observe(container.current);
    return () => { clearTimeout(leaveTimer); observer.disconnect(); };
  }, []);
  // Repeated failures retire timers and handlers. An incidental error can
  // leave a useful report interactive; a loading timeout can still recover.
  const shouldRun = !!fingerprint && !stopped && authorized && !ownerRetiring && active && visiblePage && (inViewport || expanded) && error !== "runtime";
  const running = !!runtime, key = runtime?.key ?? "";
  // Retain a virtual row until the final state ACK, not just while expanded.
  // Removing/reparenting an iframe destroys its browsing context immediately.
  useMessageReader(running || active && expanded);
  useLayoutEffect(() => {
    if (runtime) {
      if (!shouldRun || runtime.widget.html !== widget.html || runtime.scope !== scope || runtime.attempt !== attempt || runtime.owner !== owner) {
        setRuntimeRetiring(true);
        if (!authorized || stopped || error === "runtime") lease.current?.discard();
        else void lease.current?.retire();
      }
    } else if (shouldRun && fingerprint) setRuntime({ key: crypto.randomUUID(), widget, scope, fingerprint, attempt, owner });
  }, [runtime, shouldRun, widget, scope, fingerprint, attempt, owner, stopped, error, authorized]);
  useEffect(() => { if (!active || !authorized) setExpanded(false); }, [active, authorized]);
  const close = () => setExpanded(false);
  useBackAction(panel, () => { if (!expanded) return false; close(); }, 210);
  const wasExpanded = useRef(false);
  useLayoutEffect(() => {
    const dialog = panel.current!;
    const closing = wasExpanded.current && !expanded;
    wasExpanded.current = expanded;
    dialog.close();
    if (expanded) dialog.showModal();
    else {
      dialog.setAttribute("open", "");
      if (closing) expand.current?.focus({ preventScroll: true });
    }
  }, [expanded]);
  const lastTheme = useRef("");
  const initialized = useRef("");
  const initialize = () => {
    const session = lease.current;
    if (!runtime || !frame.current || !session || session.retiring || initialized.current === key) return;
    initialized.current = key;
    const theme = widgetTheme(container.current ?? document.documentElement);
    lastTheme.current = JSON.stringify(theme);
    void restoredWidgetState(runtime.scope, runtime.fingerprint, session).then(state => {
      if (session.retiring || lease.current !== session || !frame.current) return;
      setStateWarning(widgetStateFailed(runtime.scope, runtime.fingerprint));
      session.markInitialized();
      frame.current.contentWindow?.postMessage({ type: "tarobot-widget-init", key, title: runtime.widget.title, document: widgetDocument(runtime.widget, key, theme, widgetRuntime, state) }, "*");
    });
  };
  useLayoutEffect(() => {
    if (!runtime || !frame.current?.contentWindow) return;
    let mounted = true, readyBlocked = false;
    let session: WidgetStateSession;
    try {
      session = new WidgetStateSession({ owner: runtime.owner, scope: runtime.scope, hash: runtime.fingerprint, source: frame.current.contentWindow, key,
        done: () => { if (mounted) { setStateWarning(widgetStateFailed(runtime.scope, runtime.fingerprint)); setRuntime(previous => previous?.key === key ? undefined : previous); } } });
    } catch { setError("runtime"); setRuntime(undefined); return; }
    lease.current = session;
    setReady(false); setError(undefined); setDiagnostic(undefined); setRuntimeRetiring(false);
    const timer = setTimeout(() => { setError(previous => previous ?? "loading"); setSummaryOpen(true); }, 8000);
    let previousHeight = 0, previousDelta = 0, repeatedGrowth = 0, reportedAt = 0;
    let recentHeights: { height: number; at: number }[] = [];
    // Replies are idempotent for this exact frame lifetime. Never let a replay
    // duplicate an insertion, including after the composer received focus.
    const composeResults = new Map<string, boolean>();
    let composedAt = -Infinity;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== "object") return;
      const data = event.data;
      if (data.type === "tarobot-widget-shell-ready") { initialize(); return; }
      if (data.key !== key) return;
      if (data.type === "tarobot-widget-state") {
        setStateWarning(widgetStateFailed(runtime.scope, runtime.fingerprint));
        return;
      }
      if (data.type === "tarobot-widget-compose") {
        if (typeof data.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(data.id)) return;
        let accepted = composeResults.get(data.id);
        if (accepted === undefined) {
          const rect = frame.current?.getBoundingClientRect(), text = widgetComposeText(data.text);
          const visible = rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
          accepted = false;
          if (!session.retiring && composeResults.size < 64 && performance.now() - composedAt > 500 && text && visible &&
              document.visibilityState !== "hidden" && document.activeElement === frame.current) {
            try { accepted = composeRef.current?.(text) === true; } catch { /* Draft remains unchanged on refusal. */ }
          }
          if (composeResults.size < 64) composeResults.set(data.id, accepted);
          if (accepted) { composedAt = performance.now(); setExpanded(false); }
          setComposed(accepted);
        }
        frame.current?.contentWindow?.postMessage({ type: "tarobot-widget-compose-result", key, id: data.id, accepted }, "*");
        return;
      }
      if (data.type === "tarobot-widget-ready") {
        setReady(true); clearTimeout(timer);
        if (active && authorized && !session.retiring && !ownerRetiring && !readyBlocked && runtime.widget.html === readyCallback.current.html) readyCallback.current.onReady?.();
        setError(previous => previous === "loading" ? undefined : previous);
      }
      if (data.type === "tarobot-widget-error") {
        // Even one startup exception can leave an incomplete candidate. Keep the
        // normal warning UI, but do not certify this render as a successful update.
        readyBlocked = true;
        if (active && authorized && !session.retiring && !ownerRetiring && runtime.widget.html === readyCallback.current.html) readyCallback.current.onRenderError?.();
        const detail = widgetDiagnostic(data.detail); if (detail) setDiagnostic(detail);
        setError(data.persistent === true ? "runtime" : "warning"); setSummaryOpen(true); clearTimeout(timer);
        if (data.persistent === true && data.reason !== "unsupported") {
          const reason: WidgetStopReason = data.reason === "cpu" || data.reason === "limit" ? data.reason : "error";
          stopWidget(runtime.fingerprint, reason); setStopped(reason);
        }
      }
      // This message only dismisses this widget's reader; it never dispatches
      // application-wide back actions or exposes any host/native authority.
      if (data.type === "tarobot-widget-close" && panel.current?.matches(":modal") && document.activeElement === frame.current) close();
      if (data.type === "tarobot-widget-height" && Number.isFinite(data.height)) {
        const next = Math.max(80, Math.min(720, data.height)), now = performance.now(), delta = next - previousHeight;
        // A vh/percentage-height guest can add the same body padding each time
        // its parent grows. Stop rapid feedback; content remains scrollable.
        repeatedGrowth = delta > 0 && delta === previousDelta && now - reportedAt < 250 ? repeatedGrowth + 1 : 0;
        previousHeight = next; previousDelta = delta; reportedAt = now;
        recentHeights = recentHeights.filter(item => now - item.at < 500).slice(-7);
        recentHeights.push({ height: next, at: now });
        // max-height media queries can alternate between two sizes forever.
        // Hold the larger reading area; later content/user changes still resize.
        const cycling = recentHeights.length >= 6 && recentHeights.filter(item => item.height === next).length >= 3;
        if (cycling) setHeight(Math.max(...recentHeights.map(item => item.height)));
        else if (repeatedGrowth < 3) setHeight(next);
      }
    };
    const theme = () => {
      const values = widgetTheme(container.current ?? document.documentElement), serialized = JSON.stringify(values);
      if (serialized === lastTheme.current) return;
      lastTheme.current = serialized;
      frame.current?.contentWindow?.postMessage({ type: "tarobot-widget-theme", key, theme: values }, "*");
    };
    const observer = new MutationObserver(theme); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "data-mono-accent", "style", "class"] });
    const board = container.current?.closest(".adhd-grid");
    if (board) observer.observe(board, { attributes: true, attributeFilter: ["style"] });
    const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", theme);
    window.addEventListener("message", receive);
    // The lease did not exist when the earlier lifecycle effect ran. Recheck
    // this same commit instead of letting an already-hidden frame initialize.
    if (!shouldRun) {
      setRuntimeRetiring(true);
      if (!authorized || stopped || error === "runtime") session.discard();
      else void session.retire();
    }
    return () => { mounted = false; session.discard(); if (lease.current === session) lease.current = undefined; clearTimeout(timer); observer.disconnect(); media.removeEventListener("change", theme); window.removeEventListener("message", receive); };
  }, [key, runtime]);
  const retry = () => { if (fingerprint) retryWidget(fingerprint); setStopped(undefined); setError(undefined); setDiagnostic(undefined); setAttempt(n => n + 1); expand.current?.focus({ preventScroll: true }); };
  const problem = stopped === "cpu" ? t("组件运行时间过长，已停止。重新加载后才会再次运行。") : stopped === "limit" ? t("组件内容更新过多，已停止。文字摘要仍可阅读。") : t("组件未能完整运行，文字摘要仍可阅读。");
  return <section ref={container} className="inline-widget" aria-label={widget.title} style={{ minHeight: expanded ? inlineHeight : undefined }}>
    <dialog ref={panel} role={expanded ? "dialog" : "group"} aria-modal={expanded || undefined} aria-label={widget.title} className={`widget-panel${expanded ? " widget-expanded" : ""}`} onCancel={event => { event.preventDefault(); close(); }}>
      {showHeader && <header className="widget-header"><strong>{widget.title}</strong><div>
        {(error || stopped) && <button aria-label={t("重新加载组件")} title={t("重新加载组件")} onClick={retry}><RotateCcw size={16}/></button>}
        <button ref={expand} disabled={!authorized} aria-label={expanded ? t("收起交互组件") : t("放大交互组件")} title={expanded ? t("收起交互组件") : t("放大交互组件")} className="widget-expand-button" onClick={() => { if (!expanded) setInlineHeight(container.current?.getBoundingClientRect().height); setExpanded(value => !value); }}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}<span>{expanded ? t("收起") : t("放大")}</span></button>
      </div></header>}
      {running ? <iframe key={key} ref={frame} title={widget.title} src={source} onLoad={initialize} inert={!ready || runtimeRetiring || ownerRetiring || !authorized || !active || undefined} aria-busy={!ready || runtimeRetiring || ownerRetiring || undefined} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={{ height: expanded ? "100%" : height, pointerEvents: !ready || runtimeRetiring || ownerRetiring || !authorized || !active ? "none" : undefined }}/> : <div aria-hidden="true" style={{ height: !authorized || error === "runtime" || stopped ? 0 : expanded ? "100%" : height }}/>}
      <div className="widget-footer">
        {!authorized && <p className="widget-status" role="status">{t("当前对话为只读，交互组件仅显示文字摘要。")}</p>}
        {authorized && (runtimeRetiring || ownerRetiring) && running && <p className="widget-status" role="status">{t("正在保存组件设置…")}</p>}
        {stateWarning && <p className="widget-status" role="status">{t("组件未能确认最新状态，部分设置可能需要重新选择。")}</p>}
        {composed !== undefined && <p className="widget-status" role="status">{composed ? t("已填入输入框，未自动发送。") : t("未能填入输入框，草稿未改动。")}</p>}
        {(error || stopped) ? <div className="widget-problem"><p className="widget-status" role="status">{problem}</p>
          {!showHeader && <button type="button" className="widget-repair" onClick={retry}><RotateCcw size={16}/>{t("重新加载组件")}</button>}
          {(stopped || error === "warning" || error === "runtime") && compose && <button className="widget-repair" type="button" disabled={!active || !authorized || repairAccepted} onClick={() => {
            if (repairPending.current) return; repairPending.current = true;
            let accepted = false;
            try { accepted = composeRef.current?.(widgetRepairDraft(widget.title, problem, diagnostic)) === true; } catch { /* Keep the original draft. */ }
            repairPending.current = accepted; setRepairAccepted(accepted);
            setComposed(accepted); if (accepted) setExpanded(false);
          }}>{t("把问题填入输入框")}</button>}
          {diagnostic && <details className="widget-diagnostic"><summary>{t("诊断信息")}</summary><p>{diagnostic}</p></details>}
        </div> : running && !ready ? <p className="widget-status" role="status">{t("正在加载交互组件…")}</p> : null}
        <details className="widget-summary" open={!authorized || summaryOpen || !!stopped} onToggle={event => setSummaryOpen(event.currentTarget.open)}><summary>{t("文字摘要")}</summary><p>{widget.summary}</p></details>
      </div>
    </dialog>
  </section>;
}

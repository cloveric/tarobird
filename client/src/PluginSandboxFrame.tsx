import { useCanvasNodeConsent } from "./CanvasNodeConsent.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PLUGIN_HOST_PROTOCOL } from "../../src/client-protocol/plugins.js";
import {
  isPinnedCanvas,
  OFFICIAL_PLUGIN_CATALOG,
  type InstalledPluginRecord,
  type PluginRegistry,
} from "./plugin-registry.js";
import type { HubConnection } from "./connection.js";
import { createPluginSensitiveActionGate } from "./plugin-sensitive-action.js";
import { exportAttachment } from "./attachment-export.js";
import { t, useLocale } from "./i18n.js";
import {
  handlePluginHostMessage,
  isPluginSandboxSupported,
  resolvePluginSandboxSrc,
  resolvePluginTheme,
  wrapSandboxedDocument,
  type CanvasAgentBridgeAdapter,
} from "./plugin-sandbox-runtime.js";

export { handlePluginHostMessage, isPluginSandboxSupported } from "./plugin-sandbox-runtime.js";

/** Until arbitrary HTML has an independently verified runtime, only the known
 * reviewed artifacts may be executable. Folder imports receive no guest frame.
 * Today that is the two built-in SHA-256-pinned plugins, in desktop Chromium and
 * Electron only. This gate is the only barrier: a child frame the guest creates
 * runs in an unpatched realm, and WebRTC to a TURN server has not been proven
 * blocked. Before admitting any other HTML plugin, add an Electron WebRTC
 * policy, refuse guest frame creation and run a real TURN probe. */
function isReviewedPlugin(plugin: InstalledPluginRecord): boolean {
  if (isPinnedCanvas(plugin)) return true;
  return plugin.enabled && plugin.sourceKind === "official" && OFFICIAL_PLUGIN_CATALOG.some(entry =>
    entry.bundleHtml !== undefined && entry.bundleHtml === plugin.bundleHtml
    && JSON.stringify(entry.manifest) === JSON.stringify(plugin.manifest));
}

type DomainPromptState = {
  domain: string;
  reason?: string;
  resolve: (result: { granted: boolean; domain?: string; grantedDomains?: string[] }) => void;
};

/** Isolated iframe runtime for an installed plugin. Loads the runtime-appropriate
 * `plugin-sandbox.html` shell inside `sandbox="allow-scripts"` WITHOUT `allow-same-origin`
 * (unique opaque origin) and injects a per-plugin CSP scoped strictly to validated
 * `grantedDomains`, so the plugin cannot access App tokens, cookies, IndexedDB,
 * localStorage, native bridges, or the Hub API. */
export function PluginSandboxFrame({
  plugin,
  title,
  registry,
  connection,
  conversationId,
  windowId,
  tabId,
}: {
  plugin: InstalledPluginRecord;
  title?: string;
  registry: PluginRegistry;
  connection?: HubConnection;
  conversationId?: string;
  windowId?: string;
  tabId?: string;
}) {
  const activeRegistry = registry;
  const locale = useLocale();
  const supported = isPluginSandboxSupported();
  const admitted = supported && isReviewedPlugin(plugin);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [domainPrompt, setDomainPrompt] = useState<DomainPromptState | null>(null);
  const domainPromptRef = useRef<DomainPromptState | null>(null);
  domainPromptRef.current = domainPrompt;

  const frameTitle = title ?? (locale === "zh" ? plugin.manifest.nameZh ?? plugin.manifest.name : plugin.manifest.name);
  const grantedDomainsKey = plugin.grantedDomains.join(",");
  const bundleReady = plugin.bundleHtml.length > 0;
  const frameKey = `${activeRegistry.getScopeId()}:${plugin.grantedCapabilities.join(",")}:${plugin.manifest.id}:${plugin.manifest.version}:${plugin.manifest.artifact.sha256}:${plugin.installedAt}:${grantedDomainsKey}:${bundleReady ? "1" : "0"}`;
  const nodeConsent = useCanvasNodeConsent(frameKey);
  const sensitiveActions = useMemo(() => createPluginSensitiveActionGate(), [frameKey]);
  useLayoutEffect(() => () => sensitiveActions.cancel(), [sensitiveActions]);
  const sandboxSrc = resolvePluginSandboxSrc();
  const wrappedDoc = useMemo(
    () => (admitted && bundleReady ? wrapSandboxedDocument(plugin.bundleHtml, isPinnedCanvas(plugin) ? [] : plugin.grantedDomains) : ""),
    [admitted, bundleReady, plugin],
  );

  const initializedKeyRef = useRef<string>("");
  const latestInitRef = useRef({ title: frameTitle, document: wrappedDoc });
  latestInitRef.current = { title: frameTitle, document: wrappedDoc };

  const latestContextRef = useRef({
    pluginId: plugin.manifest.id,
    registry: activeRegistry,
    grantedCapabilities: plugin.grantedCapabilities,
    grantedDomains: plugin.grantedDomains,
    locale,
  });
  latestContextRef.current = {
    pluginId: plugin.manifest.id,
    registry: activeRegistry,
    grantedCapabilities: plugin.grantedCapabilities,
    grantedDomains: plugin.grantedDomains,
    locale,
  };

  const initialize = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || !latestInitRef.current.document || initializedKeyRef.current === frameKey) return;
    initializedKeyRef.current = frameKey;
    frameWindow.postMessage(
      {
        type: "tarobird-plugin-init",
        title: latestInitRef.current.title,
        document: latestInitRef.current.document,
      },
      "*",
    );
  }, [frameKey]);

  const canvasAgentClients = useMemo(() => new Map<string, Window>(), [connection, conversationId, windowId, tabId, frameKey]);
  const canvasAgent = useMemo<CanvasAgentBridgeAdapter | undefined>(() => {
    if (!isPinnedCanvas(plugin) || !connection || !conversationId || !windowId || !tabId || !plugin.grantedCapabilities.includes("canvas.agent")) {
      return undefined;
    }
    const isCurrent = (frame: Window) =>
      iframeRef.current?.contentWindow === frame && activeRegistry.isActive(plugin);
    const assertClient = (clientId: string) => {
      const frame = canvasAgentClients.get(clientId);
      if (!frame || !isCurrent(frame)) throw new Error("canvas_agent_offline");
    };
    return {
      async connect(clientId) {
        const frame = iframeRef.current?.contentWindow;
        if (!frame || !isCurrent(frame)) throw new Error("canvas_agent_offline");
        if (canvasAgentClients.has(clientId)) throw new Error("canvas_agent_already_attached");
        // Record the attachment before token issuance so iframe cleanup can
        // cancel an in-flight attach as well as an already connected one.
        canvasAgentClients.set(clientId, frame);
        let attachedHere = false;
        try {
          const attached = await connection.canvasAgentAttach(conversationId, windowId, tabId, clientId, event => {
            if (canvasAgentClients.get(clientId) !== frame || !isCurrent(frame)) return;
            if (event.event === "closed") canvasAgentClients.delete(clientId);
            frame.postMessage({
              protocol: PLUGIN_HOST_PROTOCOL,
              type: `canvas.agent.${event.event}`,
              clientId,
              ...(event.data ?? {}),
            }, "*");
          });
          attachedHere = true;
          assertClient(clientId);
          return { connected: true, protocolVersion: attached.protocolVersion, conversationId: attached.conversationId };
        } catch (error) {
          if (canvasAgentClients.get(clientId) === frame) {
            canvasAgentClients.delete(clientId);
            if (attachedHere) void connection.canvasAgentDetach(clientId, true).catch(() => undefined);
          }
          throw error;
        }
      },
      async disconnect(clientId) {
        assertClient(clientId);
        canvasAgentClients.delete(clientId);
        return connection.canvasAgentDetach(clientId, true);
      },
      async sendState(clientId, snapshot) {
        assertClient(clientId);
        const response = await connection.canvasAgentRequest(clientId, "state", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshot }),
        });
        return response.ok;
      },
      async activate(clientId) {
        assertClient(clientId);
        return (await connection.canvasAgentRequest(clientId, "activate", { method: "POST" })).ok;
      },
      async sendResult(clientId, requestId, payload) {
        assertClient(clientId);
        const response = await connection.canvasAgentRequest(clientId, "result", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, ...payload }),
        });
        return response.ok;
      },
    };
  }, [connection, conversationId, windowId, tabId, plugin, activeRegistry, canvasAgentClients]);

  useLayoutEffect(() => () => {
    for (const clientId of canvasAgentClients.keys()) {
      void connection?.canvasAgentDetach(clientId, true).catch(() => undefined);
    }
    canvasAgentClients.clear();
  }, [connection, canvasAgentClients]);

  // Cancel any pending domain confirmation modal if the frame unmounts.
  useEffect(() => () => {
    if (domainPromptRef.current) {
      domainPromptRef.current.resolve({ granted: false });
      domainPromptRef.current = null;
    }
  }, []);

  // Push live locale/theme/domain context updates to the guest without reloading the iframe.
  useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || initializedKeyRef.current !== frameKey) return;
    frameWindow.postMessage(
      {
        protocol: PLUGIN_HOST_PROTOCOL,
        type: "host.context",
        theme: resolvePluginTheme(),
        locale,
        grantedDomains: [...plugin.grantedDomains],
      },
      "*",
    );
  }, [locale, frameKey, plugin.grantedDomains]);

  useLayoutEffect(() => {
    if (!admitted || !bundleReady || activeRegistry.getPlugin(plugin.manifest.id) !== plugin) return;
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).type === "tarobird-plugin-shell-ready") {
        initialize();
        return;
      }
      const ctx = latestContextRef.current;
      if (!ctx.registry.isActive(plugin)) return;
      const scopeId = ctx.registry.getScopeId();
      const isActive = () => iframeRef.current?.contentWindow === frameWindow && ctx.registry.isActive(plugin);
      const dispatch = () => handlePluginHostMessage(event.data, {
        pluginId: ctx.pluginId,
        scopeId,
        officialBundledCanvas: ctx.registry.isActive(plugin) && isPinnedCanvas(plugin),
        declaredDomains: plugin.manifest.domains,
        confirmNode: nodeConsent.confirm,
        active: isActive,
        runSensitiveAction: (action, run) => sensitiveActions.run(frameTitle, action, run, () => isActive() && !!iframeRef.current?.getClientRects().length),
        grantedCapabilities: ctx.grantedCapabilities,
        grantedDomains: ctx.grantedDomains,
        theme: resolvePluginTheme(),
        locale: ctx.locale,
        storage: ctx.registry.storage,
        kvStore: ctx.registry.kvStore,
        credentialVault: ctx.registry.credentialVault,
        exportWorkspace: async (filename, content, mime) => {
          const blob = new Blob([typeof content === "string" ? content : new Uint8Array(content)], { type: mime ?? "application/json" });
          return exportAttachment(blob, filename);
        },
        requestDomain: (domain, reason) => new Promise((resolve) => {
          if (domainPromptRef.current) {
            domainPromptRef.current.resolve({ granted: false });
          }
          setDomainPrompt({ domain, reason, resolve });
        }),
        canvasAgent,
      });
      const method = event.data?.method;
      const operation = typeof method === "string" && /^(?:storage\.|credentials\.|canvas\.(?:data|nodes)\.)/.test(method)
        ? ctx.registry.runStorageOperation(plugin, dispatch)
        : dispatch();
      void operation
        .then((response) => {
          if (response && iframeRef.current?.contentWindow === frameWindow && ctx.registry.isActive(plugin)) {
            frameWindow.postMessage(response, "*");
          }
        })
        .catch(() => {
          const raw = event.data as Record<string, unknown> | null;
          if (raw && typeof raw === "object" && raw.protocol === PLUGIN_HOST_PROTOCOL && typeof raw.id === "string" && iframeRef.current?.contentWindow === frameWindow) {
            frameWindow.postMessage({ protocol: PLUGIN_HOST_PROTOCOL, id: raw.id, ok: false, error: "host_error" }, "*");
          }
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [admitted, bundleReady, frameKey, initialize, canvasAgent, plugin, activeRegistry, sensitiveActions, frameTitle]);

  if (!supported) {
    return (
      <div className="plugin-sandbox-unavailable" role="status">
        {t("当前版本缺少插件隔离运行支持，请更新 App 或系统后重试。")}
      </div>
    );
  }

  if (bundleReady && !admitted) {
    return <div className="plugin-sandbox-unavailable" role="status">{t("此版本暂不运行未经审核的 HTML 插件。")}</div>;
  }

  if (!bundleReady) {
    return (
      <div className="plugin-sandbox-unavailable" role="status">
        {t("正在加载插件沙箱…")}
      </div>
    );
  }

  return (
    <div className="plugin-sandbox-host" style={{ position: "relative", width: "100%", height: "100%" }}>
      <iframe
        key={frameKey}
        ref={iframeRef}
        className="plugin-sandbox-frame"
        title={frameTitle}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        src={sandboxSrc}
        onLoad={initialize}
      />
      {nodeConsent.dialog}
      {domainPrompt && (
        <div className="plugin-consent-backdrop" role="presentation" style={{ position: "absolute", inset: 0, zIndex: 20 }}>
          <section className="plugin-consent-box" role="alertdialog" aria-label={t("授权插件访问新域名")}>
            <header>
              <strong>{t("允许「{0}」访问此域名？", frameTitle)}</strong>
            </header>
            <p className="muted">
              {t("插件请求将其沙箱网络白名单扩展到以下公网 HTTPS 域名：")}
            </p>
            <p><code>{domainPrompt.domain}</code></p>
            {domainPrompt.reason && <p className="muted">{domainPrompt.reason}</p>}
            <p className="muted">
              {t("仅在信任该自定义 API 地址时允许；授权后插件沙箱将重新加载以生效。")}
            </p>
            <div className="plugin-consent-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const current = domainPrompt;
                  setDomainPrompt(null);
                  current.resolve({ granted: false });
                }}
              >
                {t("拒绝")}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const current = domainPrompt;
                  setDomainPrompt(null);
                  const granted = activeRegistry.grantDomain(plugin.manifest.id, current.domain);
                  const updated = activeRegistry.getPlugin(plugin.manifest.id);
                  current.resolve({
                    granted: !!granted,
                    ...(granted ? { domain: granted } : {}),
                    ...(updated ? { grantedDomains: [...updated.grantedDomains] } : {}),
                  });
                }}
              >
                {t("允许并重载")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

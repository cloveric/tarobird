import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PLUGIN_HOST_PROTOCOL } from "../../src/client-protocol/plugins.js";
import {
  pluginRegistry,
  type InstalledPluginRecord,
  type PluginRegistry,
} from "./plugin-registry.js";
import type { HubConnection } from "./connection.js";
import { exportAttachment } from "./attachment-export.js";
import { t, useLocale } from "./i18n.js";
import {
  handlePluginHostMessage,
  resolvePluginSandboxSrc,
  resolvePluginTheme,
  wrapSandboxedDocument,
  type CanvasAgentBridgeAdapter,
} from "./plugin-sandbox-runtime.js";

export { handlePluginHostMessage } from "./plugin-sandbox-runtime.js";

export function isPluginSandboxSupported(): boolean {
  if (!Capacitor.isNativePlatform()) return true;
  let supported = !!document.querySelector('meta[name="tarobot-widget-guard"][content="1"]');
  if (["android", "ios"].includes(Capacitor.getPlatform())) {
    try {
      supported &&= (window as unknown as { tarobotWidgetIsolation?: { supported(): boolean } }).tarobotWidgetIsolation?.supported() === true;
    } catch {
      supported = false;
    }
  }
  return supported;
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
  tabId,
}: {
  plugin: InstalledPluginRecord;
  title?: string;
  registry?: PluginRegistry;
  connection?: HubConnection;
  conversationId?: string;
  tabId?: string;
}) {
  const activeRegistry = registry ?? pluginRegistry;
  const locale = useLocale();
  const supported = isPluginSandboxSupported();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [domainPrompt, setDomainPrompt] = useState<DomainPromptState | null>(null);
  const domainPromptRef = useRef<DomainPromptState | null>(null);
  domainPromptRef.current = domainPrompt;

  const frameTitle = title ?? (locale === "zh" ? plugin.manifest.nameZh ?? plugin.manifest.name : plugin.manifest.name);
  const grantedDomainsKey = plugin.grantedDomains.join(",");
  const bundleReady = plugin.bundleHtml.length > 0;
  const frameKey = `${plugin.manifest.id}:${plugin.manifest.version}:${plugin.manifest.artifact.sha256}:${plugin.installedAt}:${grantedDomainsKey}:${bundleReady ? "1" : "0"}`;
  const sandboxSrc = resolvePluginSandboxSrc();
  const wrappedDoc = useMemo(
    () => (bundleReady ? wrapSandboxedDocument(plugin.bundleHtml, plugin.grantedDomains) : ""),
    [bundleReady, plugin.bundleHtml, plugin.grantedDomains],
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

  const activeClientIdsRef = useRef<Set<string>>(new Set());

  const canvasAgent = useMemo<CanvasAgentBridgeAdapter | undefined>(() => {
    if (!connection || !conversationId || !plugin.grantedCapabilities.includes("canvas.agent")) {
      return undefined;
    }
    const postToPlugin = (payload: Record<string, unknown>) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (frameWindow) {
        frameWindow.postMessage({ protocol: PLUGIN_HOST_PROTOCOL, ...payload }, "*");
      }
    };
    return {
      async connect(clientId) {
        const attached = await connection.canvasAgentAttach(
          conversationId,
          tabId ?? `tab_${plugin.manifest.id}`,
          clientId,
          (ev) => {
            if (ev.event === "hello") {
              postToPlugin({ type: "canvas.agent.hello", clientId, ...(ev.data ?? {}) });
            } else if (ev.event === "tool_call") {
              postToPlugin({ type: "canvas.agent.tool_call", clientId, ...(ev.data ?? {}) });
            } else if (ev.event === "tool_cancel") {
              postToPlugin({ type: "canvas.agent.tool_cancel", clientId, ...(ev.data ?? {}) });
            } else if (ev.event === "closed") {
              activeClientIdsRef.current.delete(clientId);
              postToPlugin({ type: "canvas.agent.closed", clientId });
            }
          },
        );
        activeClientIdsRef.current.add(clientId);
        return {
          connected: true,
          protocolVersion: attached.protocolVersion,
          conversationId: attached.conversationId,
        };
      },
      async disconnect(clientId) {
        activeClientIdsRef.current.delete(clientId);
        return connection.canvasAgentDetach(clientId, true);
      },
      async sendState(clientId, snapshot) {
        const res = await connection.canvasAgentRequest(
          clientId,
          `/api/canvas-agent/state?clientId=${encodeURIComponent(clientId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ snapshot }),
          },
        );
        return res.ok;
      },
      async activate(clientId) {
        const res = await connection.canvasAgentRequest(
          clientId,
          `/api/canvas-agent/activate?clientId=${encodeURIComponent(clientId)}`,
          { method: "POST" },
        );
        return res.ok;
      },
      async sendResult(clientId, requestId, payload) {
        const res = await connection.canvasAgentRequest(
          clientId,
          `/api/canvas-agent/result?clientId=${encodeURIComponent(clientId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId, ...payload }),
          },
        );
        return res.ok;
      },
    };
  }, [connection, conversationId, tabId, plugin.manifest.id, plugin.grantedCapabilities]);

  // Detach Canvas Agent clients only when the connection/conversation/frame identity changes or unmounts
  // — NEVER on locale or title changes!
  useEffect(() => {
    const clients = activeClientIdsRef.current;
    return () => {
      if (connection && clients.size > 0) {
        for (const cid of [...clients]) {
          void connection.canvasAgentDetach(cid, true).catch(() => undefined);
        }
      }
      clients.clear();
    };
  }, [connection, conversationId, tabId, frameKey]);

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
    if (!supported || !bundleReady) return;
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).type === "tarobird-plugin-shell-ready") {
        initialize();
        return;
      }
      const ctx = latestContextRef.current;
      void handlePluginHostMessage(event.data, {
        pluginId: ctx.pluginId,
        scopeId: ctx.registry.getScopeId(),
        grantedCapabilities: ctx.grantedCapabilities,
        grantedDomains: ctx.grantedDomains,
        theme: resolvePluginTheme(),
        locale: ctx.locale,
        storage: ctx.registry.storage,
        kvStore: ctx.registry.kvStore,
        credentialVault: ctx.registry.credentialVault,
        exportWorkspace: async (filename, content, mime) => {
          const blob = new Blob([content], { type: mime ?? "application/json" });
          return exportAttachment(blob, filename);
        },
        requestDomain: (domain, reason) => new Promise((resolve) => {
          if (domainPromptRef.current) {
            domainPromptRef.current.resolve({ granted: false });
          }
          setDomainPrompt({ domain, reason, resolve });
        }),
        canvasAgent,
      })
        .then((response) => {
          if (response && iframeRef.current?.contentWindow === frameWindow) {
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
  }, [supported, bundleReady, frameKey, initialize, canvasAgent]);

  if (!supported) {
    return (
      <div className="plugin-sandbox-unavailable" role="status">
        {t("当前版本缺少插件隔离运行支持，请更新 App 或系统后重试。")}
      </div>
    );
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

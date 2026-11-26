import { useEffect, useRef } from "react";
import {
  PLUGIN_HOST_PROTOCOL,
  pluginHostRequestSchema,
  requiredCapabilityForMethod,
  type PluginCapability,
  type PluginHostResponse,
} from "../../src/client-protocol/plugins.js";
import {
  pluginDataPrefix,
  pluginRegistry,
  type InstalledPluginRecord,
  type PluginCredentialVault,
  type PluginStorageAdapter,
} from "./plugin-registry.js";
import type { HubConnection } from "./connection.js";
import { useLocale } from "./i18n.js";
import { writeClipboardText } from "./clipboard-write.js";

export type CanvasAgentBridgeAdapter = {
  connect(clientId: string): Promise<{ connected: boolean; protocolVersion: number; conversationId?: string }>;
  disconnect(clientId: string): Promise<boolean>;
  sendState(clientId: string, snapshot: { projectId: string; title: string } | null): Promise<boolean>;
  activate(clientId: string): Promise<boolean>;
  sendResult(clientId: string, requestId: string, payload: { result?: unknown; error?: { code: string; message: string } }): Promise<boolean>;
};

/** Pure sandbox host-API dispatcher so capability gating is directly unit-testable.
 * Never exposes App tokens, Hub credentials, or Hub HTTP/WebSocket APIs. */
export async function handlePluginHostMessage(
  raw: unknown,
  context: {
    pluginId: string;
    scopeId?: string;
    grantedCapabilities: readonly PluginCapability[];
    theme: "light" | "dark";
    locale: string;
    storage: PluginStorageAdapter & { keys?: () => string[] };
    credentialVault?: PluginCredentialVault;
    writeClipboard?: (text: string) => Promise<void>;
    canvasAgent?: CanvasAgentBridgeAdapter;
  },
): Promise<PluginHostResponse | null> {
  const parsed = pluginHostRequestSchema.safeParse(raw);
  if (!parsed.success) {
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).protocol === PLUGIN_HOST_PROTOCOL && typeof (raw as Record<string, unknown>).id === "string") {
      return { protocol: PLUGIN_HOST_PROTOCOL, id: String((raw as Record<string, unknown>).id), ok: false, error: "method_not_allowed" };
    }
    return null;
  }
  const req = parsed.data;
  const required = requiredCapabilityForMethod(req.method);
  if (required && !context.grantedCapabilities.includes(required)) {
    return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "capability_denied" };
  }
  const scopeId = context.scopeId ?? "default";
  const prefix = pluginDataPrefix(scopeId, context.pluginId);
  const allStorageKeys = () => {
    if (context.storage.keys) return context.storage.keys();
    const maybeData = (context.storage as { data?: Map<string, string> }).data;
    if (maybeData instanceof Map) return [...maybeData.keys()];
    if (typeof window !== "undefined" && context.storage === window.localStorage) {
      const out: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k) out.push(k);
      }
      return out;
    }
    return [];
  };

  switch (req.method) {
    case "host.hello":
      return {
        protocol: PLUGIN_HOST_PROTOCOL,
        id: req.id,
        ok: true,
        result: {
          pluginId: context.pluginId,
          scopeId,
          theme: context.theme,
          locale: context.locale,
          grantedCapabilities: [...context.grantedCapabilities],
        },
      };
    case "theme.get":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { theme: context.theme } };
    case "storage.get":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: context.storage.getItem(prefix + req.key) };
    case "storage.set":
      context.storage.setItem(prefix + req.key, req.value);
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    case "storage.remove":
      context.storage.removeItem(prefix + req.key);
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    case "storage.list": {
      const result: Record<string, string> = {};
      for (const fullKey of allStorageKeys()) {
        if (!fullKey.startsWith(prefix)) continue;
        const val = context.storage.getItem(fullKey);
        if (val !== null) result[fullKey.slice(prefix.length)] = val;
      }
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result };
    }
    case "storage.clear": {
      for (const fullKey of allStorageKeys()) {
        if (fullKey.startsWith(prefix)) context.storage.removeItem(fullKey);
      }
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    }
    case "credentials.get": {
      if (!context.credentialVault) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "credentials_unavailable" };
      const val = await context.credentialVault.getSecret(scopeId, context.pluginId, req.key);
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: val };
    }
    case "credentials.set": {
      if (!context.credentialVault) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "credentials_unavailable" };
      await context.credentialVault.setSecret(scopeId, context.pluginId, req.key, req.value);
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    }
    case "credentials.remove": {
      if (!context.credentialVault) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "credentials_unavailable" };
      await context.credentialVault.removeSecret(scopeId, context.pluginId, req.key);
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    }
    case "clipboard.write":
      await (context.writeClipboard ? context.writeClipboard(req.text) : writeClipboardText(req.text));
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    case "workbench.status":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { isolated: true, sandbox: "opaque-origin" } };
    case "canvas.agent.connect":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.connect(req.clientId) };
    case "canvas.agent.disconnect":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.disconnect(req.clientId) };
    case "canvas.agent.state":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.sendState(req.clientId, req.snapshot) };
    case "canvas.agent.activate":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.activate(req.clientId) };
    case "canvas.agent.result":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      return {
        protocol: PLUGIN_HOST_PROTOCOL,
        id: req.id,
        ok: true,
        result: await context.canvasAgent.sendResult(req.clientId, req.requestId, {
          ...(req.result !== undefined ? { result: req.result } : {}),
          ...(req.error ? { error: req.error } : {}),
        }),
      };
  }
}

function wrapSandboxedDocument(bundleHtml: string, grantedDomains: readonly string[]): string {
  const connectSources = grantedDomains
    .map((domain) => domain.trim())
    .filter((domain) => /^[a-z0-9.-]+(?::\d+)?$/i.test(domain))
    .map((domain) => `https://${domain}`)
    .join(" ");
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob: https:",
    "font-src data:",
    `connect-src ${connectSources || "'none'"}`,
    "frame-src about:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return /<head[^>]*>/i.test(bundleHtml)
    ? bundleHtml.replace(/<head[^>]*>/i, (match) => `${match}${cspTag}`)
    : `<!doctype html><html><head>${cspTag}</head><body>${bundleHtml}</body></html>`;
}

/** Isolated iframe runtime for an installed plugin. Loads `/plugin-sandbox.html`
 * inside `sandbox="allow-scripts"` WITHOUT `allow-same-origin` (unique opaque origin)
 * and injects a per-plugin CSP scoped strictly to `grantedDomains`, so the plugin
 * cannot access App tokens, cookies, IndexedDB, localStorage, or the Hub API. */
export function PluginSandboxFrame({
  plugin,
  title,
  connection,
  conversationId,
  tabId,
}: {
  plugin: InstalledPluginRecord;
  title?: string;
  connection?: HubConnection;
  conversationId?: string;
  tabId?: string;
}) {
  const locale = useLocale();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameTitle = title ?? (locale === "zh" ? plugin.manifest.nameZh ?? plugin.manifest.name : plugin.manifest.name);
  const wrappedDoc = wrapSandboxedDocument(plugin.bundleHtml, plugin.grantedDomains);

  useEffect(() => {
    const activeSockets = new Map<string, { ws: WebSocket; token: string; baseUrl: string }>();

    const postToPlugin = (payload: unknown) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (frameWindow) frameWindow.postMessage(payload, "*");
    };

    const canvasAgent: CanvasAgentBridgeAdapter | undefined =
      connection && conversationId && plugin.grantedCapabilities.includes("canvas.agent")
        ? {
            async connect(clientId) {
              const existing = activeSockets.get(clientId);
              if (existing && existing.ws.readyState === WebSocket.OPEN) {
                return { connected: true, protocolVersion: 12, conversationId };
              }
              if (existing) {
                try { existing.ws.close(); } catch { /* ignore */ }
                activeSockets.delete(clientId);
              }
              const baseUrl = connection.canvasAgentBaseUrl();
              if (!baseUrl) throw new Error("canvas_agent_offline");
              const issued = await connection.issueCanvasAgentToken(conversationId, tabId ?? `tab_${plugin.manifest.id}`, clientId);
              const wsUrl = `${baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "")}/api/canvas-agent/events?clientId=${encodeURIComponent(clientId)}&token=${encodeURIComponent(issued.token)}`;
              await new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(wsUrl);
                activeSockets.set(clientId, { ws, token: issued.token, baseUrl: baseUrl.replace(/\/+$/, "") });
                ws.addEventListener("message", (ev) => {
                  try {
                    const parsed = JSON.parse(String(ev.data)) as { type?: string; data?: Record<string, unknown> };
                    if (parsed.type === "hello") {
                      postToPlugin({ type: "canvas.agent.hello", clientId, ...(parsed.data ?? {}) });
                      resolve();
                    } else if (parsed.type === "tool_call") {
                      postToPlugin({ type: "canvas.agent.tool_call", clientId, ...(parsed.data ?? {}) });
                    } else if (parsed.type === "tool_cancel") {
                      postToPlugin({ type: "canvas.agent.tool_cancel", clientId, ...(parsed.data ?? {}) });
                    }
                  } catch { /* ignore */ }
                });
                ws.addEventListener("error", () => { reject(new Error("canvas_agent_ws_error")); });
                ws.addEventListener("close", () => {
                  if (activeSockets.get(clientId)?.ws === ws) activeSockets.delete(clientId);
                  postToPlugin({ type: "canvas.agent.closed", clientId });
                });
              });
              return { connected: true, protocolVersion: issued.protocolVersion, conversationId };
            },
            async disconnect(clientId) {
              const session = activeSockets.get(clientId);
              if (session) {
                activeSockets.delete(clientId);
                try { session.ws.close(); } catch { /* ignore */ }
              }
              await connection.revokeCanvasAgentToken(conversationId, clientId).catch(() => undefined);
              return true;
            },
            async sendState(clientId, snapshot) {
              const session = activeSockets.get(clientId);
              if (!session) return false;
              const res = await fetch(`${session.baseUrl}/api/canvas-agent/state?clientId=${encodeURIComponent(clientId)}`, {
                method: "POST",
                headers: { Authorization: `CanvasAgent ${session.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ snapshot }),
              });
              return res.ok;
            },
            async activate(clientId) {
              const session = activeSockets.get(clientId);
              if (!session) return false;
              const res = await fetch(`${session.baseUrl}/api/canvas-agent/activate?clientId=${encodeURIComponent(clientId)}`, {
                method: "POST",
                headers: { Authorization: `CanvasAgent ${session.token}` },
              });
              return res.ok;
            },
            async sendResult(clientId, requestId, payload) {
              const session = activeSockets.get(clientId);
              if (!session) return false;
              const res = await fetch(`${session.baseUrl}/api/canvas-agent/result?clientId=${encodeURIComponent(clientId)}`, {
                method: "POST",
                headers: { Authorization: `CanvasAgent ${session.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ requestId, ...payload }),
              });
              return res.ok;
            },
          }
        : undefined;

    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).type === "tarobird-plugin-shell-ready") {
        frameWindow.postMessage({ type: "tarobird-plugin-init", title: frameTitle, document: wrappedDoc }, "*");
        return;
      }
      const dark = document.documentElement.dataset.theme === "dark"
        || document.documentElement.classList.contains("dark")
        || window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      void handlePluginHostMessage(event.data, {
        pluginId: plugin.manifest.id,
        scopeId: pluginRegistry.getScopeId(),
        grantedCapabilities: plugin.grantedCapabilities,
        theme: dark ? "dark" : "light",
        locale,
        storage: pluginRegistry.storage,
        credentialVault: pluginRegistry.credentialVault,
        canvasAgent,
      }).then((response) => {
        if (response && iframeRef.current?.contentWindow === frameWindow) {
          frameWindow.postMessage(response, "*");
        }
      });
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const [cid, session] of activeSockets) {
        try { session.ws.close(); } catch { /* ignore */ }
        if (connection && conversationId) {
          void connection.revokeCanvasAgentToken(conversationId, cid).catch(() => undefined);
        }
      }
      activeSockets.clear();
    };
  }, [plugin.manifest.id, plugin.grantedCapabilities, locale, frameTitle, wrappedDoc, connection, conversationId, tabId]);

  return (
    <iframe
      key={`${plugin.manifest.id}:${plugin.manifest.version}`}
      ref={iframeRef}
      className="plugin-sandbox-frame"
      title={frameTitle}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src="/plugin-sandbox.html"
    />
  );
}

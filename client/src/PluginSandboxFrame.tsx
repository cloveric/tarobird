import { Capacitor } from "@capacitor/core";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { PLUGIN_HOST_PROTOCOL } from "../../src/client-protocol/plugins.js";
import {
  pluginRegistry,
  type InstalledPluginRecord,
  type PluginRegistry,
} from "./plugin-registry.js";
import { t, useLocale } from "./i18n.js";
import {
  handlePluginHostMessage,
  resolvePluginSandboxSrc,
  resolvePluginTheme,
  wrapSandboxedDocument,
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

/** Isolated iframe runtime for an installed plugin. Loads the runtime-appropriate
 * `plugin-sandbox.html` shell inside `sandbox="allow-scripts"` WITHOUT `allow-same-origin`
 * (unique opaque origin), injects a per-plugin CSP scoped strictly to validated
 * `grantedDomains`, and disables WebRTC constructors in the trusted bootstrap before
 * plugin code executes. */
export function PluginSandboxFrame({
  plugin,
  title,
  registry,
}: {
  plugin: InstalledPluginRecord;
  title?: string;
  registry?: PluginRegistry;
}) {
  const activeRegistry = registry ?? pluginRegistry;
  const locale = useLocale();
  const supported = isPluginSandboxSupported();
  const iframeRef = useRef<HTMLIFrameElement>(null);
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
        storage: window.localStorage,
        kvStore: ctx.registry.kvStore,
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
  }, [supported, bundleReady, frameKey, initialize]);

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
  );
}

import { Capacitor } from "@capacitor/core";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { PLUGIN_HOST_PROTOCOL } from "../../src/client-protocol/plugins.js";
import type { InstalledPluginRecord } from "./plugin-registry.js";
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
 * (unique opaque origin) and injects a per-plugin CSP scoped strictly to validated
 * `grantedDomains`, so the plugin cannot access App tokens, cookies, IndexedDB,
 * localStorage, native bridges, or the Hub API. */
export function PluginSandboxFrame({ plugin, title }: { plugin: InstalledPluginRecord; title?: string }) {
  const locale = useLocale();
  const supported = isPluginSandboxSupported();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameTitle = title ?? (locale === "zh" ? plugin.manifest.nameZh ?? plugin.manifest.name : plugin.manifest.name);
  const frameKey = `${plugin.manifest.id}:${plugin.manifest.version}:${plugin.manifest.artifact.sha256}:${plugin.installedAt}`;
  const sandboxSrc = resolvePluginSandboxSrc();
  const wrappedDoc = useMemo(
    () => wrapSandboxedDocument(plugin.bundleHtml, plugin.grantedDomains),
    [plugin.bundleHtml, plugin.grantedDomains],
  );
  const initializedKeyRef = useRef<string>("");
  const latestInitRef = useRef({ title: frameTitle, document: wrappedDoc });
  latestInitRef.current = { title: frameTitle, document: wrappedDoc };
  const latestContextRef = useRef({
    pluginId: plugin.manifest.id,
    grantedCapabilities: plugin.grantedCapabilities,
    locale,
  });
  latestContextRef.current = {
    pluginId: plugin.manifest.id,
    grantedCapabilities: plugin.grantedCapabilities,
    locale,
  };

  const initialize = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow || initializedKeyRef.current === frameKey) return;
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
    if (!supported) return;
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
        grantedCapabilities: ctx.grantedCapabilities,
        theme: resolvePluginTheme(),
        locale: ctx.locale,
        storage: window.localStorage,
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
  }, [supported, frameKey, initialize]);

  if (!supported) {
    return (
      <div className="plugin-sandbox-unavailable" role="status">
        {t("当前版本缺少插件隔离运行支持，请更新 App 或系统后重试。")}
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

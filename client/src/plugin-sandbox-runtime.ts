import {
  PLUGIN_HOST_PROTOCOL,
  pluginHostRequestSchema,
  requiredCapabilityForMethod,
  type PluginCapability,
  type PluginHostResponse,
} from "../../src/client-protocol/plugins.js";
import { writeClipboardText } from "./clipboard-write.js";
import { isDesktop, isElectron } from "./desktop-bridge.js";

/** Unambiguous per-plugin KV storage key (`/` is forbidden in pluginId). */
export function pluginStorageBucketKey(pluginId: string, scopeId?: string): string {
  const cleanScope = scopeId?.trim();
  if (!cleanScope || cleanScope === "default") {
    return `tarobird.plugin.kv/${encodeURIComponent(pluginId)}`;
  }
  return `tarobird.plugin.kv/${encodeURIComponent(cleanScope)}/${encodeURIComponent(pluginId)}`;
}

export type PluginCredentialVault = {
  getSecret(scopeId: string, pluginId: string, key: string): Promise<string | null>;
  setSecret(scopeId: string, pluginId: string, key: string, value: string): Promise<void>;
  removeSecret(scopeId: string, pluginId: string, key: string): Promise<void>;
  clearPluginSecrets(scopeId: string, pluginId: string): Promise<void>;
};

export type PluginKvStore = {
  get(scopeId: string, pluginId: string, key: string): Promise<string | null>;
  set(scopeId: string, pluginId: string, key: string, value: string): Promise<void>;
  remove(scopeId: string, pluginId: string, key: string): Promise<void>;
  list(scopeId: string, pluginId: string): Promise<Record<string, string>>;
  clear(scopeId: string, pluginId: string): Promise<void>;
};

export type CanvasAgentBridgeAdapter = {
  connect(clientId: string): Promise<{ connected: boolean; protocolVersion: number; conversationId?: string }>;
  disconnect(clientId: string): Promise<boolean>;
  sendState(clientId: string, snapshot: { projectId: string; title: string } | null): Promise<boolean>;
  activate(clientId: string): Promise<boolean>;
  sendResult(clientId: string, requestId: string, payload: { result?: unknown; error?: { code: string; message: string } }): Promise<boolean>;
};

export const MAX_PLUGIN_STORAGE_KEYS = 64;
export const MAX_PLUGIN_STORAGE_BYTES = 512 * 1024;

function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: unknown; code?: unknown };
  return err.name === "QuotaExceededError"
    || err.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || err.code === 22
    || err.code === 1014;
}

function readPluginBucket(
  storage: Pick<Storage, "getItem">,
  bucketKey: string,
): Map<string, string> {
  const raw = storage.getItem(bucketKey);
  const map = new Map<string, string>();
  if (!raw) return map;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") map.set(k, v);
      }
    }
  } catch {
    // Treat corrupted bucket JSON as empty rather than crashing the host API.
  }
  return map;
}

function serializePluginBucket(map: Map<string, string>): string {
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of map.entries()) out[k] = v;
  return JSON.stringify(out);
}

/** Pure sandbox host-API dispatcher so capability gating, storage isolation,
 * quotas, and error handling are directly unit-testable.
 * Never exposes App tokens, Hub credentials, or Hub HTTP/WebSocket APIs. */
export async function handlePluginHostMessage(
  raw: unknown,
  context: {
    pluginId: string;
    scopeId?: string;
    grantedCapabilities: readonly PluginCapability[];
    grantedDomains?: readonly string[];
    theme: "light" | "dark";
    locale: string;
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    kvStore?: PluginKvStore;
    credentialVault?: PluginCredentialVault;
    writeClipboard?: (text: string) => Promise<void>;
    exportWorkspace?: (filename: string, content: string, mime?: string) => Promise<boolean>;
    requestDomain?: (domain: string, reason?: string) => Promise<{ granted: boolean; domain?: string; grantedDomains?: string[] }>;
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
  const scopeId = context.scopeId?.trim() || "default";
  const bucketKey = pluginStorageBucketKey(context.pluginId, scopeId);
  const errorCode = (err: unknown, fallback: string): string =>
    err instanceof Error && err.message ? err.message : fallback;

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
          grantedDomains: [...(context.grantedDomains ?? [])],
        },
      };
    case "theme.get":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { theme: context.theme } };
    case "storage.get":
      try {
        if (context.kvStore) {
          const val = await context.kvStore.get(scopeId, context.pluginId, req.key);
          if (val !== null) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: val };
        }
        const bucket = readPluginBucket(context.storage, bucketKey);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: bucket.get(req.key) ?? null };
      } catch {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "storage_unavailable" };
      }
    case "storage.set":
      try {
        if (context.kvStore) {
          await context.kvStore.set(scopeId, context.pluginId, req.key, req.value);
          return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
        }
        const bucket = readPluginBucket(context.storage, bucketKey);
        if (!bucket.has(req.key) && bucket.size >= MAX_PLUGIN_STORAGE_KEYS) {
          return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "storage_quota_exceeded" };
        }
        bucket.set(req.key, req.value);
        const serialized = serializePluginBucket(bucket);
        if (new TextEncoder().encode(serialized).byteLength > MAX_PLUGIN_STORAGE_BYTES) {
          return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "storage_quota_exceeded" };
        }
        context.storage.setItem(bucketKey, serialized);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      } catch (error) {
        return {
          protocol: PLUGIN_HOST_PROTOCOL,
          id: req.id,
          ok: false,
          error: isQuotaError(error) ? "storage_quota_exceeded" : "storage_unavailable",
        };
      }
    case "storage.remove":
      try {
        if (context.kvStore) {
          await context.kvStore.remove(scopeId, context.pluginId, req.key);
        }
        const bucket = readPluginBucket(context.storage, bucketKey);
        if (bucket.delete(req.key)) {
          if (bucket.size === 0) {
            context.storage.removeItem(bucketKey);
          } else {
            context.storage.setItem(bucketKey, serializePluginBucket(bucket));
          }
        }
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      } catch (error) {
        return {
          protocol: PLUGIN_HOST_PROTOCOL,
          id: req.id,
          ok: false,
          error: isQuotaError(error) ? "storage_quota_exceeded" : "storage_unavailable",
        };
      }
    case "storage.list":
      try {
        const result: Record<string, string> = {};
        const bucket = readPluginBucket(context.storage, bucketKey);
        for (const [k, v] of bucket.entries()) result[k] = v;
        if (context.kvStore) {
          const kvEntries = await context.kvStore.list(scopeId, context.pluginId);
          for (const [k, v] of Object.entries(kvEntries)) result[k] = v;
        }
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result };
      } catch {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "storage_unavailable" };
      }
    case "storage.clear":
      try {
        if (context.kvStore) {
          await context.kvStore.clear(scopeId, context.pluginId);
        }
        context.storage.removeItem(bucketKey);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      } catch {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "storage_unavailable" };
      }
    case "credentials.get":
      if (!context.credentialVault) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "credentials_unavailable" };
      try {
        const val = await context.credentialVault.getSecret(scopeId, context.pluginId, req.key);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: val };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "credentials_error") };
      }
    case "credentials.set":
      if (!context.credentialVault) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "credentials_unavailable" };
      try {
        await context.credentialVault.setSecret(scopeId, context.pluginId, req.key, req.value);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "credentials_error") };
      }
    case "credentials.remove":
      if (!context.credentialVault) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "credentials_unavailable" };
      try {
        await context.credentialVault.removeSecret(scopeId, context.pluginId, req.key);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "credentials_error") };
      }
    case "clipboard.write":
      try {
        await (context.writeClipboard ? context.writeClipboard(req.text) : writeClipboardText(req.text));
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      } catch {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "clipboard_write_failed" };
      }
    case "workspace.export":
      if (!context.exportWorkspace) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "export_unavailable" };
      }
      try {
        const saved = await context.exportWorkspace(req.filename, req.content, req.mime);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { saved } };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "export_failed") };
      }
    case "domains.request": {
      const sanitized = sanitizePluginDomain(req.domain);
      if (!sanitized) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "invalid_domain" };
      }
      if (context.grantedDomains?.includes(sanitized)) {
        return {
          protocol: PLUGIN_HOST_PROTOCOL,
          id: req.id,
          ok: true,
          result: { granted: true, domain: sanitized, grantedDomains: [...context.grantedDomains] },
        };
      }
      if (!context.requestDomain) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "domain_request_unavailable" };
      }
      try {
        const res = await context.requestDomain(sanitized, req.reason);
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: res };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "domain_request_failed") };
      }
    }
    case "workbench.status":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { isolated: true, sandbox: "opaque-origin" } };
    case "canvas.agent.connect":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      try {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.connect(req.clientId) };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "canvas_agent_connect_failed") };
      }
    case "canvas.agent.disconnect":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      try {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.disconnect(req.clientId) };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "canvas_agent_disconnect_failed") };
      }
    case "canvas.agent.state":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      try {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.sendState(req.clientId, req.snapshot) };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "canvas_agent_state_failed") };
      }
    case "canvas.agent.activate":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      try {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: await context.canvasAgent.activate(req.clientId) };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "canvas_agent_activate_failed") };
      }
    case "canvas.agent.result":
      if (!context.canvasAgent) return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "canvas_agent_unavailable" };
      try {
        return {
          protocol: PLUGIN_HOST_PROTOCOL,
          id: req.id,
          ok: true,
          result: await context.canvasAgent.sendResult(req.clientId, req.requestId, {
            ...(req.result !== undefined ? { result: req.result } : {}),
            ...(req.error ? { error: req.error } : {}),
          }),
        };
      } catch (error) {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: errorCode(error, "canvas_agent_result_failed") };
      }
  }
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return true;
  if (
    host === "localhost"
    || /\.(?:localhost|local|internal|lan|home\.arpa|localdomain)$/.test(host)
    || (!host.includes(".") && !host.includes(":"))
  ) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    const d = Number(v4[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return true;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }
  if (host.includes(":")) {
    return (
      host === "::1"
      || host === "::"
      || /^0*:0*:0*:0*:0*:0*:0*:[01]$/.test(host)
      || /^f[cd][0-9a-f]{0,2}:/.test(host)
      || /^fe[89ab][0-9a-f]:/.test(host)
      || /^ff[0-9a-f]{0,2}:/.test(host)
      || /^::ffff:/.test(host)
    );
  }
  return false;
}

/** Validates a declared plugin domain for CSP connect-src.
 * Rejects URLs with schemes/paths/credentials, wildcards, and loopback/private/local hosts. */
export function sanitizePluginDomain(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\s/?#@*;'"\\<>]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`https://${trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    if (isPrivateOrLocalHost(parsed.hostname)) return null;
    // Reject trailing dots or empty labels that could diverge from canonical host syntax.
    const cleanHost = parsed.hostname.replace(/^\[|\]$/g, "");
    if (cleanHost.endsWith(".") || cleanHost.includes("..")) return null;
    return parsed.host;
  } catch {
    return null;
  }
}

export function buildPluginCsp(grantedDomains: readonly string[]): string {
  const hosts = new Set<string>();
  for (const raw of grantedDomains) {
    const host = sanitizePluginDomain(raw);
    if (host) hosts.add(host);
  }
  const connectSources = [...hosts]
    .flatMap((host) => [`https://${host}`, `wss://${host}`])
    .join(" ");
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src ${hosts.size > 0 ? "data: blob: https:" : "data: blob:"}`,
    "font-src data:",
    `connect-src ${connectSources || "'none'"}`,
    "frame-src about:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function stripDisallowedMetaAndBase(root: ParentNode): void {
  const metas = [...root.querySelectorAll("meta")];
  for (const meta of metas) {
    const httpEquiv = meta.getAttribute("http-equiv")?.trim().toLowerCase();
    if (httpEquiv === "content-security-policy" || httpEquiv === "content-security-policy-report-only") {
      meta.remove();
    }
  }
  for (const base of [...root.querySelectorAll("base")]) {
    base.remove();
  }
  for (const template of [...root.querySelectorAll("template")]) {
    stripDisallowedMetaAndBase(template.content);
  }
}

/** Token-aware HTML fallback used only in non-DOM runtimes (Node tests).
 * Skips comments and rawtext tags so `<!-- <head> -->` or pre-head `<script>`
 * can never bypass host CSP injection. */
function wrapSandboxedDocumentWithoutDom(bundleHtml: string, cspTag: string): string {
  const stripped = stripCommentsAndUntrustedCsp(bundleHtml);
  const headMatch = findRealHeadOpenTag(stripped);
  if (headMatch) {
    const before = stripped.slice(0, headMatch.start);
    const hasScriptOrBodyBeforeHead = /<(?:script|body|iframe|img|link|style|svg|object|embed)\b/i.test(before);
    if (!hasScriptOrBodyBeforeHead) {
      return `${stripped.slice(0, headMatch.start)}<head><meta charset="utf-8">${cspTag}${stripped.slice(headMatch.end)}`;
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8">${cspTag}</head><body>${stripped}</body></html>`;
}

function stripCommentsAndUntrustedCsp(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  const lower = html.toLowerCase();
  while (i < n) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[i] === "<") {
      const rawTag = /^<(script|style|title|textarea)\b/i.exec(html.slice(i));
      if (rawTag) {
        const tagName = rawTag[1]!.toLowerCase();
        const closeNeedle = `</${tagName}`;
        const closeIdx = lower.indexOf(closeNeedle, i + rawTag[0].length);
        if (closeIdx === -1) {
          out += html.slice(i);
          break;
        }
        const closeEnd = html.indexOf(">", closeIdx + closeNeedle.length);
        const endPos = closeEnd === -1 ? n : closeEnd + 1;
        out += html.slice(i, endPos);
        i = endPos;
        continue;
      }
      const tagEnd = findTagEnd(html, i);
      const tag = html.slice(i, tagEnd);
      if (
        /^<meta\b/i.test(tag)
        && /\bhttp-equiv\s*=\s*(?:"[^"]*content-security-policy[^"]*"|'[^']*content-security-policy[^']*'|content-security-policy(?:-report-only)?)/i.test(tag)
      ) {
        i = tagEnd;
        continue;
      }
      if (/^<base\b/i.test(tag)) {
        i = tagEnd;
        continue;
      }
      out += tag;
      i = tagEnd;
      continue;
    }
    out += html[i];
    i++;
  }
  return out;
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return html.length;
}

function findRealHeadOpenTag(html: string): { start: number; end: number } | null {
  let i = 0;
  const n = html.length;
  const lower = html.toLowerCase();
  while (i < n) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[i] === "<") {
      const rawTag = /^<(script|style|title|textarea|noscript|template)\b/i.exec(html.slice(i));
      if (rawTag) {
        const tagName = rawTag[1]!.toLowerCase();
        const closeNeedle = `</${tagName}`;
        const closeIdx = lower.indexOf(closeNeedle, i + rawTag[0].length);
        if (closeIdx === -1) return null;
        const closeEnd = html.indexOf(">", closeIdx + closeNeedle.length);
        i = closeEnd === -1 ? n : closeEnd + 1;
        continue;
      }
      const tagEnd = findTagEnd(html, i);
      const tag = html.slice(i, tagEnd);
      if (/^<head(?:\s|>|\/)/i.test(tag)) {
        return { start: i, end: tagEnd };
      }
      i = tagEnd;
      continue;
    }
    i++;
  }
  return null;
}

/** Safely wraps untrusted plugin HTML with a host-owned CSP `<meta>` tag as the
 * first policy in a real `<head>`, stripping any plugin-supplied CSP `<meta>`. */
export function wrapSandboxedDocument(bundleHtml: string, grantedDomains: readonly string[]): string {
  const csp = buildPluginCsp(grantedDomains);
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(bundleHtml, "text/html");
    stripDisallowedMetaAndBase(doc);
    // Clear any untrusted attributes on <head> so serialization begins cleanly with <head>.
    for (const attr of [...doc.head.attributes]) {
      doc.head.removeAttribute(attr.name);
    }
    const charsetMeta = doc.createElement("meta");
    charsetMeta.setAttribute("charset", "utf-8");
    const cspMeta = doc.createElement("meta");
    cspMeta.setAttribute("http-equiv", "Content-Security-Policy");
    cspMeta.setAttribute("content", csp);
    doc.head.prepend(charsetMeta, cspMeta);
    return `<!doctype html>${doc.documentElement.outerHTML}`;
  }
  return wrapSandboxedDocumentWithoutDom(bundleHtml, cspTag);
}

/** Resolves the effective App light/dark theme without letting OS dark mode
 * override an explicit Light selection (`dataset.theme === "light"`). */
export function resolvePluginTheme(
  root: HTMLElement = document.documentElement,
  prefersDark?: boolean,
): "light" | "dark" {
  const explicit = root.dataset.theme;
  if (explicit === "dark") return "dark";
  if (explicit === "light") return "light";
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("light")) return "light";
  if (typeof getComputedStyle === "function") {
    const scheme = getComputedStyle(root).colorScheme.trim().toLowerCase();
    if (scheme === "dark") return "dark";
    if (scheme === "light") return "light";
  }
  const osDark = prefersDark ?? (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);
  return osDark ? "dark" : "light";
}

/** Resolves the isolated plugin-sandbox shell URL per runtime, matching Widget.tsx. */
export function resolvePluginSandboxSrc(): string {
  if (isElectron()) return "tarobot-widget://sandbox/plugin-sandbox.html";
  if (isDesktop()) {
    return navigator.userAgent.includes("Windows")
      ? "http://widget.localhost/plugin-sandbox.html"
      : "widget://localhost/plugin-sandbox.html";
  }
  return new URL("plugin-sandbox.html", document.baseURI).href;
}

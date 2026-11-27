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

export type PluginKvStore = {
  get(scopeId: string, pluginId: string, key: string): Promise<string | null>;
  set(scopeId: string, pluginId: string, key: string, value: string): Promise<void>;
  remove(scopeId: string, pluginId: string, key: string): Promise<void>;
  list(scopeId: string, pluginId: string): Promise<Record<string, string>>;
  clear(scopeId: string, pluginId: string): Promise<void>;
};

export const MAX_PLUGIN_STORAGE_KEYS = 64;
export const MAX_PLUGIN_STORAGE_BYTES = 512 * 1024;

/** WebRTC globals disabled non-configurably before plugin code runs.
 * CSP alone does not block WebRTC ICE/STUN/UDP networking, so the trusted
 * bootstrap removes these constructors as defense-in-depth. */
export const PLUGIN_SANDBOX_WEBRTC_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
  "RTCDtlsTransport",
  "RTCIceTransport",
  "RTCSctpTransport",
  "RTCCertificate",
  "RTCStatsReport",
  "RTCDataChannelEvent",
  "RTCPeerConnectionIceEvent",
  "RTCTrackEvent",
  "RTCEncodedAudioFrame",
  "RTCEncodedVideoFrame",
] as const;

export const PLUGIN_SANDBOX_BOOTSTRAP_SCRIPT = `(()=>{const names=${JSON.stringify(PLUGIN_SANDBOX_WEBRTC_GLOBALS)};const seen=new Set();for(const root of [globalThis,window,self]){for(let obj=root;obj&&obj!==Object.prototype;obj=Object.getPrototypeOf(obj)){if(seen.has(obj))continue;seen.add(obj);for(const name of names){if(obj===root||Object.prototype.hasOwnProperty.call(obj,name)){try{Object.defineProperty(obj,name,{value:undefined,writable:false,configurable:false});}catch{}}}}}})();`;

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
    writeClipboard?: (text: string) => Promise<void>;
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
  switch (req.method) {
    case "host.hello":
      return {
        protocol: PLUGIN_HOST_PROTOCOL,
        id: req.id,
        ok: true,
        result: {
          pluginId: context.pluginId,
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
    case "clipboard.write":
      try {
        await (context.writeClipboard ? context.writeClipboard(req.text) : writeClipboardText(req.text));
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
      } catch {
        return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "clipboard_write_failed" };
      }
    case "workbench.status":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { isolated: true, sandbox: "opaque-origin" } };
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
    "worker-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    `connect-src ${connectSources || "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function stripDisallowedMetaAndBase(root: ParentNode): void {
  const metas = [...root.querySelectorAll("meta")];
  for (const meta of metas) {
    const httpEquiv = meta.getAttribute("http-equiv")?.trim().toLowerCase();
    const name = meta.getAttribute("name")?.trim().toLowerCase();
    if (
      httpEquiv === "content-security-policy"
      || httpEquiv === "content-security-policy-report-only"
      || name === "referrer"
    ) {
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
 * can never bypass host CSP or WebRTC hardening bootstrap injection. */
function wrapSandboxedDocumentWithoutDom(bundleHtml: string, headPrefix: string): string {
  const stripped = stripCommentsAndUntrustedCsp(bundleHtml);
  const headMatch = findRealHeadOpenTag(stripped);
  if (headMatch) {
    const before = stripped.slice(0, headMatch.start);
    const hasScriptOrBodyBeforeHead = /<(?:script|body|iframe|img|link|style|svg|object|embed)\b/i.test(before);
    if (!hasScriptOrBodyBeforeHead) {
      return `${stripped.slice(0, headMatch.start)}<head>${headPrefix}${stripped.slice(headMatch.end)}`;
    }
  }
  return `<!doctype html><html><head>${headPrefix}</head><body>${stripped}</body></html>`;
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
        && (
          /\bhttp-equiv\s*=\s*(?:"[^"]*content-security-policy[^"]*"|'[^']*content-security-policy[^']*'|content-security-policy(?:-report-only)?)/i.test(tag)
          || /\bname\s*=\s*(?:"referrer"|'referrer'|referrer)/i.test(tag)
        )
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

/** Safely wraps untrusted plugin HTML with host-owned referrer/CSP `<meta>` tags
 * and the WebRTC-disabling bootstrap `<script>` as the first elements in `<head>`,
 * stripping any plugin-supplied CSP/referrer `<meta>` or `<base>`. */
export function wrapSandboxedDocument(bundleHtml: string, grantedDomains: readonly string[]): string {
  const csp = buildPluginCsp(grantedDomains);
  const headPrefix = `<meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>${PLUGIN_SANDBOX_BOOTSTRAP_SCRIPT}</script>`;
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(bundleHtml, "text/html");
    stripDisallowedMetaAndBase(doc);
    // Clear any untrusted attributes on <head> and inline event handlers on <html>.
    for (const attr of [...doc.head.attributes]) {
      doc.head.removeAttribute(attr.name);
    }
    for (const attr of [...doc.documentElement.attributes]) {
      if (/^on/i.test(attr.name)) doc.documentElement.removeAttribute(attr.name);
    }
    const charsetMeta = doc.createElement("meta");
    charsetMeta.setAttribute("charset", "utf-8");
    const referrerMeta = doc.createElement("meta");
    referrerMeta.setAttribute("name", "referrer");
    referrerMeta.setAttribute("content", "no-referrer");
    const cspMeta = doc.createElement("meta");
    cspMeta.setAttribute("http-equiv", "Content-Security-Policy");
    cspMeta.setAttribute("content", csp);
    const bootstrapScript = doc.createElement("script");
    bootstrapScript.textContent = PLUGIN_SANDBOX_BOOTSTRAP_SCRIPT;
    doc.head.prepend(charsetMeta, referrerMeta, cspMeta, bootstrapScript);
    return `<!doctype html>${doc.documentElement.outerHTML}`;
  }
  return wrapSandboxedDocumentWithoutDom(bundleHtml, headPrefix);
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

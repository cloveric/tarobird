import { guardWidgetBridges } from "./widget-native-guard.mjs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Native Hub requests go through the certificate-bound transport plugin, not
// WebView fetch/WebSocket. Bundled workers, fonts, PDF assets and Blob previews
// remain available. Do not weaken script-src with unsafe-inline or unsafe-eval.
export const MOBILE_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; frame-src 'self' blob: data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'";
export function mobileCspHtml(html) {
  const policies = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? [];
  if (policies.length !== 1 || !policies[0].includes('id="tarobot-csp"') || !html.includes("<head>")) throw new Error("mobile_csp_marker_missing_or_ambiguous");
  // Capacitor Android 8 injects its trusted native bridge immediately after the
  // literal <head>, before this meta. Keep that hook intact; subsequent App
  // resources are governed by this policy. iOS injects WKUserScript natively.
  return html.replace(/<meta name="tarobot-widget-guard" content="1"\/>/g, "").replace(policies[0], `<meta id="tarobot-csp" http-equiv="Content-Security-Policy" content="${MOBILE_CSP}"/><meta name="tarobot-widget-guard" content="1"/>`);
}
export async function protectMobileCopy(root, platform, config = {}) {
  // An unqualified `cap sync` also invokes this hook for the web target.
  // Its networking remains governed by the browser/Hub policy.
  if (platform === "web") return;
  if (!["android", "ios"].includes(platform)) throw new Error("mobile_csp_platform_required");
  if (config.server?.url) throw new Error("mobile_csp_requires_bundled_assets");
  await guardWidgetBridges();
  const folder = config[platform]?.path ?? platform;
  const relative = platform === "android" ? "app/src/main/assets/public/index.html" : "App/App/public/index.html";
  const file = path.resolve(root, folder, relative);
  const html = await readFile(file, "utf8");
  await writeFile(file, mobileCspHtml(html));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await protectMobileCopy(process.env.CAPACITOR_ROOT_DIR ?? process.cwd(), process.env.CAPACITOR_PLATFORM_NAME, JSON.parse(process.env.CAPACITOR_CONFIG ?? "{}"));
  console.log(process.env.CAPACITOR_PLATFORM_NAME === "web" ? "Browser content policy unchanged." : "Mobile bundled content policy verified.");
}

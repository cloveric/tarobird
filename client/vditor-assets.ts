import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const version = "4.0.1", prefix = `vditor/${version}/`;
const root = new URL("./node_modules/vditor/", import.meta.url);
export function vditorAssets(): Plugin {
  if (JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version !== version) throw Error("vditor_asset_version_mismatch");
  const files = new Map(["dist/js/lute/lute.min.js", "dist/js/i18n/zh_CN.js", "dist/js/i18n/en_US.js", "dist/js/icons/ant.js", "LICENSE"].map(name => [prefix + name, readFileSync(new URL(name, root))]));
  files.set(prefix + "Lute-LICENSE.txt", readFileSync(new URL("./licenses/vditor/Lute-LICENSE.txt", import.meta.url)));
  files.set(prefix + "NOTICE.txt", readFileSync(new URL("./licenses/vditor/NOTICE.txt", import.meta.url)));
  return {
    name: "tarobot-local-vditor-assets", enforce: "pre",
    config: () => ({ optimizeDeps: { exclude: ["vditor"] } }),
    transform(code, id) {
      if (id.split("?")[0] !== fileURLToPath(new URL("dist/index.js", root))) return;
      // Vditor's iPhone toolbar-following listener has no teardown. Source mode
      // is already contained by our flex panel and needs no page-level handler.
      const match = 'if (navigator.userAgent.indexOf("iPhone") > -1 && typeof window.visualViewport !== "undefined")';
      if (code.split(match).length !== 2) throw Error("vditor_mobile_listener_contract_changed");
      return { code: code.replace(match, 'if (vditor.options.mode !== "sv" && navigator.userAgent.indexOf("iPhone") > -1 && typeof window.visualViewport !== "undefined")'), map: null };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1), bytes = files.get(name);
        if (!bytes) return next();
        response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/plain; charset=utf-8"); response.end(bytes);
      });
    },
    generateBundle() { for (const [fileName, source] of files) this.emitFile({ type: "asset", fileName, source }); },
  };
}

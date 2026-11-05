import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

const VERSION = "0.18.1";
const root = fileURLToPath(new URL("./node_modules/@excalidraw/excalidraw/", import.meta.url));
const prefix = `excalidraw/${VERSION}/`;
const prodFallback = /\b\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/g;
const devFallback = /\b\w+\.push\(new URL\(\w+,\s*_ExcalidrawFontFace\.ASSETS_FALLBACK_URL\)\);/g;

/** The pinned component otherwise silently falls back to an external CDN when a
 * local font fails. Fail the build if upstream changes this narrow patch point. */
export function removeExcalidrawFontFallback(source: string): string {
  const matches = source.match(prodFallback) ?? [];
  if (matches.length !== 1) throw new Error(`excalidraw_${VERSION}_font_fallback_contract_changed`);
  return source.replace(devFallback, "").replace(prodFallback, "void 0");
}

const viewportGetter = /("getEditorUIOffsets",\s*\(\)\s*=>\s*\{)([\s\S]*?)(\}\);?)(?=\s*(?:\/\/ Input handling\s*)?(?:__publicField|C)\(this,\s*"onKeyDown")/g;
const viewportBodies = new Set([
  "0035bfd43c4e556dbb9c6770c093ab8fc0ec746571fc861ef7703d6b48c46eb1", // 0.18.1 dev
  "fb433dc89d14ee6c5db5322bb377773be2e201c839afef0becbd3a57ce12d4e6", // 0.18.1 prod
]);
/** Upstream 0.18.1 passes page-space toolbar/sidebar bounds to its local
 * viewport fit math. Embedded editors below the page origin can get a negative
 * usable height. Correct only these three rectangles, preserving all actions. */
export function localizeExcalidrawViewportOffsets(source: string): string {
  const matches = [...source.matchAll(viewportGetter)];
  if (matches.length !== 1 || !viewportBodies.has(createHash("sha256").update(matches[0][2]).digest("hex"))) throw new Error(`excalidraw_${VERSION}_viewport_offsets_contract_changed`);
  const body = matches[0][2];
  const rectangles = /this\.excalidrawContainerRef\?\.current\?\.querySelector\("(?:\.App-toolbar|\.sidebar|\.App-menu__left)"\)\?\.getBoundingClientRect\(\)/g;
  if ([...body.matchAll(rectangles)].length !== 3) throw new Error(`excalidraw_${VERSION}_viewport_rectangles_changed`);
  const corrected = body.replace(rectangles, value => `_tarobotViewportRect(${value.replace(/\?\.getBoundingClientRect\(\)$/, "")})`);
  const relativeRect = `const _tarobotViewportRect = element => { if (!element) return undefined; const rect = element.getBoundingClientRect(), origin = this.excalidrawContainerRef.current.getBoundingClientRect(); return {top:rect.top-origin.top,right:rect.right-origin.left,bottom:rect.bottom-origin.top,left:rect.left-origin.left,width:rect.width,height:rect.height}; };`;
  return source.replace(viewportGetter, (_match, start, _body, end) => start + relativeRect + corrected + end);
}

export function excalidrawAssets(): Plugin {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.version !== VERSION) throw new Error("excalidraw_asset_version_mismatch");
  const files = new Map<string, Buffer>();
  const add = (directory: string, base: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory() && item.name !== "Liberation") add(path, base);
      else if (item.isFile()) files.set(prefix + relative(base, path).split("\\").join("/"), readFileSync(path));
    }
  };
  add(join(root, "dist/prod/fonts"), join(root, "dist/prod"));
  const notices = fileURLToPath(new URL("./licenses/excalidraw/", import.meta.url));
  if (existsSync(notices)) for (const item of readdirSync(notices)) if (/\.(txt|json)$/.test(item)) files.set(prefix + "licenses/" + item, readFileSync(join(notices, item)));
  let patched = 0, viewportPatched = 0;
  return {
    name: "tarobot-local-excalidraw-assets", enforce: "pre",
    config() {
      // Keep the package unprebundled so its exact version-checked transform also
      // runs in development, not only in the production Rollup pipeline.
      return { optimizeDeps: { exclude: ["@excalidraw/excalidraw"], include: Object.keys(packageJson.dependencies)
        .filter(name => !["sass", "cross-env", "open-color", "pwacompat"].includes(name))
        .map(name => `@excalidraw/excalidraw > ${name}`) } };
    },
    buildStart() { patched = 0; viewportPatched = 0; },
    transform(code, id) {
      const moduleId = id.split("?")[0];
      if (!moduleId.includes("/@excalidraw/excalidraw/dist/") || !moduleId.endsWith(".js")) return null;
      let next = code;
      if (/\w+\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/.test(next)) {
        patched++; next = `if (typeof window !== "undefined") window.EXCALIDRAW_ASSET_PATH = new URL("/${prefix}", window.location.href).href;\n` + removeExcalidrawFontFallback(next);
      }
      if (next.includes('"getEditorUIOffsets",')) { viewportPatched++; next = localizeExcalidrawViewportOffsets(next); }
      return next === code ? null : { code: next, map: null };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname.slice(1), bytes = files.get(path);
        if (!bytes) { next(); return; }
        response.setHeader("Content-Type", path.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.end(bytes);
      });
    },
    generateBundle(_options, bundle) {
      if (patched !== 1) throw new Error(`excalidraw_${VERSION}_font_transform_missing`);
      if (viewportPatched !== 1) throw new Error(`excalidraw_${VERSION}_viewport_transform_missing`);
      for (const [fileName, source] of files) this.emitFile({ type: "asset", fileName, source });
      const packages = new Map<string, string>();
      for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") for (const id of Object.keys(chunk.modules)) {
        const index = id.lastIndexOf("/node_modules/"); if (index < 0) continue;
        const parts = id.slice(index + 14).split("/");
        const directory = resolve(id.slice(0, index + 14), parts[0], ...(parts[0].startsWith("@") ? [parts[1]] : []));
        const manifest = join(directory, "package.json"); if (!existsSync(manifest) || packages.has(directory)) continue;
        const data = JSON.parse(readFileSync(manifest, "utf8"));
        const licenses = readdirSync(directory).filter(name => /^(?:license|licence|copying|notice)(?:[._-].*)?$/i.test(name));
        const texts = licenses.flatMap(name => { try { return [readFileSync(join(directory, name), "utf8")]; } catch { return []; } });
        const fallback = data.name === "@excalidraw/excalidraw" ? "Excalidraw-LICENSE.txt" : data.name.startsWith("@radix-ui/") ? "Radix-LICENSE.txt" : ["fastdom", "react-remove-scroll-bar"].includes(data.name) ? `${data.name}-LICENSE.txt` : null;
        const own = fallback ? readFileSync(join(notices, fallback), "utf8") : "";
        if (!texts.length && !own) throw new Error(`bundled_dependency_license_missing:${data.name}@${data.version}`);
        packages.set(directory, `${data.name}@${data.version}\nLicense: ${typeof data.license === "string" ? data.license : JSON.stringify(data.license ?? data.licenses ?? "unknown")}\n${texts.join("\n") || own}`);
      }
      this.emitFile({ type: "asset", fileName: prefix + "licenses/bundled-dependencies.txt", source: [...packages.values()].sort().join("\n\n====================\n\n") });
    },
  };
}

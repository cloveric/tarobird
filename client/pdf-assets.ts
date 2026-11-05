import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Pin all parser support files alongside the worker. An exact path map keeps
 * development requests inside the shipped package and works without a CDN. */
export function pdfAssets(): Plugin {
  const version = "6.4.299";
  const files = new Map<string, Buffer>();
  for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    const directory = new URL(`./node_modules/pdfjs-dist/${folder}/`, import.meta.url);
    for (const item of readdirSync(fileURLToPath(directory), { withFileTypes: true })) {
      if (item.isFile()) files.set(`pdfjs/${version}/${folder}/${item.name}`, readFileSync(new URL(item.name, directory)));
    }
  }
  return {
    name: "tarocub-pdf-resources",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname.slice(1);
        const bytes = files.get(pathname); if (!bytes) { next(); return; }
        res.setHeader("Content-Type", /\.m?js$/.test(pathname) ? "text/javascript" : pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        res.setHeader("Cache-Control", "no-store"); res.end(bytes);
      });
    },
    generateBundle() {
      for (const [fileName, source] of files) this.emitFile({ type: "asset", fileName, source });
    },
  };
}

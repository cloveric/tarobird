import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { mobileCspHtml } from "../../scripts/mobile-csp.mjs";

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server) => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
export async function mobileContentServer() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = await mkdtemp(path.join(os.tmpdir(), "tarobot-mobile-policy-"));
  let requests = 0;
  const probe = createServer((_req, res) => { requests++; res.setHeader("Access-Control-Allow-Origin", "*"); res.end("probe"); });
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/__status") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ requests })); return; }
    const file = path.resolve(output, pathname === "/" ? "e2e/fixtures/mobile-content.html" : `.${pathname}`);
    if (!file.startsWith(output + path.sep)) { res.writeHead(404); res.end(); return; }
    try {
      const bytes = await readFile(file);
      res.setHeader("Content-Type", file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
      res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  try {
    const probePort = await listen(probe);
    await build({ root, configFile: path.join(root, "vite.config.ts"), logLevel: "silent", build: { outDir: output, emptyOutDir: false, rollupOptions: { input: path.join(root, "e2e/fixtures/mobile-content.html") } } });
    const entry = path.join(output, "e2e/fixtures/mobile-content.html");
    await writeFile(entry, mobileCspHtml(await readFile(entry, "utf8")).replace("__PROBE_URL__", `http://127.0.0.1:${probePort}`));
    return { url: `http://127.0.0.1:${await listen(server)}`, requests: () => requests, close: async () => { await Promise.all([close(server), close(probe)]); await rm(output, { recursive: true, force: true }); } };
  } catch (error) { await Promise.all([close(server), close(probe)]); await rm(output, { recursive: true, force: true }); throw error; }
}

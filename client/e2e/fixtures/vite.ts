import { createServer as createViteServer, type InlineConfig } from "vite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";

// Parallel browser suites must not invalidate each other's optimized modules.
// Keep each fixture server's cache local to the project and clean it on close.
export async function createServer(config: InlineConfig = {}) {
  const cacheDir = await mkdtemp(path.resolve("node_modules/.vite-e2e-"));
  try {
    const dependencies = await realpath(path.resolve("node_modules"));
    const server = await createViteServer({ ...config, cacheDir });
    // Worktrees can share node_modules outside the repository. Vite resolves
    // CSS font URLs to that real path; allow only this dependency directory so
    // fixture screenshots use the bundled fonts instead of silent fallbacks.
    if (!server.config.server.fs.allow.includes(dependencies)) server.config.server.fs.allow.push(dependencies);
    const close = server.close.bind(server);
    server.close = async () => {
      try { await close(); } finally { await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 }); }
    };
    return server;
  } catch (error) {
    await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

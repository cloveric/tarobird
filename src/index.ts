import { desktopStartupError, type DesktopStartupPhase } from "./runtime/startup-error.js";
// Capture before the Hub removes this launch-only capability from child envs.
const supervisedStartup = !!process.env.TAROBOT_HOST_SUPERVISOR;
let desktopStartupPhase: DesktopStartupPhase | undefined;
async function main(): Promise<void> {
 const [command, ...args] = process.argv.slice(2);
 if (command === "--version" || command === "-v") {
  const { readFile } = await import("node:fs/promises");
  let url = new URL("../package.json", import.meta.url);
  for (;;) { try { console.log(JSON.parse(await readFile(url, "utf8")).version); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = new URL("../package.json", url); if (parent.href === url.href) throw error; url = parent; } }
 }
 if (command === "host") { await (await import("./host-cli/cli.js")).runHostCli(args); return; }
 if (command === "desktop-update") { await (await import("./hub/desktop-update.js")).runDesktopUpdateCli(args); return; }
 if (command === "desktop-host") {
  desktopStartupPhase = "desktop_module";
  const { runDesktopHostCli } = await import("./hub/desktop.js");
  desktopStartupPhase = "desktop_command";
  await runDesktopHostCli(args); return;
 }
 if (command === "hub") {
  if (["devices", "bots", "export", "backup", "restore", "gc", "storage", "compact"].includes(args[0] ?? "") && !args.some(arg => arg === "--help" || arg === "-h") && !args.some(arg => arg === "--state-dir" || arg.startsWith("--state-dir="))) throw new Error("Offline hub maintenance requires explicit --state-dir; use tarobot init to create a host.");
  await (await import("./hub/cli.js")).runHubCli(args); return;
 }
 if (command === "gateway") { await (await import("./gateway/worker.js")).runGatewayWorker(args); return; }
 if (command === "relay") { await (await import("./relay/cli.js")).runRelayCli(args); return; }
 if (command === "gdocs") { await (await import("./gdocs/cli.js")).runGoogleDocsCli(args); return; }
 if (command === "search-mcp") { await (await import("./runtime/search-mcp-entry.js")).runConfiguredSearchMcp(); return; }
 await (await import("./host-cli/cli.js")).runHostCli(command ? [command, ...args] : []);
}
void main().catch((error: unknown) => {
 if (desktopStartupPhase) console.error(desktopStartupError(error, desktopStartupPhase));
 console.error(error instanceof Error ? error.message : String(error));
 const code = error && typeof error === "object" && "exitCode" in error ? error.exitCode : undefined;
 process.exitCode = code === 0 ? 0 : code === 130 ? 130 : code === 78 ? process.platform === "darwin" && supervisedStartup ? 0 : 78 : 1;
 // Gateway cleanup has already run. Lingering engine handles must not leave a
 // failed worker alive and prevent its owning Hub from replacing it.
 if (process.argv[2] === "gateway") process.exit(process.exitCode);
});

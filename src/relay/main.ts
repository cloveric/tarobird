import { runRelayCli } from "./cli.js";
await runRelayCli(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "relay_failed"); process.exitCode = 1; });

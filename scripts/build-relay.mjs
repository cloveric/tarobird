import { build } from "esbuild";
await build({ entryPoints: ["src/relay/main.ts"], outfile: "dist/relay-runtime.mjs", bundle: true, platform: "node", target: "node24", format: "esm", legalComments: "inline" });

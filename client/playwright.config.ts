import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Model pickers use the built-in lists; a live spec may opt back in.
process.env.TAROBOT_MODEL_DISCOVERY ??= "0";

export default defineConfig({
  globalSetup: fileURLToPath(new URL("./scripts/playwright-keychain-guard.mjs", import.meta.url)),
  testDir: "./e2e", fullyParallel: false, workers: 1, timeout: 60_000,
  use: { headless: true, viewport: { width: 1360, height: 900 }, trace: "retain-on-failure" }, reporter: "list",
});

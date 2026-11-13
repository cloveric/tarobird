import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Model pickers use the built-in lists; a live spec may opt back in.
process.env.TAROBOT_MODEL_DISCOVERY ??= "0";

export default defineConfig({
  // Warning only: macOS WebKit is allowed; this setup never blocks browser launch.
  globalSetup: fileURLToPath(new URL("./scripts/playwright-keychain-guard.mjs", import.meta.url)),
  testDir: "./e2e", fullyParallel: false, workers: 1, timeout: 60_000,
  // Explicit browserName wins over a device descriptor's defaultBrowserType.
  // The App follows the browser language on first launch; specs assert Chinese UI text.
  use: { browserName: "chromium", headless: true, locale: "zh-CN", viewport: { width: 1360, height: 900 }, trace: "retain-on-failure" }, reporter: "list",
});

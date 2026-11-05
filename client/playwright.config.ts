import { defineConfig } from "@playwright/test";

export default defineConfig({ testDir: "./e2e", fullyParallel: false, workers: 1, timeout: 60_000, use: { headless: true, viewport: { width: 1360, height: 900 }, trace: "retain-on-failure" }, reporter: "list" });

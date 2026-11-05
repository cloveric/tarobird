import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["tests/fixtures/gateway-guard-swallow.case.ts"],
  setupFiles: ["./tests/setup-gateway-guard.ts"],
  fileParallelism: false,
} });

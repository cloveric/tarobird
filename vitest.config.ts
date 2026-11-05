import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Native audit process tests use node:test; run via the client's dedicated
    // test:audit-runner script, not Vitest's suite collector.
    exclude: [...configDefaults.exclude, "**/dist/**", "**/.claude/worktrees/**", "client/e2e/**", "client/scripts/*.test.mjs", "client/electron/tests/**", "client/src-desktop-updater/tests/lab.test.mjs", "scripts/macos-artifact-paths.test.mjs", "scripts/check-upload-privacy.test.mjs", "scripts/release-version.test.mjs"],
    // Runs before each test file: normalizes a too-long inherited TMPDIR so
    // deep-path tests don't spuriously fail. See tests/setup-tmpdir.ts.
    setupFiles: ["./tests/setup-instance-env.ts", "./tests/setup-tmpdir.ts", "./tests/setup-gateway-guard.ts"],
  },
});

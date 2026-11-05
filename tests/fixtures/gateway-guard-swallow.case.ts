// Intentionally faulty fixture, collected only by gateway-guard.vitest.config.ts.
// The surrounding self-test requires this test run to fail despite swallowed errors.
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it("cannot hide child-process violations by catching the errors", () => {
  try { execFileSync(process.execPath, [process.env.GUARD_FAKE!]); } catch { /* deliberately swallowed */ }
  expect(true).toBe(true);
});

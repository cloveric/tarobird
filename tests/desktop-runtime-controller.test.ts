import { it } from "vitest";
import assert from "node:assert/strict";
import { prepareLocalController, recoverLocalController } from "../client/src/local-controller.js";
import type { HostRegistry } from "../client/src/host-registry.js";
import { startupAttempt } from "../client/src/startup-diagnostics.js";

function fixture() {
  let closed = 0;
  const record = { id: "local", state: "ready", publicKey: "host-key", registrationId: "original" };
  const registry = {
    nativeLocalHost: async () => "host-key", rememberNativeLocalHost: async () => {}, list: async () => [record],
    open: async () => ({ identity: { deviceId: "device", publicKey: "device-key", keyRef: "device" }, cache: { close() { closed++; } } }),
  } as unknown as HostRegistry;
  return { registry, closed: () => closed };
}
const healthy = { available: true, running: true, publicKey: "host-key" };
const proof = ["desktop-controller-challenge", "enroll-desktop-controller"];

for (const [error, expected] of [
  ["desktop_host_operation_failed|exit=1|reason=runtime_update_required", "runtime_update_required"],
  ["desktop_host_update_required", "runtime_update_required"],
  ["device_key_unavailable", "keychain"], ["system_keychain_busy", "keychain"],
  ["desktop_host_device_key_mismatch", "credentials"],
  ["desktop_host_operation_failed|reason=controller_proof_rejected", "credentials"],
  ["desktop_host_operation_failed|reason=control_closed", "controller_failed"],
  ["local_controller_registration_changed", "controller_failed"],
  ["private path and secret must never be echoed", "controller_failed"],
] as const) it(`classifies pairing failure ${expected}: ${error.split("|")[0]}`, async () => {
  const f = fixture();
  const result = await prepareLocalController(f.registry, async ({ action }) => { if (action === "pair") throw new Error(error); return healthy; });
  assert.deepEqual(result, { publicKey: "host-key", pending: true, issue: expected });
  assert.equal(f.closed(), 1);
});

for (const issue of ["runtime_update_required", "runtime_restart_required", "runtime_recovery_failed", "runtime_waiting"] as const) {
  it(`reports ${issue} before attempting unsupported native pairing`, async () => {
    let pairs = 0;
    const result = await prepareLocalController(fixture().registry, async ({ action }) => {
      if (action === "pair") pairs++;
      return { ...healthy, runtimeIssue: issue };
    });
    assert.deepEqual(result, { publicKey: "host-key", pending: true, issue }); assert.equal(pairs, 0);
  });
}
it("keeps a compatible busy host usable so its pending questions can be answered", async () => {
  let pairs = 0;
  const result = await prepareLocalController(fixture().registry, async ({ action }) => {
    if (action === "pair") pairs++;
    return { ...healthy, runtimeIssue: "runtime_waiting", controlCapabilities: proof };
  });
  assert.deepEqual(result, { publicKey: "host-key", pending: false, issue: "runtime_waiting" }); assert.equal(pairs, 1);
});
it("native verification after a successful host handoff clears the pending connection", async () => {
  let pairs = 0, refreshes = 0;
  const pool = { localHostKey: "host-key", localControllerPending: true, refresh: async () => { refreshes++; } };
  await recoverLocalController(fixture().registry, pool, () => {}, () => true, async ({ action }) => {
    if (action === "pair") pairs++;
    return { ...healthy, controlCapabilities: proof };
  });
  assert.equal(pool.localControllerPending, false); assert.equal(pool.localHostKey, "host-key"); assert.equal(pairs, 1); assert.equal(refreshes, 1);
});
it("a proof-compatible old host without safe handoff stays usable for finishing work", async () => {
  let pairs = 0;
  const result = await prepareLocalController(fixture().registry, async ({ action }) => {
    if (action === "pair") pairs++;
    return { ...healthy, runtimeIssue: "runtime_restart_required", controlCapabilities: proof };
  });
  assert.deepEqual(result, { publicKey: "host-key", pending: false, issue: "runtime_restart_required" }); assert.equal(pairs, 1);
});
it("manual restart guidance does not pause an already authenticated compatible host", async () => {
  const pool = { localHostKey: "host-key", localControllerPending: false, refresh: async () => { throw new Error("unexpected refresh"); } };
  await recoverLocalController(fixture().registry, pool, result => assert.equal(result.pending, false), () => true, async () => ({
    ...healthy, runtimeIssue: "runtime_restart_required", controlCapabilities: proof,
  }));
  assert.equal(pool.localControllerPending, false);
});
it("waiting does not pause an already authenticated pool or enroll a second device", async () => {
  let refreshes = 0, calls = 0;
  const pool = { localHostKey: "host-key", localControllerPending: false, refresh: async () => { refreshes++; } };
  await recoverLocalController(fixture().registry, pool, result => assert.equal(result.pending, false), () => true, async ({ action }) => {
    assert.equal(action, "resume"); calls++; return { ...healthy, runtimeIssue: "runtime_waiting" };
  });
  assert.equal(pool.localControllerPending, false); assert.equal(refreshes, 0); assert.equal(calls, 1);
});
it("identity changes still take priority over update status", async () => {
  const result = await prepareLocalController(fixture().registry, async () => ({ ...healthy, publicKey: "unexpected", runtimeIssue: "runtime_waiting" }));
  assert.equal(result.issue, "identity_changed"); assert.equal(result.publicKey, "host-key");
});
it("clears the waiting notice after handoff without pairing an already healthy pool again", async () => {
  const published: unknown[] = [];
  const pool = { localHostKey: "host-key", localControllerPending: false, refresh: async () => { throw new Error("unexpected refresh"); } };
  await recoverLocalController(fixture().registry, pool, result => published.push(result), () => true, async ({ action }) => {
    assert.equal(action, "resume"); return { ...healthy, runtimeIssue: "runtime_waiting" };
  });
  await recoverLocalController(fixture().registry, pool, result => published.push(result), () => true, async ({ action }) => {
    assert.equal(action, "resume"); return healthy;
  });
  assert.deepEqual(published, [{ publicKey: "host-key", pending: false, issue: "runtime_waiting" }, { publicKey: "host-key", pending: false }]);
});
it("safe diagnostic fields survive parsing without exposing raw native output", () => {
  assert.equal(startupAttempt("resume", "desktop_host_operation_failed|reason=runtime_update_required").reason, "runtime_update_required");
  assert.equal(startupAttempt("resume", "desktop_host_operation_failed|reason=private path").reason, undefined);
});

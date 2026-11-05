import { it } from "vitest";
import assert from "node:assert/strict";
import { desktopRuntimePolicy } from "../src/client-protocol/desktop-runtime.js";

const proof = ["desktop-controller-challenge", "enroll-desktop-controller"];
const safe = ["drain", "drain-renew", "drain-cancel", "drained-stop"];
for (const [name, status, independent, expected] of [
  ["DMG replacement upgrades an older App-owned process missing native proof", { version: "0.1.420", drained: false, controlCapabilities: safe }, false, "upgrade"],
  ["an older compatible App-owned process also receives the installed fixes", { version: "0.1.443", drained: false, controlCapabilities: [...safe, ...proof] }, false, "upgrade"],
  ["a matching process stays running", { version: "0.1.444", controlCapabilities: proof }, false, "current"],
  ["a newer compatible process is never downgraded", { version: "0.1.445", controlCapabilities: proof }, false, "current"],
  ["a same-version incomplete runtime is not restarted in a loop", { version: "0.1.444", drained: false, controlCapabilities: safe }, false, "update_required"],
  ["a newer incompatible process is not downgraded", { version: "0.2.0", drained: false, controlCapabilities: safe }, false, "update_required"],
  ["a separately selected older runtime is not replaced", { version: "0.1.420", drained: false, controlCapabilities: safe }, true, "update_required"],
  ["a compatible independent runtime is retained", { version: "0.1.420", controlCapabilities: proof }, true, "current"],
  ["an old host without safe stop needs explicit recovery", { version: "0.1.420", controlCapabilities: proof }, false, "restart_required"],
  ["one missing drain capability prevents automatic termination", { version: "0.1.420", drained: true, controlCapabilities: safe.slice(0, -1) }, false, "restart_required"],
  ["unknown versions do not trigger a guessed restart", { controlCapabilities: safe }, false, "restart_required"],
  ["compatible unknown versions keep working", { controlCapabilities: proof }, false, "current"],
  ["prerelease ordering is not guessed", { version: "0.2.0-rc.1", drained: true, controlCapabilities: safe }, false, "restart_required"],
  ["version numbers are compared numerically", { version: "0.1.99", drained: true, controlCapabilities: safe }, false, "upgrade"],
] as const) {
  it(name, () => assert.equal(desktopRuntimePolicy(status, "0.1.444", independent), expected));
}

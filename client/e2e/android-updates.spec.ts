import { test, expect } from "@playwright/test";
import { AndroidUpdateController, type AndroidUpdateState, type AndroidUpdateBridge } from "../src/android-update-controller.js";

function fixture() {
  let state: AndroidUpdateState = { phase: "available", version: "1.0.88", nextVersion: "1.0.89", authenticated: true };
  const calls: string[] = []; let fail = "", done!: (value: AndroidUpdateState) => void;
  const bridge: AndroidUpdateBridge = {
    status: async () => state, openLogin: async () => {}, addListener: async () => ({ remove: async () => {} }),
    cancel: async () => { fail = "github_update_cancelled"; },
    invoke: async ({ command }) => {
      calls.push(command);
      if (command === "download") { if (fail) throw new Error(fail); return state = { ...state, phase: "ready", downloaded: true }; }
      if (command === "install") return new Promise<AndroidUpdateState>(resolve => { done = resolve; });
      if (command === "check") return state;
      if (command === "github_update_logout") return state = { phase: "initial", authenticated: false, downloaded: false };
      throw new Error("unexpected");
    },
  };
  const controller = new AndroidUpdateController(bridge);
  return { controller, calls, fail: (value: string) => { fail = value; }, state: (value: AndroidUpdateState) => { state = value; }, done: () => done({ ...state, phase: "ready" }) };
}
test("Android installer launch stays pending, cancellation retains verified download and retry does not redownload", async () => {
  const f = fixture(); await f.controller.refresh(); expect(f.calls).toEqual([]);
  const first = f.controller.install(); await expect.poll(() => f.controller.snapshot().phase).toBe("install-pending");
  expect(f.controller.install()).not.toBe(first); // disabled state performs no second call
  expect(f.calls).toEqual(["download", "install"]);
  f.done(); await first; expect(f.controller.snapshot().phase).toBe("ready");
  const retry = f.controller.install(); await expect.poll(() => f.calls.length).toBe(3);
  expect(f.calls).toEqual(["download", "install", "install"]); f.done(); await retry;
});
test("failed verification never opens installer and unknown native detail is not displayed", async () => {
  const f = fixture(); await f.controller.refresh(); f.fail("github_update_signature"); await f.controller.install();
  expect(f.calls).toEqual(["download"]); expect(f.controller.snapshot()).toMatchObject({ phase: "error", error: "github_update_signature" });
  f.fail("secret response content"); await f.controller.install(); expect(f.controller.snapshot().error).toBe("github_update_failed");
});
test("startup restores an already downloaded update and logout removes the offer", async () => {
  const f = fixture(); f.state({ phase: "ready", version: "1.0.88", nextVersion: "1.0.89", downloaded: true, authenticated: true });
  await f.controller.refresh(); const pending = f.controller.install(); await expect.poll(() => f.calls.length).toBe(1);
  expect(f.calls).toEqual(["install"]); f.done(); await pending; await f.controller.logout();
  expect(f.controller.snapshot()).toMatchObject({ phase: "initial", downloaded: false, authenticated: false });
  expect(f.controller.snapshot().nextVersion).toBeUndefined();
});
test("revoked authorization cannot be interpreted as current or installed", async () => {
  const f = fixture(); f.controller.bridge.invoke = async () => { throw new Error("github_update_login_required"); };
  await f.controller.check(); expect(f.controller.snapshot()).toMatchObject({ phase: "error", error: "github_update_login_required", authenticated: false });
});

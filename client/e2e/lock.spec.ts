import { test, expect } from "@playwright/test";
import { LockController, type LockBackend } from "../src/lock-controller.js";

test("a stored lock hides cold-start data, failed authentication stays locked, and returning requires a new unlock", async () => {
  let fail = true; let foreground = true; let prompts = 0; const shield: boolean[] = [];
  const lock = new LockController({ load: async () => true, save: async () => undefined, available: async () => true, active: async () => foreground, privacy: async (on) => { shield.push(on); }, authenticate: async () => { prompts++; lock.background(); if (fail) throw new Error("cancelled"); } });
  expect(lock.state.locked).toBe(true); await lock.initialize(); expect(lock.state).toMatchObject({ ready: true, enabled: true, locked: true });
  await lock.unlock(); expect(lock.state.locked).toBe(true); expect(lock.state.error).toBe("cancelled");
  fail = false; await lock.unlock(); expect(lock.state.locked).toBe(false); lock.background(); expect(lock.state.locked).toBe(true);
  foreground = false; await lock.unlock(); expect(lock.state.locked).toBe(true); expect(prompts).toBe(3); expect(shield).toEqual([true]);
});
test("enabling and disabling require authentication and cannot lose the old policy when storage fails", async () => {
  let saved = false; let rejectWrite = false; let prompts = 0; let privacy = false;
  const backend: LockBackend = { load: async () => saved, save: async (on) => { if (rejectWrite) throw new Error("storage unavailable"); saved = on; }, available: async () => true, active: async () => true, privacy: async (on) => { privacy = on; }, authenticate: async () => { prompts++; } };
  const lock = new LockController(backend); await lock.initialize(); expect(lock.state.locked).toBe(false);
  await lock.setEnabled(true); expect(saved).toBe(true); expect(privacy).toBe(true); lock.background(); expect(lock.state.locked).toBe(true); await lock.unlock();
  rejectWrite = true; await lock.setEnabled(false); expect(saved).toBe(true); expect(privacy).toBe(true); expect(lock.state.enabled).toBe(true);
  rejectWrite = false; await lock.setEnabled(false); expect(saved).toBe(false); expect(privacy).toBe(false); lock.background(); expect(lock.state.locked).toBe(false); expect(prompts).toBe(4);
});
test("unavailable secure storage fails closed without starting the app", async () => {
  const lock = new LockController({ load: async () => { throw new Error("secure storage unavailable"); }, save: async () => undefined, available: async () => true, authenticate: async () => undefined, active: async () => true, privacy: async () => undefined });
  await lock.initialize(); expect(lock.state).toMatchObject({ ready: false, locked: true, busy: false });
});

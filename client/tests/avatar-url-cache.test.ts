import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/connection.js", () => ({ HubConnection: class {} }));
import { acquireAvatarUrl, releaseAvatarUrl, AVATAR_URL_LINGER_MS } from "../src/Avatar.js";

let created = 0;
beforeEach(() => {
  vi.useFakeTimers(); created = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:fixture-${++created}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("shares one decoded URL between instances and revokes it only after the last one lingers out", async () => {
  const load = vi.fn(async () => new Blob(["png"]));
  const a = acquireAvatarUrl("host:bot:a:1", load), b = acquireAvatarUrl("host:bot:a:1", load);
  expect(a).toBe(b); expect(load).toHaveBeenCalledOnce();
  expect(await a.url).toBe("blob:fixture-1");
  releaseAvatarUrl("host:bot:a:1", a);
  await vi.advanceTimersByTimeAsync(AVATAR_URL_LINGER_MS);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  releaseAvatarUrl("host:bot:a:1", b);
  // A virtualized row remounting during the linger reuses the same URL.
  await vi.advanceTimersByTimeAsync(AVATAR_URL_LINGER_MS / 2);
  const again = acquireAvatarUrl("host:bot:a:1", load);
  expect(again).toBe(a); expect(load).toHaveBeenCalledOnce();
  releaseAvatarUrl("host:bot:a:1", again);
  await vi.advanceTimersByTimeAsync(AVATAR_URL_LINGER_MS);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fixture-1");
  // After revocation a new mount loads again.
  acquireAvatarUrl("host:bot:a:1", load); expect(load).toHaveBeenCalledTimes(2);
});

it("does not cache failures and never leaks a URL created after every user left", async () => {
  const failing = vi.fn(async () => { throw new Error("offline"); });
  const failed = acquireAvatarUrl("host:bot:b:1", failing);
  await expect(failed.url).rejects.toThrow("offline");
  releaseAvatarUrl("host:bot:b:1", failed);
  const ok = vi.fn(async () => new Blob(["png"]));
  const retried = acquireAvatarUrl("host:bot:b:1", ok);
  expect(retried).not.toBe(failed); expect(ok).toHaveBeenCalledOnce();
  await retried.url; releaseAvatarUrl("host:bot:b:1", retried);

  let finish!: (blob: Blob) => void;
  const slow = acquireAvatarUrl("host:bot:c:1", () => new Promise<Blob>((resolve) => { finish = resolve; }));
  releaseAvatarUrl("host:bot:c:1", slow);
  await vi.advanceTimersByTimeAsync(AVATAR_URL_LINGER_MS);
  finish(new Blob(["late"]));
  const url = await slow.url;
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
});

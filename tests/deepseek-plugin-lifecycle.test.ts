import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { connectDeepSeekAppPlugin } from "../src/codex/deepseek-app-plugin.js";
import { NativeAppPipe } from "../src/codex/native-app-pipe.js";

function fixture(callable = false) {
  const input = new PassThrough(), output = new PassThrough();
  const dispose = vi.fn(async () => {});
  let resolve!: (handle: { dispose: typeof dispose }) => void, reject!: (error: Error) => void;
  const ready = new Promise<{ dispose: typeof dispose }>((yes, no) => { resolve = yes; reject = no; });
  const legacyDispose = vi.fn();
  const registration = callable ? Object.assign(legacyDispose, { then: ready.then.bind(ready) }) : ready;
  const hooks = new Set<string>();
  let unload: (() => unknown) | undefined;
  const ctx = {
    agents: { get: () => undefined },
    get: () => ({ register: () => registration }),
    on: (name: string) => { hooks.add(name); return () => { hooks.delete(name); }; },
    effect: (effect: () => (() => unknown)) => { unload = effect(); },
  } as unknown as Parameters<typeof connectDeepSeekAppPlugin>[0];
  const host = new NativeAppPipe(output, input, async () => ({}));
  const connecting = Promise.resolve(connectDeepSeekAppPlugin(ctx, input, output));
  return { input, output, dispose, legacyDispose, resolve: () => resolve({ dispose }), reject, hooks, host, connecting, unload: () => unload?.() };
}

describe("DeepSeek asynchronous projection lifecycle", () => {
  it.each([false, true])("waits for registration before installing consumers and answering the private pipe (callable=%s)", async callable => {
    const f = fixture(callable); let answered = false;
    const response = f.host.request("install", { sessionId: "missing", definitions: [{ name: "app_send_file", description: "send", inputSchema: {} }] }).then(value => { answered = true; return value; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.hooks.size).toBe(0); expect(answered).toBe(false);
    f.resolve(); const close = await f.connecting;
    expect(await response).toEqual({ installed: false });
    f.host.close(); await Promise.resolve(); expect(f.dispose).not.toHaveBeenCalled();
    await close(); await close(); expect(f.dispose).toHaveBeenCalledOnce(); expect(f.hooks.size).toBe(0);
    expect(f.legacyDispose).not.toHaveBeenCalled();
  });

  it("closes pipes and installs no consumers when registration fails", async () => {
    const f = fixture();
    const failed = expect(f.connecting).rejects.toThrow("registration failed");
    f.reject(new Error("registration failed")); await failed;
    expect(f.input.destroyed).toBe(true); expect(f.output.destroyed).toBe(true);
    expect(f.hooks.size).toBe(0); expect(f.dispose).not.toHaveBeenCalled();
    f.host.close();
  });

  it.each(["unload", "pipe"])("releases a late registration after %s without resurrecting the plugin", async reason => {
    const f = fixture(); const failed = expect(f.connecting).rejects.toThrow(/closed/i);
    if (reason === "unload") await f.unload(); else f.host.close();
    f.resolve(); await failed;
    expect(f.hooks.size).toBe(0); expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.input.destroyed).toBe(true); expect(f.output.destroyed).toBe(true);
    f.host.close();
  });
});

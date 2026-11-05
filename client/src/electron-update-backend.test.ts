import { describe, expect, it } from "vitest";
import { createElectronUpdateBackend, ELECTRON_UPDATE_EVENT } from "./electron-update-backend.js";
import { UpdateController, type UpdateEvent } from "./update-controller.js";

function fakeBridge() {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let installed!: () => void;
  const bridge = {
    calls, listeners,
    emit(payload: unknown) { for (const listener of listeners.get(ELECTRON_UPDATE_EVENT) ?? []) listener(payload); },
    finishInstall: () => installed(),
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push([command, args]);
      if (command === "github_update_info") return { configured: true, version: "1.2.3", provider: "github", authenticated: true, login: "lab-user" } as T;
      if (command === "github_update_check") return { offerId: "offer-1", version: "1.2.4", body: "Notes" } as T;
      if (command === "github_update_install") return new Promise<T>(resolve => { installed = () => resolve(null as T); });
      return null as T;
    },
    on(event: string, receive: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set(); set.add(receive); listeners.set(event, set);
      return () => { set.delete(receive); };
    },
  };
  return bridge;
}

describe("Electron update backend", () => {
  it("drives the shared controller with opaque offers and only this offer's progress", async () => {
    const bridge = fakeBridge();
    const controller = new UpdateController(createElectronUpdateBackend(() => bridge as never));
    await controller.check();
    expect(controller.state).toMatchObject({ phase: "available", provider: "github", nextVersion: "1.2.4", notes: "Notes" });
    const install = controller.install();
    await Promise.resolve(); await Promise.resolve();
    const send = (event: UpdateEvent, offerId = "offer-1") => bridge.emit({ offerId, event });
    send({ event: "Started", data: { contentLength: 100 } });
    send({ event: "Progress", data: { chunkLength: 40 } });
    send({ event: "Progress", data: { chunkLength: 99 } }, "offer-2");
    bridge.emit({ offerId: "offer-1", event: { event: "Unknown" } });
    expect(controller.state).toMatchObject({ phase: "installing", installStage: "downloading", bytes: 40, total: 100 });
    send({ event: "WaitingForHost" });
    expect(controller.state.installStage).toBe("waiting");
    send({ event: "Installing" }); send({ event: "RestartingHost" }); send({ event: "Finished" });
    bridge.finishInstall();
    await install;
    expect(controller.state.phase).toBe("installed");
    expect(bridge.listeners.get(ELECTRON_UPDATE_EVENT)?.size).toBe(0);
    expect(bridge.calls.map(([command]) => command)).toEqual(["github_update_info", "github_update_check", "github_update_install", "github_update_close"]);
    expect(bridge.calls[2][1]).toEqual({ offerId: "offer-1" });
    await controller.restart();
    expect(bridge.calls.at(-1)?.[0]).toBe("restart_client");
  });

  it("unsubscribes when the native install fails", async () => {
    const bridge = fakeBridge();
    bridge.invoke = (async (command: string) => {
      if (command === "github_update_check") return { offerId: "offer-1", version: "1.2.4" };
      if (command === "github_update_install") throw new Error("github_update_signature");
      return { configured: true, version: "1.2.3", provider: "github", authenticated: true };
    }) as typeof bridge.invoke;
    const controller = new UpdateController(createElectronUpdateBackend(() => bridge as never));
    await controller.check();
    await controller.install();
    expect(controller.state).toMatchObject({ phase: "error", error: "github_update_signature" });
    expect(bridge.listeners.get(ELECTRON_UPDATE_EVENT)?.size).toBe(0);
  });
});

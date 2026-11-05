import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenJoin } from "../src/client-protocol/remote-screen.js";
const transport = vi.hoisted(() => ({ pin: undefined as undefined | (() => Promise<string>), connections: [] as Array<{ role: string; receive: (value: unknown) => void; sent: Record<string, unknown>[] }> }));
vi.mock("../client/electron/screen-network.mjs", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  screenPin: () => transport.pin!(),
  openScreenSocket: (_route: unknown, _pin: unknown, role: string, _ticket: string, options: { receive: (value: unknown) => void }) => {
    const connection = { role, receive: options.receive, sent: [] as Record<string, unknown>[] }; transport.connections.push(connection);
    return { readyState: 1, bufferedAmount: 0, send: (text: string) => connection.sent.push(JSON.parse(text)) };
  },
}));
// @ts-expect-error Electron main JavaScript boundary
import { ScreenViewers } from "../client/electron/screen-viewer.mjs";
class Port extends EventEmitter { messages: unknown[] = []; start() {} close() {} postMessage(value: unknown) { this.messages.push(value); } }
const cleanups: Array<() => void> = [];
beforeEach(() => { transport.connections.length = 0; });
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  let resolvePin!: (pin: string) => void;
  const pin = new Promise<string>(resolve => { resolvePin = resolve; }); transport.pin = () => pin;
  const window = { visible: true, minimized: false, isDestroyed: () => false, isFocused: () => true,
    isVisible() { return this.visible; }, isMinimized() { return this.minimized; }, webContents: { postMessage() {} } };
  const port = new Port(), viewers = new ScreenViewers(window, { MessageChannelMain: class { port1 = port; port2 = new Port(); } });
  cleanups.push(() => viewers.retire());
  const join: ScreenJoin = { session: { id: "screen_opening", generation: "generation_opening", desktopId: "desktop", deviceId: "device", deviceName: "Synthetic viewer", createdAt: 1000, state: "viewing", controlAllowed: true,
    display: { id: "display", nativeId: "1", name: "Synthetic display", revision: 1, x: 0, y: 0, width: 640, height: 360, scale: 1, rotation: 0 } }, controlTicket: "c".repeat(43), mediaTicket: "m".repeat(43), expiresAt: 31000, serverTime: 1000 };
  const opening = viewers.open({ channelId: "403229c4-3be2-4a3a-a824-c9555eb65e22", join, network: { url: "https://127.0.0.1:8443", publicKey: "a".repeat(59) + "=" } }, () => true);
  const command = (value: Record<string, unknown>) => port.emit("message", { data: { ...value, sessionId: join.session.id, generation: join.session.generation } });
  return { window, viewers, port, opening, join, command, finishPin: () => resolvePin("f".repeat(64)), attach: () => { const control = transport.connections.find(value => value.role === "control")!; control.receive({ type: "attached", sessionId: join.session.id }); return control; } };
}
it("resamples a window shown during TLS pinning before forwarding an explicit control request", async () => {
  const f = fixture(); f.window.visible = false; f.viewers.windowVisibility(false); f.window.visible = true; f.viewers.windowVisibility(true);
  f.finishPin(); await f.opening; const control = f.attach();
  expect(control.sent).toEqual([]); f.command({ type: "control", frameSequence: 1 });
  expect(control.sent).toEqual([expect.objectContaining({ type: "control", frameSequence: 1 })]);
});
it.each(["hidden", "minimized"])("keeps a %s window paused after TLS pinning and requires explicit control after show", async mode => {
  const f = fixture(); f.window.visible = mode !== "hidden"; f.window.minimized = mode === "minimized"; f.viewers.windowVisibility(false);
  f.finishPin(); await f.opening; const control = f.attach();
  expect(f.port.messages).toContainEqual({ type: "native-visibility", visible: false });
  expect(control.sent).toEqual([expect.objectContaining({ type: "visibility", visible: false })]);
  f.command({ type: "control", frameSequence: 1 }); expect(control.sent.at(-1)?.type).toBe("release");
  f.window.visible = true; f.window.minimized = false; f.viewers.windowVisibility(true);
  f.command({ type: "visibility", visible: true }); expect(control.sent.some(value => value.type === "control")).toBe(false);
  f.command({ type: "control", frameSequence: 2 }); expect(control.sent.at(-1)).toMatchObject({ type: "control", frameSequence: 2 });
});
it("cannot finish a retired viewer while its TLS pin is pending", async () => {
  const f = fixture(); f.viewers.retire(); f.finishPin(); await expect(f.opening).rejects.toThrow("native_document_retired");
  expect(transport.connections).toEqual([]); expect(f.viewers.viewers.size).toBe(0);
});

import { describe, expect, it } from "vitest";
import { createSideWindowExpansion, planSideWindow, type SideWindowFrame, type SideWindowPort, type SideWindowRequest } from "../client/src/side-window-expansion.js";
const frame = (): SideWindowFrame => ({ x: 100, y: 60, width: 1000, height: 700, outerWidth: 1000, outerHeight: 728,
  scale: 1, maximized: false, fullscreen: false, resizable: true, work: { x: 0, y: 24, width: 1920, height: 1056 } });
function fixture(initial = frame()) {
  let current = structuredClone(initial);
  const calls: unknown[] = [], states: unknown[] = [];
  const port: SideWindowPort = {
    read: async () => structuredClone(current),
    size: async (width, height) => { calls.push(["size", width, height]); current.outerWidth += width - current.width; current.outerHeight += height - current.height; current.width = width; current.height = height; },
    position: async (x, y) => { calls.push(["position", x, y]); current.x = x; current.y = y; },
  };
  const controller = createSideWindowExpansion(async () => port);
  const request = (owner = {}): SideWindowRequest => ({ owner, panel: 400, viewport: 1000, sidebar: 272, changed: state => states.push(state) });
  return { port, controller, request, calls, states, current: () => current, change: (value: Partial<SideWindowFrame>) => Object.assign(current, value) };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("side window planning", () => {
  it("extends right without changing main content or height", () => {
    const plan = planSideWindow(frame(), 400, 1000)!;
    expect(plan).toMatchObject({ x: 100, y: 60, width: 1400, height: 700, outerWidth: 1400, outerHeight: 728 });
  });
  it("moves left only as far as required by the work area", () => {
    expect(planSideWindow({ ...frame(), x: 850 }, 400, 1000)).toMatchObject({ x: 520, width: 1400 });
  });
  it("handles negative monitor origins and physical/CSS scaling", () => {
    const current = { ...frame(), x: -2700, width: 2000, outerWidth: 2000, scale: 2, work: { x: -3840, y: 0, width: 3840, height: 2160 } };
    expect(planSideWindow(current, 400, 1000)).toMatchObject({ x: -2800, width: 2800 });
  });
  it.each([{ maximized: true }, { fullscreen: true }, { resizable: false }, { work: null }, { width: 0 }, { x: -300 }])("keeps existing split for unavailable geometry %j", patch => {
    expect(planSideWindow({ ...frame(), ...patch }, 400, 1000)).toBeUndefined();
  });
  it("does not shrink the requested panel to pretend the screen fits", () => {
    expect(planSideWindow({ ...frame(), work: { x: 0, y: 0, width: 1280, height: 900 } }, 400, 1000)).toBeUndefined();
  });
});

describe("window lease", () => {
  it("restores the exact window only after closing the last owner", async () => {
    const f = fixture(), a = f.request(), b = f.request();
    f.controller.acquire(a); await f.controller.settled();
    expect(f.current().width).toBe(1400);
    f.controller.acquire(b); f.controller.release(a.owner); await f.controller.settled();
    expect(f.calls).toEqual([["size", 1400, 700]]);
    f.controller.release(b.owner); await f.controller.settled();
    expect(f.current()).toEqual(frame());
    expect(f.calls).toEqual([["size", 1400, 700], ["size", 1000, 700]]);
  });
  it("cleanup followed by another Host opening does not shrink or grow twice", async () => {
    const f = fixture(), a = f.request(), b = { ...f.request(), viewport: 1400 };
    f.controller.acquire(a); await f.controller.settled();
    f.controller.release(a.owner); f.controller.acquire(b); await f.controller.settled();
    expect(f.calls).toEqual([["size", 1400, 700]]);
    expect(f.states.at(-1)).toMatchObject({ expanded: true, viewport: 1000 });
  });
  it.each([false, true])("opening during close IPC uses restored geometry even after a move (%s)", async moved => {
    const f = fixture(), a = f.request(), b = { ...f.request(), viewport: 1400 }, wait = gate(), entered = gate(), size = f.port.size;
    f.controller.acquire(a); await f.controller.settled();
    f.port.size = async (width, height) => { if (width === 1000) { entered.resolve(); await wait.promise; } await size(width, height); };
    if (moved) f.change({ x: 200, y: 100 });
    f.controller.release(a.owner); await entered.promise; f.controller.acquire(b); wait.resolve(); await f.controller.settled();
    expect(f.current().width).toBe(1400);
    expect(f.states.at(-1)).toMatchObject({ expanded: true, viewport: 1000 });
  });
  it("restores a left shift as well as size", async () => {
    const f = fixture({ ...frame(), x: 850 }), a = f.request();
    f.controller.acquire(a); await f.controller.settled(); f.controller.release(a.owner); await f.controller.settled();
    expect(f.calls).toEqual([["position", 520, 60], ["size", 1400, 700], ["size", 1000, 700], ["position", 850, 60]]);
  });
  it.each([{ work: { x: 1920, y: 24, width: 1920, height: 1056 } }, { resizable: false }, { maximized: true }, { fullscreen: true }, { scale: 2 }])("does not overwrite user window changes %j", async patch => {
    const f = fixture(), a = f.request(); f.controller.acquire(a); await f.controller.settled();
    f.change(patch); f.controller.release(a.owner); await f.controller.settled();
    expect(f.calls).toHaveLength(1); expect(f.current()).toMatchObject(patch);
  });
  it("restores auto-added width after a move without moving the window back", async () => {
    const f = fixture({ ...frame(), x: 850 }), a = f.request();
    f.controller.acquire(a); await f.controller.settled();
    f.change({ x: 300, y: 120 });
    const viewport = await f.controller.release(a.owner);
    expect(viewport).toBe(1000);
    expect(f.current()).toMatchObject({ x: 300, y: 120, width: 1000, height: 700 });
    expect(f.calls).toEqual([["position", 520, 60], ["size", 1400, 700], ["size", 1000, 700]]);
  });
  it("transfers the original width across Hosts after a position-only move", async () => {
    const f = fixture(), a = f.request(), b = { ...f.request(), viewport: 1400 };
    f.controller.acquire(a); await f.controller.settled(); f.change({ x: 200, y: 100 });
    f.controller.acquire(b); await f.controller.release(a.owner); await f.controller.settled();
    expect(f.states.at(-1)).toMatchObject({ expanded: true, viewport: 1000 });
    expect(await f.controller.release(b.owner)).toBe(1000);
    expect(f.current()).toMatchObject({ x: 200, y: 100, width: 1000 });
  });
  it("does not report a restored viewport when native resize failed", async () => {
    const f = fixture(), a = f.request(); f.controller.acquire(a); await f.controller.settled();
    f.port.size = async () => { throw Error("resize failed"); };
    expect(await f.controller.release(a.owner)).toBeUndefined();
    expect(f.current().width).toBe(1400);
  });
  it("closes to the original width after a manual resize while retaining the new height", async () => {
    const f = fixture(), a = f.request(); f.controller.acquire(a); await f.controller.settled();
    f.change({ width: 1550, outerWidth: 1550, height: 800, outerHeight: 828 });
    expect(await f.controller.release(a.owner)).toBe(1000);
    expect(f.current()).toMatchObject({ width: 1000, height: 800, x: 100, y: 60 });
  });
  it("reopening after shrink acknowledgement ignores a stale wide renderer viewport", async () => {
    const f = fixture(), a = f.request(), b = { ...f.request(), viewport: 1400 };
    f.controller.acquire(a); await f.controller.settled(); await f.controller.release(a.owner);
    f.controller.acquire(b); await f.controller.settled();
    expect(f.current().width).toBe(1400);
    expect(f.states.at(-1)).toMatchObject({ expanded: true, viewport: 1000 });
  });
  it("close during module loading never grows the window", async () => {
    const f = fixture(), wait = gate(), a = f.request();
    const control = createSideWindowExpansion(async () => { await wait.promise; return f.port; });
    control.acquire(a); control.release(a.owner); wait.resolve(); await control.settled();
    expect(f.calls).toEqual([]); expect(f.states).toEqual([]);
  });
  it("close while a native resize is in flight releases the completed resize", async () => {
    const f = fixture(), wait = gate(), entered = gate(), a = f.request(), size = f.port.size;
    f.port.size = async (width, height) => { await size(width, height); if (width === 1400) { entered.resolve(); await wait.promise; } };
    f.controller.acquire(a); await entered.promise; f.controller.release(a.owner); wait.resolve(); await f.controller.settled();
    expect(f.current()).toEqual(frame()); expect(f.states).toEqual([]);
  });
  it.each([false, true])("failed resize (applied=%s) safely restores a prior move", async applied => {
    const f = fixture({ ...frame(), x: 850 }), a = f.request(), size = f.port.size;
    f.port.size = async (width, height) => { if (width === 1400) { if (applied) await size(width, height); throw Error("IPC failed"); } await size(width, height); };
    f.controller.acquire(a); await f.controller.settled();
    expect(f.current()).toEqual({ ...frame(), x: 850 });
    expect(f.states).toEqual([{ expanded: false, viewport: 1000, panel: 400, sidebar: 272 }]);
  });
  it("opening rollback does not overwrite an unrelated resize after failed IPC", async () => {
    const f = fixture(), a = f.request(), size = f.port.size;
    f.port.size = async (width, height) => {
      await size(width, height);
      f.change({ width: 1500, outerWidth: 1500 });
      throw Error("resize receipt failed after user change");
    };
    f.controller.acquire(a); await f.controller.settled();
    expect(f.current().width).toBe(1500);
    expect(f.calls).toEqual([["size", 1400, 700]]);
    expect(f.states.at(-1)).toMatchObject({ expanded: false });
  });
  it("read failure falls back instead of blocking the side session", async () => {
    const f = fixture(), a = f.request(); f.port.read = async () => { throw Error("not supported"); };
    f.controller.acquire(a); await f.controller.settled();
    expect(f.calls).toEqual([]); expect(f.states).toHaveLength(1);
    expect(f.states[0]).toMatchObject({ expanded: false });
  });
  it("a manual resize between the initial reads is not overwritten", async () => {
    const f = fixture(), a = f.request(), read = f.port.read; let reads = 0;
    f.port.read = async () => { if (++reads === 2) f.change({ width: 1100, outerWidth: 1100 }); return read(); };
    f.controller.acquire(a); await f.controller.settled();
    expect(f.calls).toEqual([]); expect(f.states[0]).toMatchObject({ expanded: false });
  });
});


describe('right-panel native width protection',()=>{
  it('sets a minimum after expansion, updates it for divider allocation, and clears before closing',async()=>{
    const f=fixture(), request=f.request();
    f.port.minimum=async width=>{f.calls.push(['minimum',width]);};
    f.controller.acquire(request);await f.controller.settled();
    expect(f.calls).toEqual([['size',1400,700],['minimum',1320]]);
    f.controller.protect(request.owner,1280);await f.controller.settled();
    expect(f.calls.at(-1)).toEqual(['minimum',1280]);
    f.change({width:1600,outerWidth:1600});
    await f.controller.release(request.owner);
    expect(f.calls.slice(-2)).toEqual([['minimum',null],['size',1000,700]]);
  });
  it('a stale owner cannot clear or change the current window protection',async()=>{
    const f=fixture(),a=f.request(),b=f.request();f.port.minimum=async width=>{f.calls.push(['minimum',width]);};
    f.controller.acquire(a);await f.controller.settled();f.controller.acquire(b);await f.controller.settled();
    f.controller.protect(a.owner,1900);await f.controller.release(a.owner);await f.controller.settled();
    expect(f.calls).toEqual([['size',1400,700],['minimum',1320]]);
    await f.controller.release(b.owner);expect(f.calls.slice(-2)).toEqual([['minimum',null],['size',1000,700]]);
  });
  it('releases the temporary minimum even when fullscreen means no frame restoration',async()=>{
    const f=fixture(),request=f.request();f.port.minimum=async width=>{f.calls.push(['minimum',width]);};
    f.controller.acquire(request);await f.controller.settled();f.change({fullscreen:true});
    await f.controller.release(request.owner);expect(f.calls).toEqual([['size',1400,700],['minimum',1320],['minimum',null]]);
  });
  it('clears an uncertain minimum write and restores the frame before falling back',async()=>{
    const f=fixture(),request=f.request();f.port.minimum=async width=>{f.calls.push(['minimum',width]);if(width!==null)throw Error('unavailable');};
    f.controller.acquire(request);await f.controller.settled();
    expect(f.calls).toEqual([['size',1400,700],['minimum',1320],['minimum',null],['size',1000,700]]);
    expect(f.states.at(-1)).toMatchObject({expanded:false});
  });
});

/** Physical desktop frames; kept separate from React and the side-session API. */
export type SideWindowFrame = {
  x: number; y: number; width: number; height: number; outerWidth: number; outerHeight: number;
  scale: number; maximized: boolean; fullscreen: boolean; resizable: boolean;
  work: { x: number; y: number; width: number; height: number } | null;
};
export type SideWindowPort = {
  read(): Promise<SideWindowFrame>;
  size(width: number, height: number): Promise<void>;
  position(x: number, y: number): Promise<void>;
  minimum?(width: number | null): Promise<void>;
};
export type SideWindowRequest = {
  owner: object; panel: number; viewport: number; sidebar: number; minimumViewport?: number;
  changed(state: { expanded: boolean; viewport: number; panel: number; sidebar: number }): void;
};
const near = (a: number, b: number) => Math.abs(a - b) <= 2;
export function sameSideWindow(a: SideWindowFrame, b: SideWindowFrame): boolean {
  return [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height, a.outerWidth - b.outerWidth, a.outerHeight - b.outerHeight].every(value => Math.abs(value) <= 2)
    && a.scale === b.scale && a.maximized === b.maximized && a.fullscreen === b.fullscreen;
}
// Closing returns the auto-expanded window to its original width, including
// after a manual resize. Preserve later position/height changes; do not leave
// fullscreen/maximized mode or write geometry onto a different display.
function sameSideWindowMode(a: SideWindowFrame, b: SideWindowFrame): boolean {
  return a.scale === b.scale && a.maximized === b.maximized && a.fullscreen === b.fullscreen && a.resizable && !!a.work && !!b.work
    && ["x", "y", "width", "height"].every(key => near(a.work![key as keyof NonNullable<SideWindowFrame["work"]>], b.work![key as keyof NonNullable<SideWindowFrame["work"]>]));
}
function restorableSideWindow(a: SideWindowFrame, b: SideWindowFrame): boolean {
  return sameSideWindow({ ...a, x: b.x, y: b.y }, b) && sameSideWindowMode(a, b);
}
export function planSideWindow(frame: SideWindowFrame, panel: number, viewport: number): SideWindowFrame | undefined {
  const work = frame.work, ratio = frame.width / viewport;
  if (frame.maximized || frame.fullscreen || !frame.resizable || !work || !Number.isFinite(ratio) || ratio <= 0
    || !Number.isFinite(panel) || panel < 280 || panel > 4000) return;
  const extra = Math.round(panel * ratio), outerWidth = frame.outerWidth + extra;
  if (extra <= 0 || outerWidth > work.width || frame.x < work.x - 2 || frame.x + frame.outerWidth > work.x + work.width + 2) return;
  // Prefer extending right. If necessary, shift just enough left to stay on
  // this monitor; never span displays or alter height/fullscreen state.
  return { ...frame, x: Math.min(frame.x, work.x + work.width - outerWidth), width: frame.width + extra, outerWidth };
}

/** One serialized lease per native window, shared by all mounted Host Apps.
 * A later owner supersedes the old one; its cleanup cannot shrink the new one.
 * Restore the original width while preserving later position/height changes. */
export function createSideWindowExpansion(load: () => Promise<SideWindowPort>) {
  let desired: SideWindowRequest | undefined, version = 0, processed = 0, pending: Promise<void> | undefined;
  let lease: { port: SideWindowPort; before: SideWindowFrame; after: SideWindowFrame; request: SideWindowRequest; minimum?: number } | undefined;
  const publish = (request: SideWindowRequest, expanded: boolean, original = request) => {
    if (desired === request) request.changed({ expanded, viewport: original.viewport, panel: original.panel, sidebar: original.sidebar });
  };
  let closingReceipt: { viewport?: number } | undefined;
  let restored: { before: SideWindowFrame; original: SideWindowRequest; next?: SideWindowRequest } | undefined;
  const clearMinimum = async (owned: NonNullable<typeof lease>) => {
    if (owned.minimum === undefined) return;
    await owned.port.minimum?.(null); owned.minimum = undefined;
  };
  const protect = async (owned: NonNullable<typeof lease>, request: SideWindowRequest) => {
    if (!owned.port.minimum) return;
    const width = Math.round((request.minimumViewport ?? owned.request.viewport + 320) * owned.before.width / owned.request.viewport);
    if (owned.minimum === width) return;
    owned.minimum = width; // also clear after an uncertain/rejected native write
    await owned.port.minimum(width);
  };
  const restore = async (closing = false) => {
    const owned = lease, receipt = closing ? closingReceipt : undefined;
    if (!owned) return;
    try {
      const current = await owned.port.read();
      if (closing ? !sameSideWindowMode(current, owned.after) : !sameSideWindow(current, owned.after)) {
        await clearMinimum(owned); lease = undefined; return;
      }
      const moved = !near(current.x, owned.after.x) || !near(current.y, owned.after.y);
      if (closing && desired) return; // another Host/side acquired the same window
      await clearMinimum(owned);
      lease = undefined;
      await owned.port.size(owned.before.width, current.height);
      const shrunk = await owned.port.read();
      const restoredFrame = { ...owned.before, height: current.height, outerHeight: current.outerHeight };
      const sizeRestored = restorableSideWindow(shrunk, restoredFrame);
      if (receipt && sizeRestored) receipt.viewport = owned.request.viewport;
      if (!moved && sizeRestored && near(shrunk.width, owned.before.width) && near(shrunk.height, current.height)
        && near(shrunk.x, owned.after.x) && near(shrunk.y, owned.after.y) && !shrunk.maximized && !shrunk.fullscreen
        && (!near(shrunk.x, owned.before.x) || !near(shrunk.y, owned.before.y)))
        await owned.port.position(owned.before.x, owned.before.y);
      // A new side may mount during the shrink IPC and measure the old wide
      // viewport. Carry the original CSS geometry through that handoff.
      if (closing && sizeRestored) restored = { before: restoredFrame, original: owned.request, next: desired };
    } catch { await clearMinimum(owned).catch(() => {}); lease = undefined; /* Do not force a second resize after uncertain native results. */ }
  };
  const run = async () => {
    while (processed !== version) {
      const revision = version, request = desired; processed = revision;
      if (!request) { await restore(true); continue; }
      if (lease) {
        try {
          if (sameSideWindowMode(await lease.port.read(), lease.after)) { await protect(lease, request); publish(request, true, lease.request); continue; }
        } catch { /* Fall back if the native frame cannot be read. */ }
        await clearMinimum(lease).catch(() => {}); lease = undefined;
        publish(request, false); continue;
      }
      let port: SideWindowPort, before: SideWindowFrame;
      try { port = await load(); before = await port.read(); }
      catch { publish(request, false); continue; }
      if (revision !== version) continue;
      const original = restored && (!restored.next || restored.next === request) && restorableSideWindow(before, restored.before)
        && (near(request.viewport, restored.original.viewport) || near(request.viewport, restored.original.viewport + restored.original.panel))
        ? { ...request, viewport: restored.original.viewport, sidebar: restored.original.sidebar } : request;
      restored = undefined;
      const target = planSideWindow(before, original.panel, original.viewport);
      if (!target) { publish(request, false); continue; }
      try {
        // Native reads can race a manual move while the module is loading.
        if (revision !== version) continue;
        if (!sameSideWindow(before, await port.read())) { publish(request, false); continue; }
        if (revision !== version) continue;
        const positioned = { ...before, x: target.x, y: target.y };
        // Record intent before awaiting IPC: a rejected write may still apply.
        lease = { port, before, after: positioned, request: original };
        if (!near(before.x, target.x)) await port.position(target.x, target.y);
        if (!sameSideWindow(await port.read(), positioned)) { lease = undefined; publish(request, false); continue; }
        if (revision !== version) { await restore(); continue; }
        lease.after = target;
        await port.size(target.width, target.height);
        const actual = await port.read();
        if (!sameSideWindow(actual, target)) { lease = undefined; publish(request, false); continue; }
        lease.after = actual;
        await protect(lease, request);
        publish(request, true, original);
      } catch {
        if (lease) {
          // setSize may reject before or after applying. Both known frames are
          // ours; an unrelated frame is deliberately left alone.
          try {
            const actual = await port.read();
            if (sameSideWindow(actual, target) || sameSideWindow(actual, { ...before, x: target.x, y: target.y })) lease.after = actual;
          } catch { /* restore performs its own guarded read */ }
          await restore();
        }
        publish(request, false);
      }
    }
  };
  const start = () => { pending ??= run().finally(() => { pending = undefined; if (processed !== version) start(); }); };
  const settled = async () => { while (pending) await pending; };
  return {
    acquire(request: SideWindowRequest) { desired = request; version++; start(); },
    protect(owner: object, minimumViewport: number) {
      if (desired?.owner !== owner || !Number.isFinite(minimumViewport) || minimumViewport < 100) return;
      const width = Math.round(minimumViewport);
      if (desired.minimumViewport === width) return;
      desired.minimumViewport = width; version++; start();
    },
    async release(owner: object): Promise<number | undefined> {
      if (desired?.owner !== owner) return;
      const receipt: { viewport?: number } = {}; closingReceipt = receipt;
      desired = undefined; version++; start();
      await settled();
      // Only a confirmed shrink provides a viewport for renderer handoff.
      return receipt.viewport;
    },
    settled,
  };
}

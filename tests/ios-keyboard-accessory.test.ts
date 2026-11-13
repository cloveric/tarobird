import { describe, expect, it, vi } from 'vitest';
import { installExpandedIphoneKeyboardBar } from '../client/src/ios-keyboard-accessory.js';

function windowFixture(width = 951, height = 669, userAgent = 'iPhone') {
  const events = new EventTarget();
  return Object.assign(events, { innerWidth: width, innerHeight: height, navigator: { userAgent } }) as unknown as Window;
}
function resize(win: Window, width: number, height: number) {
  Object.assign(win, { innerWidth: width, innerHeight: height });
  win.dispatchEvent(new Event('resize'));
}
const settled = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe('expanded iPhone native keyboard dismissal bar', () => {
  it('restores compact policy after a document reload retains the native Show state', async () => {
    let nativeVisible = false;
    const setAccessoryBarVisible = vi.fn(async ({ isVisible }: { isVisible: boolean }) => { nativeVisible = isVisible; });
    const load = async () => ({ setAccessoryBarVisible });
    installExpandedIphoneKeyboardBar(windowFixture(), load);
    await settled(); expect(nativeVisible).toBe(true);
    // A full page reload destroys the old JS world without React cleanup.
    const stop = installExpandedIphoneKeyboardBar(windowFixture(466, 678), load);
    await settled(); expect(nativeVisible).toBe(false);
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: true }], [{ isVisible: false }]]);
    stop();
  });

  it('refreshes the existing native input view only after the current policy has applied', async () => {
    const win = windowFixture(), gate = deferred(), refreshAccessory = vi.fn();
    Object.assign(win, { tarobotKeyboardInsets: { refreshAccessory } });
    const setAccessoryBarVisible = vi.fn(async ({ isVisible }: { isVisible: boolean }) => { if (isVisible) await gate.promise; });
    const stop = installExpandedIphoneKeyboardBar(win, async () => ({ setAccessoryBarVisible }));
    await settled(); expect(refreshAccessory).not.toHaveBeenCalled();
    resize(win, 466, 678); gate.resolve(); await settled();
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: true }], [{ isVisible: false }]]);
    expect(refreshAccessory).toHaveBeenCalledTimes(1); // Only the final Hide.
    resize(win, 951, 669); await settled();
    expect(refreshAccessory).toHaveBeenCalledTimes(2);
    stop(); await settled(); expect(refreshAccessory).toHaveBeenCalledTimes(3);
  });

  it.each([[390, 844], [844, 390], [466, 678], [678, 466]])(
    'keeps the compact default hidden at %s x %s without repeating on resize', async (width, height) => {
      const win = windowFixture(width, height), setAccessoryBarVisible = vi.fn(async () => {});
      const stop = installExpandedIphoneKeyboardBar(win, async () => ({ setAccessoryBarVisible }));
      await settled(); resize(win, height, width); await settled(); stop(); await settled();
      expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: false }]]);
    },
  );

  it.each([[1024, 768, 'iPad'], [951, 669, 'Android']])(
    'leaves the existing policy untouched for %s x %s %s', async (width, height, ua) => {
      const load = vi.fn();
      const stop = installExpandedIphoneKeyboardBar(windowFixture(width, height, ua), load);
      await settled(); stop(); await settled();
      expect(load).not.toHaveBeenCalled();
    },
  );

  it('coalesces expansion during initial loading, restores on folding and removes its listener', async () => {
    const win = windowFixture(466, 678), setAccessoryBarVisible = vi.fn(async () => {});
    const load = vi.fn(async () => ({ setAccessoryBarVisible }));
    const stop = installExpandedIphoneKeyboardBar(win, load);
    resize(win, 951, 669); await settled();
    resize(win, 669, 951); await settled(); // Rotation is still expanded.
    resize(win, 466, 678); await settled();
    resize(win, 951, 669); await settled(); stop(); await settled();
    resize(win, 951, 669); await settled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: true }], [{ isVisible: false }], [{ isVisible: true }], [{ isVisible: false }]]);
  });

  it.each(['fold', 'dispose'])('does not enable after %s while the native module is loading', async action => {
    const gate = deferred(), win = windowFixture(), setAccessoryBarVisible = vi.fn(async () => {});
    const stop = installExpandedIphoneKeyboardBar(win, async () => { await gate.promise; return { setAccessoryBarVisible }; });
    if (action === 'fold') resize(win, 466, 678); else stop();
    gate.resolve(); await settled();
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: false }]]); stop();
  });

  it.each(['fold', 'dispose'])('serializes restoration after %s during a native Show request', async action => {
    const gate = deferred(), win = windowFixture();
    const setAccessoryBarVisible = vi.fn(async ({ isVisible }: { isVisible: boolean }) => { if (isVisible) await gate.promise; });
    const stop = installExpandedIphoneKeyboardBar(win, async () => ({ setAccessoryBarVisible }));
    await settled();
    if (action === 'fold') resize(win, 466, 678); else stop();
    expect(setAccessoryBarVisible).toHaveBeenCalledTimes(1);
    gate.resolve(); await settled();
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: true }], [{ isVisible: false }]]); stop();
  });

  it('bounds loader failures across unchanged resizes and retries when the window policy changes', async () => {
    const win = windowFixture(), report = vi.fn(), refreshAccessory = vi.fn();
    Object.assign(win, { tarobotKeyboardInsets: { refreshAccessory } });
    const setAccessoryBarVisible = vi.fn(async () => {});
    const load = vi.fn().mockRejectedValueOnce(new Error('module unavailable')).mockResolvedValue({ setAccessoryBarVisible });
    const stop = installExpandedIphoneKeyboardBar(win, load, report);
    await settled();
    for (const [width, height] of [[669, 951], [951, 669], [900, 650]]) { resize(win, width!, height!); await settled(); }
    expect(load).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(refreshAccessory).not.toHaveBeenCalled();
    resize(win, 466, 678); await settled();
    expect(load).toHaveBeenCalledTimes(2);
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: false }]]);
    resize(win, 951, 669); await settled();
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: false }], [{ isVisible: true }]]);
    expect(refreshAccessory).toHaveBeenCalledTimes(2);
    stop(); await settled();
    expect(setAccessoryBarVisible.mock.calls.at(-1)).toEqual([{ isVisible: false }]);
    resize(win, 951, 669); await settled();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['fold', 'dispose'])('does not loop after loading rejects during %s', async action => {
    const gate = deferred(), win = windowFixture(), report = vi.fn();
    const load = vi.fn(async () => { await gate.promise; throw new Error('module unavailable'); });
    const stop = installExpandedIphoneKeyboardBar(win, load, report);
    if (action === 'fold') resize(win, 466, 678); else stop();
    gate.resolve(); await settled();
    resize(win, 678, 466); await settled();
    resize(win, 466, 678); await settled();
    stop(); await settled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports a native failure once and requests default restoration after folding', async () => {
    const win = windowFixture(), report = vi.fn();
    const setAccessoryBarVisible = vi.fn(async () => { throw new Error('unavailable'); });
    const stop = installExpandedIphoneKeyboardBar(win, async () => ({ setAccessoryBarVisible }), report);
    await settled(); resize(win, 669, 951); await settled();
    expect(report).toHaveBeenCalledTimes(1);
    resize(win, 466, 678); await settled();
    expect(setAccessoryBarVisible.mock.calls).toEqual([[{ isVisible: true }], [{ isVisible: false }]]);
    expect(report).toHaveBeenCalledTimes(2); stop();
  });
});

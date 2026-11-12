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
  it.each([[390, 844, 'iPhone'], [844, 390, 'iPhone'], [466, 678, 'iPhone'], [678, 466, 'iPhone'], [1024, 768, 'iPad'], [951, 669, 'Android']])(
    'leaves the existing policy untouched for %s x %s %s', async (width, height, ua) => {
      const load = vi.fn();
      const stop = installExpandedIphoneKeyboardBar(windowFixture(width, height, ua), load);
      await settled(); stop(); await settled();
      expect(load).not.toHaveBeenCalled();
    },
  );

  it('shows only on expansion, restores on folding and removes its listener', async () => {
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
    expect(setAccessoryBarVisible).not.toHaveBeenCalled(); stop();
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

  it('reports a native failure once and still restores the default after folding', async () => {
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

import { afterEach, expect, it, vi } from "vitest";
import { createReadingScroll, usesIosReadingScroll } from "../client/src/reading-scroll.js";
// Exercise the client's installed virtualizer, not a root-only dependency.
import { Virtualizer } from "../client/node_modules/@tanstack/virtual-core/dist/esm/index.js";

afterEach(() => vi.unstubAllGlobals());

it("publishes an immediate jump before a clamped measurement can replay the old location", () => {
  vi.stubGlobal("navigator", { userAgent: "Chrome", platform: "MacIntel", maxTouchPoints: 0 });
  const targetWindow = { requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn(), setTimeout, clearTimeout, performance };
  const element = Object.assign(new EventTarget(), {
    scrollTop: 900, scrollHeight: 1000, clientHeight: 100,
    ownerDocument: { defaultView: targetWindow },
    scrollTo({ top }: { top: number }) { this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)); },
  }) as unknown as HTMLDivElement;
  const reading = createReadingScroll(() => null);
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 30, estimateSize: () => 160, getScrollElement: () => element,
    initialOffset: 900, observeElementRect: (_instance, cb) => { cb({ width: 400, height: 100 }); },
    observeElementOffset: reading.observe, scrollToFn: reading.scrollTo,
  });
  try {
    virtualizer._willUpdate();
    virtualizer.getVirtualItems();
    virtualizer.resizeItem(0, 318); // Old anchor correction is clamped at 900.
    virtualizer.scrollToIndex(0, { align: "start" });
    expect(element.scrollTop).toBe(0);
    expect(virtualizer.scrollOffset).toBe(0);
    // A later DOM commit grows the extent. It must not retry the old 1058.
    Object.defineProperty(element, "scrollHeight", { value: 2000, configurable: true });
    virtualizer._willUpdate();
    expect(element.scrollTop).toBe(0);
    // Ordinary row compensation still updates both positions exactly once.
    virtualizer.scrollToOffset(700);
    virtualizer.resizeItem(0, 418);
    expect(element.scrollTop).toBe(800);
    expect(virtualizer.scrollOffset).toBe(800);
    reading.scrollTo(3000, {}, virtualizer); // E.g. restored logical height not committed yet.
    expect(element.scrollTop).toBe(1900);
    expect(virtualizer.scrollOffset).toBe(800);
    Object.defineProperty(element, "clientHeight", { value: 0, configurable: true });
    reading.scrollTo(0, {}, virtualizer); // Hidden pane's zero is not a new reading position.
    expect(virtualizer.scrollOffset).toBe(800);
    Object.defineProperty(element, "clientHeight", { value: 100, configurable: true });
    reading.scrollTo(800, {}, virtualizer);
    virtualizer.scrollToOffset(500, { behavior: "smooth" });
    expect(virtualizer.scrollOffset).toBe(800); // Native observation owns smooth scrolling.
    element.dispatchEvent(new Event("scroll"));
    expect(virtualizer.scrollOffset).toBe(500);
  } finally { virtualizer._didMount()(); }
  reading.scrollTo(200, {}, virtualizer);
  expect(virtualizer.scrollOffset).toBe(500); // Detached observer cannot mutate old state.
});

it("does not undo an explicit native jump while its old offset is still observed", () => {
  vi.stubGlobal("navigator", { userAgent: "Chrome", platform: "MacIntel", maxTouchPoints: 0 });
  const reading = createReadingScroll(() => null);
  // A reference jump reached the first row, but the scroll event has not yet
  // updated the list. A new row's +158 measurement must not restore 2593.
  expect(reading.canAdjust(0, 2435, 0)).toBe(false);
  expect(reading.canAdjust(0, 2435, 158)).toBe(false);
  expect(reading.canAdjust(0, 0, 0)).toBe(true);
  // Normal reading compensation and fractional browser offsets still work.
  expect(reading.canAdjust(2593, 2435, 158)).toBe(true);
  expect(reading.canAdjust(2593.5, 2593, 0)).toBe(true);
});

it("leaves iOS logical-origin compensation independent of native offset lag", () => {
  vi.stubGlobal("navigator", { userAgent: "iPhone AppleWebKit/605.1.15", platform: "iPhone", maxTouchPoints: 5 });
  expect(createReadingScroll(() => null).canAdjust(0, 2435, 158)).toBe(true);
});

it("repositions user rows and background task groups via data-row-key during iOS deferred compensation", () => {
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    maxTouchPoints: 5,
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const makeRow = (dataset: { messageId: string; rowKey?: string }, initialTop: number) =>
    ({ dataset, style: { transform: `translateY(${initialTop}px)` } }) as unknown as HTMLElement;

  const bgKey = JSON.stringify(["conv_1", "bot_1", "", "group_1"]);
  const userRow = makeRow({ messageId: "msg_user", rowKey: "user:owner:client_1" }, 100);
  const bgRow = makeRow({ messageId: "msg_bg", rowKey: bgKey }, 180);
  const botRow = makeRow({ messageId: "msg_bot", rowKey: "msg_bot" }, 260);
  const legacyRow = makeRow({ messageId: "msg_legacy" }, 340);
  const history = {
    children: [userRow, bgRow, botRow, legacyRow],
    style: { transform: "", height: "" },
  } as unknown as HTMLDivElement;

  const scroller = Object.assign(new EventTarget(), {
    scrollTop: 500,
    scrollHeight: 2000,
    clientHeight: 600,
  }) as unknown as HTMLDivElement;

  const fakeList = {
    scrollElement: scroller,
    getVirtualItems: () => [
      { key: "user:owner:client_1", start: 300 },
      { key: bgKey, start: 380 },
      { key: "msg_bot", start: 460 },
      { key: "msg_legacy", start: 540 },
    ],
    getTotalSize: () => 2200,
  } as unknown as Parameters<ReturnType<typeof createReadingScroll>["changed"]>[0];

  const reading = createReadingScroll(() => history);
  expect(reading.ios).toBe(true);
  reading.changed(fakeList);
  expect(reading.defer(200)).toBe(true);
  reading.changed(fakeList);

  expect(history.style.transform).toBe("translateY(-200px)");
  expect(history.style.height).toBe("2000px");
  expect(userRow.style.transform).toBe("translateY(300px)");
  expect(bgRow.style.transform).toBe("translateY(380px)");
  expect(botRow.style.transform).toBe("translateY(460px)");
  expect(legacyRow.style.transform).toBe("translateY(540px)");
});

it("keeps native iPhone, iPad, and iPad desktop WebKit on the inertia path", () => {
  for (const userAgent of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    "Mozilla/5.0 (iPad; CPU OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 CriOS/153.0 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 FxiOS/149.0 Safari/605.1.15",
  ]) expect(usesIosReadingScroll({ userAgent, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
});

it("does not apply iOS shifts to touch Chromium, Android or non-touch Mac Safari", () => {
  for (const userAgent of [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/153.0 Safari/537.36 Edg/153.0",
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/153.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0",
  ]) expect(usesIosReadingScroll({ userAgent, platform: "MacIntel", maxTouchPoints: 1 })).toBe(false);
  expect(usesIosReadingScroll({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
});

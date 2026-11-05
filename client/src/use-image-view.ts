import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { clampImageValue, imageAnchor, imageFitRatio, imageScrollAt, type ImageFit, type ImagePoint, type ImageSize } from "./image-viewer-geometry.js";

const distance = (a: ImagePoint, b: ImagePoint) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: ImagePoint, b: ImagePoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
type Drag = { start: ImagePoint; last: ImagePoint; scroll: ImagePoint; at: number; lastAt: number; moved: boolean; multi: boolean; type: string; onImage: boolean; velocity: ImagePoint };

/** The scrollport owns pan bounds. Only zoom updates React, at most once per frame. */
export function useImageView({ reader, canvas, imageKey, natural, change, toggleControls, dismiss }: {
  reader: RefObject<HTMLDivElement | null>; canvas: RefObject<HTMLDivElement | null>;
  imageKey: string; natural?: ImageSize; change: (offset: number) => void; toggleControls: () => void; dismiss: () => void;
}) {
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 });
  const [fitOverride, setFitOverride] = useState<ImageFit>();
  const [zoom, setZoom] = useState(1), zoomRef = useRef(1), renderedZoom = useRef(1);
  const long = !!natural && natural.height > natural.width * 2;
  const fit = fitOverride ?? (long ? "width" : "contain");
  const ratio = natural ? imageFitRatio(natural, viewport, fit) : 0;
  const base = { width: (natural?.width ?? 0) * ratio, height: (natural?.height ?? 0) * ratio };
  const pending = useRef<ImagePoint | undefined>(undefined), frame = useRef<number | undefined>(undefined), momentum = useRef<number | undefined>(undefined), clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointers = useRef(new Map<number, ImagePoint>()), drag = useRef<Drag | undefined>(undefined), tap = useRef<{ at: number; point: ImagePoint; type: string; onImage: boolean } | undefined>(undefined);
  const pinch = useRef<{ distance: number; zoom: number; anchor: ImagePoint } | undefined>(undefined);
  const live = useRef({ ratio, base, viewport, fit, long, change, toggleControls, dismiss });
  live.current = { ratio, base, viewport, fit, long, change, toggleControls, dismiss };
  const stopMomentum = () => { if (momentum.current !== undefined) cancelAnimationFrame(momentum.current); momentum.current = undefined; };
  const stopTap = () => { clearTimeout(clickTimer.current); clickTimer.current = undefined; tap.current = undefined; };
  const resetGesture = () => {
    stopMomentum(); stopTap(); pointers.current.clear(); drag.current = undefined; pinch.current = undefined;
    canvas.current?.style.removeProperty("--image-drag-transform");
  };
  const scroll = (): ImagePoint => pending.current ?? { x: reader.current?.scrollLeft ?? 0, y: reader.current?.scrollTop ?? 0 };
  const scaled = () => ({ width: live.current.base.width * zoomRef.current, height: live.current.base.height * zoomRef.current });
  const local = (point: ImagePoint): ImagePoint => { const rect = reader.current!.getBoundingClientRect(); return { x: point.x - rect.left, y: point.y - rect.top }; };
  const anchorAt = (point: ImagePoint) => imageAnchor(point, scroll(), scaled(), live.current.viewport);
  // Pointer capture retargets pointerup to the reader, so use the actual image
  // bounds at both ends instead of treating the whole canvas as image content.
  const onImageAt = (point: ImagePoint) => {
    const bounds = live.current.ratio && canvas.current?.querySelector("img")?.getBoundingClientRect();
    return !!bounds && point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
  };
  const applyScroll = () => {
    const node = reader.current, point = pending.current;
    if (node && point) { node.scrollLeft = point.x; node.scrollTop = point.y; pending.current = undefined; }
  };
  const scaleTo = (value: number, point?: ImagePoint, anchor?: ImagePoint) => {
    const valueNow = live.current; if (!valueNow.ratio) return;
    stopMomentum(); stopTap();
    const location = point ?? { x: valueNow.viewport.width / 2, y: valueNow.viewport.height / 2 };
    const fixed = anchor ?? anchorAt(location), next = clampImageValue(value, 1, 6);
    zoomRef.current = next;
    pending.current = imageScrollAt(fixed, location, scaled(), valueNow.viewport);
    if (frame.current === undefined) frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      if (renderedZoom.current === zoomRef.current) applyScroll();
      setZoom(zoomRef.current);
    });
  };
  const toggleZoom = (point?: ImagePoint) => scaleTo(zoomRef.current > 1 ? 1 : 3, point);
  const reset = () => {
    resetGesture(); zoomRef.current = 1; setZoom(1); pending.current = { x: 0, y: 0 };
    if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined;
    applyScroll();
  };
  useLayoutEffect(() => {
    const node = reader.current!;
    const resize = () => setViewport(old => old.width === node.clientWidth && old.height === node.clientHeight ? old : { width: node.clientWidth, height: node.clientHeight });
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    return () => { observer.disconnect(); resetGesture(); if (frame.current !== undefined) cancelAnimationFrame(frame.current); };
  }, []);
  useLayoutEffect(() => { reset(); setFitOverride(undefined); }, [imageKey]);
  const geometry = useRef<{ key: string; fit: ImageFit; image: ImageSize; viewport: ImageSize; scroll: ImagePoint } | undefined>(undefined);
  useLayoutEffect(() => {
    const node = reader.current!, previous = geometry.current;
    if (base.width && base.height) {
      if (previous?.key === imageKey && previous.fit === fit && previous.image.width && previous.viewport.width) {
        const anchor = imageAnchor({ x: previous.viewport.width / 2, y: previous.viewport.height / 2 }, previous.scroll, previous.image, previous.viewport);
        pending.current = imageScrollAt(anchor, { x: viewport.width / 2, y: viewport.height / 2 }, scaled(), viewport);
      } else pending.current = { x: 0, y: 0 };
      applyScroll();
      geometry.current = { key: imageKey, fit, image: scaled(), viewport, scroll: { x: node.scrollLeft, y: node.scrollTop } };
    }
    stopMomentum();
  }, [base.width, base.height, viewport.width, viewport.height, fit, imageKey]);
  useLayoutEffect(() => {
    renderedZoom.current = zoom; applyScroll();
    if (base.width) geometry.current = { key: imageKey, fit, image: { width: base.width * zoom, height: base.height * zoom }, viewport, scroll: scroll() };
  }, [zoom]);
  useEffect(() => {
    const node = reader.current!;
    type Gesture = Event & { scale?: number; clientX?: number; clientY?: number };
    let trackpad: { zoom: number; point: ImagePoint; anchor: ImagePoint } | undefined;
    const gestureStart = (event: Event) => {
      event.preventDefault(); stopTap(); stopMomentum();
      if (pointers.current.size >= 2 || !live.current.ratio) return;
      const gesture = event as Gesture, rect = node.getBoundingClientRect();
      const point = local({ x: gesture.clientX ?? rect.left + node.clientWidth / 2, y: gesture.clientY ?? rect.top + node.clientHeight / 2 });
      trackpad = { zoom: zoomRef.current, point, anchor: anchorAt(point) };
    };
    const gestureChange = (event: Event) => {
      event.preventDefault(); const scale = (event as Gesture).scale;
      if (trackpad && pointers.current.size < 2 && typeof scale === "number" && scale > 0) scaleTo(trackpad.zoom * scale, trackpad.point, trackpad.anchor);
    };
    const gestureEnd = (event: Event) => { event.preventDefault(); trackpad = undefined; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); stopTap(); stopMomentum();
      if (!live.current.ratio) return;
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      // Two-finger trackpad scroll and ordinary wheel movement pan the image.
      // Chromium pinch arrives as Ctrl+wheel; WebKit has gesture events above.
      if (!event.ctrlKey && !event.metaKey) {
        node.scrollLeft += event.deltaX * factor; node.scrollTop += event.deltaY * factor; return;
      }
      scaleTo(zoomRef.current * Math.exp(-clampImageValue(event.deltaY * factor, -600, 600) * .003), local({ x: event.clientX, y: event.clientY }));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("gesturestart", gestureStart, { passive: false });
    node.addEventListener("gesturechange", gestureChange, { passive: false });
    node.addEventListener("gestureend", gestureEnd, { passive: false });
    return () => { node.removeEventListener("wheel", wheel); node.removeEventListener("gesturestart", gestureStart); node.removeEventListener("gesturechange", gestureChange); node.removeEventListener("gestureend", gestureEnd); };
  }, []);
  const glide = (velocity: ImagePoint) => {
    let before = performance.now(), elapsed = 0, vx = velocity.x, vy = velocity.y;
    const advance = (now: number) => {
      const node = reader.current; if (!node) { momentum.current = undefined; return; }
      const dt = Math.min(32, now - before); before = now; elapsed += dt;
      const x = node.scrollLeft, y = node.scrollTop;
      node.scrollLeft += vx * dt; node.scrollTop += vy * dt;
      vx *= Math.exp(-dt / 160); vy *= Math.exp(-dt / 160);
      if (node.scrollLeft === x) vx = 0; if (node.scrollTop === y) vy = 0;
      if (elapsed < 750 && Math.hypot(vx, vy) > .025) momentum.current = requestAnimationFrame(advance);
      else momentum.current = undefined;
    };
    momentum.current = requestAnimationFrame(advance);
  };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const stoppingMomentum = momentum.current !== undefined;
    event.preventDefault(); stopMomentum(); clearTimeout(clickTimer.current);
    event.currentTarget.focus({ preventScroll: true });
    const point = { x: event.clientX, y: event.clientY }, now = performance.now();
    pointers.current.set(event.pointerId, point);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* A cancelled touch can disappear before capture. */ }
    if (pointers.current.size === 1) drag.current = { start: point, last: point, scroll: scroll(), at: now, lastAt: now, moved: stoppingMomentum, multi: false, type: event.pointerType, onImage: onImageAt(point), velocity: { x: 0, y: 0 } };
    else if (pointers.current.size === 2) {
      stopTap(); if (drag.current) { drag.current.multi = true; drag.current.moved = true; }
      if (live.current.ratio) {
        const [a, b] = [...pointers.current.values()];
        pinch.current = { distance: Math.max(1, distance(a!, b!)), zoom: zoomRef.current, anchor: anchorAt(local(middle(a!, b!))) };
      }
      canvas.current?.style.removeProperty("--image-drag-transform");
    }
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY }, gesture = drag.current;
    pointers.current.set(event.pointerId, point); if (!gesture) return;
    if (distance(gesture.start, point) > 8) { gesture.moved = true; stopTap(); }
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      scaleTo(pinch.current.zoom * distance(a!, b!) / pinch.current.distance, local(middle(a!, b!)), pinch.current.anchor);
    } else {
      const node = event.currentTarget, dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
      const x = node.scrollLeft, y = node.scrollTop, now = performance.now(), dt = Math.max(8, now - gesture.lastAt);
      if (zoomRef.current > 1) node.scrollLeft = gesture.scroll.x - dx;
      if (zoomRef.current > 1 || Math.abs(dy) >= Math.abs(dx)) node.scrollTop = gesture.scroll.y - dy;
      if (zoomRef.current === 1 && gesture.type === "touch" && !gesture.multi && Math.abs(dx) > Math.abs(dy) * 1.5) canvas.current?.style.setProperty("--image-drag-transform", `translateX(${clampImageValue(dx * .22, -75, 75)}px)`);
      gesture.velocity = { x: clampImageValue((node.scrollLeft - x) / dt, -3, 3), y: clampImageValue((node.scrollTop - y) / dt, -3, 3) };
      gesture.lastAt = now;
    }
    gesture.last = point;
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !drag.current) return;
    const point = { x: event.clientX, y: event.clientY }, gesture = drag.current;
    pointers.current.delete(event.pointerId); canvas.current?.style.removeProperty("--image-drag-transform");
    if (pointers.current.size) {
      const remaining = [...pointers.current.values()][0]!;
      gesture.start = remaining; gesture.last = remaining; gesture.scroll = scroll(); gesture.velocity = { x: 0, y: 0 }; gesture.lastAt = performance.now();
      // Rebase after any finger leaves; a third finger cannot preserve a stale pinch origin.
      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        pinch.current = { distance: Math.max(1, distance(a!, b!)), zoom: zoomRef.current, anchor: anchorAt(local(middle(a!, b!))) };
      } else pinch.current = undefined;
      return;
    }
    drag.current = undefined; pinch.current = undefined;
    const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y, now = performance.now();
    if (gesture.multi || gesture.moved || distance(gesture.start, point) > 8) {
      stopTap();
      if (!gesture.multi && gesture.type === "touch" && zoomRef.current === 1 && Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(dy) * 1.5) live.current.change(dx < 0 ? 1 : -1);
      else if (gesture.type === "touch" && now - gesture.lastAt < 80) glide(gesture.velocity);
      return;
    }
    if (now - gesture.at > 350) { stopTap(); return; }
    if (gesture.onImage !== onImageAt(point)) { stopTap(); return; }
    // Only mouse clicks on the backdrop dismiss. Touch taps toggle the
    // overlay controls at any zoom, after allowing time for a double tap.
    if (gesture.type === "mouse" && !gesture.onImage) { stopTap(); live.current.dismiss(); return; }
    const previous = tap.current;
    if (previous && previous.type === gesture.type && previous.onImage === gesture.onImage && now - previous.at < 320 && distance(previous.point, point) < 28) { stopTap(); if (gesture.onImage) toggleZoom(local(point)); }
    else {
      tap.current = { at: now, point, type: gesture.type, onImage: gesture.onImage };
      clickTimer.current = setTimeout(() => {
        clickTimer.current = undefined; tap.current = undefined;
        live.current.toggleControls();
      }, 320);
    }
  };
  return {
    viewport, zoom, ratio, long, fit, width: base.width * zoom, height: base.height * zoom,
    reset, toggleZoom, scaleTo, zoomBy: (factor: number) => scaleTo(zoomRef.current * factor),
    toggleFit: () => { reset(); setFitOverride(fit === "width" ? "contain" : "width"); },
    stop: resetGesture,
    handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: resetGesture,
      onScroll: () => { const node = reader.current, previous = geometry.current; if (node && previous && node.clientWidth === previous.viewport.width && node.clientHeight === previous.viewport.height) previous.scroll = { x: node.scrollLeft, y: node.scrollTop }; },
      onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => { if (pointers.current.has(event.pointerId)) resetGesture(); } },
  };
}

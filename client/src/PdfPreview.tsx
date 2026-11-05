import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, FileX, LoaderCircle, LockKeyhole, ZoomIn, ZoomOut } from "lucide-react";
import { PDFWorker, PasswordResponses, PixelsPerInch, TextLayer, getDocument, normalizeUnicode } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { t, useLocale } from "./i18n.js";
import "./pdf-preview.css";

// The worker and the PDF.js data files ship with the app under the document base
// URL. Nothing is fetched from a CDN and the file itself never leaves the device.
const ASSETS = "./pdfjs/6.4.299/";
const CSS_UNITS = PixelsPerInch.PDF_TO_CSS_UNITS;
const MIN_SCALE = 0.25, MAX_SCALE = 4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
// Only the current page owns a canvas. Its backing store stays under 8 MP and 8192 px
// a side, inside mobile WebKit's limits; deeper zoom trades sharpness for memory.
const MAX_CANVAS_PIXELS = 8 * 1024 * 1024, MAX_CANVAS_SIDE = 8192;
/** A zoom or resize repaints after this pause; the stretched canvas stands in meanwhile. */
const REPAINT_DELAY = 120;
// PDF.js 6.4.299's generated constructor type narrows its supported `port`
// parameter to null. Its implementation accepts a Worker and installs a private
// MessageHandler; keep that upstream declaration workaround at this boundary.
const BundledWorker = PDFWorker as unknown as new (options: { port: Worker }) => PDFWorker;

type Load = { kind: "loading" } | { kind: "password"; incorrect: boolean } | { kind: "error"; reason: "invalid" | "failed" } | { kind: "ready"; doc: PDFDocumentProxy };
type Zoom = "fit" | number;
/** A page that could not be loaded keeps its number without a proxy. */
type PageView = { number: number; proxy?: PDFPageProxy };
/** Where the scroll position goes once a page or zoom change is on screen. */
type Anchor = { kind: "page"; page: number; edge: "start" | "end" } | { kind: "point"; to: number; x: number; y: number; clientX: number; clientY: number; at: number };
type StyleWithVars = CSSProperties & Record<`--${string}`, string>;

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
const asset = (path: string) => new URL(ASSETS + path, document.baseURI).href;
const errorName = (error: unknown) => typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
function canvasSize(viewport: PageViewport, pixelRatio: number) {
  const ratio = Math.min(pixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)), MAX_CANVAS_SIDE / viewport.width, MAX_CANVAS_SIDE / viewport.height);
  const width = Math.max(1, Math.floor(viewport.width * ratio)), height = Math.max(1, Math.floor(viewport.height * ratio));
  return { width, height, transform: [width / viewport.width, 0, 0, height / viewport.height, 0, 0] };
}
/** WebKit keeps a detached canvas's memory until its backing store is emptied. */
function release(canvas: HTMLCanvasElement): void { canvas.width = 0; canvas.height = 0; }
function selectionWithin(node: Node | null): boolean {
  const selection = document.getSelection();
  return !!node && !!selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(node);
}

/** Built-in PDF reader for the file preview: one canvas page at a time with a
 * selectable PDF.js text layer. No annotation layer, so links, forms, attachments
 * and document JavaScript stay inert. The surrounding preview owns name, save and close. */
export default function PdfPreview({ blob, name }: { blob: Blob; name: string }) {
  useLocale();
  const ids = useId();
  const [source, setSource] = useState(blob);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [pageNumber, setPageNumber] = useState(1);
  const [view, setView] = useState<PageView>();
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [width, setWidth] = useState(0);
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1);
  const [painted, setPainted] = useState<PDFPageProxy>();
  const [broken, setBroken] = useState<PDFPageProxy>();
  const [repaint, setRepaint] = useState(0);
  const [draft, setDraft] = useState<string>();
  const scroller = useRef<HTMLDivElement>(null), paper = useRef<HTMLDivElement>(null), canvasHost = useRef<HTMLDivElement>(null), textHost = useRef<HTMLDivElement>(null), stateCard = useRef<HTMLDivElement>(null);
  const passwordReply = useRef<((password: string) => void) | undefined>(undefined);
  const shown = useRef<{ proxy: PDFPageProxy; canvas: HTMLCanvasElement } | undefined>(undefined);
  const textLayer = useRef<TextLayer | undefined>(undefined);
  const anchor = useRef<Anchor | undefined>(undefined);
  // The zoom asked for but not yet committed, so quick wheel ticks accumulate.
  const requested = useRef<number | undefined>(undefined);
  const refocus = useRef(false);
  // Committed values for native listeners and callbacks that outlive a render.
  const live = useRef<{ page: number; pages: number; scale?: number; fit?: number; viewport?: PageViewport }>({ page: 1, pages: 0 });

  const restart = () => { setLoad({ kind: "loading" }); setPageNumber(1); setView(undefined); setZoom("fit"); setDraft(undefined); setPainted(undefined); setBroken(undefined); };
  if (source !== blob) { setSource(blob); restart(); }

  const doc = load.kind === "ready" ? load.doc : undefined, pages = doc?.numPages ?? 0, page = view?.proxy;
  const base = useMemo(() => page?.getViewport({ scale: CSS_UNITS }), [page]);
  const fit = base && width > 0 ? clampScale(Math.floor(width / base.width * 1000) / 1000) : undefined;
  const scale = zoom === "fit" ? fit : zoom;
  const viewport = useMemo(() => page && scale ? page.getViewport({ scale: scale * CSS_UNITS }) : undefined, [page, scale]);
  const opening = load.kind === "loading" || (doc !== undefined && (!view || (page !== undefined && !viewport)));
  const pending = page !== undefined && viewport !== undefined && painted !== page && broken !== page;

  useEffect(() => {
    let disposed = false, task: PDFDocumentLoadingTask | undefined;
    let thread: Worker | undefined, worker: PDFWorker | undefined, workerFailed: (() => void) | undefined, releasing = false;
    const disposeWorker = () => {
      if (releasing) return;
      releasing = true;
      if (workerFailed) { thread?.removeEventListener("error", workerFailed); thread?.removeEventListener("messageerror", workerFailed); }
      const terminate = () => { worker?.destroy(); thread?.terminate(); };
      // A crashed or blocked worker cannot acknowledge PDF.js's shutdown. Bound
      // the grace period, then release the explicitly owned worker regardless.
      const deadline = window.setTimeout(terminate, 1000);
      void (task?.destroy() ?? Promise.resolve()).then(() => { window.clearTimeout(deadline); terminate(); }, () => { window.clearTimeout(deadline); terminate(); });
    };
    void (async () => {
      const data = new Uint8Array(await source.arrayBuffer());
      if (disposed) return;
      // PDF.js's automatic worker treats custom App schemes as cross-origin and
      // creates a blob wrapper. Own a same-bundle worker instead, preserving the
      // existing self-only script policy and avoiding its main-thread fallback.
      thread = new Worker(new URL(workerSrc, document.baseURI), { type: "module" });
      const failed = new Promise<never>((_, reject) => {
        workerFailed = () => { reject(new Error("pdf_worker_failed")); if (!disposed) setLoad({ kind: "error", reason: "failed" }); disposeWorker(); };
        thread!.addEventListener("error", workerFailed); thread!.addEventListener("messageerror", workerFailed);
      });
      worker = new BundledWorker({ port: thread });
      task = getDocument({ data, worker, cMapUrl: asset("cmaps/"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts/"), wasmUrl: asset("wasm/"), iccUrl: asset("iccs/") });
      // The password goes straight to PDF.js for this document; it is never kept in state or storage.
      task.onPassword = (reply: (password: string) => void, reason: number) => {
        if (disposed) return;
        passwordReply.current = reply; setLoad({ kind: "password", incorrect: reason === PasswordResponses.INCORRECT_PASSWORD });
      };
      const opened = await Promise.race([task.promise, failed]);
      if (!disposed) setLoad({ kind: "ready", doc: opened });
    })().catch((error: unknown) => { if (!disposed) setLoad({ kind: "error", reason: errorName(error) === "InvalidPDFException" ? "invalid" : "failed" }); disposeWorker(); });
    return () => { disposed = true; passwordReply.current = undefined; disposeWorker(); };
  }, [source, attempt]);

  useEffect(() => {
    let query: MediaQueryList | undefined;
    const watch = () => {
      const ratio = window.devicePixelRatio || 1; setPixelRatio(ratio);
      query?.removeEventListener("change", watch); query = window.matchMedia(`(resolution: ${ratio}dppx)`); query.addEventListener("change", watch);
    };
    watch(); return () => query?.removeEventListener("change", watch);
  }, []);

  useEffect(() => {
    const element = scroller.current; if (!element) return;
    // The content box excludes padding and the reserved scrollbar gutter, so fit width never overflows.
    const observer = new ResizeObserver(([entry]) => { const next = Math.floor(entry.contentRect.width); if (next > 0) setWidth(next); });
    observer.observe(element); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!doc) return;
    let stale = false;
    doc.getPage(pageNumber).then((proxy) => { if (!stale) setView({ number: pageNumber, proxy }); }, () => { if (!stale) setView({ number: pageNumber }); });
    return () => { stale = true; };
  }, [doc, pageNumber, repaint]);

  useLayoutEffect(() => {
    live.current = { page: pageNumber, pages, scale, fit, viewport }; requested.current = undefined;
    const target = anchor.current, element = scroller.current, box = paper.current;
    if (!target || !element) return;
    if (target.kind === "page") {
      if (view?.number !== target.page || !viewport) return;
      anchor.current = undefined; element.scrollTop = target.edge === "end" ? element.scrollHeight : 0;
      if (target.edge === "start") element.scrollLeft = 0;
      return;
    }
    // A zoom that never landed (clamped, or overtaken by a resize) must not move the view later.
    if (performance.now() - target.at > 1500) { anchor.current = undefined; if (box) { box.style.transform = ""; box.style.transformOrigin = ""; } return; }
    if (!box || scale === undefined || Math.abs(scale - target.to) > 1e-4) return;
    // Keep the document point that was under the pointer (or the view centre) in place.
    anchor.current = undefined; box.style.transform = ""; box.style.transformOrigin = "";
    const rect = element.getBoundingClientRect();
    element.scrollLeft = box.offsetLeft + target.x * scale - (target.clientX - rect.left - element.clientLeft);
    element.scrollTop = box.offsetTop + target.y * scale - (target.clientY - rect.top - element.clientTop);
  });

  useEffect(() => {
    const host = canvasHost.current;
    if (!host || !page || !viewport) return;
    // Another page never stands in for this one; the same page may, stretched, while it repaints.
    if (shown.current && shown.current.proxy !== page) { release(shown.current.canvas); host.replaceChildren(); shown.current = undefined; setPainted(undefined); }
    const resize = shown.current !== undefined;
    // A fresh canvas per paint: a cancelled task can never draw into the one on screen.
    const canvas = document.createElement("canvas"), size = canvasSize(viewport, pixelRatio);
    canvas.width = size.width; canvas.height = size.height; canvas.setAttribute("aria-hidden", "true");
    let current = true, task: RenderTask | undefined;
    const paint = () => {
      task = page.render({ canvas, viewport, transform: size.transform, background: "#ffffff" });
      task.promise.then(() => {
        if (!current) return;
        const previous = shown.current?.canvas; host.replaceChildren(canvas); if (previous) release(previous);
        shown.current = { proxy: page, canvas }; setPainted(page); setBroken((failed) => failed === page ? undefined : failed);
      }, (error: unknown) => { if (current && errorName(error) !== "RenderingCancelledException") setBroken(page); });
    };
    const timer = resize ? window.setTimeout(paint, REPAINT_DELAY) : undefined;
    if (!resize) paint();
    return () => { current = false; window.clearTimeout(timer); task?.cancel(); if (shown.current?.canvas !== canvas) release(canvas); };
  }, [page, viewport, pixelRatio, repaint]);

  const hasViewport = viewport !== undefined;
  useEffect(() => {
    const container = textHost.current, initial = live.current.viewport;
    if (!container || !page || !initial) return;
    const controller = new AbortController(), { signal } = controller;
    container.replaceChildren();
    // PDF.js builds the runs with textContent only; document text is never parsed as HTML.
    const layer = new TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container, viewport: initial });
    textLayer.current = layer;
    layer.render().then(() => {
      if (signal.aborted) return;
      const end = document.createElement("div"); end.className = "endOfContent"; container.append(end);
    }, () => undefined);
    // Selection behaviour mirrors PDF.js's TextLayerBuilder: while selecting, the
    // end-of-content block covers the page so dragging past a run does not jump.
    let pointerDown = false;
    const settle = () => container.classList.remove("selecting");
    container.addEventListener("mousedown", () => container.classList.add("selecting"), { signal });
    document.addEventListener("pointerdown", () => { pointerDown = true; }, { signal });
    document.addEventListener("pointerup", () => { pointerDown = false; settle(); }, { signal });
    document.addEventListener("keyup", () => { if (!pointerDown) settle(); }, { signal });
    window.addEventListener("blur", () => { pointerDown = false; settle(); }, { signal });
    document.addEventListener("selectionchange", () => {
      const selection = document.getSelection();
      container.classList.toggle("selecting", !!selection && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(container));
    }, { signal });
    // Copy plain text only: the runs are transparent and would paste invisibly as rich text.
    container.addEventListener("copy", (event) => {
      const text = document.getSelection()?.toString();
      if (!text || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", String(normalizeUnicode(text)).replaceAll("\0", ""));
      event.preventDefault(); event.stopPropagation();
    }, { signal });
    return () => { controller.abort(); layer.cancel(); if (textLayer.current === layer) textLayer.current = undefined; container.replaceChildren(); settle(); };
  }, [page, hasViewport]);

  useEffect(() => { if (viewport) textLayer.current?.update({ viewport }); }, [viewport]);
  useEffect(() => () => { page?.cleanup(); }, [page]);

  const goTo = useCallback((target: number, edge: "start" | "end" = "start") => {
    const { page: currentPage, pages: total } = live.current, next = Math.min(total, Math.max(1, Math.round(target)));
    setDraft(undefined);
    if (!total || next === currentPage) return;
    anchor.current = { kind: "page", page: next, edge }; setPageNumber(next);
  }, []);
  const zoomTo = useCallback((next: Zoom, at?: { clientX: number; clientY: number }) => {
    const { scale: current, fit: fitScale } = live.current, element = scroller.current, box = paper.current;
    const to = next === "fit" ? fitScale : clampScale(next);
    if (element && box && current && to) {
      const rect = element.getBoundingClientRect();
      const clientX = at?.clientX ?? rect.left + element.clientLeft + element.clientWidth / 2, clientY = at?.clientY ?? rect.top + element.clientTop + element.clientHeight / 2;
      anchor.current = { kind: "point", to, at: performance.now(), clientX, clientY,
        x: (element.scrollLeft + clientX - rect.left - element.clientLeft - box.offsetLeft) / current,
        y: (element.scrollTop + clientY - rect.top - element.clientTop - box.offsetTop) / current };
      requested.current = to;
    }
    setZoom(next === "fit" ? "fit" : clampScale(next));
  }, []);
  const zoomStep = (direction: 1 | -1) => {
    const current = requested.current ?? live.current.scale; if (!current) return;
    zoomTo(direction > 0 ? ZOOM_STEPS.find((step) => step > current + 0.005) ?? MAX_SCALE : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.005) ?? MIN_SCALE);
  };

  useEffect(() => {
    const element = scroller.current; if (!element) return;
    // Phones: two-finger pinch zooms around the fingers (previewed with a transform,
    // then repainted); a quick horizontal swipe turns the page while it fits the width.
    // macOS trackpads in WebKit pinch through gesture events; elsewhere through Ctrl+wheel.
    type Pinch = { scale: number; ratio: number; clientX: number; clientY: number; x: number; y: number; touch: boolean; distance: number };
    let pinch: Pinch | undefined, swipe: { x: number; y: number; time: number } | undefined, multiTouch = false;
    const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const begin = (clientX: number, clientY: number, touch: boolean, distance = 0) => {
      const box = paper.current, current = live.current.scale;
      if (!box || !current) return;
      const rect = box.getBoundingClientRect();
      pinch = { scale: current, ratio: 1, clientX, clientY, x: clientX - rect.left, y: clientY - rect.top, touch, distance };
      box.style.transformOrigin = `${pinch.x}px ${pinch.y}px`;
    };
    const stretch = (ratio: number) => {
      if (!pinch) return;
      pinch.ratio = clampScale(pinch.scale * ratio) / pinch.scale;
      if (paper.current) paper.current.style.transform = `scale(${pinch.ratio})`;
    };
    const finish = () => {
      const done = pinch; pinch = undefined; if (!done) return;
      const to = clampScale(done.scale * done.ratio), box = paper.current;
      if (Math.abs(to - done.scale) < 0.01) { if (box) { box.style.transform = ""; box.style.transformOrigin = ""; } return; }
      anchor.current = { kind: "point", to, at: performance.now(), clientX: done.clientX, clientY: done.clientY, x: done.x / done.scale, y: done.y / done.scale };
      requested.current = to; setZoom(to);
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length === 1 && !multiTouch) { swipe = { x: event.touches[0].clientX, y: event.touches[0].clientY, time: event.timeStamp }; return; }
      multiTouch = true; swipe = undefined;
      if (event.touches.length === 2 && !pinch) begin((event.touches[0].clientX + event.touches[1].clientX) / 2, (event.touches[0].clientY + event.touches[1].clientY) / 2, true, spread(event.touches));
    };
    const touchMove = (event: TouchEvent) => {
      if (!pinch?.touch || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      stretch(spread(event.touches) / pinch.distance);
    };
    const touchEnd = (event: TouchEvent) => {
      if (pinch?.touch && event.touches.length < 2) finish();
      if (event.touches.length > 0) return;
      const began = swipe, touch = event.changedTouches[0]; swipe = undefined;
      if (multiTouch || !began || !touch) { multiTouch = false; return; }
      const dx = touch.clientX - began.x, dy = touch.clientY - began.y;
      // Long presses (text selection) and diagonal scrolls are not swipes.
      if (event.timeStamp - began.time > 600 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (element.scrollWidth > element.clientWidth + 1 || selectionWithin(textHost.current)) return;
      goTo(live.current.page + (dx < 0 ? 1 : -1));
    };
    const touchCancel = () => {
      swipe = undefined; multiTouch = false;
      if (pinch?.touch) { pinch = undefined; if (paper.current) { paper.current.style.transform = ""; paper.current.style.transformOrigin = ""; } }
    };
    type Gesture = Event & { scale?: number; clientX?: number; clientY?: number };
    const gestureStart = (event: Event) => {
      event.preventDefault(); if (pinch) return; // iOS: the touch handlers already own this pinch
      const gesture = event as Gesture, rect = element.getBoundingClientRect();
      begin(gesture.clientX ?? rect.left + element.clientWidth / 2, gesture.clientY ?? rect.top + element.clientHeight / 2, false);
    };
    const gestureChange = (event: Event) => {
      if (!pinch || pinch.touch) return;
      event.preventDefault(); const { scale: ratio } = event as Gesture; if (typeof ratio === "number" && ratio > 0) stretch(ratio);
    };
    const gestureEnd = (event: Event) => { if (pinch && !pinch.touch) { event.preventDefault(); finish(); } };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const current = requested.current ?? live.current.scale; if (!current) return;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * element.clientHeight : event.deltaY;
      zoomTo(current * Math.exp(-delta * 0.002), { clientX: event.clientX, clientY: event.clientY });
    };
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchmove", touchMove, { passive: false });
    element.addEventListener("touchend", touchEnd); element.addEventListener("touchcancel", touchCancel);
    element.addEventListener("gesturestart", gestureStart); element.addEventListener("gesturechange", gestureChange); element.addEventListener("gestureend", gestureEnd);
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("touchstart", touchStart); element.removeEventListener("touchmove", touchMove);
      element.removeEventListener("touchend", touchEnd); element.removeEventListener("touchcancel", touchCancel);
      element.removeEventListener("gesturestart", gestureStart); element.removeEventListener("gesturechange", gestureChange); element.removeEventListener("gestureend", gestureEnd);
      element.removeEventListener("wheel", wheel);
    };
  }, [goTo, zoomTo]);

  useEffect(() => {
    if (!refocus.current) return;
    if (load.kind === "ready") { refocus.current = false; scroller.current?.focus({ preventScroll: true }); }
    else if (load.kind === "error") { refocus.current = false; stateCard.current?.focus({ preventScroll: true }); }
  }, [load.kind]);
  useEffect(() => () => { if (shown.current) release(shown.current.canvas); shown.current = undefined; TextLayer.cleanup(); }, []);

  const retry = () => { refocus.current = true; restart(); setAttempt((value) => value + 1); };
  const retryPage = () => { setBroken(undefined); setRepaint((value) => value + 1); };
  const unlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget, field = form.elements.namedItem("password"), reply = passwordReply.current;
    const password = field instanceof HTMLInputElement ? field.value : "";
    if (!password || !reply) return;
    passwordReply.current = undefined; form.reset(); refocus.current = true;
    setLoad({ kind: "loading" }); reply(password);
  };
  const commitDraft = () => { if (draft === undefined) return; const next = Number.parseInt(draft, 10); setDraft(undefined); if (Number.isFinite(next)) goTo(next); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = scroller.current;
    if (!doc || !element || event.altKey || event.defaultPrevented) return;
    const command = event.ctrlKey || event.metaKey, field = event.target instanceof Element && event.target.closest("input, select, textarea") !== null;
    if (!field || command) {
      const zoomKey = event.key === "+" || event.key === "=" ? 1 : event.key === "-" ? -1 : event.key === "0" ? 0 : undefined;
      if (zoomKey !== undefined) { event.preventDefault(); if (zoomKey === 0) zoomTo("fit"); else zoomStep(zoomKey); return; }
    }
    if (field || command || event.shiftKey) return;
    const fitsWidth = element.scrollWidth <= element.clientWidth + 1;
    // Arrow keys turn pages only while there is nothing to scroll sideways; Page Up/Down
    // scroll the page first and turn it at the edge.
    if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && fitsWidth) { event.preventDefault(); goTo(pageNumber + (event.key === "ArrowRight" ? 1 : -1)); }
    else if (event.key === "PageDown" && pageNumber < pages && element.scrollTop + element.clientHeight >= element.scrollHeight - 2) { event.preventDefault(); goTo(pageNumber + 1); }
    else if (event.key === "PageUp" && pageNumber > 1 && element.scrollTop <= 1) { event.preventDefault(); goTo(pageNumber - 1, "end"); }
  };

  const paperStyle: StyleWithVars | undefined = viewport && { width: `${Math.floor(viewport.width)}px`, height: `${Math.floor(viewport.height)}px`, "--scale-factor": String(viewport.scale), "--user-unit": String(viewport.userUnit) };
  const fieldStyle: StyleWithVars = { "--digits": String(Math.max(2, String(pages).length)) };
  // Pinch and Ctrl+wheel land between presets; the menu then shows that value too.
  const customZoom = zoom !== "fit" && !ZOOM_PRESETS.some((preset) => Math.abs(preset - zoom) < 1e-6) ? zoom : undefined;
  const zoomText = zoom === "fit" ? t("适合宽度") : t("缩放 {0}%", Math.round(zoom * 100));
  const titleId = `${ids}-title`, hintId = `${ids}-hint`, errorId = `${ids}-error`;
  const pageFailed = view !== undefined && !page;

  return <div className="pdf-reader" onKeyDown={onKeyDown}>
    <div className="pdf-reader-stage">
      <div ref={scroller} className="pdf-reader-viewport" tabIndex={doc ? 0 : -1} role="region" aria-label={name} aria-busy={pending || undefined}>
        {page && paperStyle && <div ref={paper} className="pdf-page" style={paperStyle}>
          <div ref={canvasHost} className="pdf-page-canvas"/>
          <div ref={textHost} className="pdf-text-layer"/>
          {pending && <div className="pdf-page-pending" aria-hidden="true"><LoaderCircle className="spin" size={20}/></div>}
          {broken === page && <div className="pdf-page-failed"><p role="alert">{t("这一页无法显示。")}</p><button type="button" onClick={retryPage}>{t("重试")}</button></div>}
        </div>}
      </div>
      {opening && <div className="pdf-reader-state" role="status"><LoaderCircle className="spin" size={20} aria-hidden="true"/><span>{t("正在打开 PDF…")}</span></div>}
      {pageFailed && <div className="pdf-reader-state"><div className="pdf-reader-card"><p role="alert">{t("这一页无法显示。")}</p><button type="button" onClick={retryPage}>{t("重试")}</button></div></div>}
      {load.kind === "password" && <div className="pdf-reader-state">
        <form className="pdf-reader-card" aria-labelledby={titleId} onSubmit={unlock}>
          <span className="pdf-reader-emblem" aria-hidden="true"><LockKeyhole size={20}/></span>
          <h3 id={titleId}>{t("这个 PDF 已加密")}</h3>
          <p id={hintId}>{t("输入密码后打开。密码只用于这次查看，不会被保存。")}</p>
          <div className="pdf-password-row">
            <input name="password" type="password" required autoFocus autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="go" aria-label={t("PDF 密码")} aria-invalid={load.incorrect || undefined} aria-describedby={load.incorrect ? `${errorId} ${hintId}` : hintId}/>
            <button type="submit" className="primary">{t("解锁")}</button>
          </div>
          {load.incorrect && <p id={errorId} className="error-text" role="alert">{t("密码不正确，请重新输入。")}</p>}
        </form>
      </div>}
      {load.kind === "error" && <div className="pdf-reader-state">
        <div ref={stateCard} className="pdf-reader-card" tabIndex={-1} aria-labelledby={titleId}>
          <span className="pdf-reader-emblem" aria-hidden="true"><FileX size={20}/></span>
          <div role="alert"><h3 id={titleId}>{t("无法显示这个 PDF")}</h3><p>{load.reason === "invalid" ? t("文件可能已损坏，或不是有效的 PDF。可以另存为后用其他应用打开。") : t("读取 PDF 时出错。可以重试，或另存为后用其他应用打开。")}</p></div>
          <button type="button" onClick={retry}>{t("重试")}</button>
        </div>
      </div>}
    </div>
    {doc && <div className="pdf-reader-bar">
      <div className="pdf-reader-group" role="group" aria-label={t("PDF 翻页")}>
        <button type="button" aria-label={t("上一页")} title={t("上一页")} aria-disabled={pageNumber <= 1 || undefined} onClick={() => goTo(pageNumber - 1)}><ChevronLeft size={18} aria-hidden="true"/></button>
        <label className="pdf-page-position">
          <input className="pdf-page-field" style={fieldStyle} value={draft ?? String(pageNumber)} inputMode="numeric" enterKeyHint="go" autoComplete="off" aria-label={t("页码，共 {0} 页", pages)}
            onFocus={(event) => event.currentTarget.select()} onChange={(event) => setDraft(event.currentTarget.value.replace(/\D/g, ""))} onBlur={commitDraft}
            onKeyDown={(event) => { if (event.key === "Enter") commitDraft(); else if (event.key === "Escape" && draft !== undefined) { event.preventDefault(); setDraft(undefined); } }}/>
          <span aria-hidden="true">/ {pages}</span>
        </label>
        <button type="button" aria-label={t("下一页")} title={t("下一页")} aria-disabled={pageNumber >= pages || undefined} onClick={() => goTo(pageNumber + 1)}><ChevronRight size={18} aria-hidden="true"/></button>
      </div>
      <div className="pdf-reader-group" role="group" aria-label={t("PDF 缩放")}>
        <button type="button" className="pdf-zoom-step" aria-label={t("缩小")} title={t("缩小")} aria-disabled={!scale || scale <= MIN_SCALE + 1e-3 || undefined} onClick={() => zoomStep(-1)}><ZoomOut size={18} aria-hidden="true"/></button>
        <select className="pdf-zoom-select" aria-label={t("缩放")} value={zoom === "fit" ? "fit" : String(zoom)} onChange={(event) => { const { value } = event.currentTarget; zoomTo(value === "fit" ? "fit" : Number(value)); }}>
          <option value="fit">{t("适合宽度")}</option>
          {customZoom !== undefined && <option value={String(customZoom)}>{Math.round(customZoom * 100)}%</option>}
          {ZOOM_PRESETS.map((preset) => <option key={preset} value={String(preset)}>{Math.round(preset * 100)}%</option>)}
        </select>
        <button type="button" className="pdf-zoom-step" aria-label={t("放大")} title={t("放大")} aria-disabled={!scale || scale >= MAX_SCALE - 1e-3 || undefined} onClick={() => zoomStep(1)}><ZoomIn size={18} aria-hidden="true"/></button>
      </div>
    </div>}
    <p className="pdf-reader-sr" role="status">{doc && <><span>{t("第 {0} 页，共 {1} 页", pageNumber, pages)}</span> <span>{zoomText}</span></>}</p>
  </div>;
}

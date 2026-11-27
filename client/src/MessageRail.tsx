import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type WheelEvent } from "react";
import { t, useLocale } from "./i18n.js";
import {
  clampPreviewCenter,
  findActiveRailItemId,
  isRailDense,
  normalizeWheelDeltaY,
  railTickBudget,
  sampleMessageRailItems,
  type MessageRailItem,
} from "./message-rail.js";
import "./message-rail.css";

const MAX_RAIL_TICKS = 44;
const WAKE_HOLD_MS = 1100;
const FALLBACK_PREVIEW_HALF_HEIGHT = 68;

export type MessageRailProps = {
  items: readonly MessageRailItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Current anchor message index in `displayedMessages` (typically derived from scroll/virtualizer). */
  anchorIndex: number;
  /** Whether the viewport is currently scrolled to the bottom. */
  atBottom: boolean;
  /** Jump to a message by ID (and its index in `displayedMessages`). */
  onJump: (item: MessageRailItem) => void;
  /** Forward wheel movement so scrolling over the rail moves the conversation naturally. */
  onWheelDirection?: (deltaY: number) => void;
};

function formatRailTime(timestamp: number, locale: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    return sameDay
      ? date.toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Subtle right-edge message rail for desktop conversations. One tick per user
 * turn (sampled evenly in very long threads), lights up on scroll/hover, shows
 * a turn + reply preview card on hover/focus, and clicks jump directly there. */
export function MessageRail({ items, scrollRef, anchorIndex, atBottom, onJump, onWheelDirection }: MessageRailProps) {
  const locale = useLocale();
  const railRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [awake, setAwake] = useState(false);
  const [hoveredId, setHoveredId] = useState<string>();
  const [previewAnchorY, setPreviewAnchorY] = useState<number>(0);
  const [previewTop, setPreviewTop] = useState<number>(0);
  const [bounds, setBounds] = useState<{ top: number; height: number }>();
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const activeId = useMemo(
    () => findActiveRailItemId(items, anchorIndex, atBottom),
    [items, anchorIndex, atBottom],
  );
  const maxTicks = bounds ? railTickBudget(bounds.height, MAX_RAIL_TICKS) : MAX_RAIL_TICKS;
  const visibleItems = useMemo(
    () => sampleMessageRailItems(items, activeId, maxTicks),
    [items, activeId, maxTicks],
  );
  const hoveredItem = hoveredId ? visibleItems.find((item) => item.id === hoveredId) : undefined;
  const dense = isRailDense(visibleItems.length, bounds?.height);

  const wake = useCallback(() => {
    setAwake(true);
    clearTimeout(wakeTimer.current);
    wakeTimer.current = setTimeout(() => setAwake(false), WAKE_HOLD_MS);
  }, []);

  useEffect(() => () => { clearTimeout(wakeTimer.current); }, []);

  // Align the rail strictly to the vertical bounds of `.message-scroll` inside `.conversation-main`.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const parent = viewport?.parentElement;
    if (!viewport || !parent) return;
    const measure = () => {
      const top = viewport.offsetTop;
      const height = viewport.clientHeight;
      setBounds((prev) => prev && prev.top === top && prev.height === height ? prev : { top, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [scrollRef, items.length]);

  // Wake the rail whenever the message viewport scrolls.
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const onScroll = () => wake();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [scrollRef, wake]);

  // Clear stale hover if the hovered item disappears (e.g. conversation switch).
  useEffect(() => {
    if (hoveredId && !visibleItems.some((item) => item.id === hoveredId)) setHoveredId(undefined);
  }, [hoveredId, visibleItems]);

  const positionPreview = useCallback((button: HTMLElement) => {
    const rail = railRef.current;
    if (!rail) return;
    const railRect = rail.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    const center = btnRect.top + btnRect.height / 2 - railRect.top;
    setPreviewAnchorY(center);
    const measuredHalf = previewRef.current
      ? previewRef.current.getBoundingClientRect().height / 2
      : FALLBACK_PREVIEW_HALF_HEIGHT;
    const halfHeight = measuredHalf > 0 ? measuredHalf : FALLBACK_PREVIEW_HALF_HEIGHT;
    setPreviewTop(clampPreviewCenter(center, railRect.height, halfHeight));
  }, []);

  // Re-clamp against the actual rendered preview height before paint so tall
  // cards never bleed into the header or composer on shorter viewports.
  useLayoutEffect(() => {
    if (!hoveredItem) return;
    const rail = railRef.current;
    const preview = previewRef.current;
    if (!rail || !preview) return;
    const clamp = () => {
      const railHeight = rail.getBoundingClientRect().height;
      const previewHeight = preview.getBoundingClientRect().height;
      if (railHeight <= 0 || previewHeight <= 0) return;
      const next = clampPreviewCenter(previewAnchorY, railHeight, previewHeight / 2);
      setPreviewTop((prev) => Math.abs(prev - next) < 0.5 ? prev : next);
    };
    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [hoveredItem, previewAnchorY, bounds?.height]);

  const handleWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const fontSize = parseFloat(getComputedStyle(viewport).fontSize);
    const lineHeight = Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : 24;
    const deltaY = normalizeWheelDeltaY(event.deltaY, event.deltaMode, lineHeight, viewport.clientHeight);
    if (deltaY !== 0) {
      onWheelDirection?.(deltaY);
      viewport.scrollTop += deltaY;
      wake();
    }
  }, [scrollRef, onWheelDirection, wake]);

  if (items.length < 2 || maxTicks < 2) return null;

  return (
    <nav
      ref={railRef}
      className={`message-rail${awake ? " is-awake" : ""}${hoveredItem ? " is-hovering" : ""}${dense ? " is-dense" : ""}`}
      aria-label={t("消息刻度条")}
      style={bounds ? { top: bounds.top, height: bounds.height } : undefined}
      onMouseEnter={() => { setAwake(true); clearTimeout(wakeTimer.current); }}
      onMouseLeave={() => { setHoveredId(undefined); wake(); }}
      onWheel={handleWheel}
    >
      <ul className="message-rail-track" role="list">
        {visibleItems.map((item) => {
          const isActive = item.id === activeId;
          const isHovered = item.id === hoveredId;
          const label = t("第 {0} 条消息：{1}", item.turnNumber, item.prompt);
          return (
            <li key={item.id} className="message-rail-item">
              <button
                type="button"
                className={`message-rail-tick${isActive ? " is-active" : ""}${isHovered ? " is-hovered" : ""}`}
                data-rail-message-id={item.id}
                data-rail-turn={item.turnNumber}
                aria-label={label}
                aria-current={isActive ? "location" : undefined}
                onMouseEnter={(event) => { setHoveredId(item.id); positionPreview(event.currentTarget); }}
                onFocus={(event) => { setAwake(true); setHoveredId(item.id); positionPreview(event.currentTarget); }}
                onBlur={() => { setHoveredId((current) => current === item.id ? undefined : current); wake(); }}
                onClick={() => onJump(item)}
              >
                <span className="message-rail-bar" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {hoveredItem && (
        <div
          ref={previewRef}
          className="message-rail-preview"
          role="tooltip"
          style={{ top: previewTop }}
        >
          <div className="message-rail-preview-head">
            <span className="message-rail-preview-turn">
              {hoveredItem.sourceLabel
                ? hoveredItem.sourceLabel
                : t("第 {0} / {1} 轮", hoveredItem.turnNumber, items.length)}
            </span>
            <time className="message-rail-preview-time">{formatRailTime(hoveredItem.createdAt, locale)}</time>
          </div>
          <p className="message-rail-preview-prompt">{hoveredItem.prompt}</p>
          {hoveredItem.replyPreview && (
            <p className="message-rail-preview-reply">
              {hoveredItem.replyAuthor ? <strong>{hoveredItem.replyAuthor}: </strong> : null}
              {hoveredItem.replyPreview}
            </p>
          )}
        </div>
      )}
    </nav>
  );
}

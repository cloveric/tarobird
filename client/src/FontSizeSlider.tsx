import { useRef, type PointerEvent } from "react";
import { t } from "./i18n.js";
import "./font-size-slider.css";

/** Keep native keyboard/assistive controls, but arbitrate touch before changing
 * the value: a native range eagerly jumps on touch-down during page scrolling. */
export function FontSizeSlider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; axis: "pending" | "horizontal" | "vertical" } | null>(null);
  const setFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Match the 24px thumb's centre at either end of the native track.
    const fraction = (event.clientX - rect.left - 12) / Math.max(1, rect.width - 24);
    onChange(Math.max(12, Math.min(20, Math.round(12 + fraction * 8))));
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.id === event.pointerId) gesture.current = null;
  };
  return <div className="settings-row font-size-row">
    <label htmlFor="font-size">{t("字号")}</label>
    <div className="font-size-slider" onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || gesture.current) return;
      const mouse = event.pointerType === "mouse";
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: mouse ? "horizontal" : "pending" };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (mouse) {
        event.preventDefault();
        input.current?.focus({ preventScroll: true });
        setFromPointer(event);
      }
    }} onPointerMove={event => {
      const active = gesture.current;
      if (!active || active.id !== event.pointerId) return;
      if (active.axis === "pending") {
        const dx = Math.abs(event.clientX - active.x), dy = Math.abs(event.clientY - active.y);
        if (Math.max(dx, dy) < 8) return;
        if (dy >= dx) active.axis = "vertical";
        else if (dx > dy * 1.5) active.axis = "horizontal";
      }
      if (active.axis === "horizontal") setFromPointer(event);
    }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}>
      <input ref={input} id="font-size" type="range" min="12" max="20" step="1" value={value} aria-valuetext={`${value} px`} onChange={event => onChange(Number(event.target.value))}/>
    </div>
    <output htmlFor="font-size" className="font-size-value">{value} <small>px</small></output>
  </div>;
}

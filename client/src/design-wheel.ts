/** Canvas-only wheel response. Keep fine pixel motion intact; soften large
 * mouse-wheel/accelerated inputs without guessing which device produced them.
 * Self-contained: the build adapter also embeds this function in artboard frames.
 * Do not apply this to native scrollable panels, touch/drag or gesture events. */
export function designWheelDelta(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">, width: number, height: number) {
  const mode = event.deltaMode;
  const unitX = mode === 1 ? 16 : mode === 2 ? Math.max(1, width) : 1;
  const unitY = mode === 1 ? 16 : mode === 2 ? Math.max(1, height) : 1;
  const x = Number.isFinite(event.deltaX) ? event.deltaX * unitX : 0;
  const y = Number.isFinite(event.deltaY) ? event.deltaY * unitY : 0;
  const length = Math.hypot(x, y);
  // A diagonal event has the same travel budget as a vertical one, preserving
  // direction. The curve joins continuously at 12 px and approaches 60 px.
  const travel = length <= 12 ? length : 12 + 48 * (1 - Math.exp(-(length - 12) / 96));
  const gain = length > 0 ? travel / length : 0;
  return { dx: x * gain, dy: y * gain, zoomLog: Math.max(-0.075, Math.min(0.075, -y * 0.01)) };
}

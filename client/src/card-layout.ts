import type { CSSProperties } from "react";
import type { CardElement, Json } from "../../src/client-protocol/index.js";

const colors = new Set(["red", "blue", "green", "grey", "orange"]);
const length = (value: Json | undefined) => typeof value === "string" && /^(?:\d{1,3}px ?){1,4}$/.test(value) ? value : undefined;
const color = (value: Json | undefined) => typeof value === "string" && colors.has(value) ? `var(--${value})` : undefined;
/** Only semantic colors and bounded CSS dimensions cross the card boundary. */
export function cardLayoutStyle(element: Pick<CardElement, "type" | "layout">): CSSProperties {
  const layout = element.layout ?? {}, style: CSSProperties = {};
  style.padding = length(layout.padding); style.margin = length(layout.margin);
  style.columnGap = length(layout.columnSpacing ?? layout.horizontalSpacing); style.rowGap = length(layout.verticalSpacing);
  if (typeof layout.weight === "number" && Number.isFinite(layout.weight) && layout.weight > 0) style.flex = `${Math.min(layout.weight, 100)} 1 0%`;
  if (layout.width === "auto") style.flex = "0 0 auto";
  else if (layout.width === "fill") {
    style.flex = "1 1 0%";
    // Buttons normally hug their label. Inside a vertical card column, flex
    // alone only affects height; stretch the cross axis to fill its width too.
    if (element.type === "button") style.alignSelf = "stretch";
  }
  else if (length(layout.width) && !String(layout.width).trim().includes(" ")) { style.width = length(layout.width); style.flex = "0 0 auto"; }
  if (length(layout.height) && !String(layout.height).trim().includes(" ")) style.height = length(layout.height);
  const row = layout.direction === "horizontal" || layout.direction !== "vertical" && (element.type === "columns" || element.type === "buttonGroup");
  if (layout.direction === "horizontal" || layout.direction === "vertical") style.flexDirection = row ? "row" : "column";
  const vertical = { top: "flex-start", center: "center", bottom: "flex-end" };
  const horizontal = { left: "flex-start", center: "center", right: "flex-end" };
  const v = vertical[layout.verticalAlign as keyof typeof vertical], h = horizontal[layout.horizontalAlign as keyof typeof horizontal];
  if (v) { if (row) style.alignItems = v; else style.justifyContent = v; }
  if (h) { if (row) style.justifyContent = h; else style.alignItems = h; }
  if (row && (layout.flexMode === "flow" || layout.flexMode === "none")) style.flexWrap = layout.flexMode === "flow" ? "wrap" : "nowrap";
  if (["left", "center", "right"].includes(String(layout.textAlign))) style.textAlign = layout.textAlign as "left" | "center" | "right";
  const fonts: Record<string, string> = { notation: "12px", normal: "14px", heading: "16px" };
  if (typeof layout.textSize === "string") style.fontSize = fonts[layout.textSize];
  style.color = color(layout.textColor);
  if (layout.background === "grey") style.background = "var(--surface)";
  else if (layout.background === "default") style.background = "var(--bg)";
  style.borderRadius = length(layout.borderRadius);
  if (typeof layout.border === "object" && layout.border && !Array.isArray(layout.border)) {
    style.border = `1px solid ${color(layout.border.color) ?? "var(--border)"}`;
    style.borderRadius = length(layout.border.corner_radius) ?? style.borderRadius;
  }
  return style;
}

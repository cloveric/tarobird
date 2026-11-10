import { z } from "zod";
import { expandedIphoneWindow } from "./ios-window.js";

export const ADHD_PANEL_LIMIT = 12;
export const adhdPaneSchema = z.object({
  hostId: z.string().min(1).max(128), registrationId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(256),
}).strict();
export type AdhdPaneRef = z.infer<typeof adhdPaneSchema>;
export const adhdPaneKey = (pane: AdhdPaneRef) => JSON.stringify([pane.hostId, pane.registrationId, pane.conversationId]);
// Keep the original layout record readable by 1.0.86 during rollback. Display
// options live in a separate record, committed atomically with the layout.
export const adhdLegacyBoardSchema = z.object({
  version: z.literal(1), columns: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4)]),
  panes: z.array(adhdPaneSchema).max(ADHD_PANEL_LIMIT),
}).strict().refine(value => new Set(value.panes.map(adhdPaneKey)).size === value.panes.length, "duplicate_adhd_pane");
export const adhdViewSchema = z.object({
  version: z.literal(1), columns: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  fontSize: z.number().int().min(11).max(16),
}).strict();
export const adhdBoardSchema = z.object({
  version: z.literal(1), columns: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  fontSize: z.number().int().min(11).max(16).default(12),
  panes: z.array(adhdPaneSchema).max(ADHD_PANEL_LIMIT),
}).strict().refine(value => new Set(value.panes.map(adhdPaneKey)).size === value.panes.length, "duplicate_adhd_pane");
export type AdhdBoardState = z.infer<typeof adhdBoardSchema>;
export const emptyAdhdBoard = (): AdhdBoardState => ({ version: 1, columns: 0, fontSize: 12, panes: [] });
export function addAdhdPane(board: AdhdBoardState, pane: AdhdPaneRef): AdhdBoardState {
  adhdPaneSchema.parse(pane);
  if (board.panes.some(item => adhdPaneKey(item) === adhdPaneKey(pane))) return board;
  return adhdBoardSchema.parse({ ...board, panes: [...board.panes, pane] });
}
export function moveAdhdPane(board: AdhdBoardState, key: string, destination: number): AdhdBoardState {
  const index = board.panes.findIndex(item => adhdPaneKey(item) === key);
  if (index < 0 || !Number.isInteger(destination) || destination < 0 || destination >= board.panes.length || index === destination) return board;
  const panes = [...board.panes], [pane] = panes.splice(index, 1); panes.splice(destination, 0, pane!);
  return { ...board, panes };
}
export function adhdColumns(width: number, count: number, requested: number, minimum = 300, maximum = 6) {
  // Explicit choices are honored with horizontal scrolling at the card minimum.
  // Auto fills the available width instead of imposing a three-column ceiling.
  const capacity = Math.min(maximum, Math.max(1, Math.floor((width + 10) / (minimum + 10))));
  if (requested) return Math.max(1, Math.min(count || 1, maximum, requested));
  // Distribute the last row: seven panes become 4 + 3 rather than 6 + 1.
  return Math.max(1, Math.ceil(count / Math.max(1, Math.ceil(count / capacity))));
}
export function adhdSupported(platform: string, width: number) {
  return !["ios", "android"].includes(platform) && width > 760;
}
/** The ADHD board itself also opens on native iOS once the window is
 * desktop-wide (iPad, an unfolded iPhone). Android stays out, and the diff
 * viewers and Agent Bus keep `adhdSupported`. */
export function adhdBoardSupported(platform: string, width: number, height: number, userAgent: string) {
  return platform !== "android" && width > 760
    && (!adhdPhoneBoard(platform, userAgent) || expandedIphoneWindow(platform, userAgent, width, height));
}
/** An unfolded iPhone: two tall panes beside the full picker. */
export const ADHD_PHONE_CARD_MIN = 260, ADHD_PHONE_COLUMNS = 2;
/** Folding shut must hold this long before the board gives way, so a transient size during the fold does not exit. */
export const ADHD_FOLD_SETTLE_MS = 450;
export function adhdPhoneBoard(platform: string, userAgent: string) {
  return platform === "ios" && /\biPhone\b/.test(userAgent);
}

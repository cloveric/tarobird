import { designFormatSchema } from "../../src/client-protocol/workbench-design.js";
import { z } from "zod";
import { workbenchSourceSchema, type WorkbenchSource } from "../../src/client-protocol/workbench.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const workbenchTabSchema = z.object({
  id, kind: z.enum(["whiteboard", "chart", "browser", "markdown", "design"]), title: z.string().trim().min(1).max(128),
  designFormat: designFormatSchema.optional(),
  source: workbenchSourceSchema.optional(), url: z.string().max(8192).optional(),
}).strict();
export type WorkbenchTab = z.infer<typeof workbenchTabSchema>;
export const workbenchLayoutSchema = z.object({
  schema: z.literal(1), revision: z.number().int().nonnegative(),
  tabs: z.array(workbenchTabSchema).max(64), closed: z.array(workbenchTabSchema).max(64),
  visible: z.array(id).max(4), active: id.nullable(), maximized: id.nullable(), expanded: z.boolean(),
  column: z.number().min(.2).max(.8), row: z.number().min(.2).max(.8),
}).strict().superRefine((value, ctx) => {
  const ids = new Set(value.tabs.map(tab => tab.id));
  if (ids.size !== value.tabs.length || new Set(value.visible).size !== value.visible.length
    || value.visible.some(tab => !ids.has(tab)) || value.active && !value.visible.includes(value.active)
    || value.maximized && !value.visible.includes(value.maximized)
    || value.closed.some(tab => ids.has(tab.id)) || new Set(value.closed.map(tab => tab.id)).size !== value.closed.length)
    ctx.addIssue({ code: "custom", message: "invalid_workbench_layout" });
});
export type WorkbenchLayout = z.infer<typeof workbenchLayoutSchema>;
export function emptyWorkbench(): WorkbenchLayout {
  return { schema: 1, revision: 0, tabs: [], closed: [], visible: [], active: null, maximized: null, expanded: false, column: .5, row: .5 };
}
export function workbenchScope(host: string, user: string, conversation: string): string {
  return JSON.stringify([host, user, conversation]);
}
export type LayoutAction =
  | { type: "open"; tab: WorkbenchTab }
  | { type: "select" | "split" | "remove" | "close" | "reopen" | "delete" | "maximize"; id: string }
  | { type: "tile" } | { type: "single"; id?: string }
  | { type: "set-visible"; ids: string[] }
  | { type: "rename"; id: string; title: string }
  | { type: "move"; id: string; direction: -1 | 1 }
  | { type: "chart"; id: string; source: WorkbenchSource; previous: WorkbenchSource }
  | { type: "browser"; id: string; url: string; title?: string }
  | { type: "expanded"; value: boolean }
  | { type: "ratio"; axis: "column" | "row"; value: number };

/** Pure layout operations; the active region alone is replaced, never a neighbor. */
export function changeWorkbench(old: WorkbenchLayout, action: LayoutAction): WorkbenchLayout {
  const next = structuredClone(old);
  const replace = (tab: string) => {
    // A maximized split shows only its active region; selecting another region follows it.
    if (next.visible.includes(tab)) { next.active = tab; if (next.maximized) next.maximized = tab; return; }
    if (!next.visible.length) next.visible = [tab];
    else next.visible.splice(Math.max(0, next.visible.indexOf(next.active ?? "")), 1, tab);
    next.active = tab; next.maximized = null;
  };
  if (action.type === "expanded") next.expanded = action.value;
  else if (action.type === "ratio") next[action.axis] = Math.max(.2, Math.min(.8, action.value));
  else if (action.type === "set-visible") {
    // One serialized commit, not a sequence of remove/add operations. Reject
    // stale choices instead of silently substituting or reopening closed tabs.
    if (action.ids.length < 2 || action.ids.length > 4 || new Set(action.ids).size !== action.ids.length)
      throw new Error("workbench_split_selection");
    if (action.ids.some(id => !next.tabs.some(tab => tab.id === id))) throw new Error("workbench_tab_closed");
    next.visible = [...action.ids];
    if (!next.active || !next.visible.includes(next.active)) next.active = next.visible[0];
    next.maximized = null;
  }
  else if (action.type === "tile") {
    // An existing split is restored as it was; one region becomes the active tab
    // plus the leftmost others, up to four, in tab order. Repeating never merges,
    // and fewer than two open tabs leave the regions as they are.
    if (next.visible.length < 2 && next.tabs.length >= 2) {
      const current = next.active ?? next.visible[0] ?? next.tabs[0].id;
      const shown = new Set([current, ...next.tabs.filter(tab => tab.id !== current).slice(0, 3).map(tab => tab.id)]);
      next.visible = next.tabs.filter(tab => shown.has(tab.id)).map(tab => tab.id); next.active = current;
    }
    next.maximized = null;
  } else if (action.type === "open") {
    const tab = workbenchTabSchema.parse(action.tab);
    if (!next.tabs.some(value => value.id === tab.id)) { if (next.tabs.length >= 64) throw new Error("workbench_tab_limit"); next.tabs.push(tab); }
    next.closed = next.closed.filter(value => value.id !== tab.id); replace(tab.id);
  } else if (action.type === "reopen") {
    const tab = next.closed.find(value => value.id === action.id); if (!tab) throw new Error("workbench_tab_not_found");
    return changeWorkbench(old, { type: "open", tab });
  } else if (action.type === "single") {
    // Merging keeps one region: the named tab (rejected once closed), else the active one.
    if (action.id !== undefined && !next.tabs.some(tab => tab.id === action.id)) throw new Error("workbench_tab_closed");
    const current = action.id ?? next.active ?? next.visible[0] ?? null;
    next.visible = current ? [current] : []; next.active = current; next.maximized = null;
  } else if (action.type === "delete") {
    next.closed = next.closed.filter(tab => tab.id !== action.id);
    next.tabs = next.tabs.filter(tab => tab.id !== action.id);
    next.visible = next.visible.filter(tab => tab !== action.id);
  } else {
    const tab = next.tabs.find(value => value.id === action.id); if (!tab) throw new Error("workbench_tab_closed");
    if (action.type === "select") replace(tab.id);
    else if (action.type === "split") {
      if (!next.visible.includes(tab.id)) { if (next.visible.length === 4) throw new Error("workbench_split_full"); next.visible.push(tab.id); }
      next.active = tab.id; next.maximized = null;
    } else if (action.type === "remove" || action.type === "close") {
      if (action.type === "close" && next.closed.length >= 64) throw new Error("workbench_closed_limit");
      next.visible = next.visible.filter(id => id !== tab.id);
      if (action.type === "close") { next.tabs = next.tabs.filter(value => value.id !== tab.id); next.closed = [...next.closed.filter(value => value.id !== tab.id), tab]; }
    } else if (action.type === "maximize") {
      if (!next.visible.includes(tab.id)) throw new Error("workbench_region_not_visible");
      next.maximized = next.maximized === tab.id ? null : tab.id; next.active = tab.id;
    } else if (action.type === "rename") tab.title = workbenchTabSchema.shape.title.parse(action.title);
    else if (action.type === "move") {
      const from = next.tabs.indexOf(tab), to = Math.max(0, Math.min(next.tabs.length - 1, from + action.direction));
      next.tabs.splice(from, 1); next.tabs.splice(to, 0, tab);
    } else if (action.type === "chart") {
      if (tab.kind !== "chart" || JSON.stringify(tab.source) !== JSON.stringify(action.previous)) throw new Error("workbench_source_conflict");
      tab.source = workbenchSourceSchema.parse(action.source);
    } else if (action.type === "browser") {
      if (tab.kind !== "browser") throw new Error("workbench_wrong_kind");
      tab.url = action.url; if (action.title?.trim()) tab.title = action.title.trim().slice(0, 128);
    }
  }
  if (next.active && !next.visible.includes(next.active)) next.active = next.visible[0] ?? null;
  // Only a split can be maximized; a single remaining region is plain single view.
  if (next.maximized && (next.visible.length < 2 || !next.visible.includes(next.maximized))) next.maximized = null;
  next.revision++;
  return workbenchLayoutSchema.parse(next);
}

export const WORKBENCH_BOARD_BYTES = 32 * 1024 * 1024;
export const WORKBENCH_SCENE_BYTES = 2 * 1024 * 1024;
const jsonObject = z.record(z.string(), z.json());
export const boardSceneSchema = z.object({
  elements: z.array(jsonObject).max(2000), appState: jsonObject,
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= WORKBENCH_SCENE_BYTES, "whiteboard_scene_too_large");
export type BoardScene = z.infer<typeof boardSceneSchema>;
export const boardDocumentSchema = z.object({
  schema: z.literal(1), id, revision: z.number().int().nonnegative(), scene: boardSceneSchema,
  files: z.record(z.string(), jsonObject), undo: z.array(boardSceneSchema).max(12), redo: z.array(boardSceneSchema).max(12),
  receipts: z.array(z.object({ id, fingerprint: z.string().max(128), revision: z.number().int().nonnegative() }).strict()).max(128),
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= WORKBENCH_BOARD_BYTES, "whiteboard_storage_limit");
export type BoardDocument = z.infer<typeof boardDocumentSchema>;
/** Autosave pre-check for a document whose scenes were already validated (the
 * draft scene in BoardSession.local, undo/redo when they were saved): structure,
 * files and the document byte budget, without re-walking each element through
 * zod. Failures are ZodErrors like the full schema's. The storage boundary still
 * applies the full schema before anything is written. */
const boardFilesSchema = z.record(z.string(), jsonObject);
const flushFailure = (message: string): never => { z.custom(() => false, { message }).parse(undefined); throw new Error(message); };
export function checkBoardFlush(document: BoardDocument): void {
  const plain = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value);
  if (document.undo.length > 12 || document.redo.length > 12 || document.receipts.length > 128) flushFailure("whiteboard_invalid_input");
  for (const scene of [document.scene, ...document.undo, ...document.redo]) {
    if (!plain(scene) || !Array.isArray(scene.elements) || scene.elements.length > 2000 || !plain(scene.appState) || !scene.elements.every(plain)) flushFailure("whiteboard_invalid_input");
  }
  boardFilesSchema.parse(document.files);
  if (new TextEncoder().encode(JSON.stringify(document)).length > WORKBENCH_BOARD_BYTES) flushFailure("whiteboard_storage_limit");
}
export function emptyBoard(id: string): BoardDocument {
  return { schema: 1, id, revision: 0, scene: { elements: [], appState: { viewBackgroundColor: "#ffffff" } }, files: {}, undo: [], redo: [], receipts: [] };
}
/** Coordinates/selection are ephemeral; only necessary editor view state is saved. */
export function savedBoardState(value: Record<string, unknown>): BoardScene["appState"] {
  const keep = ["viewBackgroundColor", "scrollX", "scrollY", "zoom", "gridSize", "gridStep", "gridModeEnabled"];
  return Object.fromEntries(keep.filter(key => value[key] !== undefined).map(key => [key, value[key] as BoardScene["appState"][string]]));
}

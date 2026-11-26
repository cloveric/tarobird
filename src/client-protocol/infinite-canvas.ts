import { z } from "zod";

/** Compatible with basketikun/infinite-canvas Canvas Agent protocol v12 (MIT). */
export const CANVAS_AGENT_PROTOCOL_VERSION = 12 as const;

const recordSchema = z.record(z.string(), z.unknown());
const positionSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({ x: z.number(), y: z.number(), k: z.number() });
const nodeTypeSchema = z.enum(["image", "text", "video", "audio", "group"]);
const nodePatchSchema = z.object({
  title: z.string().optional(),
  position: positionSchema.optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  metadata: recordSchema.optional(),
}).strict();
const generationModeSchema = z.enum(["text", "image", "video", "audio"]);

export const CANVAS_TOOL_NAMES = [
  "canvas_get_state",
  "canvas_get_nodes",
  "canvas_list_models",
  "canvas_apply_ops",
  "canvas_list_references",
  "canvas_insert_media",
  "canvas_view_image",
  "canvas_create_text_nodes",
  "canvas_create_generation_flow",
  "generation_get_status",
  "prompts_search",
  "assets_list",
  "assets_add",
] as const;

export type CanvasToolName = (typeof CANVAS_TOOL_NAMES)[number];

export const canvasOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_node"), nodeType: nodeTypeSchema.optional(), id: z.string().optional(), title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), position: positionSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
  z.object({ type: z.literal("update_node"), id: z.string(), patch: nodePatchSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
  z.object({ type: z.literal("move_nodes"), items: z.array(z.object({ id: z.string(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() })).min(1) }),
  z.object({ type: z.literal("group_nodes"), ids: z.array(z.string()).min(1), title: z.string().optional(), id: z.string().optional() }),
  z.object({ type: z.literal("ungroup_nodes"), ids: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("set_group_members"), groupId: z.string(), nodeIds: z.array(z.string()) }),
  z.object({ type: z.literal("delete_node"), id: z.string().optional(), ids: z.array(z.string()).optional() }).passthrough(),
  z.object({ type: z.literal("delete_connections"), id: z.string().optional(), ids: z.array(z.string()).optional(), all: z.boolean().optional() }).passthrough(),
  z.object({ type: z.literal("connect_nodes"), id: z.string().optional(), fromNodeId: z.string(), toNodeId: z.string() }).passthrough(),
  z.object({ type: z.literal("set_viewport"), viewport: viewportSchema }).passthrough(),
  z.object({ type: z.literal("select_nodes"), ids: z.array(z.string()) }).passthrough(),
  z.object({ type: z.literal("run_generation"), nodeId: z.string(), mode: generationModeSchema.optional(), prompt: z.string().optional() }).passthrough(),
]);
export type CanvasAgentOp = z.infer<typeof canvasOpSchema>;

const textNodeSchema = z.object({
  text: z.string(),
  title: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const generationOptionsSchema = z.object({
  model: z.string().optional(),
  size: z.string().optional(),
  quality: z.string().optional(),
  count: z.number().optional(),
  seconds: z.string().optional(),
  vquality: z.string().optional(),
  generateAudio: z.string().optional(),
  watermark: z.string().optional(),
  videoMode: z.string().optional(),
  audioVoice: z.string().optional(),
  audioFormat: z.string().optional(),
  audioSpeed: z.string().optional(),
  audioInstructions: z.string().optional(),
});

export const canvasToolInputSchemas = {
  canvas_get_state: z.object({ ids: z.array(z.string()).optional(), types: z.array(nodeTypeSchema).optional(), selectedOnly: z.boolean().optional(), groupId: z.string().optional(), keyword: z.string().optional(), includeConnections: z.boolean().optional(), offset: z.number().int().min(0).optional() }),
  canvas_get_nodes: z.object({ ids: z.array(z.string()).min(1).max(50) }),
  canvas_list_models: z.object({ capability: generationModeSchema.optional(), keyword: z.string().optional() }),
  canvas_apply_ops: z.object({ ops: z.array(canvasOpSchema).max(200) }),
  canvas_list_references: z.object({}),
  canvas_insert_media: z.object({ assetId: z.string().optional(), storageKey: z.string().optional(), title: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
  canvas_view_image: z.object({ nodeId: z.string().optional(), storageKey: z.string().optional() }),
  canvas_create_text_nodes: z.object({ items: z.array(textNodeSchema).min(1), x: z.number().optional(), y: z.number().optional(), gap: z.number().optional(), direction: z.enum(["row", "column"]).optional() }),
  canvas_create_generation_flow: z.object({
    prompt: z.string(),
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    referenceNodeIds: z.array(z.string()).optional(),
    mode: generationModeSchema.optional(),
    autoRun: z.boolean().optional(),
  }).merge(generationOptionsSchema),
  generation_get_status: z.object({ scope: z.enum(["all", "canvas", "image", "video"]).optional(), taskId: z.string().optional(), nodeIds: z.array(z.string()).optional(), limit: z.number().optional() }),
  prompts_search: z.object({ keyword: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), page: z.number().optional(), pageSize: z.number().optional() }),
  assets_list: z.object({ ids: z.array(z.string()).optional(), includeContent: z.boolean().optional(), kind: z.enum(["all", "text", "image", "video"]).optional(), keyword: z.string().optional(), page: z.number().optional(), pageSize: z.number().optional() }),
  assets_add: z.object({ kind: z.enum(["text", "image"]), title: z.string(), content: z.string().optional(), imageUrl: z.string().optional(), source: z.string().optional(), note: z.string().optional() }),
} satisfies Record<CanvasToolName, z.ZodObject<z.ZodRawShape>>;

export const canvasToolDescriptions: Record<CanvasToolName, string> = {
  canvas_get_state: "Read compact canvas overview: node IDs, types, titles, positions, sizes, states, group members and text previews.",
  canvas_get_nodes: "Read full text, generation parameters, media dimensions and group members for up to 50 node IDs.",
  canvas_list_models: "List configured image/video/text/audio model IDs and defaults on the canvas.",
  canvas_apply_ops: "Apply batch operations on the canvas: add_node, update_node, move_nodes, group_nodes, ungroup_nodes, set_group_members, delete_node, delete_connections, connect_nodes, set_viewport, select_nodes, run_generation.",
  canvas_list_references: "List recent uploaded reference images on the current canvas project.",
  canvas_insert_media: "Insert an asset or reference image onto the canvas.",
  canvas_view_image: "Inspect an image node or asset image by nodeId or storageKey.",
  canvas_create_text_nodes: "Create one or more text nodes arranged in a row or column.",
  canvas_create_generation_flow: "Create a generation flow on the canvas (optionally autoRun=true to trigger generation nodes).",
  generation_get_status: "Check status of canvas or workbench generation tasks.",
  prompts_search: "Search the canvas prompt library by keyword, category or tags.",
  assets_list: "List saved assets in the canvas asset library.",
  assets_add: "Save a text or image asset into the canvas asset library.",
};

export function isCanvasToolName(name: string): name is CanvasToolName {
  return (CANVAS_TOOL_NAMES as readonly string[]).includes(name);
}

export function parseCanvasToolInput<K extends CanvasToolName>(name: K, raw: unknown): z.infer<(typeof canvasToolInputSchemas)[K]> {
  return canvasToolInputSchemas[name].parse(raw ?? {}) as z.infer<(typeof canvasToolInputSchemas)[K]>;
}

export const canvasSnapshotSchema = z.object({
  projectId: z.string().min(1).max(128),
  title: z.string().max(256),
});
export type CanvasPresenceSnapshot = z.infer<typeof canvasSnapshotSchema>;

export const canvasAgentTokenRequestSchema = z.object({
  conversationId: z.string().min(1).max(128),
  tabId: z.string().min(1).max(128),
  clientId: z.string().min(1).max(128),
}).strict();
export type CanvasAgentTokenRequest = z.infer<typeof canvasAgentTokenRequestSchema>;

export type CanvasNodeType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "group"
  | "html"
  | "markdown"
  | "panorama"
  | "sticky-note"
  | "svg"
  | "template";

export type CanvasNode = {
  id: string;
  type: CanvasNodeType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  groupId?: string;
  metadata: Record<string, unknown>;
};

export type CanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

export type CanvasProject = {
  id: string;
  title: string;
  updatedAt: number;
  viewport: { x: number; y: number; k: number };
  selectedIds: string[];
  nodes: CanvasNode[];
  connections: CanvasConnection[];
};

export type CanvasAsset = {
  id: string;
  kind: "text" | "image" | "video";
  title: string;
  content?: string;
  imageUrl?: string;
  source?: string;
  note?: string;
  createdAt: number;
};

export type CanvasPromptItem = {
  id: string;
  title: string;
  prompt: string;
  category: string;
  tags: string[];
};

export type GenerationRecord = {
  id: string;
  mode: "image" | "video" | "text" | "audio";
  prompt: string;
  model: string;
  status: "queued" | "running" | "succeeded" | "failed";
  outputUrl?: string;
  outputText?: string;
  error?: string;
  nodeId?: string;
  createdAt: number;
};

export type ModelChannelConfig = {
  name: string;
  baseUrl: string;
  imageModel: string;
  videoModel: string;
  textModel: string;
};

export const DEFAULT_PROMPTS: CanvasPromptItem[] = [
  {
    id: "p_editorial",
    title: "Editorial Product Hero",
    prompt: "Minimalist studio photography of a ceramic tea cup on warm limestone, soft directional morning sunlight, crisp shadows, 85mm lens",
    category: "Product",
    tags: ["studio", "minimal", "lighting"],
  },
  {
    id: "p_arch",
    title: "Architectural Axonometric",
    prompt: "Clean isometric architectural diagram of a sunlit courtyard pavilion with timber louvers and reflecting pool, warm paper texture",
    category: "Architecture",
    tags: ["isometric", "diagram", "pavilion"],
  },
  {
    id: "p_storyboard",
    title: "Kinetic Motion Frame",
    prompt: "Cinema wide-angle frame of a glass conservatory at dusk, soft rain on skylight, subtle volumetric light",
    category: "Video",
    tags: ["cinema", "dusk", "motion"],
  },
];

export function createStarterProject(): CanvasProject {
  return {
    id: "proj_starter",
    title: "Visual Exploration",
    updatedAt: Date.now(),
    viewport: { x: 48, y: 48, k: 1 },
    selectedIds: [],
    nodes: [
      {
        id: "n_brief",
        type: "text",
        title: "Creative Brief",
        x: 40,
        y: 40,
        width: 260,
        height: 150,
        metadata: {
          content: "Explore lighting, material contrast, and framing. Connect this brief to a generation node or ask the conversation Bot via Agent.",
        },
      },
      {
        id: "n_sticky",
        type: "sticky-note",
        title: "Sticky Note",
        x: 340,
        y: 36,
        width: 220,
        height: 140,
        metadata: {
          content: "Official node plugins (HTML, Markdown, Panorama, Sticky Note, SVG, Template) run offline.",
          color: "#fef3c7",
        },
      },
      {
        id: "n_svg",
        type: "svg",
        title: "SVG Wireframe",
        x: 340,
        y: 210,
        width: 240,
        height: 140,
        metadata: {
          content: "<svg viewBox=\"0 0 220 90\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"8\" y=\"8\" width=\"204\" height=\"74\" rx=\"12\" fill=\"rgba(37,99,235,0.1)\" stroke=\"#2563eb\" stroke-width=\"1.5\"/><circle cx=\"56\" cy=\"45\" r=\"18\" fill=\"rgba(37,99,235,0.22)\"/><rect x=\"88\" y=\"28\" width=\"104\" height=\"12\" rx=\"6\" fill=\"rgba(37,99,235,0.28)\"/><rect x=\"88\" y=\"48\" width=\"72\" height=\"10\" rx=\"5\" fill=\"rgba(100,116,139,0.35)\"/></svg>",
        },
      },
    ],
    connections: [
      { id: "conn_1", fromNodeId: "n_brief", toNodeId: "n_sticky" },
    ],
  };
}

export type CanvasAgentExecutionEnv = {
  getProject: () => CanvasProject;
  updateProject: (updater: (project: CanvasProject) => CanvasProject) => void;
  getChannel: () => ModelChannelConfig;
  getAssets: () => CanvasAsset[];
  addAsset: (asset: Omit<CanvasAsset, "id" | "createdAt">) => CanvasAsset;
  getPrompts: () => CanvasPromptItem[];
  getGenerations: () => GenerationRecord[];
  triggerGeneration: (nodeId: string, promptOverride?: string, mode?: "image" | "video" | "text" | "audio") => Promise<GenerationRecord>;
};

export async function executeCanvasAgentTool(
  name: string,
  input: Record<string, unknown>,
  env: CanvasAgentExecutionEnv,
): Promise<unknown> {
  const project = env.getProject();

  switch (name) {
    case "canvas_get_state": {
      const ids = Array.isArray(input.ids) ? new Set(input.ids.map(String)) : null;
      const types = Array.isArray(input.types) ? new Set(input.types.map(String)) : null;
      const selectedOnly = input.selectedOnly === true;
      const keyword = typeof input.keyword === "string" ? input.keyword.toLowerCase() : "";
      const selectedSet = new Set(project.selectedIds);
      const nodes = project.nodes
        .filter((n) => (!ids || ids.has(n.id))
          && (!types || types.has(n.type))
          && (!selectedOnly || selectedSet.has(n.id))
          && (!keyword || n.title.toLowerCase().includes(keyword) || String(n.metadata.content ?? "").toLowerCase().includes(keyword)))
        .slice(0, 200)
        .map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
          groupId: n.groupId,
          preview: typeof n.metadata.content === "string" ? n.metadata.content.slice(0, 120) : undefined,
          status: n.metadata.status,
        }));
      return {
        projectId: project.id,
        title: project.title,
        viewport: project.viewport,
        selectedIds: project.selectedIds,
        nodes,
        connections: input.includeConnections === false ? [] : project.connections,
      };
    }

    case "canvas_get_nodes": {
      const requested = Array.isArray(input.ids) ? input.ids.map(String) : [];
      const found = project.nodes.filter((n) => requested.includes(n.id));
      const foundIds = new Set(found.map((n) => n.id));
      return {
        projectId: project.id,
        nodes: found,
        missingIds: requested.filter((id) => !foundIds.has(id)),
      };
    }

    case "canvas_list_models": {
      const ch = env.getChannel();
      return {
        models: [
          { id: ch.imageModel || "gpt-image-1", capability: "image", channel: ch.name },
          { id: ch.videoModel || "sora-2", capability: "video", channel: ch.name },
          { id: ch.textModel || "gpt-4o-mini", capability: "text", channel: ch.name },
        ],
      };
    }

    case "canvas_apply_ops": {
      const ops = Array.isArray(input.ops) ? input.ops as Array<Record<string, unknown>> : [];
      const createdIds: string[] = [];
      const submittedNodeIds: string[] = [];
      const pendingGenerations: Array<{ nodeId: string; mode?: "image" | "video" | "text" | "audio"; prompt?: string }> = [];

      env.updateProject((curr) => {
        let nodes = [...curr.nodes];
        let connections = [...curr.connections];
        let viewport = { ...curr.viewport };
        let selectedIds = [...curr.selectedIds];

        for (const op of ops) {
          const type = String(op.type ?? "");
          if (type === "add_node") {
            const id = typeof op.id === "string" && op.id ? op.id : `node_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const pos = (op.position && typeof op.position === "object" ? op.position : {}) as { x?: number; y?: number };
            const node: CanvasNode = {
              id,
              type: (typeof op.nodeType === "string" ? op.nodeType : "text") as CanvasNodeType,
              title: typeof op.title === "string" ? op.title : "New Node",
              x: typeof op.x === "number" ? op.x : typeof pos.x === "number" ? pos.x : 80 + nodes.length * 40,
              y: typeof op.y === "number" ? op.y : typeof pos.y === "number" ? pos.y : 80 + nodes.length * 30,
              width: typeof op.width === "number" ? op.width : 260,
              height: typeof op.height === "number" ? op.height : 160,
              metadata: (op.metadata && typeof op.metadata === "object" ? op.metadata : {}) as Record<string, unknown>,
            };
            nodes.push(node);
            createdIds.push(id);
          } else if (type === "update_node" && typeof op.id === "string") {
            const patch = (op.patch && typeof op.patch === "object" ? op.patch : {}) as Record<string, unknown>;
            const pos = (patch.position && typeof patch.position === "object" ? patch.position : {}) as { x?: number; y?: number };
            nodes = nodes.map((n) => n.id !== op.id ? n : {
              ...n,
              title: typeof patch.title === "string" ? patch.title : n.title,
              x: typeof pos.x === "number" ? pos.x : n.x,
              y: typeof pos.y === "number" ? pos.y : n.y,
              width: typeof patch.width === "number" ? patch.width : n.width,
              height: typeof patch.height === "number" ? patch.height : n.height,
              metadata: {
                ...n.metadata,
                ...(patch.metadata && typeof patch.metadata === "object" ? patch.metadata as Record<string, unknown> : {}),
                ...(op.metadata && typeof op.metadata === "object" ? op.metadata as Record<string, unknown> : {}),
              },
            });
          } else if (type === "move_nodes" && Array.isArray(op.items)) {
            const byId = new Map<string, Record<string, unknown>>();
            for (const item of op.items as Array<Record<string, unknown>>) byId.set(String(item.id), item);
            nodes = nodes.map((n) => {
              const m = byId.get(n.id);
              if (!m) return n;
              return {
                ...n,
                x: typeof m.x === "number" ? m.x : n.x + (typeof m.dx === "number" ? m.dx : 0),
                y: typeof m.y === "number" ? m.y : n.y + (typeof m.dy === "number" ? m.dy : 0),
              };
            });
          } else if (type === "delete_node") {
            const removeIds = new Set<string>([
              ...(typeof op.id === "string" ? [op.id] : []),
              ...(Array.isArray(op.ids) ? op.ids.map(String) : []),
            ]);
            nodes = nodes.filter((n) => !removeIds.has(n.id));
            connections = connections.filter((c) => !removeIds.has(c.fromNodeId) && !removeIds.has(c.toNodeId));
          } else if (type === "connect_nodes" && typeof op.fromNodeId === "string" && typeof op.toNodeId === "string") {
            const id = typeof op.id === "string" ? op.id : `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            connections.push({ id, fromNodeId: op.fromNodeId, toNodeId: op.toNodeId });
          } else if (type === "delete_connections") {
            if (op.all === true) connections = [];
            else {
              const del = new Set<string>([...(typeof op.id === "string" ? [op.id] : []), ...(Array.isArray(op.ids) ? op.ids.map(String) : [])]);
              connections = connections.filter((c) => !del.has(c.id));
            }
          } else if (type === "group_nodes" && Array.isArray(op.ids)) {
            const gid = typeof op.id === "string" ? op.id : `grp_${Date.now()}`;
            const memberIds = new Set(op.ids.map(String));
            const members = nodes.filter((n) => memberIds.has(n.id));
            const minX = Math.min(...members.map((m) => m.x), 40) - 20;
            const minY = Math.min(...members.map((m) => m.y), 40) - 40;
            const maxX = Math.max(...members.map((m) => m.x + m.width), 300) + 20;
            const maxY = Math.max(...members.map((m) => m.y + m.height), 200) + 20;
            nodes.push({ id: gid, type: "group", title: typeof op.title === "string" ? op.title : "Group", x: minX, y: minY, width: maxX - minX, height: maxY - minY, metadata: { memberIds: [...memberIds] } });
            nodes = nodes.map((n) => memberIds.has(n.id) ? { ...n, groupId: gid } : n);
            createdIds.push(gid);
          } else if (type === "ungroup_nodes" && Array.isArray(op.ids)) {
            const gids = new Set(op.ids.map(String));
            nodes = nodes.filter((n) => !(n.type === "group" && gids.has(n.id))).map((n) => n.groupId && gids.has(n.groupId) ? { ...n, groupId: undefined } : n);
          } else if (type === "set_viewport" && op.viewport && typeof op.viewport === "object") {
            const v = op.viewport as { x: number; y: number; k: number };
            viewport = { x: v.x, y: v.y, k: Math.max(0.25, Math.min(2.5, v.k)) };
          } else if (type === "select_nodes" && Array.isArray(op.ids)) {
            selectedIds = op.ids.map(String);
          } else if (type === "run_generation" && typeof op.nodeId === "string") {
            pendingGenerations.push({
              nodeId: op.nodeId,
              mode: typeof op.mode === "string" ? op.mode as "image" | "video" | "text" | "audio" : undefined,
              prompt: typeof op.prompt === "string" ? op.prompt : undefined,
            });
            submittedNodeIds.push(op.nodeId);
          }
        }
        return { ...curr, updatedAt: Date.now(), nodes, connections, viewport, selectedIds };
      });

      for (const job of pendingGenerations) {
        void env.triggerGeneration(job.nodeId, job.prompt, job.mode).catch(() => undefined);
      }

      return { projectId: project.id, applied: true, createdIds, submittedNodeIds };
    }

    case "canvas_create_text_nodes": {
      const items = Array.isArray(input.items) ? input.items as Array<{ text: string; title?: string; x?: number; y?: number; width?: number; height?: number }> : [];
      const baseX = typeof input.x === "number" ? input.x : 80;
      const baseY = typeof input.y === "number" ? input.y : 80;
      const gap = typeof input.gap === "number" ? input.gap : 24;
      const dir = input.direction === "column" ? "column" : "row";
      const createdIds: string[] = [];
      env.updateProject((curr) => {
        const nextNodes = [...curr.nodes];
        items.forEach((item, idx) => {
          const id = `txt_${Date.now()}_${idx}`;
          createdIds.push(id);
          nextNodes.push({
            id,
            type: "text",
            title: item.title ?? `Note ${idx + 1}`,
            x: item.x ?? (dir === "row" ? baseX + idx * (260 + gap) : baseX),
            y: item.y ?? (dir === "column" ? baseY + idx * (160 + gap) : baseY),
            width: item.width ?? 260,
            height: item.height ?? 160,
            metadata: { content: item.text },
          });
        });
        return { ...curr, updatedAt: Date.now(), nodes: nextNodes };
      });
      return { projectId: project.id, createdIds };
    }

    case "canvas_create_generation_flow": {
      const prompt = String(input.prompt ?? "");
      const mode = (typeof input.mode === "string" ? input.mode : "image") as "image" | "video" | "text" | "audio";
      const nodeId = `gen_${Date.now()}`;
      env.updateProject((curr) => ({
        ...curr,
        updatedAt: Date.now(),
        nodes: [
          ...curr.nodes,
          {
            id: nodeId,
            type: mode === "video" ? "video" : mode === "text" ? "text" : "image",
            title: typeof input.title === "string" ? input.title : `${mode.toUpperCase()} Generation`,
            x: typeof input.x === "number" ? input.x : 120 + curr.nodes.length * 40,
            y: typeof input.y === "number" ? input.y : 120,
            width: 280,
            height: 240,
            metadata: { prompt, mode, model: input.model, status: input.autoRun ? "queued" : "idle" },
          },
        ],
        connections: [
          ...curr.connections,
          ...((Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds : []) as string[]).map((refId, i) => ({
            id: `conn_${Date.now()}_${i}`,
            fromNodeId: refId,
            toNodeId: nodeId,
          })),
        ],
      }));
      const submittedNodeIds: string[] = [];
      if (input.autoRun === true) {
        submittedNodeIds.push(nodeId);
        void env.triggerGeneration(nodeId, prompt, mode).catch(() => undefined);
      }
      return { projectId: project.id, createdNodeIds: [nodeId], submittedNodeIds };
    }

    case "canvas_insert_media": {
      const asset = typeof input.assetId === "string" ? env.getAssets().find((a) => a.id === input.assetId) : undefined;
      const nodeId = `media_${Date.now()}`;
      env.updateProject((curr) => ({
        ...curr,
        updatedAt: Date.now(),
        nodes: [
          ...curr.nodes,
          {
            id: nodeId,
            type: asset?.kind === "video" ? "video" : asset?.kind === "text" ? "text" : "image",
            title: typeof input.title === "string" ? input.title : asset?.title ?? "Inserted Media",
            x: typeof input.x === "number" ? input.x : 100 + curr.nodes.length * 36,
            y: typeof input.y === "number" ? input.y : 100,
            width: 260,
            height: 200,
            metadata: {
              assetId: asset?.id,
              storageKey: input.storageKey,
              imageUrl: asset?.imageUrl,
              content: asset?.content,
            },
          },
        ],
      }));
      return { projectId: project.id, nodeId };
    }

    case "canvas_list_references": {
      return { references: env.getAssets().filter((a) => a.kind === "image").slice(0, 50) };
    }

    case "canvas_view_image": {
      const node = typeof input.nodeId === "string" ? project.nodes.find((n) => n.id === input.nodeId) : undefined;
      return {
        nodeId: node?.id,
        storageKey: input.storageKey,
        imageUrl: node?.metadata.imageUrl,
      };
    }

    case "generation_get_status": {
      return { tasks: env.getGenerations().slice(0, typeof input.limit === "number" ? input.limit : 20) };
    }

    case "prompts_search": {
      const kw = typeof input.keyword === "string" ? input.keyword.toLowerCase() : "";
      const items = env.getPrompts().filter((p) => !kw || p.title.toLowerCase().includes(kw) || p.prompt.toLowerCase().includes(kw));
      return { items, total: items.length };
    }

    case "assets_list": {
      const items = env.getAssets().map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        ...(input.includeContent ? { content: a.content, imageUrl: a.imageUrl } : {}),
        createdAt: a.createdAt,
      }));
      return { items, total: items.length };
    }

    case "assets_add": {
      const created = env.addAsset({
        kind: input.kind === "image" ? "image" : "text",
        title: String(input.title ?? "Untitled Asset"),
        content: typeof input.content === "string" ? input.content : undefined,
        imageUrl: typeof input.imageUrl === "string" ? input.imageUrl : undefined,
        source: typeof input.source === "string" ? input.source : undefined,
        note: typeof input.note === "string" ? input.note : undefined,
      });
      return { asset: created };
    }

    default:
      throw new Error(`UNKNOWN_TOOL:${name}`);
  }
}

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PROMPTS,
  createStarterProject,
  executeCanvasAgentTool,
  type CanvasAsset,
  type CanvasNode,
  type CanvasNodeType,
  type CanvasProject,
  type CanvasPromptItem,
  type GenerationRecord,
  type ModelChannelConfig,
} from "./canvas-engine.js";
import { hostBridge, subscribeCanvasAgentEvents, type HostHelloInfo } from "./host-bridge.js";
import {
  BUNDLED_OFFICIAL_NODE_PLUGINS,
  NodePluginManager,
  type NodePluginsState,
  type OfficialNodePluginId,
} from "./node-plugins-state.js";

type ViewId = "home" | "canvas" | "create" | "prompts" | "assets" | "settings";

const DEFAULT_CHANNEL: ModelChannelConfig = {
  name: "Custom OpenAI-Compatible API",
  baseUrl: "",
  imageModel: "gpt-image-1",
  videoModel: "sora-2",
  textModel: "gpt-4o-mini",
};

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function InfiniteCanvasApp() {
  const [hello, setHello] = useState<HostHelloInfo>({
    pluginId: "tarobird.infinite-canvas",
    scopeId: "default",
    theme: "light",
    locale: "zh",
    grantedCapabilities: [],
  });
  const [view, setView] = useState<ViewId>("canvas");
  const [projects, setProjects] = useState<CanvasProject[]>(() => [createStarterProject()]);
  const [activeProjectId, setActiveProjectId] = useState<string>("proj_starter");
  const [assets, setAssets] = useState<CanvasAsset[]>([]);
  const [prompts, setPrompts] = useState<CanvasPromptItem[]>(DEFAULT_PROMPTS);
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [channel, setChannel] = useState<ModelChannelConfig>(DEFAULT_CHANNEL);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [hasSavedApiKey, setHasSavedApiKey] = useState(false);

  // Node plugins state (official bundled + default-off third-party)
  const [pluginMgr] = useState(() => new NodePluginManager());
  const [nodePlugins, setNodePlugins] = useState<NodePluginsState>(() => pluginMgr.getState());
  const [showThirdPartyWarning, setShowThirdPartyWarning] = useState(false);
  const [thirdPartyUrlInput, setThirdPartyUrlInput] = useState("");
  const [thirdPartyNameInput, setThirdPartyNameInput] = useState("");
  const [pendingThirdPartyConfirm, setPendingThirdPartyConfirm] = useState<{ name: string; url: string } | null>(null);

  // Agent panel & TaroBird Host Canvas Agent connection
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentConnected, setAgentConnected] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [agentLogs, setAgentLogs] = useState<string[]>([]);
  const [clientId] = useState(() => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : makeId("ic_client")));

  // Create Workbench state
  const [createMode, setCreateMode] = useState<"image" | "video">("image");
  const [createPrompt, setCreatePrompt] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [promptSearch, setPromptSearch] = useState("");

  const zh = hello.locale !== "en";
  const word = (zhText: string, enText: string) => (zh ? zhText : enText);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0]!,
    [projects, activeProjectId],
  );

  // Latest state refs for Canvas Agent tool callbacks
  const stateRef = useRef({ activeProject, channel, assets, prompts, generations });
  stateRef.current = { activeProject, channel, assets, prompts, generations };

  const persist = (key: string, value: unknown) => {
    void hostBridge.storageSet(key, JSON.stringify(value)).catch(() => undefined);
  };

  const updateActiveProject = (updater: (project: CanvasProject) => CanvasProject) => {
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === activeProject.id ? updater(p) : p));
      persist("ic:projects:v1", next);
      return next;
    });
  };

  const runGeneration = async (nodeId: string, promptOverride?: string, mode: "image" | "video" | "text" | "audio" = "image"): Promise<GenerationRecord> => {
    const ch = stateRef.current.channel;
    const node = stateRef.current.activeProject.nodes.find((n) => n.id === nodeId);
    const prompt = promptOverride ?? String(node?.metadata.prompt ?? node?.metadata.content ?? createPrompt ?? "").trim();
    const record: GenerationRecord = {
      id: makeId("gen"),
      mode,
      prompt,
      model: mode === "video" ? ch.videoModel : ch.imageModel,
      status: "running",
      nodeId,
      createdAt: Date.now(),
    };
    setGenerations((prev) => {
      const next = [record, ...prev];
      persist("ic:generations:v1", next);
      return next;
    });

    try {
      const key = await hostBridge.credentialsGet("channel:default:apiKey");
      if (!ch.baseUrl || !key) {
        throw new Error(word("请先在「设置 → 模型渠道」配置 Base URL 和 API Key。", "Configure Base URL and API Key in Settings → Model Channels first."));
      }
      const cleanBase = ch.baseUrl.replace(/\/+$/, "");
      const endpoint = mode === "video" ? `${cleanBase}/v1/videos/generations` : `${cleanBase}/v1/images/generations`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: record.model, prompt, n: 1, size: "1024x1024" }),
      });
      if (!res.ok) throw new Error(`API HTTP ${res.status}`);
      const json = await res.json() as { data?: Array<{ url?: string; b64_json?: string }> };
      const first = json.data?.[0];
      const outputUrl = first?.url ?? (first?.b64_json ? `data:image/png;base64,${first.b64_json}` : "");
      if (!outputUrl) throw new Error("Empty model response");

      const done: GenerationRecord = { ...record, status: "succeeded", outputUrl };
      setGenerations((prev) => {
        const next = prev.map((g) => (g.id === record.id ? done : g));
        persist("ic:generations:v1", next);
        return next;
      });
      updateActiveProject((proj) => ({
        ...proj,
        nodes: proj.nodes.map((n) => n.id === nodeId ? { ...n, metadata: { ...n.metadata, status: "succeeded", imageUrl: outputUrl } } : n),
      }));
      return done;
    } catch (err) {
      const failed: GenerationRecord = {
        ...record,
        status: "failed",
        error: err instanceof Error ? err.message : "generation_failed",
      };
      setGenerations((prev) => {
        const next = prev.map((g) => (g.id === record.id ? failed : g));
        persist("ic:generations:v1", next);
        return next;
      });
      updateActiveProject((proj) => ({
        ...proj,
        nodes: proj.nodes.map((n) => n.id === nodeId ? { ...n, metadata: { ...n.metadata, status: "failed", error: failed.error } } : n),
      }));
      return failed;
    }
  };

  // Boot: handshake with TaroBird Host, load scoped storage + isolated API key, and connect Canvas Agent
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const info = await hostBridge.hello();
        if (!alive) return;
        setHello(info);
        document.body.dataset.theme = info.theme;

        const [rawProj, rawAssets, rawPrompts, rawChannel, rawPlugins, savedKey] = await Promise.all([
          hostBridge.storageGet("ic:projects:v1"),
          hostBridge.storageGet("ic:assets:v1"),
          hostBridge.storageGet("ic:prompts:v1"),
          hostBridge.storageGet("ic:channel:v1"),
          hostBridge.storageGet("ic:node-plugins:v1"),
          hostBridge.credentialsGet("channel:default:apiKey").catch(() => null),
        ]);
        if (!alive) return;
        if (rawProj) {
          const parsed = JSON.parse(rawProj) as CanvasProject[];
          if (Array.isArray(parsed) && parsed.length) {
            setProjects(parsed);
            setActiveProjectId(parsed[0]!.id);
          }
        }
        if (rawAssets) setAssets(JSON.parse(rawAssets) as CanvasAsset[]);
        if (rawPrompts) setPrompts(JSON.parse(rawPrompts) as CanvasPromptItem[]);
        if (rawChannel) setChannel({ ...DEFAULT_CHANNEL, ...(JSON.parse(rawChannel) as Partial<ModelChannelConfig>) });
        if (rawPlugins) {
          const parsedPlugins = JSON.parse(rawPlugins) as Partial<NodePluginsState>;
          const hydrated = new NodePluginManager({ ...parsedPlugins, scopeId: info.scopeId ?? "default" });
          Object.assign(pluginMgr, hydrated);
          setNodePlugins(hydrated.getState());
        }
        setHasSavedApiKey(Boolean(savedKey));

        if (info.grantedCapabilities.includes("canvas.agent")) {
          const conn = await hostBridge.agentConnect(clientId).catch(() => null);
          if (alive && conn?.connected) {
            setAgentConnected(true);
            setAgentLogs((prev) => [`Connected to TaroBird Host Canvas Agent (v${conn.protocolVersion})`, ...prev.slice(0, 19)]);
          }
        }
      } catch {
        // Ignore boot failure in preview
      }
    })();
    return () => { alive = false; };
  }, []);

  // Push active canvas presence to TaroBird Host Canvas Agent
  useEffect(() => {
    if (!agentConnected) return;
    void hostBridge.agentState(clientId, { projectId: activeProject.id, title: activeProject.title }).catch(() => undefined);
  }, [agentConnected, clientId, activeProject.id, activeProject.title]);

  // Handle incoming Canvas Agent tool calls from TaroBird Host
  useEffect(() => {
    return subscribeCanvasAgentEvents((ev) => {
      if (ev.type === "canvas.agent.hello") {
        setAgentConnected(true);
        setAgentError("");
      } else if (ev.type === "canvas.agent.closed") {
        setAgentConnected(false);
      } else if (ev.type === "canvas.agent.tool_call") {
        setAgentLogs((prev) => [`Bot tool: ${ev.name}`, ...prev.slice(0, 19)]);
        void executeCanvasAgentTool(ev.name, ev.input ?? {}, {
          getProject: () => stateRef.current.activeProject,
          updateProject: updateActiveProject,
          getChannel: () => stateRef.current.channel,
          getAssets: () => stateRef.current.assets,
          addAsset: (assetInput) => {
            const created: CanvasAsset = { ...assetInput, id: makeId("asset"), createdAt: Date.now() };
            setAssets((prev) => {
              const next = [created, ...prev];
              persist("ic:assets:v1", next);
              return next;
            });
            return created;
          },
          getPrompts: () => stateRef.current.prompts,
          getGenerations: () => stateRef.current.generations,
          triggerGeneration: runGeneration,
        })
          .then((result) => hostBridge.agentResult(clientId, ev.requestId, { result }))
          .catch((err) => hostBridge.agentResult(clientId, ev.requestId, {
            error: { code: "CANVAS_TOOL_FAILED", message: err instanceof Error ? err.message : "Tool failed" },
          }));
      }
    });
  }, [clientId]);

  const addNode = (type: CanvasNodeType, title?: string, content?: string) => {
    const id = makeId("node");
    const bundled = BUNDLED_OFFICIAL_NODE_PLUGINS.find((p) => p.id === type);
    const node: CanvasNode = {
      id,
      type,
      title: title ?? (bundled ? (zh ? bundled.nameZh : bundled.name) : type.toUpperCase()),
      x: 90 + (activeProject.nodes.length % 5) * 44,
      y: 90 + (activeProject.nodes.length % 4) * 38,
      width: type === "image" ? 260 : 240,
      height: type === "image" ? 220 : 155,
      metadata: { content: content ?? bundled?.defaultContent ?? "" },
    };
    updateActiveProject((p) => ({ ...p, updatedAt: Date.now(), nodes: [...p.nodes, node], selectedIds: [id] }));
  };

  const handleExportWorkspace = async () => {
    const all = await hostBridge.storageList().catch(() => ({}));
    const payload = {
      app: "infinite-canvas",
      upstream: "basketikun/infinite-canvas@4c67f1e",
      scopeId: hello.scopeId ?? "default",
      exportedAt: new Date().toISOString(),
      data: all,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `infinite-canvas-backup-${activeProject.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportWorkspace = async (file: File) => {
    const text = await file.text();
    const parsed = JSON.parse(text) as { data?: Record<string, string> };
    if (!parsed.data || typeof parsed.data !== "object") return;
    for (const [k, v] of Object.entries(parsed.data)) {
      if (typeof v === "string" && k.startsWith("ic:")) {
        await hostBridge.storageSet(k, v);
      }
    }
    if (parsed.data["ic:projects:v1"]) {
      const list = JSON.parse(parsed.data["ic:projects:v1"]) as CanvasProject[];
      if (Array.isArray(list) && list.length) { setProjects(list); setActiveProjectId(list[0]!.id); }
    }
    if (parsed.data["ic:assets:v1"]) setAssets(JSON.parse(parsed.data["ic:assets:v1"]) as CanvasAsset[]);
    setStatusMsg(word("已导入画布备份数据。", "Workspace backup imported."));
  };

  const saveNodePluginsState = (next: NodePluginsState) => {
    setNodePlugins(next);
    persist("ic:node-plugins:v1", next);
  };

  const saveApiKey = async () => {
    const trimmed = apiKeyDraft.trim();
    if (!trimmed) return;
    await hostBridge.credentialsSet("channel:default:apiKey", trimmed);
    setApiKeyDraft("");
    setHasSavedApiKey(true);
    setStatusMsg(word("API Key 已保存到本机隔离凭据存储（不会同步到 Hub 或写入 localStorage）。", "API Key saved to local isolated credential vault (never synced or placed in localStorage)."));
  };

  const renderNodeBody = (node: CanvasNode) => {
    const content = String(node.metadata.content ?? "");
    if (node.type === "svg") {
      return (
        <div className="ic-node-body">
          <div style={{ padding: 6, borderRadius: 6, background: "var(--ic-bg)", textAlign: "center" }} dangerouslySetInnerHTML={{ __html: content.replace(/<script[\s\S]*?<\/script>/gi, "") }} />
        </div>
      );
    }
    if (node.type === "html") {
      return (
        <div className="ic-node-body">
          <iframe title={node.title} sandbox="" srcDoc={content} style={{ width: "100%", height: "100%", border: "1px solid var(--ic-border)", borderRadius: 6, background: "#fff" }} />
        </div>
      );
    }
    if (node.type === "panorama") {
      return (
        <div className="ic-node-body">
          <div style={{ flex: 1, borderRadius: 8, background: "radial-gradient(circle at 35% 35%, #3b82f6 0%, #1e3a8a 60%, #0f172a 100%)", color: "#fff", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 600 }}>
            360° Panorama · {node.title}
          </div>
        </div>
      );
    }
    if (node.type === "image") {
      const imageUrl = typeof node.metadata.imageUrl === "string" ? node.metadata.imageUrl : "";
      const promptVal = String(node.metadata.prompt ?? "");
      return (
        <div className="ic-node-body">
          {imageUrl ? <img className="ic-node-img" src={imageUrl} alt={node.title} /> : <div style={{ padding: 14, textAlign: "center", borderRadius: 7, background: "var(--ic-surface-2)", color: "var(--ic-muted)" }}>{word("等待生成或插入图片", "Ready to generate image")}</div>}
          <input
            aria-label={word("生图提示词", "Image prompt")}
            placeholder={word("输入提示词…", "Prompt…")}
            value={promptVal}
            onChange={(e) => updateActiveProject((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === node.id ? { ...n, metadata: { ...n.metadata, prompt: e.target.value } } : n) }))}
          />
          <button type="button" className="ic-btn is-primary" onClick={() => void runGeneration(node.id, promptVal, "image")}>
            {word("生成图片", "Generate")}
          </button>
        </div>
      );
    }
    return (
      <div className="ic-node-body" style={node.type === "sticky-note" ? { background: "rgba(254, 243, 199, 0.45)" } : undefined}>
        <textarea
          aria-label={node.title}
          value={content}
          onChange={(e) => {
            const val = e.target.value;
            updateActiveProject((p) => ({ ...p, nodes: p.nodes.map((n) => n.id === node.id ? { ...n, metadata: { ...n.metadata, content: val } } : n) }));
          }}
        />
      </div>
    );
  };

  return (
    <div className="ic-shell">
      <aside className="ic-sidebar">
        <div className="ic-brand">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="9" cy="10" r="2.5" fill="currentColor" />
            <path d="M12.5 16L16.5 10.5L19 16H12.5Z" fill="currentColor" />
          </svg>
          <div className="ic-brand-meta">
            <div className="ic-brand-title">{word("无限画布", "Infinite Canvas")}</div>
            <div className="ic-brand-credit">by basketikun · MIT</div>
          </div>
        </div>

        <nav className="ic-nav" aria-label={word("无限画布导航", "Infinite Canvas navigation")}>
          {([
            ["home", word("概览", "Home")],
            ["canvas", word("画布", "Canvas")],
            ["create", word("生图 / 视频台", "Create")],
            ["prompts", word("提示词库", "Prompts")],
            ["assets", word("素材库", "Assets")],
            ["settings", word("设置", "Settings")],
          ] as Array<[ViewId, string]>).map(([id, label]) => (
            <button key={id} type="button" className={view === id ? "is-active" : undefined} onClick={() => setView(id)}>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="ic-sidebar-foot">
          <div>{word("原作者：basketikun", "Author: basketikun")}</div>
          <div>MIT · <code>4c67f1e</code></div>
          <a href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noreferrer">GitHub ↗</a>
        </div>
      </aside>

      <main className="ic-main">
        <header className="ic-topbar">
          <div className="ic-topbar-group">
            <strong>{view === "canvas" ? activeProject.title : word("Infinite Canvas 工作台", "Infinite Canvas Workbench")}</strong>
            <span className="ic-pill">{word("离线官方插件已内置", "Official plugins bundled")}</span>
          </div>
          <div className="ic-topbar-group">
            {view === "canvas" && (
              <>
                <button type="button" className="ic-btn" onClick={() => updateActiveProject((p) => ({ ...p, viewport: { ...p.viewport, k: Math.max(0.4, +(p.viewport.k - 0.15).toFixed(2)) } }))}>-</button>
                <span style={{ fontSize: 12, minWidth: 42, textAlign: "center" }}>{Math.round(activeProject.viewport.k * 100)}%</span>
                <button type="button" className="ic-btn" onClick={() => updateActiveProject((p) => ({ ...p, viewport: { ...p.viewport, k: Math.min(2, +(p.viewport.k + 0.15).toFixed(2)) } }))}>+</button>
                <button type="button" className="ic-btn" onClick={() => updateActiveProject((p) => ({ ...p, viewport: { x: 48, y: 48, k: 1 } }))}>{word("重置", "Reset")}</button>
              </>
            )}
            <button
              type="button"
              className={`ic-btn${agentOpen ? " is-primary" : ""}`}
              data-ic-agent-toggle
              onClick={() => setAgentOpen((v) => !v)}
            >
              <span>Agent</span>
              <span className={`ic-pill${agentConnected ? " is-online" : ""}`}>{agentConnected ? word("已连接", "Live") : word("未连接", "Off")}</span>
            </button>
          </div>
        </header>

        {statusMsg && (
          <div role="status" style={{ padding: "7px 14px", background: "var(--ic-accent-soft)", fontSize: 12.5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{statusMsg}</span>
            <button type="button" className="ic-btn" onClick={() => setStatusMsg("")}>{word("关闭", "Dismiss")}</button>
          </div>
        )}

        {view === "canvas" && (
          <div className="ic-canvas-wrap">
            <div
              className="ic-viewport"
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                const startX = e.clientX, startY = e.clientY;
                const orig = activeProject.viewport;
                const onMove = (ev: PointerEvent) => {
                  updateActiveProject((p) => ({ ...p, viewport: { ...p.viewport, x: orig.x + (ev.clientX - startX), y: orig.y + (ev.clientY - startY) } }));
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
            >
              <div
                className="ic-stage"
                style={{ transform: `translate(${activeProject.viewport.x}px, ${activeProject.viewport.y}px) scale(${activeProject.viewport.k})` }}
              >
                <svg className="ic-edges" viewBox="-4000 -4000 8000 8000">
                  {activeProject.connections.map((conn) => {
                    const from = activeProject.nodes.find((n) => n.id === conn.fromNodeId);
                    const to = activeProject.nodes.find((n) => n.id === conn.toNodeId);
                    if (!from || !to) return null;
                    const x1 = from.x + from.width;
                    const y1 = from.y + from.height / 2;
                    const x2 = to.x;
                    const y2 = to.y + to.height / 2;
                    return (
                      <path
                        key={conn.id}
                        d={`M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke="var(--ic-accent)"
                        strokeOpacity="0.55"
                        strokeWidth="2"
                      />
                    );
                  })}
                </svg>

                {activeProject.nodes.map((node) => (
                  <div
                    key={node.id}
                    className={`ic-node${node.type === "group" ? " is-group" : ""}${activeProject.selectedIds.includes(node.id) ? " is-selected" : ""}`}
                    style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest("textarea,input,button")) return;
                      e.stopPropagation();
                      const startX = e.clientX, startY = e.clientY, origX = node.x, origY = node.y;
                      const zoom = activeProject.viewport.k;
                      updateActiveProject((p) => ({ ...p, selectedIds: [node.id] }));
                      const onMove = (ev: PointerEvent) => {
                        updateActiveProject((p) => ({
                          ...p,
                          nodes: p.nodes.map((n) => n.id === node.id ? { ...n, x: origX + (ev.clientX - startX) / zoom, y: origY + (ev.clientY - startY) / zoom } : n),
                        }));
                      };
                      const onUp = () => {
                        window.removeEventListener("pointermove", onMove);
                        window.removeEventListener("pointerup", onUp);
                      };
                      window.addEventListener("pointermove", onMove);
                      window.addEventListener("pointerup", onUp);
                    }}
                  >
                    <div className="ic-node-head">
                      <span>{node.title}</span>
                      <span className="ic-node-type">{node.type}</span>
                    </div>
                    {renderNodeBody(node)}
                  </div>
                ))}
              </div>

              <div className="ic-floating-bar">
                <button type="button" className="ic-btn" onClick={() => addNode("text", word("文本节点", "Text"))}>{word("+ 文本", "+ Text")}</button>
                <button type="button" className="ic-btn" onClick={() => addNode("image", word("生图节点", "Image"))}>{word("+ 生图", "+ Image")}</button>
                {BUNDLED_OFFICIAL_NODE_PLUGINS.filter((p) => nodePlugins.officialEnabled.includes(p.id)).map((p) => (
                  <button key={p.id} type="button" className="ic-btn" onClick={() => addNode(p.id as CanvasNodeType)}>
                    + {zh ? p.nameZh : p.name}
                  </button>
                ))}
              </div>

              <div className="ic-minimap" aria-hidden="true">
                {activeProject.nodes.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      position: "absolute",
                      left: Math.max(4, Math.min(120, n.x / 10)),
                      top: Math.max(4, Math.min(72, n.y / 10)),
                      width: Math.max(10, n.width / 12),
                      height: Math.max(8, n.height / 12),
                      borderRadius: 2,
                      background: "var(--ic-accent)",
                      opacity: 0.45,
                    }}
                  />
                ))}
              </div>
            </div>

            {agentOpen && (
              <aside className="ic-agent-panel" aria-label="Canvas Agent">
                <div className="ic-agent-head">
                  <span>{word("对话 Bot · Canvas Agent", "Conversation Bot · Canvas Agent")}</span>
                  <button
                    type="button"
                    className="ic-btn"
                    onClick={() => {
                      if (agentConnected) {
                        void hostBridge.agentDisconnect(clientId).then(() => setAgentConnected(false));
                      } else {
                        void hostBridge.agentConnect(clientId)
                          .then((res) => { setAgentConnected(res.connected); setAgentError(""); })
                          .catch((err) => setAgentError(err instanceof Error ? err.message : "connect_failed"));
                      }
                    }}
                  >
                    {agentConnected ? word("断开", "Disconnect") : word("连接", "Connect")}
                  </button>
                </div>
                <div className="ic-agent-body">
                  <div className="ic-card">
                    <strong>{agentConnected ? word("TaroBird Host MCP 已就绪", "TaroBird Host MCP Ready") : word("未连接", "Disconnected")}</strong>
                    <p>{word("通过当前会话的短期隔离令牌连接 TaroBird Host，仅当前对话的 Bot 可读写此画布。", "Connected via a short-lived tab-scoped token on TaroBird Host. Only Bots in this conversation can read/write this canvas.")}</p>
                    {agentError && <p style={{ color: "var(--ic-danger)" }}>{agentError}</p>}
                  </div>
                  <div>
                    <strong>{word("最近工具调用", "Recent Tool Calls")}</strong>
                    {agentLogs.length ? (
                      <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
                        {agentLogs.map((log, i) => <li key={i}>{log}</li>)}
                      </ul>
                    ) : <p className="ic-brand-credit">{word("在对话中让 Bot 操作画布或生图后，调用会显示在这里。", "Ask your Bot to read/edit this canvas; tool calls appear here.")}</p>}
                  </div>
                </div>
              </aside>
            )}
          </div>
        )}

        {view === "home" && (
          <div className="ic-page">
            <div className="ic-card">
              <h3>{word("无限画布 (Infinite Canvas)", "Infinite Canvas")}</h3>
              <p>{word("原作者：basketikun（MIT 开源协议，commit 4c67f1e）。作为 TaroBird 按需安装的独立沙箱工作台扩展运行。", "Original author: basketikun (MIT License, commit 4c67f1e). Running inside TaroBird's isolated on-demand sandbox.")}</p>
              <div className="ic-topbar-group">
                <button type="button" className="ic-btn is-primary" onClick={() => setView("canvas")}>{word("打开当前画布", "Open Canvas")}</button>
                <button type="button" className="ic-btn" onClick={() => setView("create")}>{word("前往生图 / 视频台", "Open Create Workbench")}</button>
              </div>
            </div>
            <div className="ic-grid">
              {projects.map((proj) => (
                <div key={proj.id} className="ic-card">
                  <h4>{proj.title}</h4>
                  <p>{word("{0} 个节点 · {1} 条连线", "{0} nodes · {1} edges").replace("{0}", String(proj.nodes.length)).replace("{1}", String(proj.connections.length))}</p>
                  <button type="button" className="ic-btn" onClick={() => { setActiveProjectId(proj.id); setView("canvas"); }}>{word("进入画布", "Open")}</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "create" && (
          <div className="ic-page">
            <div className="ic-card">
              <div className="ic-topbar-group" style={{ justifyContent: "space-between" }}>
                <h3>{word("AI 创作台（图片 / 视频）", "AI Generation Workbench (Image / Video)")}</h3>
                <div className="ic-topbar-group">
                  <button type="button" className={`ic-btn${createMode === "image" ? " is-primary" : ""}`} onClick={() => setCreateMode("image")}>{word("图片", "Image")}</button>
                  <button type="button" className={`ic-btn${createMode === "video" ? " is-primary" : ""}`} onClick={() => setCreateMode("video")}>{word("视频", "Video")}</button>
                </div>
              </div>
              <div className="ic-form-row">
                <label>{word("提示词", "Prompt")}</label>
                <textarea rows={3} value={createPrompt} onChange={(e) => setCreatePrompt(e.target.value)} placeholder={word("描述你想生成的画面…", "Describe the image or video to generate…")} />
              </div>
              <div className="ic-topbar-group">
                <button
                  type="button"
                  className="ic-btn is-primary"
                  disabled={createBusy || !createPrompt.trim()}
                  onClick={() => {
                    setCreateBusy(true);
                    const newNodeId = makeId("gen");
                    addNode(createMode === "video" ? "video" : "image", createPrompt.slice(0, 24), createPrompt);
                    void runGeneration(newNodeId, createPrompt, createMode).finally(() => setCreateBusy(false));
                  }}
                >
                  {createBusy ? word("生成中…", "Generating…") : word("立即生成并添加到画布", "Generate & Add to Canvas")}
                </button>
              </div>
            </div>
            <div className="ic-grid">
              {generations.map((g) => (
                <div key={g.id} className="ic-card">
                  <strong>{g.mode.toUpperCase()} · {g.status}</strong>
                  <p>{g.prompt}</p>
                  {g.outputUrl && <img className="ic-node-img" src={g.outputUrl} alt={g.prompt} />}
                  {g.error && <p style={{ color: "var(--ic-danger)" }}>{g.error}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "prompts" && (
          <div className="ic-page">
            <div className="ic-form-row">
              <input placeholder={word("搜索提示词…", "Search prompts…")} value={promptSearch} onChange={(e) => setPromptSearch(e.target.value)} />
            </div>
            <div className="ic-grid">
              {prompts.filter((p) => !promptSearch || p.title.toLowerCase().includes(promptSearch.toLowerCase()) || p.prompt.toLowerCase().includes(promptSearch.toLowerCase())).map((p) => (
                <div key={p.id} className="ic-card">
                  <h4>{p.title}</h4>
                  <p>{p.prompt}</p>
                  <div className="ic-topbar-group">
                    <button type="button" className="ic-btn" onClick={() => { setCreatePrompt(p.prompt); setView("create"); }}>{word("用于创作", "Use in Create")}</button>
                    <button type="button" className="ic-btn" onClick={() => { addNode("text", p.title, p.prompt); setView("canvas"); }}>{word("放入画布", "Add to Canvas")}</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "assets" && (
          <div className="ic-page">
            <div className="ic-topbar-group">
              <button
                type="button"
                className="ic-btn is-primary"
                onClick={() => {
                  const created: CanvasAsset = { id: makeId("asset"), kind: "text", title: word("新文本素材", "New Text Asset"), content: word("示例参考文本", "Sample reference text"), createdAt: Date.now() };
                  setAssets((prev) => { const next = [created, ...prev]; persist("ic:assets:v1", next); return next; });
                }}
              >
                {word("+ 新建文本素材", "+ Add Text Asset")}
              </button>
            </div>
            <div className="ic-grid">
              {assets.length ? assets.map((a) => (
                <div key={a.id} className="ic-card">
                  <h4>{a.title}</h4>
                  <p>{a.content ?? a.note ?? a.kind}</p>
                  {a.imageUrl && <img className="ic-node-img" src={a.imageUrl} alt={a.title} />}
                  <button type="button" className="ic-btn" onClick={() => { addNode(a.kind === "image" ? "image" : "text", a.title, a.content ?? ""); setView("canvas"); }}>{word("插入画布", "Insert to Canvas")}</button>
                </div>
              )) : <p>{word("暂无素材。", "No assets saved yet.")}</p>}
            </div>
          </div>
        )}

        {view === "settings" && (
          <div className="ic-page">
            <section className="ic-card">
              <h3>{word("模型渠道（自配 OpenAI 兼容接口）", "Model Channel (User-Configured OpenAI-Compatible API)")}</h3>
              <p>{word("不预置任何非官方中转渠道。API Key 仅保存在本机隔离凭据存储，绝不写入 localStorage、日志、Hub 或同步到其他设备。", "No unofficial channels preset. Your API Key stays strictly in local isolated credential storage — never in localStorage, logs, Hub, or other devices.")}</p>
              <div className="ic-form-row">
                <label>Base URL</label>
                <input placeholder="https://api.openai.com" value={channel.baseUrl} onChange={(e) => { const next = { ...channel, baseUrl: e.target.value }; setChannel(next); persist("ic:channel:v1", next); }} />
              </div>
              <div className="ic-form-row">
                <label>API Key {hasSavedApiKey ? `(${word("已保存", "Saved")})` : ""}</label>
                <div className="ic-topbar-group">
                  <input type="password" style={{ flex: 1 }} placeholder={hasSavedApiKey ? "••••••••••••" : "sk-..."} value={apiKeyDraft} onChange={(e) => setApiKeyDraft(e.target.value)} />
                  <button type="button" className="ic-btn is-primary" onClick={() => void saveApiKey()}>{word("保存 Key", "Save Key")}</button>
                  {hasSavedApiKey && (
                    <button type="button" className="ic-btn is-danger" onClick={() => void hostBridge.credentialsRemove("channel:default:apiKey").then(() => setHasSavedApiKey(false))}>{word("清除", "Clear")}</button>
                  )}
                </div>
              </div>
              <div className="ic-grid">
                <div className="ic-form-row">
                  <label>{word("生图模型", "Image Model")}</label>
                  <input value={channel.imageModel} onChange={(e) => { const next = { ...channel, imageModel: e.target.value }; setChannel(next); persist("ic:channel:v1", next); }} />
                </div>
                <div className="ic-form-row">
                  <label>{word("视频模型", "Video Model")}</label>
                  <input value={channel.videoModel} onChange={(e) => { const next = { ...channel, videoModel: e.target.value }; setChannel(next); persist("ic:channel:v1", next); }} />
                </div>
              </div>
            </section>

            <section className="ic-card">
              <div className="ic-topbar-group" style={{ justifyContent: "space-between" }}>
                <div>
                  <h3>{word("画布节点插件", "Canvas Node Plugins")}</h3>
                  <p>{word("官方插件已随扩展打包内置，离线可用；第三方插件默认关闭。", "Official node plugins are bundled offline; third-party plugins are off by default.")}</p>
                </div>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    data-third-party-node-switch
                    checked={nodePlugins.allowThirdParty}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setShowThirdPartyWarning(true);
                      } else {
                        saveNodePluginsState(pluginMgr.disableThirdParty());
                      }
                    }}
                  />
                  <span>{word("允许安装第三方插件", "Allow installing third-party plugins")}</span>
                </label>
              </div>

              {showThirdPartyWarning && !nodePlugins.allowThirdParty && (
                <div className="ic-warning-box" role="alert">
                  <strong>{word("安全警告：启用第三方节点插件", "Security Warning: Enable Third-Party Node Plugins")}</strong>
                  <p>{word("第三方节点插件代码会直接运行在画布页面内，可以读取画布内容与你在画布中配置的 API Key，并可访问外部网络。请只安装来自完全信任来源的插件。", "Third-party plugin code runs directly in the canvas page, can read canvas content and the API Key configured in the canvas, and can access the network. Only install from sources you trust.")}</p>
                  <div className="ic-topbar-group" style={{ justifyContent: "flex-end" }}>
                    <button type="button" className="ic-btn" onClick={() => setShowThirdPartyWarning(false)}>{word("保持关闭", "Keep Off")}</button>
                    <button
                      type="button"
                      className="ic-btn is-primary"
                      data-confirm-third-party-warning
                      onClick={() => {
                        saveNodePluginsState(pluginMgr.enableThirdParty(true));
                        setShowThirdPartyWarning(false);
                      }}
                    >
                      {word("已知晓风险，确认开启", "I Understand, Enable")}
                    </button>
                  </div>
                </div>
              )}

              <div className="ic-grid">
                {BUNDLED_OFFICIAL_NODE_PLUGINS.map((p) => {
                  const enabled = nodePlugins.officialEnabled.includes(p.id as OfficialNodePluginId);
                  return (
                    <div key={p.id} className="ic-card">
                      <div className="ic-topbar-group" style={{ justifyContent: "space-between" }}>
                        <strong>{zh ? p.nameZh : p.name}</strong>
                        <span className="ic-pill">{word("官方内置", "Bundled")}</span>
                      </div>
                      <p>{zh ? p.descriptionZh : p.description}</p>
                      <button type="button" className="ic-btn" onClick={() => saveNodePluginsState(pluginMgr.toggleOfficial(p.id, !enabled))}>
                        {enabled ? word("已启用", "Enabled") : word("已停用", "Disabled")}
                      </button>
                    </div>
                  );
                })}
              </div>

              {nodePlugins.allowThirdParty && (
                <div className="ic-card" style={{ background: "var(--ic-surface-2)" }}>
                  <h4>{word("安装第三方节点插件（HTTPS JS URL）", "Install Third-Party Node Plugin (HTTPS JS URL)")}</h4>
                  <div className="ic-topbar-group">
                    <input style={{ flex: 1 }} placeholder={word("插件名称", "Plugin name")} value={thirdPartyNameInput} onChange={(e) => setThirdPartyNameInput(e.target.value)} />
                    <input style={{ flex: 2 }} placeholder="https://example.com/node-plugin.js" value={thirdPartyUrlInput} onChange={(e) => setThirdPartyUrlInput(e.target.value)} />
                    <button
                      type="button"
                      className="ic-btn is-primary"
                      disabled={!thirdPartyUrlInput.trim()}
                      onClick={() => setPendingThirdPartyConfirm({ name: thirdPartyNameInput.trim() || "Third-Party Plugin", url: thirdPartyUrlInput.trim() })}
                    >
                      {word("安装", "Install")}
                    </button>
                  </div>
                </div>
              )}

              {nodePlugins.thirdParty.length > 0 && (
                <div className="ic-grid">
                  {nodePlugins.thirdParty.map((tp) => (
                    <div key={tp.id} className="ic-card">
                      <div className="ic-topbar-group" style={{ justifyContent: "space-between" }}>
                        <strong>{tp.name}</strong>
                        <span className="ic-pill is-third">{word("第三方", "Third-party")}</span>
                      </div>
                      <p style={{ wordBreak: "break-all" }}>{tp.url}</p>
                      <div className="ic-topbar-group">
                        <button type="button" className="ic-btn" disabled={!nodePlugins.allowThirdParty} onClick={() => saveNodePluginsState(pluginMgr.toggleThirdParty(tp.id, !tp.enabled))}>
                          {tp.enabled ? word("停用", "Disable") : word("已停用", "Disabled")}
                        </button>
                        <button type="button" className="ic-btn is-danger" onClick={() => saveNodePluginsState(pluginMgr.removeThirdParty(tp.id))}>
                          {word("删除", "Delete")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="ic-card">
              <h3>{word("作用域存储与备份", "Scoped Storage & Backup")}</h3>
              <p>{word("按「设备 + 主机身份 + 用户」隔离存储：", "Scoped by device + Host identity + user:")} <code>{hello.scopeId ?? "default"}</code></p>
              <div className="ic-topbar-group">
                <button type="button" className="ic-btn" onClick={() => void handleExportWorkspace()}>{word("导出画布备份", "Export Workspace")}</button>
                <label className="ic-btn" style={{ cursor: "pointer" }}>
                  {word("导入画布备份", "Import Workspace")}
                  <input type="file" accept=".json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void handleImportWorkspace(f); }} />
                </label>
              </div>
            </section>

            <section className="ic-card">
              <h3>{word("开源声明与原作者信息", "Attribution & Open Source License")}</h3>
              <p>Infinite Canvas · Copyright (c) 2026 <strong>basketikun</strong> · MIT License · <a href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noreferrer">github.com/basketikun/infinite-canvas</a> (<code>4c67f1e</code>)</p>
            </section>
          </div>
        )}
      </main>

      {pendingThirdPartyConfirm && (
        <div className="ic-modal-backdrop" role="dialog" aria-modal="true">
          <div className="ic-modal">
            <strong>{word("确认安装第三方节点插件", "Confirm Third-Party Node Plugin URL")}</strong>
            <p style={{ margin: 0, fontSize: 12.5 }}>{word("即将从以下地址加载并执行第三方插件代码：", "You are about to load and execute third-party plugin code from:")}</p>
            <code style={{ wordBreak: "break-all", fontSize: 12 }}>{pendingThirdPartyConfirm.url}</code>
            <div className="ic-topbar-group" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="ic-btn" onClick={() => setPendingThirdPartyConfirm(null)}>{word("取消", "Cancel")}</button>
              <button
                type="button"
                className="ic-btn is-primary"
                onClick={() => {
                  try {
                    saveNodePluginsState(pluginMgr.installThirdParty({
                      id: makeId("tp"),
                      name: pendingThirdPartyConfirm.name,
                      url: pendingThirdPartyConfirm.url,
                      confirmedUrl: true,
                    }));
                    setThirdPartyNameInput("");
                    setThirdPartyUrlInput("");
                    setPendingThirdPartyConfirm(null);
                  } catch (err) {
                    setStatusMsg(err instanceof Error ? err.message : "install_failed");
                    setPendingThirdPartyConfirm(null);
                  }
                }}
              >
                {word("确认来源并安装", "Confirm Source & Install")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type OfficialNodePluginId =
  | "html"
  | "markdown"
  | "panorama"
  | "sticky-note"
  | "svg"
  | "template";

export type BundledOfficialNodePlugin = {
  id: OfficialNodePluginId;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  defaultContent: string;
};

export const BUNDLED_OFFICIAL_NODE_PLUGINS: readonly BundledOfficialNodePlugin[] = [
  {
    id: "html",
    name: "HTML Renderer",
    nameZh: "HTML 渲染器",
    description: "Render interactive HTML snippets safely inside a canvas node.",
    descriptionZh: "在画布节点内安全预览与编辑 HTML 片段。",
    defaultContent: "<div style=\"padding:12px;font-family:sans-serif\"><strong>HTML Node</strong><p>Bundled offline renderer.</p></div>",
  },
  {
    id: "markdown",
    name: "Markdown Note",
    nameZh: "Markdown 渲染",
    description: "Rich Markdown note node with offline preview.",
    descriptionZh: "支持离线渲染的 Markdown 文档节点。",
    defaultContent: "# Design Brief\n\n- Concept\n- Composition\n- Palette",
  },
  {
    id: "panorama",
    name: "3D Panorama",
    nameZh: "3D 全景节点",
    description: "Interactive 360° panoramic preview node for environment shots.",
    descriptionZh: "用于环绕场景图的 360° 全景交互预览节点。",
    defaultContent: "Panorama 360° Viewport (Equirectangular)",
  },
  {
    id: "sticky-note",
    name: "Sticky Note",
    nameZh: "便利贴",
    description: "Color-coded quick sticky notes for visual brainstorming.",
    descriptionZh: "用于头脑风暴与标注的彩色便利贴节点。",
    defaultContent: "Key reminder: keep aspect ratio 16:9.",
  },
  {
    id: "svg",
    name: "SVG Vector",
    nameZh: "SVG 矢量渲染",
    description: "Inline SVG vector diagram & icon node.",
    descriptionZh: "支持矢量图形预览与编辑的 SVG 节点。",
    defaultContent: "<svg viewBox=\"0 0 120 60\" xmlns=\"http://www.w3.org/2000/svg\"><rect x=\"6\" y=\"6\" width=\"108\" height=\"48\" rx=\"10\" fill=\"#2563eb\" opacity=\"0.18\" stroke=\"#2563eb\" stroke-width=\"2\"/><text x=\"60\" y=\"35\" text-anchor=\"middle\" font-size=\"13\" fill=\"currentColor\">SVG</text></svg>",
  },
  {
    id: "template",
    name: "Workflow Template",
    nameZh: "节点模板",
    description: "Reusable prompt-to-image workflow node template.",
    descriptionZh: "可复用的文生图/图生图画布流程模板。",
    defaultContent: "Template: Prompt -> Reference -> Image Generation",
  },
];

export type ThirdPartyNodePlugin = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  installedAt: number;
};

export type NodePluginsState = {
  scopeId: string;
  allowThirdParty: boolean;
  officialEnabled: OfficialNodePluginId[];
  thirdParty: ThirdPartyNodePlugin[];
};

const ALL_OFFICIAL_IDS: OfficialNodePluginId[] = BUNDLED_OFFICIAL_NODE_PLUGINS.map((p) => p.id);

export class NodePluginManager {
  private state: NodePluginsState;

  constructor(initial?: Partial<NodePluginsState> & { scopeId?: string }) {
    this.state = {
      scopeId: initial?.scopeId ?? "default",
      allowThirdParty: initial?.allowThirdParty === true,
      officialEnabled: Array.isArray(initial?.officialEnabled)
        ? initial.officialEnabled.filter((id): id is OfficialNodePluginId => ALL_OFFICIAL_IDS.includes(id))
        : [...ALL_OFFICIAL_IDS],
      thirdParty: Array.isArray(initial?.thirdParty)
        ? initial.thirdParty.map((item) => ({ ...item, enabled: initial?.allowThirdParty === true ? item.enabled : false }))
        : [],
    };
  }

  getState(): NodePluginsState {
    return {
      ...this.state,
      officialEnabled: [...this.state.officialEnabled],
      thirdParty: this.state.thirdParty.map((item) => ({ ...item })),
    };
  }

  toggleOfficial(id: OfficialNodePluginId, enabled: boolean): NodePluginsState {
    const next = new Set(this.state.officialEnabled);
    if (enabled) next.add(id);
    else next.delete(id);
    this.state = { ...this.state, officialEnabled: [...next] };
    return this.getState();
  }

  enableThirdParty(confirmedSecurityWarning: boolean): NodePluginsState {
    if (!confirmedSecurityWarning) {
      throw new Error("third_party_warning_not_confirmed");
    }
    this.state = { ...this.state, allowThirdParty: true };
    return this.getState();
  }

  /** Turning off the switch disables all third-party plugins WITHOUT deleting them. */
  disableThirdParty(): NodePluginsState {
    this.state = {
      ...this.state,
      allowThirdParty: false,
      thirdParty: this.state.thirdParty.map((item) => ({ ...item, enabled: false })),
    };
    return this.getState();
  }

  installThirdParty(input: { id: string; name: string; url: string; confirmedUrl: boolean }): NodePluginsState {
    if (!this.state.allowThirdParty) {
      throw new Error("third_party_disabled");
    }
    if (!input.confirmedUrl) {
      throw new Error("third_party_url_not_confirmed");
    }
    const cleanUrl = input.url.trim();
    if (!/^https:\/\//i.test(cleanUrl)) {
      throw new Error("third_party_url_invalid");
    }
    const cleanId = input.id.trim() || `tp_${Date.now()}`;
    const cleanName = input.name.trim() || cleanUrl.split("/").pop() || cleanId;
    const filtered = this.state.thirdParty.filter((item) => item.id !== cleanId && item.url !== cleanUrl);
    this.state = {
      ...this.state,
      thirdParty: [
        ...filtered,
        { id: cleanId, name: cleanName, url: cleanUrl, enabled: true, installedAt: Date.now() },
      ],
    };
    return this.getState();
  }

  toggleThirdParty(id: string, enabled: boolean): NodePluginsState {
    if (enabled && !this.state.allowThirdParty) {
      throw new Error("third_party_disabled");
    }
    this.state = {
      ...this.state,
      thirdParty: this.state.thirdParty.map((item) => item.id === id ? { ...item, enabled } : item),
    };
    return this.getState();
  }

  removeThirdParty(id: string): NodePluginsState {
    this.state = {
      ...this.state,
      thirdParty: this.state.thirdParty.filter((item) => item.id !== id),
    };
    return this.getState();
  }
}

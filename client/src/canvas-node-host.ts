import type { PluginHostRequest } from "../../src/client-protocol/plugins.js";
import { canvasNodeRegistry, loadCanvasNodeSource, type CanvasNodeInfo } from "./canvas-node-registry.js";
import { runCanvasNode } from "./canvas-node-runner.js";

export type NodeConsent = { kind: "enable" } | { kind: "install"; node: CanvasNodeInfo };
type Request = Extract<PluginHostRequest, { method: `canvas.nodes.${string}` }>;
export async function handleCanvasNodeRequest(req: Request, context: {
  scope: string;
  networkAllowed: boolean;
  active: () => boolean;
  confirm: (consent: NodeConsent) => Promise<boolean>;
}) {
  const { scope } = context;
  const current = () => { if (!context.active()) throw new Error("canvas_node_closed"); };
  current();
  switch (req.method) {
    case "canvas.nodes.list":
      return canvasNodeRegistry.get(scope);
    case "canvas.nodes.enable": {
      if (req.enabled && !(await canvasNodeRegistry.get(scope)).enabled) {
        current();
        if (!(await context.confirm({ kind: "enable" }))) throw new Error("canvas_node_cancelled");
      }
      current();
      return canvasNodeRegistry.setEnabled(scope, req.enabled);
    }
    case "canvas.nodes.install": {
      if (!context.networkAllowed) throw new Error("capability_denied");
      const node = await canvasNodeRegistry.prepare(scope, req.url, loadCanvasNodeSource);
      current();
      if (!(await context.confirm({ kind: "install", node }))) throw new Error("canvas_node_cancelled");
      current();
      await canvasNodeRegistry.install(scope, node);
      return canvasNodeRegistry.get(scope);
    }
    case "canvas.nodes.remove":
      await canvasNodeRegistry.remove(scope, req.pluginId);
      return canvasNodeRegistry.get(scope);
    case "canvas.nodes.render": {
      const installed = await canvasNodeRegistry.source(scope, req.pluginId);
      current();
      const output = await runCanvasNode(installed.source, req.node);
      current();
      if ((await canvasNodeRegistry.source(scope, req.pluginId)).sha256 !== installed.sha256) throw new Error("canvas_node_changed");
      return output;
    }
  }
}

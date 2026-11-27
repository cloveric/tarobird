import { evaluateCanvasNode, type CanvasNodeInput } from "./canvas-node-evaluator.js";

self.onmessage = async (event: MessageEvent<{ source: string; node: CanvasNodeInput }>) => {
  try {
    const output = await evaluateCanvasNode(event.data.source, event.data.node);
    self.postMessage({ ok: true, output });
  } catch {
    self.postMessage({ ok: false });
  }
};

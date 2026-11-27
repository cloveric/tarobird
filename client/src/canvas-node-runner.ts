import type { CanvasNodeInput, CanvasNodeOutput } from "./canvas-node-evaluator.js";

let running = 0;

export async function runCanvasNode(source: string, node: CanvasNodeInput): Promise<CanvasNodeOutput> {
  if (running >= 2) throw new Error("canvas_node_busy");
  const worker = new Worker(new URL("./canvas-node.worker.ts", import.meta.url), { type: "module" });
  ++running;
  try {
    return await new Promise<CanvasNodeOutput>((resolve, reject) => {
      const fail = () => reject(new Error("canvas_node_execution_failed"));
      const timer = setTimeout(fail, 5000);
      const failed = () => { clearTimeout(timer); fail(); };
      worker.onerror = failed;
      worker.onmessageerror = failed;
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        const output = data?.output;
        if (data?.ok !== true || typeof output?.text !== "string" || output.text.length > 16384
          || (output.color !== undefined && (typeof output.color !== "string" || !/^#[0-9a-f]{6}$/i.test(output.color)))) { fail(); return; }
        resolve({ text: output.text, ...(output.color ? { color: output.color } : {}) });
      };
      worker.postMessage({ source, node });
    });
  } finally { worker.terminate(); --running; }
}

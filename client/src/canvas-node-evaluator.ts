import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { DefaultIntrinsics, newQuickJSWASMModuleFromVariant, Scope } from "quickjs-emscripten-core";

export type CanvasNodeInput = { text: string; title?: string };
export type CanvasNodeOutput = { text: string; color?: string };

// This module runs in a one-use Worker. QuickJS gets plain strings and no
// native bindings, module loader, DOM, network, credentials or host callbacks.
export async function evaluateCanvasNode(source: string, node: CanvasNodeInput): Promise<CanvasNodeOutput> {
  if (source.length > 256 * 1024 || node.text.length > 16384 || (node.title?.length ?? 0) > 160) throw new Error("canvas_node_input_invalid");
  const engine = await newQuickJSWASMModuleFromVariant(variant);
  return Scope.withScope(scope => {
    const runtime = scope.manage(engine.newRuntime());
    runtime.setMemoryLimit(12 * 1024 * 1024);
    runtime.setMaxStackSize(256 * 1024);
    const deadline = performance.now() + 180;
    runtime.setInterruptHandler(() => performance.now() > deadline);
    // QuickJS uses its Eval and Promise intrinsics to compile ES modules. Both
    // exist only within this VM. No module loader or async job pump is installed.
    const vm = scope.manage(runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false, Proxy: false } }));
    // Only the VM evaluates the downloaded module. A private alias also accepts
    // ordinary single-file scripts declaring function render(node).
    const evaluated = vm.evalCode(source + "\n;export const __tarobirdNodeRender = typeof render === 'function' ? render : undefined;", "node.mjs", { type: "module" });
    if (evaluated.error) { evaluated.error.dispose(); throw new Error("canvas_node_module_invalid"); }
    const exports = scope.manage(evaluated.value);
    const defaultRender = scope.manage(vm.getProp(exports, "default"));
    const render = vm.typeof(defaultRender) === "function" ? defaultRender : scope.manage(vm.getProp(exports, "__tarobirdNodeRender"));
    if (vm.typeof(render) !== "function") throw new Error("canvas_node_missing_render");
    const input = scope.manage(vm.newObject(vm.null));
    vm.setProp(input, "text", scope.manage(vm.newString(node.text)));
    if (node.title !== undefined) vm.setProp(input, "title", scope.manage(vm.newString(node.title)));
    // Validate getters and produce only primitive strings inside the same
    // interruptible VM; never dump an arbitrary object graph into the worker.
    const normalizer = vm.evalCode(`(function (render, input) {
      const out = render(input);
      if (!out || typeof out !== "object") return null;
      const text = out.text, color = out.color;
      if (typeof text !== "string" || text.length > 16384 || (color !== undefined &&
          (typeof color !== "string" || color.length !== 7))) return null;
      return [text, color];
    })`, "result.js", { type: "global" });
    if (normalizer.error) { normalizer.error.dispose(); throw new Error("canvas_node_result_invalid"); }
    const call = vm.callFunction(scope.manage(normalizer.value), vm.undefined, render, input);
    if (call.error) { call.error.dispose(); throw new Error("canvas_node_execution_failed"); }
    const value = scope.manage(call.value);
    if (!vm.sameValue(value, vm.null) && vm.typeof(value) === "object") {
      const text = vm.getString(scope.manage(vm.getProp(value, 0)));
      const colorHandle = scope.manage(vm.getProp(value, 1));
      if (vm.typeof(colorHandle) === "undefined") return { text };
      const color = vm.getString(colorHandle);
      if (/^#[0-9a-f]{6}$/i.test(color)) return { text, color };
    }
    throw new Error("canvas_node_result_invalid");
  });
}

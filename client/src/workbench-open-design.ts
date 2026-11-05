import { designFormatTitle } from "../../src/client-protocol/workbench-design.js";
import type { DesignFormat } from "../../src/client-protocol/workbench-design.js";
import type { WorkbenchController } from "./workbench-controller.js";
import type { OpenedDesign } from "./workbench-design-opener.js";

/** Called only after the opener's source-bound command was admitted. Reuse a
 * live Design; don't create an empty document for each subsequent request. */
export async function openWorkbenchDesign(controller: WorkbenchController, requestId: string, check: () => void, signal: AbortSignal, format: DesignFormat = "canvas"): Promise<OpenedDesign> {
  check();
  if (!controller.isVisible) {
    await new Promise<void>((resolve, reject) => {
      let stopped = false, stop = () => {};
      const finish = (error?: Error) => {
        if (stopped) return; stopped = true; stop(); clearTimeout(timer); signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(new Error("workbench_cancelled"));
      const timer = setTimeout(() => finish(new Error("workbench_open_unavailable")), 5000);
      const changed = () => { try { check(); if (controller.isVisible) finish(); } catch { aborted(); } };
      stop = controller.subscribe(changed); signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted(); else changed();
    });
  }
  check();
  const layout = controller.getSnapshot().layout;
  const selected = layout.tabs.find(tab => tab.id === layout.active && tab.kind === "design" && (tab.designFormat ?? "canvas") === format)
    ?? [...layout.tabs].reverse().find(tab => tab.kind === "design" && (tab.designFormat ?? "canvas") === format);
  const created = !selected;
  const id = selected?.id ?? await controller.createDesign(designFormatTitle(format), `open_${requestId}`, check, undefined, format);
  check();
  if (selected) await controller.change({ type: "select", id }, check);
  check();
  const context = await controller.context(); check();
  const registration = controller.getRegistration();
  if (!registration?.visible || context?.kind !== "design" || context.target.tabId !== id || context.revision === undefined) throw new Error("workbench_open_unavailable");
  return { registration, target: context.target, revision: context.revision, created };
}

/** A controller can become visible while React is still loading the panel or
 * Electron is expanding its window. Wait for this exact panel/tab to mount;
 * a persisted document alone is not an opened UI. */
export async function waitForDesignSurface(id: string, tabId: string, check: () => void, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let frame = 0, stopped = false;
    const finish = (error?: Error) => {
      if (stopped) return; stopped = true; cancelAnimationFrame(frame); clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(new Error("workbench_cancelled"));
    const timer = setTimeout(() => finish(new Error("workbench_open_unavailable")), 5000);
    const inspect = () => {
      try {
        check();
        const panel = document.getElementById(id);
        const selected = panel?.querySelector('[role="tab"][aria-selected="true"]');
        if (panel && !panel.hidden && panel.getBoundingClientRect().width > 0 && selected?.getAttribute("aria-controls") === `${id}-pane-${tabId}`) { finish(); return; }
        frame = requestAnimationFrame(inspect);
      } catch { aborted(); }
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted(); else inspect();
  });
}

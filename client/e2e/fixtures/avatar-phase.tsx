import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AgentAvatar } from "../../src/AgentAvatar.js";
import type { AgentSignal } from "../../src/agent-state.js";

/** Real component and CSS; no Host timing or stored user data in this fixture. */
export function mountAvatarPhases(container: HTMLElement) {
  const root = createRoot(container);
  const signals: AgentSignal[] = Array.from({ length: 6 }, () => ({ state: "working", at: Date.now() }));
  const render = () => flushSync(() => root.render(createElement("div", {}, ...signals.map((signal, i) =>
    createElement(AgentAvatar, { key: i, signal, size: 40, className: "phase-avatar", children:
      createElement("span", { className: "profile-avatar", style: { display: "inline-block", width: 40, height: 40 } }) })))));
  render();
  return { finish(indices: number[]) { const at = Date.now(); for (const i of indices) signals[i] = { state: "done", at }; render(); }, unmount() { flushSync(() => root.unmount()); } };
}

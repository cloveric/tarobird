import { handlePluginHostMessage } from "../../src/plugin-sandbox-runtime.js";
import { createPluginSensitiveActionGate } from "../../src/plugin-sensitive-action.js";

const gate = createPluginSensitiveActionGate();
let active = true;
const requests = new Map<string, unknown>();
const effects: string[] = [];
Object.assign(window, { fixture: {
  submit(id: string, kind: "clipboard" | "export") {
    const method = kind === "clipboard"
      ? { method: "clipboard.write", text: "Fixture clipboard" }
      : { method: "workspace.export", filename: "fixture.txt", content: "Fixture file" };
    void handlePluginHostMessage({ protocol: "tarobird.plugin.v1", id, ...method }, {
      pluginId: "fixture.plugin", storage: localStorage, theme: "light", locale: "en",
      grantedCapabilities: ["files.export", "clipboard.write"],
      runSensitiveAction: (action, run) => gate.run("Fixture plugin", action, run, () => active),
      writeClipboard: async text => { effects.push(`${text}/${navigator.userActivation.isActive}`); },
      exportWorkspace: async filename => { effects.push(`${filename}/${navigator.userActivation.isActive}`); return true; },
    }).then(result => requests.set(id, result));
  },
  expire() { active = false; },
  summary() { return { results: [...requests], effects: [...effects] }; },
} });

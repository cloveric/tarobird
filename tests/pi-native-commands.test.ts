import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PI_COMMAND_CARD_LIMIT, runPiNativeCommand,
  type PiCommandAnswer, type PiCommandQuestion, type PiNativeCommandContext,
} from "../src/codex/pi-native-commands.js";
import {
  PiNativeBridgeUnavailableError, PiNativeBusyError, PiNativeRejectedError, PiNativeUncertainError,
  type PiNativeCommand, type PiNativeControls, type PiNativeModelScope, type PiNativeProjectTrust, type PiNativeState, type PiNativeStats,
  type PiNativeTree, type PiNativeTreeNode,
} from "../src/codex/pi-native-types.js";
import { PI_TUI_BUILTIN_COMMANDS } from "../src/codex/pi-rpc-protocol.js";

type Call = [method: string, ...args: unknown[]];
type RawModel = { provider: string; id: string; name?: string; reasoning?: boolean; baseUrl?: string };

const OUT = path.resolve("/srv/tarobird/out/request-1");

const baseState = (): PiNativeState => ({
  sessionId: "sess-0001", modelSource: "native",
  model: { provider: "alpha", modelId: "dup-model", name: "Dup Model", reasoning: true, input: ["text"], contextWindow: 200_000 },
  thinkingLevel: "medium", availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
  isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
  autoCompactionEnabled: true, pending: { steering: [], followUp: [] }, bridge: "connected", ui: { status: {}, widgets: {} },
});

const baseStats = (): PiNativeStats => ({
  userMessages: 4, assistantMessages: 5, toolCalls: 2, totalMessages: 11,
  tokens: { input: 12_345, output: 678, cacheRead: 9_000, cacheWrite: 10, total: 22_033 },
  costUsd: 0.0123, context: { tokens: 24_000, contextWindow: 200_000, percent: 12.04 },
});

const DEFAULT_MODELS: RawModel[] = [
  { provider: "alpha", id: "dup-model", name: "Dup Model", reasoning: true, baseUrl: "http://127.0.0.1:1/v1" },
  { provider: "alpha", id: "plain-model", name: "Plain Model" },
  { provider: "beta", id: "dup-model", name: "Dup Model", reasoning: true },
  { provider: "router", id: "vendor/claude-x", name: "Claude X" },
];

function node(id: string, parentId: string | null, role: string, preview: string, childIds: string[], extra: Partial<PiNativeTreeNode> = {}): PiNativeTreeNode {
  return { id, parentId, type: "message", role, preview, childIds, ...extra };
}
/** u1 → a1 → { u2 → a2 (leaf), u2b → a2b }. */
const baseTree = (): PiNativeTree => ({
  leafId: "a2",
  nodes: [
    node("u1", null, "user", "first question", ["a1"]),
    node("a1", "u1", "assistant", "first answer", ["u2", "u2b"]),
    node("u2", "a1", "user", "second question", ["a2"]),
    node("a2", "u2", "assistant", "second answer", []),
    node("u2b", "a1", "user", "other branch question", ["a2b"], { label: "kept idea" }),
    node("a2b", "u2b", "assistant", "other branch answer", []),
  ],
});

interface Harness {
  /** Per-model split returned by getStats, when a test sets one. */
  costByModel?: PiNativeStats["costByModel"];
  controls: PiNativeControls;
  calls: Call[];
  state: PiNativeState;
  models: RawModel[];
  commands: PiNativeCommand[];
  tree: PiNativeTree;
  forkPoints: Array<{ entryId: string; text: string }>;
  lastAssistantText: string | undefined;
  bash: { output: string; exitCode?: number | null; cancelled: boolean; truncated: boolean; fullOutputPath?: string };
  exportPath: string | undefined;
  replaced: { sessionId: string; cancelled: boolean; text: string };
  navigate: { cancelled: boolean; leafId: string | null; editorText?: string };
  trust: PiNativeProjectTrust;
  scope: PiNativeModelScope;
  importInfo: { sessionId: string; name?: string; sameWorkspace: boolean; alreadyPresent: boolean } | undefined;
  imported: { sessionId: string; cancelled: boolean };
  fail: Partial<Record<keyof PiNativeControls, unknown>>;
  named(method: string): Call[];
}

function harness(): Harness {
  const h: Harness = {
    calls: [], state: baseState(), models: DEFAULT_MODELS.map(model => ({ ...model })), commands: [], tree: baseTree(),
    forkPoints: [{ entryId: "u1", text: "first question" }, { entryId: "u2", text: "second question" }],
    lastAssistantText: "second answer", bash: { output: "hello\n", exitCode: 0, cancelled: false, truncated: false },
    exportPath: undefined, replaced: { sessionId: "sess-0002", cancelled: false, text: "second question" },
    navigate: { cancelled: false, leafId: "a1", editorText: "second question" }, fail: {},
    trust: { hasProjectFiles: false }, scope: { scope: [], nativePatterns: [] },
    importInfo: { sessionId: "sess-0100", name: "old work", sameWorkspace: true, alreadyPresent: false },
    imported: { sessionId: "sess-0100", cancelled: false },
    named: method => h.calls.filter(call => call[0] === method),
    controls: undefined as unknown as PiNativeControls,
  };
  const record = <T>(method: keyof PiNativeControls, args: unknown[], value: () => T): Promise<T> => {
    h.calls.push([method, ...args]);
    if (h.fail[method] !== undefined) return Promise.reject(h.fail[method]);
    return Promise.resolve().then(value);
  };
  h.controls = {
    getState: id => record("getState", [id], () => ({ ...h.state })),
    listModels: id => record("listModels", [id], () => h.models as unknown[]),
    listCommands: id => record("listCommands", [id], () => h.commands),
    getStats: id => record("getStats", [id], () => ({ ...baseStats(), ...(h.costByModel ? { costByModel: h.costByModel } : {}) })),
    getTree: id => record("getTree", [id], () => h.tree),
    listForkPoints: id => record("listForkPoints", [id], () => h.forkPoints),
    getLastAssistantText: id => record("getLastAssistantText", [id], () => h.lastAssistantText),
    listTools: id => record("listTools", [id], () => []),
    subscribe: () => () => {},
    setModel: (id, model) => record("setModel", [id, model], () => {
      if (model) {
        const raw = h.models.find(row => row.provider === model.provider && row.id === model.modelId);
        h.state = {
          ...h.state, modelSource: "session",
          model: { provider: model.provider, modelId: model.modelId, name: raw?.name ?? model.modelId, reasoning: raw?.reasoning === true, input: ["text"], contextWindow: 100_000 },
          thinkingLevel: raw?.reasoning === true ? h.state.thinkingLevel : "off",
        };
      }
      return { ...h.state };
    }),
    setThinkingLevel: (id, level) => record("setThinkingLevel", [id, level], () => { if (level) h.state = { ...h.state, thinkingLevel: level }; return { ...h.state }; }),
    setSessionName: (id, name) => record("setSessionName", [id, name], () => { h.state = { ...h.state, sessionName: name }; }),
    followUp: (id, input) => record("followUp", [id, input], () => "queued" as const),
    clearQueue: id => record("clearQueue", [id], () => ({ steering: [], followUp: [] })),
    compact: (id, input) => record("compact", [id, input], () => ({ summary: "summary text", tokensBefore: 150_000, estimatedTokensAfter: 32_000 })),
    abortRetry: id => record("abortRetry", [id], () => undefined),
    runUserBash: (id, input) => record("runUserBash", [id, input], () => ({ ...h.bash })),
    exportHtml: (id, input) => record("exportHtml", [id, input], () => ({ path: input?.outputPath ?? h.exportPath ?? path.resolve("/srv/workspace/pi-session-default.html") })),
    setActiveTools: (id, names) => record("setActiveTools", [id, names], () => []),
    reload: id => record("reload", [id], () => undefined),
    setLabel: (id, input) => record("setLabel", [id, input], () => undefined),
    navigateTree: (id, input) => record("navigateTree", [id, input], () => ({ ...h.navigate })),
    fork: (id, input) => record("fork", [id, input], () => ({ ...h.replaced })),
    clone: id => record("clone", [id], () => ({ sessionId: h.replaced.sessionId, cancelled: h.replaced.cancelled })),
    newSession: id => record("newSession", [id], () => ({ sessionId: h.replaced.sessionId, cancelled: h.replaced.cancelled })),
    getProjectTrust: id => record("getProjectTrust", [id], () => ({ ...h.trust })),
    setProjectTrust: (id, decision) => record("setProjectTrust", [id, decision], () => {
      h.trust = { ...h.trust, decision, loaded: decision === "yes" };
      return { ...h.trust };
    }),
    exportJsonl: (id, input) => record("exportJsonl", [id, input], () => ({ path: input.outputPath, entries: 42 })),
    inspectImport: (id, input) => record("inspectImport", [id, input], () => h.importInfo),
    importSession: (id, input) => record("importSession", [id, input], () => ({ ...h.imported })),
    getModelScope: id => record("getModelScope", [id], () => ({ scope: [...h.scope.scope], nativePatterns: [...h.scope.nativePatterns] })),
    setModelScope: (id, models) => record("setModelScope", [id, models], () => {
      h.scope = { ...h.scope, scope: models ?? [] };
      return { scope: [...h.scope.scope], nativePatterns: [...h.scope.nativePatterns] };
    }),
    setNativeGlobalSetting: (id, setting) => record("setNativeGlobalSetting", [id, setting], () => undefined),
  };
  return h;
}

/** Scripted card answers; each asked question is recorded. */
function cards(answers: Array<PiCommandAnswer | ((question: PiCommandQuestion) => PiCommandAnswer)>) {
  const asked: PiCommandQuestion[] = [];
  const ask = async (question: PiCommandQuestion): Promise<PiCommandAnswer> => {
    asked.push(question);
    const next = answers.shift();
    if (next === undefined) throw new Error(`Unexpected card: ${question.title}`);
    return typeof next === "function" ? next(question) : next;
  };
  return { ask, asked };
}

function context(h: Harness, extra: Partial<PiNativeCommandContext> = {}): PiNativeCommandContext {
  return { sessionId: "sess-0001", controls: h.controls, locale: "en", approvalMode: "bypass", ...extra };
}

async function handled(text: string, ctx: PiNativeCommandContext): Promise<{ text: string; sessionId?: string }> {
  const result = await runPiNativeCommand(text, ctx);
  if (!result.handled) throw new Error(`Expected ${JSON.stringify(text)} to be handled`);
  expect(result.text.trim()).not.toBe("");
  return result;
}

const MUTATING = ["setModel", "setThinkingLevel", "setSessionName", "compact", "runUserBash", "exportHtml", "reload", "setLabel",
  "navigateTree", "fork", "clone", "newSession", "setNativeGlobalSetting", "followUp", "clearQueue", "setActiveTools", "abortRetry",
  "setProjectTrust", "exportJsonl", "importSession", "setModelScope"];
const mutations = (h: Harness): Call[] => h.calls.filter(call => MUTATING.includes(call[0]));

describe("Pi native commands: routing", () => {
  const names = Object.keys(PI_TUI_BUILTIN_COMMANDS);

  it("covers the 27 terminal built-ins", () => {
    expect(names).toHaveLength(27);
  });

  it.each(names.flatMap(name => (["en", "zh"] as const).map(locale => [name, locale] as const)))(
    "serves /%s itself (%s) and never hands it to the model", async (name, locale) => {
      const h = harness();
      const result = await runPiNativeCommand(`/${name}`, context(h, { locale }));
      expect(result.handled).toBe(true);
      if (result.handled) expect(result.text.trim().length).toBeGreaterThan(3);
    });

  it.each(["/skill:review", "/mcp login search", "/unknown", "/unknown with args", "//comment", "plain text", "", "   ", "!", "!!", "!   ",
    "/Model", "/constructor", "/toString", "/__proto__", "/hasOwnProperty x", "/model/x"])("leaves %j to Pi", async text => {
    const h = harness();
    expect(await runPiNativeCommand(text, context(h))).toEqual({ handled: false });
    expect(mutations(h)).toEqual([]);
  });

  it("lets a built-in win over a session command of the same name, as the terminal does", async () => {
    const h = harness();
    h.commands = [{ name: "tree", source: "extension" }, { name: "model", source: "prompt" }, { name: "copy", source: "extension" }];
    expect((await handled("/tree", context(h))).text).toContain("first question");
    expect((await handled("/model plain-model", context(h))).text).toContain("alpha/plain-model");
    expect((await handled("/copy", context(h))).text).toBe("second answer");
    expect(h.named("listCommands")).toEqual([]);
  });

  it("hands an exact-match built-in followed by text to the session command of that name", async () => {
    const h = harness();
    h.commands = [{ name: "tree", source: "extension" }, { name: "copy", source: "prompt" }, { name: "logout", source: "extension" },
      { name: "trust", source: "extension" }, { name: "scoped-models", source: "prompt" }];
    h.trust = { hasProjectFiles: true };
    for (const text of ["/tree go deep", "/copy now", "/logout alpha", "/trust yes", "/scoped-models clear"]) {
      expect(await runPiNativeCommand(text, context(h))).toEqual({ handled: false });
    }
    expect(mutations(h)).toEqual([]);
  });

  it("answers an exact-match built-in followed by text when no session command claims it", async () => {
    const h = harness();
    for (const name of ["copy", "session", "clone", "new", "reload"]) {
      expect((await handled(`/${name} extra words`, context(h))).text).toBe(`/${name} takes no arguments. Nothing was changed.`);
    }
    expect((await handled("/share now", context(h))).text).toContain("Nothing was uploaded");
    expect(h.calls.filter(call => call[0] !== "listCommands")).toEqual([]);
  });

  it("treats a failing command list as no session command", async () => {
    const h = harness();
    h.fail.listCommands = new Error("gone");
    expect((await handled("/reload now", context(h))).text).toContain("takes no arguments");
  });
});

describe("Pi native commands: /model", () => {
  it("resolves an exact provider/id whose id contains slashes", async () => {
    const h = harness();
    const reply = await handled("/model router/vendor/claude-x", context(h));
    expect(h.named("setModel")).toEqual([["setModel", "sess-0001", { provider: "router", modelId: "vendor/claude-x" }]]);
    expect(reply.text).toContain("Claude X (router/vendor/claude-x)");
    expect(reply.text).toContain("current conversation only");
    expect(reply.text).not.toContain("127.0.0.1");
  });

  it("reports a clamped thinking level", async () => {
    const h = harness();
    const reply = await handled("/model alpha/plain-model", context(h));
    expect(reply.text).toContain("Thinking level: off (was medium)");
  });

  it("offers the candidates when an id exists under several providers", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "beta/dup-model" }]);
    const reply = await handled("/model dup-model", context(h, { ask }));
    expect(asked).toHaveLength(1);
    expect(asked[0].options.map(option => option.label)).toEqual(["alpha/dup-model", "beta/dup-model"]);
    expect(asked[0].options[0].description).toContain("current");
    expect(h.named("setModel")[0][2]).toEqual({ provider: "beta", modelId: "dup-model" });
    expect(reply.text).toContain("beta/dup-model");
  });

  it("lists the candidates as text when it cannot show a card, and changes nothing", async () => {
    const h = harness();
    const reply = await handled("/model DUP-MODEL", context(h));
    expect(reply.text).toContain("- alpha/dup-model");
    expect(reply.text).toContain("- beta/dup-model");
    expect(reply.text).toContain("/model <provider>/<id>");
    expect(h.named("setModel")).toEqual([]);
  });

  it("matches a unique name fragment, case-insensitively", async () => {
    const h = harness();
    await handled("/model plain mod", context(h));
    expect(h.named("setModel")[0][2]).toEqual({ provider: "alpha", modelId: "plain-model" });
  });

  it("never guesses when nothing matches", async () => {
    const h = harness();
    const reply = await handled("/model gpt-nope", context(h));
    expect(reply.text).toContain('No available model matches "gpt-nope"');
    expect(h.named("setModel")).toEqual([]);
  });

  it("asks for the provider first, then the model", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "beta" }, { value: "beta/dup-model" }]);
    await handled("/model", context(h, { ask }));
    expect(asked[0].options.map(option => option.value)).toEqual(["alpha", "beta", "router"]);
    expect(asked[0].options[0].description).toBe("2 models · current");
    expect(asked[1].options.map(option => option.value)).toEqual(["beta/dup-model"]);
    expect(h.named("setModel")[0][2]).toEqual({ provider: "beta", modelId: "dup-model" });
  });

  it("skips the provider step with a single provider", async () => {
    const h = harness();
    h.models = h.models.filter(model => model.provider === "alpha");
    const { ask, asked } = cards([{ value: "alpha/plain-model" }]);
    await handled("/model", context(h, { ask }));
    expect(asked).toHaveLength(1);
    expect(asked[0].options).toHaveLength(2);
    expect(asked[0].text).toBeUndefined();
  });

  it("pages a long list and narrows it by typed text", async () => {
    const h = harness();
    h.models = Array.from({ length: 45 }, (_, index) => ({ provider: "alpha", id: `m-${index}`, name: `Model ${index}` }));
    const { ask, asked } = cards([{ text: "zzz" }, { text: "M-4" }, { value: "alpha/m-41" }]);
    await handled("/model", context(h, { ask }));
    expect(asked[0].options).toHaveLength(PI_COMMAND_CARD_LIMIT);
    expect(asked[0].text?.placeholder).toBeTruthy();
    expect(asked[0].message).toContain("45");
    expect(asked[1].message).toContain('Nothing matches "zzz"');
    expect(asked[1].options).toHaveLength(PI_COMMAND_CARD_LIMIT);
    expect(asked[2].options.map(option => option.label)).toEqual(["alpha/m-4", "alpha/m-40", "alpha/m-41", "alpha/m-42", "alpha/m-43", "alpha/m-44"]);
    expect(asked[2].text).toBeUndefined();
    expect(h.named("setModel")[0][2]).toEqual({ provider: "alpha", modelId: "m-41" });
  });

  it("selects directly when typed text leaves one model", async () => {
    const h = harness();
    h.models = Array.from({ length: 45 }, (_, index) => ({ provider: "alpha", id: `m-${index}`, name: `Model ${index}` }));
    const { ask } = cards([{ text: "model 37" }]);
    await handled("/model", context(h, { ask }));
    expect(h.named("setModel")[0][2]).toEqual({ provider: "alpha", modelId: "m-37" });
  });

  it("bounds the text listing", async () => {
    const h = harness();
    h.models = Array.from({ length: 45 }, (_, index) => ({ provider: "alpha", id: `m-${index}` }));
    const reply = await handled("/model", context(h));
    expect(reply.text.split("\n").filter(line => line.startsWith("- "))).toHaveLength(PI_COMMAND_CARD_LIMIT);
    expect(reply.text).toContain("and 15 more");
  });

  it("explains how to sign in when no model is available", async () => {
    const h = harness();
    h.models = [];
    expect((await handled("/model", context(h))).text).toContain("pi auth login");
  });

  it("changes nothing on cancel or on a value outside the list", async () => {
    const h = harness();
    expect((await handled("/model dup-model", context(h, { ask: cards([{ cancelled: true }]).ask }))).text).toBe("Cancelled. Nothing was changed.");
    expect((await handled("/model dup-model", context(h, { ask: cards([{ value: "gamma/other" }]).ask }))).text).toContain("not in the list");
    expect(h.named("setModel")).toEqual([]);
  });

  it("maps an unavailable model from the session", async () => {
    const h = harness();
    h.fail.setModel = new PiNativeRejectedError("Model not found: alpha/plain-model", "model-unavailable");
    expect((await handled("/model alpha/plain-model", context(h))).text).toContain("not available in this session");
  });
});

describe("Pi native commands: /thinking, /name, /session, /copy, /compact", () => {
  it("sets a supported level, case-insensitively, and treats off as a level", async () => {
    const h = harness();
    expect((await handled("/thinking HIGH", context(h))).text).toContain("Thinking level: high");
    expect((await handled("/thinking off", context(h))).text).toContain("Thinking level: off");
    expect(h.named("setThinkingLevel").map(call => call[2])).toEqual(["high", "off"]);
  });

  it("lists the supported levels for an unsupported one", async () => {
    const h = harness();
    const reply = await handled("/thinking max", context(h));
    expect(reply.text).toBe('Unknown thinking level "max". Available levels: off, minimal, low, medium, high.');
    expect(h.named("setThinkingLevel")).toEqual([]);
  });

  it("shows a card of levels, or a text list without cards", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "low" }]);
    await handled("/thinking", context(h, { ask }));
    expect(asked[0].options.map(option => option.value)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(asked[0].options.find(option => option.value === "medium")?.description).toBe("current");
    expect(h.named("setThinkingLevel")[0][2]).toBe("low");
    expect((await handled("/thinking", context(h))).text).toContain("Available: off, minimal, low, medium, high");
  });

  it("says so when the model cannot think", async () => {
    const h = harness();
    h.state = { ...h.state, thinkingLevel: "off", availableThinkingLevels: ["off"] };
    expect((await handled("/thinking", context(h))).text).toContain("does not support thinking");
  });

  it("uses the allowed list from a rejection", async () => {
    const h = harness();
    h.fail.setThinkingLevel = new PiNativeRejectedError("unsupported", "thinking-unsupported", ["off", "low"]);
    expect((await handled("/thinking high", context(h))).text).toContain("Supported: off, low.");
  });

  it("shows, explains and sets the session name", async () => {
    const h = harness();
    expect((await handled("/name", context(h))).text).toContain("/name <name>");
    expect((await handled("/name  refactor auth ", context(h))).text).toBe("Session name set: refactor auth");
    expect(h.named("setSessionName")[0][2]).toBe("refactor auth");
    expect((await handled("/name", context(h))).text).toBe("Session name: refactor auth");
  });

  it("prints a compact session block", async () => {
    const h = harness();
    const lines = (await handled("/session", context(h))).text.split("\n");
    expect(lines).toEqual([
      "Session sess-0001",
      "Model: alpha/dup-model · thinking medium",
      "State: idle",
      "Messages: 11 (4 from you, 5 replies, 2 tool calls)",
      "Tokens: 12,345 in · 678 out · 9,000 cache read · 10 cache write · 22,033 total",
      "Cost: $0.0123 at list price",
      "Context: 12% of 200,000 tokens",
    ]);
    h.state = { ...h.state, sessionName: "auth work" };
    expect((await handled("/session", context(h))).text.split("\n")[0]).toBe("Session auth work (sess-0001)");
    expect((await handled("/session", context(h, { locale: "zh" }))).text).toContain("会话 auth work（sess-0001）\n模型：alpha/dup-model");
  });

  it("returns the last reply for /copy, or says there is none", async () => {
    const h = harness();
    expect((await handled("/copy", context(h))).text).toBe("second answer");
    h.lastAssistantText = undefined;
    expect((await handled("/copy", context(h))).text).toContain("no reply to copy");
  });

  it("passes compaction instructions through", async () => {
    const h = harness();
    expect((await handled("/compact", context(h))).text).toBe("Context compacted. Before: 150,000 tokens. After: about 32,000 tokens.");
    await handled("/compact focus on code changes", context(h));
    expect(h.named("compact").map(call => call[2])).toEqual([undefined, { instructions: "focus on code changes" }]);
  });
});

describe("Pi native commands: /session cost by model", () => {
  const costLines = (text: string) => text.split("\n").filter(line => line.startsWith("  "));

  it("lists each model that answered, as Pi's own /session does", async () => {
    const h = harness();
    h.costByModel = [{ key: "beta/dup-model", costUsd: 0.01, tokens: 15_000 }, { key: "alpha/dup-model", costUsd: 0.002, tokens: 7_000 }, { key: "Tools/summaries", costUsd: 0.0003, tokens: 33 }];
    expect(costLines((await handled("/session", context(h))).text)).toEqual([
      "  beta/dup-model: $0.01 (15,000 tokens)",
      "  alpha/dup-model: $0.002 (7,000 tokens)",
      "  Tool and summary calls: $0.0003 (33 tokens)",
    ]);
    expect(costLines((await handled("/session", context(h, { locale: "zh" }))).text)).toEqual([
      "  beta/dup-model：$0.01（15,000 token）",
      "  alpha/dup-model：$0.002（7,000 token）",
      "  工具与摘要调用：$0.0003（33 token）",
    ]);
  });

  it("leaves out a single line that only repeats the selected model's total", async () => {
    const h = harness();
    h.costByModel = [{ key: "alpha/dup-model", costUsd: 0.0123, tokens: 22_033 }];
    expect(costLines((await handled("/session", context(h))).text)).toEqual([]);
    // A router model answers under another name: that single line is information.
    h.costByModel = [{ key: "alpha/routed-elsewhere", costUsd: 0.0123, tokens: 22_033 }];
    expect(costLines((await handled("/session", context(h))).text)).toEqual(["  alpha/routed-elsewhere: $0.0123 (22,033 tokens)"]);
    h.costByModel = undefined;
    expect(costLines((await handled("/session", context(h))).text)).toEqual([]);
  });
});

describe("Pi native commands: unconfirmed earlier change", () => {
  it("says why nothing was attempted and what to do", async () => {
    const h = harness();
    h.fail.setModel = new PiNativeUncertainError("set_model");
    const en = (await handled("/model alpha/dup-model", context(h))).text;
    expect(en).toBe("An earlier model or thinking change in this session got no confirmed answer and may still take effect, so /model was not attempted. Restart the Bot to change them again.");
    h.fail.setThinkingLevel = new PiNativeUncertainError("set_thinking_level");
    expect((await handled("/thinking low", context(h, { locale: "zh" }))).text).toBe("这个会话里之前一次模型或思考级别的更改没有得到确认，可能稍后才生效，所以没有执行 /thinking。重启 Bot 后可以再改。");
  });
});

describe("Pi native commands: /export", () => {
  const exported = (h: Harness) => (h.named("exportHtml")[0][2] as { outputPath?: string }).outputPath;
  const inside = (file: string | undefined) => file !== undefined && path.dirname(file) === OUT;

  it("writes a generated file into the output directory", async () => {
    const h = harness();
    const reply = await handled("/export", context(h, { outputDir: OUT }));
    expect(exported(h)).toBe(path.join(OUT, "pi-session-sess-0001.html"));
    expect(reply.text).toBe("Session exported to pi-session-sess-0001.html. The file is delivered in this conversation.");
  });

  it.each([["report.html", "report.html"], ["report", "report.html"], ['"my notes.html" trailing', "my-notes.html"], [".hidden", "hidden.html"]])(
    "keeps a bare file name %j", async (argument, file) => {
      const h = harness();
      const reply = await handled(`/export ${argument}`, context(h, { outputDir: OUT }));
      expect(exported(h)).toBe(path.join(OUT, file));
      expect(reply.text).not.toContain("requested location");
    });

  it.each([
    ["../../etc/x.html", "x.html"], ["/var/data/y.html", "y.html"], ["sub/dir/z", "z.html"], ["..\\..\\w.html", "w.html"],
    ["..", "pi-session-sess-0001.html"], ["../", "pi-session-sess-0001.html"],
  ])("contains the path %j inside the output directory", async (argument, file) => {
    const h = harness();
    const reply = await handled(`/export ${argument}`, context(h, { outputDir: OUT }));
    expect(inside(exported(h))).toBe(true);
    expect(exported(h)).toBe(path.join(OUT, file));
    expect(reply.text).toContain("requested location was not used");
    expect(reply.text).not.toContain(OUT);
  });

  it("never writes a caller path when there is no output directory, and shows only the file name", async () => {
    const h = harness();
    const reply = await handled("/export /var/data/y.html", context(h));
    expect(h.named("exportHtml")[0][2]).toEqual({});
    expect(reply.text).toContain("pi-session-default.html in the workspace");
    expect(reply.text).toContain("requested location was not used");
    expect(reply.text).not.toMatch(/[\\/](srv|var)[\\/]/);
  });
});

describe("Pi native commands: /fork, /clone, /new, /reload", () => {
  it("forks from a chosen message, newest first, and returns the new session", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "u2" }]);
    const reply = await handled("/fork", context(h, { ask }));
    expect(asked[0].options.map(option => option.value)).toEqual(["u2", "u1"]);
    expect(h.named("fork")).toEqual([["fork", "sess-0001", { entryId: "u2" }]]);
    expect(reply.sessionId).toBe("sess-0002");
    expect(reply.text).toContain("second question");
  });

  it("accepts a position or an entry id as text", async () => {
    const h = harness();
    await handled("/fork 2", context(h));
    await handled("/fork u2", context(h));
    expect(h.named("fork").map(call => call[2])).toEqual([{ entryId: "u1" }, { entryId: "u2" }]);
    expect((await handled("/fork 9", context(h))).text).toContain("not found");
  });

  it("lists the fork points without cards", async () => {
    const h = harness();
    const reply = await handled("/fork", context(h));
    expect(reply.text).toContain("1. second question\n2. first question");
    expect(reply.text).toContain("/fork <number>");
    expect(h.named("fork")).toEqual([]);
  });

  it("keeps the session when a fork is cancelled or there is nothing to fork", async () => {
    const h = harness();
    h.replaced = { ...h.replaced, cancelled: true };
    const cancelled = await handled("/fork 1", context(h));
    expect(cancelled.sessionId).toBeUndefined();
    expect(cancelled.text).toContain("cancelled");
    h.forkPoints = [];
    expect((await handled("/fork", context(h))).text).toContain("no messages to fork from");
  });

  it("returns the new session for /clone and /new", async () => {
    const h = harness();
    expect((await handled("/clone", context(h))).sessionId).toBe("sess-0002");
    expect((await handled("/new", context(h))).sessionId).toBe("sess-0002");
    h.replaced = { ...h.replaced, cancelled: true };
    expect((await handled("/clone", context(h))).sessionId).toBeUndefined();
    expect((await handled("/new", context(h))).sessionId).toBeUndefined();
    expect(h.named("clone")).toHaveLength(2);
    expect(h.named("newSession")).toHaveLength(2);
  });

  it("reloads through the bridge", async () => {
    const h = harness();
    expect((await handled("/reload", context(h))).text).toContain("Reloaded");
    expect(h.named("reload")).toHaveLength(1);
  });
});

describe("Pi native commands: /tree", () => {
  it("lists what Pi's tree lists by default (replies included), newest first, with branch marks", async () => {
    const h = harness();
    const { ask, asked } = cards([{ cancelled: true }]);
    await handled("/tree", context(h, { ask }));
    expect(asked[0].options).toEqual([
      { label: "· other branch answer", description: "reply · other branch", value: "a2b" },
      { label: "· other branch question", description: "[kept idea] · other branch", value: "u2b" },
      { label: "· second answer", description: "reply · current position", value: "a2" },
      { label: "· second question", description: "current branch", value: "u2" },
      { label: "first answer", description: "reply · current branch", value: "a1" },
      { label: "first question", description: "current branch", value: "u1" },
    ]);
    expect(h.named("navigateTree")).toEqual([]);
  });

  it.each([
    ["no", { targetId: "u2b", summarize: false }],
    ["yes", { targetId: "u2b", summarize: true }],
  ])("navigates with summary choice %s", async (choice, expected) => {
    const h = harness();
    const { ask, asked } = cards([{ value: "u2b" }, { value: choice }]);
    const reply = await handled("/tree", context(h, { ask }));
    expect(asked[1].options.map(option => option.label)).toEqual(["No summary", "Summarize", "Summarize with custom instructions"]);
    expect(h.named("navigateTree")).toEqual([["navigateTree", "sess-0001", expected]]);
    expect(reply.text).toContain("Moved to the selected point.");
    expect(reply.text).toContain("second question");
    expect(reply.sessionId).toBeUndefined();
  });

  it("takes custom summary instructions, returning to the choice when they are cancelled", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "u1" }, { value: "custom" }, { cancelled: true }, { value: "custom" }, { text: " keep the API notes " }]);
    await handled("/tree", context(h, { ask }));
    expect(asked[2].text?.multiline).toBe(true);
    expect(asked).toHaveLength(5);
    expect(h.named("navigateTree")[0][2]).toEqual({ targetId: "u1", summarize: true, customInstructions: "keep the API notes" });
  });

  it("does nothing when the summary choice is cancelled or the point is the current one", async () => {
    const h = harness();
    expect((await handled("/tree", context(h, { ask: cards([{ value: "u1" }, { cancelled: true }]).ask }))).text).toBe("Cancelled. Nothing was changed.");
    h.tree = { ...h.tree, leafId: "u2" };
    expect((await handled("/tree", context(h, { ask: cards([{ value: "u2" }]).ask }))).text).toBe("Already at this point.");
    expect(h.named("navigateTree")).toEqual([]);
  });

  it("supports the text forms", async () => {
    const h = harness();
    const listing = (await handled("/tree", context(h))).text;
    expect(listing).toContain("2. · other branch question ([kept idea] · other branch)");
    expect(listing).toContain("6. first question (current branch)");
    expect((await handled("/tree", context(h, { locale: "zh" }))).text).toContain("6. first question（当前分支）");
    expect((await handled("/tree", context(h, { locale: "zh" }))).text).toContain("5. first answer（回复 · 当前分支）");
    await handled("/tree 6", context(h));
    await handled("/tree u2b summarize focus on the parser", context(h));
    expect(h.named("navigateTree").map(call => call[2])).toEqual([
      { targetId: "u1", summarize: false },
      { targetId: "u2b", summarize: true, customInstructions: "focus on the parser" },
    ]);
    expect((await handled("/tree nope", context(h))).text).toContain("not found");
  });

  it("sets and clears labels", async () => {
    const h = harness();
    expect((await handled("/tree label 4 good start", context(h))).text).toBe("Label set: good start");
    expect((await handled("/tree label u2b", context(h))).text).toBe("Label removed.");
    expect(h.named("setLabel").map(call => call[2])).toEqual([{ entryId: "u2", label: "good start" }, { entryId: "u2b", label: null }]);
  });

  it("reports a cancelled navigation and an empty tree", async () => {
    const h = harness();
    h.navigate = { cancelled: true, leafId: "a2" };
    expect((await handled("/tree 6", context(h))).text).toContain("Navigation was cancelled");
    h.tree = { nodes: [], leafId: null };
    expect((await handled("/tree", context(h))).text).toContain("no entries");
  });

  it("keeps an empty filter result empty, as Pi does, and still takes an exact id", async () => {
    const h = harness();
    h.tree = { leafId: "c1", nodes: [{ id: "c1", parentId: null, type: "model_change", preview: "", childIds: [] }, { id: "c0", parentId: null, type: "thinking_level_change", preview: "high", childIds: [] }] };
    const { ask, asked } = cards([]);
    expect((await handled("/tree", context(h, { ask }))).text).toContain('No entries match Pi\'s tree filter "default"');
    expect(asked).toHaveLength(0);
    expect((await handled("/tree c1", context(h))).text).toBe("Already at this point.");
    await handled("/tree c0", context(h));
    expect(h.named("navigateTree").map(call => call[2])).toEqual([{ targetId: "c0", summarize: false }]);
    // labeled-only with no labels lists nothing either (root review).
    const plain = harness();
    for (const entry of plain.tree.nodes) delete entry.label;
    const settings = async () => ({ treeFilterMode: "labeled-only", branchSummary: { skipPrompt: true } });
    const listed = (await handled("/tree", context(plain, { readNativeSettings: settings }))).text;
    expect(listed).not.toContain("first question");
    await handled("/tree a1", context(plain, { readNativeSettings: settings }));
    expect(plain.named("navigateTree").at(-1)![2]).toEqual({ targetId: "a1", summarize: false });
  });

  it("navigates to a reply and to any entry by its exact id, listed or not", async () => {
    const h = harness();
    h.tree.nodes.push({ id: "m1", parentId: "a2b", type: "model_change", preview: "fakeprov/plain-model", childIds: [] });
    h.tree.nodes.find(node => node.id === "a2b")!.childIds.push("m1");
    await handled("/tree 5", context(h));
    await handled("/tree a1", context(h));
    // Hidden from the default list as bookkeeping, still a point Pi can move to.
    await handled("/tree m1", context(h));
    expect(h.named("navigateTree").map(call => call[2])).toEqual([
      { targetId: "a1", summarize: false }, { targetId: "a1", summarize: false }, { targetId: "m1", summarize: false },
    ]);
    expect((await handled("/tree label a1 answer kept", context(h))).text).toBe("Label set: answer kept");
  });

  it("hides a reply that only called tools unless it is the current position, and keeps a failed one", async () => {
    const h = harness();
    h.tree = { leafId: "a3", nodes: [
      node("u1", null, "user", "run it", ["t1"]),
      node("t1", "u1", "assistant", "", ["r1"]),
      node("r1", "t1", "toolResult", "done", ["e1"]),
      node("e1", "r1", "assistant", "[error] 429 rate limited", ["a3"]),
      node("a3", "e1", "assistant", "", []),
      { id: "use1", parentId: null, type: "usage", preview: "", childIds: [] },
    ] };
    const listed = (await handled("/tree", context(h))).text;
    expect(listed).not.toMatch(/\bt1\b|use1/);
    expect(listed).toContain("[error] 429 rate limited");
    expect(listed).toContain("1. message (reply · current position)");
    expect(listed).toContain("tool result");
    expect((await handled("/tree use1", context(h))).text).toContain("not found");
  });

  it.each([
    ["user-only", ["u2b", "u2", "u1"]],
    ["labeled-only", ["u2b"]],
    ["no-tools", ["a2b", "u2b", "a2", "u2", "a1", "u1"]],
    ["nonsense", ["a2b", "u2b", "a2", "u2", "a1", "u1"]],
  ])("follows Pi's treeFilterMode %s", async (mode, expected) => {
    const h = harness();
    const { ask, asked } = cards([{ cancelled: true }]);
    await handled("/tree", context(h, { ask, readNativeSettings: async () => ({ treeFilterMode: mode }) }));
    expect(asked[0].options.map(option => option.value)).toEqual(expected);
  });

  it("skips the summary question when Pi's branchSummary.skipPrompt is on, and uses defaults when settings cannot be read", async () => {
    const h = harness();
    const quiet = cards([{ value: "u1" }]);
    await handled("/tree", context(h, { ask: quiet.ask, readNativeSettings: async () => ({ branchSummary: { skipPrompt: true } }) }));
    expect(quiet.asked).toHaveLength(1);
    expect(h.named("navigateTree").at(-1)![2]).toEqual({ targetId: "u1", summarize: false });
    const failing = cards([{ value: "u1" }, { value: "yes" }]);
    await handled("/tree", context(h, { ask: failing.ask, readNativeSettings: async () => { throw new Error("bridge gone"); } }));
    expect(failing.asked).toHaveLength(2);
    expect(h.named("navigateTree").at(-1)![2]).toEqual({ targetId: "u1", summarize: true });
  });
});

describe("Pi native commands: /settings", () => {
  it("changes a global setting only after an explicit confirmation", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "steering" }, { value: "all" }, { value: "yes" }]);
    const reply = await handled("/settings", context(h, { ask }));
    expect(asked[0].message).toContain("every Pi session on this computer, the terminal included");
    expect(asked[0].options.map(option => [option.value, option.description])).toEqual([
      ["steering", "one at a time (one-at-a-time)"], ["follow-up", "one at a time (one-at-a-time)"],
      ["auto-compaction", "on"], ["auto-retry", "not reported by Pi"],
    ]);
    expect(asked[1].options.find(option => option.value === "one-at-a-time")?.description).toBe("current");
    expect(asked[2].message).toContain("every Pi session");
    expect(h.named("setNativeGlobalSetting")).toEqual([["setNativeGlobalSetting", "sess-0001", { key: "steeringMode", value: "all" }]]);
    expect(reply.text).toContain("global Pi setting");
  });

  it.each([[{ value: "no" }], [{ cancelled: true as const }]])("keeps the value when the confirmation is %j", async answer => {
    const h = harness();
    const { ask } = cards([{ value: "auto-retry" }, { value: "off" }, answer]);
    expect((await handled("/settings", context(h, { ask }))).text).toBe("Cancelled. Nothing was changed.");
    expect(h.named("setNativeGlobalSetting")).toEqual([]);
  });

  it("requires the word confirm in the text form", async () => {
    const h = harness();
    const pending = await handled("/settings auto-compaction off", context(h));
    expect(pending.text).toContain("`/settings auto-compaction off confirm`");
    expect(h.named("setNativeGlobalSetting")).toEqual([]);
    await handled("/settings AUTO-COMPACTION OFF CONFIRM", context(h));
    await handled("/settings follow-up all confirm", context(h));
    expect(h.named("setNativeGlobalSetting").map(call => call[2])).toEqual([{ key: "autoCompaction", value: false }, { key: "followUpMode", value: "all" }]);
  });

  it("asks only for confirmation when the text form arrives on a card surface", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "yes" }]);
    await handled("/settings auto-retry on", context(h, { ask }));
    expect(asked).toHaveLength(1);
    expect(h.named("setNativeGlobalSetting")[0][2]).toEqual({ key: "autoRetry", value: true });
  });

  it("lists the settings and rejects unknown names", async () => {
    const h = harness();
    const listing = (await handled("/settings", context(h))).text;
    expect(listing).toContain("- steering (Steering mode): one at a time (one-at-a-time)");
    expect((await handled("/settings", context(h, { locale: "zh" }))).text).toContain("- auto-retry（自动重试）：Pi 未报告");
    expect(listing).toContain("settings.json");
    expect((await handled("/settings theme dark", context(h))).text).toContain("steering one-at-a-time|all");
    expect(h.named("setNativeGlobalSetting")).toEqual([]);
  });
});

describe("Pi native commands: shell lines", () => {
  it("runs ! and !! directly in bypass mode", async () => {
    const h = harness();
    const plain = await handled("!  ls -la ", context(h));
    const excluded = await handled("!!echo secret", context(h));
    expect(h.named("runUserBash").map(call => call[2])).toEqual([
      { command: "ls -la", excludeFromContext: false },
      { command: "echo secret", excludeFromContext: true },
    ]);
    expect(plain.text).toBe("`ls -la`\nExit code 0.\n```\nhello\n```");
    expect(excluded.text).toContain("kept out of the model's context");
  });

  it("refuses in normal mode when it cannot ask", async () => {
    const h = harness();
    expect((await handled("!rm -rf build", context(h, { approvalMode: "normal" }))).text).toContain("Nothing was run");
    expect(h.named("runUserBash")).toEqual([]);
  });

  it("asks first in normal mode", async () => {
    const h = harness();
    const seen: string[] = [];
    const deny = context(h, { approvalMode: "normal", approveBash: async command => { seen.push(command); return false; } });
    expect((await handled("!make test", deny)).text).toBe("Not approved. Nothing was run.");
    expect(h.named("runUserBash")).toEqual([]);
    const allow = context(h, { approvalMode: "normal", approveBash: async command => { seen.push(command); return true; } });
    await handled("!!make test", allow);
    expect(seen).toEqual(["make test", "make test"]);
    expect(h.named("runUserBash")).toHaveLength(1);
  });

  it("bounds long output, keeps the tail and names the full log", async () => {
    const h = harness();
    h.bash = { output: `${"a".repeat(6_000)}TAIL`, exitCode: 3, cancelled: false, truncated: true, fullOutputPath: "/tmp/pi-bash-abc.log" };
    const reply = await handled("!long", context(h));
    expect(reply.text.length).toBeLessThan(4_600);
    expect(reply.text).toContain("TAIL\n```");
    expect(reply.text).toContain("Exit code 3.");
    expect(reply.text).toContain("Earlier output is omitted");
    expect(reply.text).toContain("/tmp/pi-bash-abc.log");
  });

  it("fences output that contains backticks and reports cancellation", async () => {
    const h = harness();
    h.bash = { output: "```js\ncode\n```", exitCode: null, cancelled: true, truncated: false };
    const reply = await handled("!cat x.md", context(h));
    expect(reply.text).toContain("````\n```js\ncode\n```\n````");
    expect(reply.text).toContain("The command was cancelled.");
    h.bash = { output: "", exitCode: 0, cancelled: false, truncated: false };
    expect((await handled("!true", context(h))).text).toContain("(no output)");
  });
});

describe("Pi native commands: failures and cancellation", () => {
  it("explains a busy session and a missing bridge", async () => {
    const h = harness();
    h.fail.navigateTree = new PiNativeBusyError("tree navigation");
    expect((await handled("/tree 6", context(h))).text).toBe("The session is busy. /tree needs it idle; send it again when the current reply has finished.");
    h.fail.reload = new PiNativeBridgeUnavailableError("reload");
    expect((await handled("/reload", context(h))).text).toBe("The TaroBird bridge is not connected for this session, so /reload cannot run.");
    h.fail.runUserBash = new PiNativeBusyError("bash");
    expect((await handled("!ls", context(h))).text).toContain("The session is busy. ! needs it idle");
  });

  it("maps rejection reasons", async () => {
    const h = harness();
    h.fail.fork = new PiNativeRejectedError("Invalid entry ID for forking", "not-found");
    expect((await handled("/fork 1", context(h))).text).toBe("That entry was not found in this session.");
    h.fail.setSessionName = new PiNativeRejectedError("bad", "invalid", ["a", "b"]);
    expect((await handled("/name x", context(h))).text).toBe("That value was not accepted. Allowed: a, b.");
  });

  it("gives a short failure line without local paths", async () => {
    const h = harness();
    h.fail.compact = new Error("Nothing to compact (session too small)");
    expect((await handled("/compact", context(h))).text).toBe("/compact failed. Nothing to compact (session too small)");
    h.fail.exportHtml = new Error("ENOENT: no such file or directory, open '/opt/data/private/out.html'\n    at stack (/opt/app/file.js:1:1)");
    const reply = await handled("/export", context(h, { outputDir: OUT }));
    expect(reply.text.startsWith("/export failed.")).toBe(true);
    expect(reply.text).not.toMatch(/\/opt\/|private|at stack|file\.js/);
    expect(reply.text.length).toBeLessThan(240);
    h.fail.getStats = "not an error object";
    expect((await handled("/session", context(h, { locale: "zh" }))).text).toBe("/session 没有成功。");
  });

  it("does nothing once aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect((await handled("/clone", context(h, { abortSignal: controller.signal }))).text).toBe("Cancelled. Nothing was changed.");
    expect(h.calls).toEqual([]);
  });

  it("stops when the abort arrives while a card is open", async () => {
    const h = harness();
    const controller = new AbortController();
    const ask = async (): Promise<PiCommandAnswer> => { controller.abort(); return { value: "beta/dup-model" }; };
    expect((await handled("/model dup-model", context(h, { ask, abortSignal: controller.signal }))).text).toBe("Cancelled. Nothing was changed.");
    expect(h.named("setModel")).toEqual([]);
  });

  it("changes nothing when a single-choice card is answered with several values", async () => {
    const h = harness();
    expect((await handled("/thinking", context(h, { ask: cards([{ values: ["low", "high"] }]).ask }))).text).toBe("Cancelled. Nothing was changed.");
    expect((await handled("/model dup-model", context(h, { ask: cards([{ values: ["alpha/dup-model", "beta/dup-model"] }]).ask }))).text).toBe("Cancelled. Nothing was changed.");
    expect((await handled("/thinking", context(h, { ask: cards([{ values: ["low"] }]).ask }))).text).toContain("Thinking level: low");
    expect(h.named("setModel")).toEqual([]);
    expect(h.named("setThinkingLevel").map(call => call[2])).toEqual(["low"]);
  });

  it("reports a failing card surface as a failure", async () => {
    const h = harness();
    const ask = async (): Promise<PiCommandAnswer> => { throw new Error("card surface closed"); };
    expect((await handled("/thinking", context(h, { ask }))).text).toBe("/thinking failed. card surface closed");
  });

  it("declines terminal-only commands with what to do instead", async () => {
    const h = harness();
    expect((await handled("/login alpha", context(h))).text).toContain("`pi auth login alpha`");
    expect((await handled("/login $(whoami)", context(h))).text).toContain("`pi auth login <provider>`");
    expect((await handled("/logout", context(h))).text).toContain("pi auth logout <provider>");
    expect((await handled("/share", context(h))).text).toContain("Nothing was uploaded");
    expect((await handled("/bug it crashed", context(h))).text).toContain("Nothing was uploaded");
    expect((await handled("/hotkeys", context(h))).text).toContain("do not apply here");
    expect((await handled("/changelog", context(h))).text).toContain("/changelog");
    expect((await handled("/debug", context(h))).text).toContain("only works in Pi's terminal interface");
    expect((await handled("/resume", context(h))).text).toContain("session list");
    expect((await handled("/quit", context(h))).text).toContain("nothing to quit");
    expect((await handled("/登录", context(h, { locale: "zh" })).catch(() => ({ text: "not a built-in" }))).text).toBe("not a built-in");
    expect(h.calls).toEqual([]);
  });
});

describe("Pi native commands: JSONL /export", () => {
  it("writes the native session file into the output directory and reports the entry count", async () => {
    const h = harness();
    const reply = await handled("/export notes.jsonl", context(h, { outputDir: OUT }));
    expect(h.named("exportJsonl")).toEqual([["exportJsonl", "sess-0001", { outputPath: path.join(OUT, "notes.jsonl") }]]);
    expect(h.named("exportHtml")).toEqual([]);
    expect(reply.text).toBe("Session exported to notes.jsonl: 42 entries of the current branch, in Pi's own session format. The file is delivered in this conversation.");
    expect((await handled("/export notes.jsonl", context(h, { outputDir: OUT, locale: "zh" }))).text).toContain("notes.jsonl：当前分支的 42 个条目");
  });

  it.each([
    ["../../etc/x.jsonl", "x.jsonl"], ["/var/data/y.JSONL", "y.jsonl"], ["sub/dir/z.jsonl", "z.jsonl"], ["..\\..\\w.jsonl", "w.jsonl"],
    ['"/var/data/my notes.jsonl"', "my-notes.jsonl"],
  ])("contains the JSONL path %j inside the output directory", async (argument, file) => {
    const h = harness();
    const reply = await handled(`/export ${argument}`, context(h, { outputDir: OUT }));
    const written = (h.named("exportJsonl")[0][2] as { outputPath: string }).outputPath;
    expect(path.dirname(written)).toBe(OUT);
    expect(written).toBe(path.join(OUT, file));
    expect(reply.text).toContain("requested location was not used");
    expect(reply.text).not.toContain(OUT);
  });

  it("generates a name when only the extension is given", async () => {
    const h = harness();
    const reply = await handled("/export .jsonl", context(h, { outputDir: OUT }));
    expect((h.named("exportJsonl")[0][2] as { outputPath: string }).outputPath).toBe(path.join(OUT, "pi-session-sess-0001.jsonl"));
    expect(reply.text).not.toContain("requested location");
  });

  it("writes nothing when there is no output directory to deliver from", async () => {
    const h = harness();
    expect((await handled("/export /var/data/y.jsonl", context(h))).text).toContain("Nothing was written");
    expect((await handled("/export y.jsonl", context(h, { locale: "zh" }))).text).toContain("没有写入任何文件");
    expect(mutations(h)).toEqual([]);
  });
});

describe("Pi native commands: /trust", () => {
  it("does nothing when the workspace has no project-local Pi files", async () => {
    const h = harness();
    expect((await handled("/trust", context(h))).text).toContain("no project-local Pi files");
    expect((await handled("/trust yes", context(h, { ask: cards([]).ask }))).text).toContain("nothing to decide");
    expect((await handled("/trust", context(h, { locale: "zh" }))).text).toContain("没有项目级 Pi 文件");
    expect(h.named("setProjectTrust")).toEqual([]);
  });

  it("shows the state and what the answer means, then records it", async () => {
    const h = harness();
    h.trust = { hasProjectFiles: true, loaded: false };
    const { ask, asked } = cards([{ value: "yes" }]);
    const reply = await handled("/trust", context(h, { ask }));
    expect(asked[0].options.map(option => option.label)).toEqual(["Trust and load", "Do not load"]);
    for (const part of ["applies to this workspace for this Bot only", "Pi's own trust list, which the terminal uses, is not changed",
      "Extensions and MCP servers in the project run code on this computer", "No answer is recorded yet.", "has not loaded them"]) {
      expect(asked[0].message).toContain(part);
    }
    expect(h.named("setProjectTrust")).toEqual([["setProjectTrust", "sess-0001", "yes"]]);
    expect(reply.text).toBe("Project files are now trusted for this workspace and this Bot. Pi has loaded them. Pi's own trust list is unchanged.");
  });

  it("records a refusal and marks the recorded answer on the next card", async () => {
    const h = harness();
    h.trust = { hasProjectFiles: true, decision: "yes", loaded: true };
    const { ask, asked } = cards([{ value: "no" }]);
    const reply = await handled("/trust", context(h, { ask, locale: "zh" }));
    expect(asked[0].options).toEqual([{ label: "信任并加载", value: "yes", description: "当前" }, { label: "不加载", value: "no" }]);
    expect(asked[0].message).toContain("只对这个 Bot 的这个工作区生效");
    expect(asked[0].message).toContain("终端使用的那份");
    expect(asked[0].message).toContain("在这台电脑上执行代码");
    expect(h.named("setProjectTrust")[0][2]).toBe("no");
    expect(reply.text).toContain("不会被加载");
  });

  it("supports the text form and rejects other words", async () => {
    const h = harness();
    h.trust = { hasProjectFiles: true };
    const listing = (await handled("/trust", context(h))).text;
    expect(listing).toContain("`/trust yes`");
    expect(listing).toContain("this Bot only");
    expect((await handled("/trust maybe", context(h))).text).toBe("Use `/trust yes` or `/trust no`. Nothing was changed.");
    expect(h.named("setProjectTrust")).toEqual([]);
    await handled("/trust YES", context(h));
    await handled("/trust no", context(h));
    expect(h.named("setProjectTrust").map(call => call[2])).toEqual(["yes", "no"]);
  });

  it("changes nothing when the answer is already in effect, and applies one that is not loaded yet", async () => {
    const h = harness();
    h.trust = { hasProjectFiles: true, decision: "yes", loaded: true };
    expect((await handled("/trust yes", context(h))).text).toContain("already trusted and loaded");
    h.trust = { hasProjectFiles: true, decision: "no", loaded: false };
    expect((await handled("/trust no", context(h))).text).toContain("already left out");
    expect(h.named("setProjectTrust")).toEqual([]);
    h.trust = { hasProjectFiles: true, decision: "yes", loaded: false };
    await handled("/trust yes", context(h));
    expect(h.named("setProjectTrust")).toHaveLength(1);
  });

  it("changes nothing on cancel, on an unknown choice, or while the session is busy", async () => {
    const h = harness();
    h.trust = { hasProjectFiles: true };
    expect((await handled("/trust", context(h, { ask: cards([{ cancelled: true }]).ask }))).text).toBe("Cancelled. Nothing was changed.");
    expect((await handled("/trust", context(h, { ask: cards([{ value: "always" }]).ask }))).text).toContain("not in the list");
    expect(h.named("setProjectTrust")).toEqual([]);
    h.fail.setProjectTrust = new PiNativeBusyError("project trust");
    expect((await handled("/trust yes", context(h))).text).toContain("The session is busy. /trust needs it idle");
  });
});

describe("Pi native commands: /import", () => {
  const SOURCE = "/data/exports/old-session.jsonl";

  it("needs a path", async () => {
    const h = harness();
    expect((await handled("/import", context(h))).text).toContain("/import <path>");
    expect((await handled('/import "unterminated', context(h))).text).toContain("/import <path>");
    expect((await handled("/import", context(h, { locale: "zh" }))).text).toContain("/import <路径>");
    expect(h.calls).toEqual([]);
  });

  it("refuses a file that is not a Pi session", async () => {
    const h = harness();
    h.importInfo = undefined;
    const reply = await handled(`/import ${SOURCE}`, context(h, { ask: cards([]).ask }));
    expect(reply.text).toBe("old-session.jsonl is not a Pi session file. Nothing was imported.");
    expect(h.named("inspectImport")).toEqual([["inspectImport", "sess-0001", { path: SOURCE }]]);
    expect(h.named("importSession")).toEqual([]);
  });

  it("refuses a session recorded in another working directory and says why", async () => {
    const h = harness();
    h.importInfo = { sessionId: "sess-0100", sameWorkspace: false, alreadyPresent: false };
    const reply = await handled(`/import ${SOURCE}`, context(h, { ask: cards([]).ask }));
    expect(reply.text).toContain("recorded in a different working directory");
    expect(reply.text).toContain("which is not this Bot's workspace");
    expect((await handled(`/import ${SOURCE}`, context(h, { locale: "zh" }))).text).toContain("不是这个 Bot 的工作区");
    expect(h.named("importSession")).toEqual([]);
  });

  it("points to the session list when the session is already here", async () => {
    const h = harness();
    h.importInfo = { sessionId: "sess-0100", sameWorkspace: true, alreadyPresent: true };
    const reply = await handled(`/import ${SOURCE}`, context(h, { ask: cards([]).ask }));
    expect(reply.text).toBe("old-session.jsonl is already among this Bot's sessions. Open it from the session list with /resume.");
    expect(h.named("importSession")).toEqual([]);
  });

  it("does not import without a confirmation card", async () => {
    const h = harness();
    expect((await handled(`/import ${SOURCE}`, context(h))).text).toContain("needs a confirmation card");
    expect((await handled(`/import ${SOURCE}`, context(h, { locale: "zh" }))).text).toContain("需要一张确认卡片");
    expect(h.named("importSession")).toEqual([]);
  });

  it.each([[{ cancelled: true as const }], [{ value: "no" }], [{ text: "yes" }]])("keeps the current session when the confirmation is %j", async answer => {
    const h = harness();
    const reply = await handled(`/import ${SOURCE}`, context(h, { ask: cards([answer]).ask }));
    expect(reply.text).toBe("Cancelled. Nothing was changed.");
    expect(reply.sessionId).toBeUndefined();
    expect(h.named("importSession")).toEqual([]);
  });

  it("imports after confirmation and returns the session the conversation continues in", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "yes" }]);
    const reply = await handled('/import "/data/exports/old session.jsonl" extra', context(h, { ask }));
    expect(asked).toHaveLength(1);
    for (const part of ["old session.jsonl", '("old work")', "The current session stays available to resume", "copied on this computer; nothing is uploaded"]) {
      expect(asked[0].message).toContain(part);
    }
    expect(asked[0].options.map(option => option.value)).toEqual(["yes", "no"]);
    expect(h.named("importSession")).toEqual([["importSession", "sess-0001", { path: "/data/exports/old session.jsonl" }]]);
    expect(reply.sessionId).toBe("sess-0100");
    expect(reply.text).toContain("Imported old session.jsonl");
    expect(`${asked[0].message}${reply.text}`).not.toContain("/data/exports");
  });

  it("uses the confirmation copy of the locale", async () => {
    const h = harness();
    const { ask, asked } = cards([{ value: "yes" }]);
    const reply = await handled(`/import ${SOURCE}`, context(h, { ask, locale: "zh" }));
    expect(asked[0].message).toContain("当前会话仍然可以恢复");
    expect(asked[0].message).toContain("不会上传任何内容");
    expect(reply.text).toContain("已导入 old-session.jsonl");
    expect(reply.sessionId).toBe("sess-0100");
  });

  it("keeps the binding when Pi cancels the import", async () => {
    const h = harness();
    h.imported = { sessionId: "sess-0001", cancelled: true };
    const reply = await handled(`/import ${SOURCE}`, context(h, { ask: cards([{ value: "yes" }]).ask }));
    expect(reply.sessionId).toBeUndefined();
    expect(reply.text).toContain("import was cancelled");
  });

  it("reports a missing file by name and a busy session", async () => {
    const h = harness();
    h.fail.inspectImport = new PiNativeRejectedError("ENOENT", "not-found");
    const missing = await handled(`/import ${SOURCE}`, context(h, { ask: cards([]).ask }));
    expect(missing.text).toBe("old-session.jsonl was not found or cannot be read. Nothing was imported.");
    delete h.fail.inspectImport;
    h.fail.importSession = new PiNativeBusyError("import");
    expect((await handled(`/import ${SOURCE}`, context(h, { ask: cards([{ value: "yes" }]).ask }))).text).toContain("The session is busy. /import needs it idle");
  });
});

describe("Pi native commands: /scoped-models", () => {
  it("shows the Bot scope, the global list read-only, and what a scope does", async () => {
    const h = harness();
    h.scope = { scope: [], nativePatterns: ["alpha/*", "sonnet"] };
    const text = (await handled("/scoped-models", context(h))).text;
    for (const part of ["This Bot has no model scope.", "Your global Pi list (enabledModels) is alpha/*, sonnet.",
      "changed in a Pi terminal with /scoped-models because it affects every Pi session", "listed first in /model",
      "otherwise on the first scoped model", "Sessions that already exist keep their model", "`/scoped-models clear`"]) {
      expect(text).toContain(part);
    }
    h.scope = { scope: [{ provider: "beta", modelId: "dup-model" }], nativePatterns: [] };
    const scoped = (await handled("/scoped-models", context(h))).text;
    expect(scoped).toContain("This Bot's scope: beta/dup-model.");
    expect(scoped).toContain("Your global Pi list (enabledModels) is not set.");
    expect((await handled("/scoped-models", context(h, { locale: "zh" }))).text).toContain("这个 Bot 的模型范围：beta/dup-model。");
    expect(h.named("setModelScope")).toEqual([]);
  });

  it("sets the scope from a multi-select card", async () => {
    const h = harness();
    h.scope = { scope: [{ provider: "beta", modelId: "dup-model" }], nativePatterns: [] };
    const { ask, asked } = cards([{ values: ["alpha/plain-model", "router/vendor/claude-x", "alpha/plain-model"] }]);
    const reply = await handled("/scoped-models", context(h, { ask }));
    expect(asked[0].multiple).toBe(true);
    expect(asked[0].options.map(option => option.value)).toEqual(["alpha/dup-model", "alpha/plain-model", "beta/dup-model", "router/vendor/claude-x"]);
    expect(asked[0].options[2].description).toBe("Dup Model · in scope");
    expect(asked[0].message).toContain("Your selection replaces the current scope");
    expect(h.named("setModelScope")).toEqual([["setModelScope", "sess-0001", [
      { provider: "alpha", modelId: "plain-model" }, { provider: "router", modelId: "vendor/claude-x" },
    ]]]);
    expect(reply.text).toContain("This Bot's scope is now alpha/plain-model, router/vendor/claude-x.");
    expect(reply.text).toContain("listed first in /model");
  });

  it("accepts a single value from a surface that cannot multi-select", async () => {
    const h = harness();
    await handled("/scoped-models", context(h, { ask: cards([{ value: "beta/dup-model" }]).ask }));
    expect(h.named("setModelScope")[0][2]).toEqual([{ provider: "beta", modelId: "dup-model" }]);
  });

  it.each([
    [{ values: [] as string[] }, "Nothing was selected"], [{ cancelled: true as const }, "Cancelled."],
    [{ values: ["alpha/plain-model", "gamma/unknown"] }, "not in the list"],
  ])("leaves the scope alone for the answer %j", async (answer, expected) => {
    const h = harness();
    expect((await handled("/scoped-models", context(h, { ask: cards([answer]).ask }))).text).toContain(expected);
    expect(h.named("setModelScope")).toEqual([]);
  });

  it("sets the scope from text, resolving each reference as /model does", async () => {
    const h = harness();
    const reply = await handled("/scoped-models alpha/plain-model, router/vendor/claude-x ,claude x", context(h));
    expect(h.named("setModelScope")[0][2]).toEqual([{ provider: "alpha", modelId: "plain-model" }, { provider: "router", modelId: "vendor/claude-x" }]);
    expect(reply.text).toContain("alpha/plain-model, router/vendor/claude-x");
    expect((await handled("/scoped-models plain mod", context(h, { locale: "zh" }))).text).toContain("模型范围已设为 alpha/plain-model");
  });

  it("names unknown and ambiguous references and changes nothing", async () => {
    const h = harness();
    const reply = await handled("/scoped-models nope, dup-model, alpha/plain-model", context(h));
    expect(reply.text).toBe('No available model matches "nope". More than one model matches "dup-model"; write each as provider/id. Nothing was changed.');
    expect((await handled("/scoped-models ,", context(h))).text).toBe("Nothing was changed.");
    expect(h.named("setModelScope")).toEqual([]);
  });

  it("clears the Bot scope, and says which list applies afterwards", async () => {
    const h = harness();
    expect((await handled("/scoped-models clear", context(h))).text).toBe("This Bot has no model scope to clear. Nothing was changed.");
    expect(h.named("setModelScope")).toEqual([]);
    h.scope = { scope: [{ provider: "beta", modelId: "dup-model" }], nativePatterns: ["alpha/*"] };
    expect((await handled("/scoped-models CLEAR", context(h))).text).toBe("This Bot's scope is cleared. Your global Pi list applies again.");
    expect(h.named("setModelScope")).toEqual([["setModelScope", "sess-0001", null]]);
    h.scope = { scope: [{ provider: "beta", modelId: "dup-model" }], nativePatterns: [] };
    expect((await handled("/scoped-models clear", context(h))).text).toContain("Every available model is offered as before.");
  });

  it("pages provider by provider when there are too many models for one card", async () => {
    const h = harness();
    h.models = [
      ...Array.from({ length: 40 }, (_, index) => ({ provider: "alpha", id: `m-${index}` })),
      ...Array.from({ length: 5 }, (_, index) => ({ provider: "beta", id: `b-${index}` })),
    ];
    const { ask, asked } = cards([
      { value: "provider:alpha" }, { values: ["alpha/m-1", "alpha/m-2"] },
      { value: "provider:beta" }, { values: ["beta/b-0"] },
      question => ({ value: question.options[0].value }),
    ]);
    const reply = await handled("/scoped-models", context(h, { ask }));
    expect(asked[0].options.map(option => option.label)).toEqual(["alpha", "beta"]);
    expect(asked[0].multiple).toBeUndefined();
    expect(asked[1].multiple).toBe(true);
    expect(asked[1].options).toHaveLength(PI_COMMAND_CARD_LIMIT);
    expect(asked[1].text?.placeholder).toBeTruthy();
    expect(asked[2].options.map(option => [option.label, option.description])).toEqual([
      ["Save the 2 selected models", undefined], ["alpha", "40 models · 2 selected"], ["beta", "5 models"],
    ]);
    expect(asked[3].options).toHaveLength(5);
    expect(asked[4].options[0]).toEqual({ label: "Save the 3 selected models", value: "save-scope" });
    expect(asked[4].options.slice(1).map(option => option.value)).toEqual(["provider:alpha", "provider:beta"]);
    expect(h.named("setModelScope")[0][2]).toEqual([
      { provider: "alpha", modelId: "m-1" }, { provider: "alpha", modelId: "m-2" }, { provider: "beta", modelId: "b-0" },
    ]);
    expect(reply.text).toContain("alpha/m-1, alpha/m-2, beta/b-0");
  });

  it("saves nothing when a paged selection is cancelled", async () => {
    const h = harness();
    h.models = Array.from({ length: 45 }, (_, index) => ({ provider: index < 40 ? "alpha" : "beta", id: `m-${index}` }));
    const { ask } = cards([{ value: "provider:alpha" }, { values: ["alpha/m-1"] }, { cancelled: true }]);
    expect((await handled("/scoped-models", context(h, { ask }))).text).toBe("Cancelled. Nothing was changed.");
    expect(h.named("setModelScope")).toEqual([]);
  });

  it("explains a busy session and an empty catalog", async () => {
    const h = harness();
    h.fail.setModelScope = new PiNativeBusyError("model scope");
    expect((await handled("/scoped-models alpha/plain-model", context(h))).text).toContain("The session is busy. /scoped-models needs it idle");
    h.models = [];
    expect((await handled("/scoped-models", context(h, { ask: cards([]).ask }))).text).toContain("pi auth login");
  });
});

describe("Pi native commands: /model with a Bot scope", () => {
  const scoped = (h: Harness) => { h.scope = { scope: [{ provider: "beta", modelId: "dup-model" }, { provider: "gone", modelId: "removed" }], nativePatterns: [] }; };

  it("lists the scoped models first and marks them", async () => {
    const h = harness();
    scoped(h);
    const lines = (await handled("/model", context(h))).text.split("\n");
    expect(lines[1]).toBe("- beta/dup-model — Dup Model (in scope)");
    expect(lines[2]).toBe("- alpha/dup-model — Dup Model (current)");
    expect((await handled("/model", context(h, { locale: "zh" }))).text).toContain("- beta/dup-model — Dup Model（范围内）");
    expect((await handled("/model", context(h, { locale: "zh-CN" }))).text).toContain("- beta/dup-model — Dup Model（范围内）");
    expect((await handled("/model", context(h, { locale: "ja-JP" }))).text).toContain("- beta/dup-model — Dup Model（スコープ内）");
  });

  it("offers the scope first, with a way to every model", async () => {
    const h = harness();
    scoped(h);
    const first = cards([{ value: "beta/dup-model" }]);
    await handled("/model", context(h, { ask: first.ask }));
    expect(first.asked[0].options.map(option => option.label)).toEqual(["beta/dup-model", "All models"]);
    expect(first.asked[0].options.map(option => option.value)).toEqual(["beta/dup-model", "all-models"]);
    expect(first.asked[0].options[0].description).toBe("Dup Model · in scope");
    expect(h.named("setModel")[0][2]).toEqual({ provider: "beta", modelId: "dup-model" });

    const all = cards([question => ({ value: question.options.at(-1)!.value }), { value: "alpha" }, { value: "alpha/plain-model" }]);
    await handled("/model", context(h, { ask: all.ask }));
    expect(all.asked[1].options.map(option => option.value)).toEqual(["beta", "alpha", "router"]);
    expect(h.named("setModel")[1][2]).toEqual({ provider: "alpha", modelId: "plain-model" });
  });

  it("orders candidates scoped first", async () => {
    const h = harness();
    scoped(h);
    const { ask, asked } = cards([{ cancelled: true }]);
    await handled("/model dup-model", context(h, { ask }));
    expect(asked[0].options.map(option => option.label)).toEqual(["beta/dup-model", "alpha/dup-model"]);
  });

  it("still works when the scope cannot be read", async () => {
    const h = harness();
    h.fail.getModelScope = new Error("scope store unavailable");
    expect((await handled("/model alpha/plain-model", context(h))).text).toContain("alpha/plain-model");
  });
});

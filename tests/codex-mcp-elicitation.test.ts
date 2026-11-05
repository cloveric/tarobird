import { describe, expect, it } from "vitest";
import { normalizeCodexMcpElicitation } from "../src/codex/codex-mcp-elicitation.js";

const request = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ mode: "form", serverName: "acceptance", threadId: "thread-1", turnId: "turn-1", message: "Fill the form", requestedSchema: { type: "object", properties, required } });
const answer = (form: NonNullable<ReturnType<typeof normalizeCodexMcpElicitation>>, values: string[]) => form.response({ behavior: "allow", updatedInput: { answers: Object.fromEntries(form.toolInput.questions.map((q, i) => [q.question, values[i] ?? ""])) } });

describe("Codex MCP form elicitation", () => {
  it("requires explicit one-time confirmation for empty forms", () => {
    const form = normalizeCodexMcpElicitation(request({}))!;
    expect(form.toolInput.questions[0]!.allowFreeText).toBe(false);
    expect(form.response({ behavior: "allow" })).toEqual({ action: "decline" });
    expect(answer(form, ["拒绝"])).toEqual({ action: "decline" });
    expect(answer(form, ["允许本次"])).toEqual({ action: "accept", content: {} });
    expect(form.response({ behavior: "deny" })).toEqual({ action: "cancel" });
    expect(normalizeCodexMcpElicitation(request({}, ["missing"]))).toBeUndefined();
  });
  it("returns typed server values, honoring required fields and native labels", () => {
    const form = normalizeCodexMcpElicitation(request({
      color: { type: "string", oneOf: [{ const: "blue", title: "蓝色" }, { const: "green", title: "绿色" }] },
      count: { type: "integer", minimum: 1, maximum: 4 },
      enabled: { type: "boolean" },
      memo: { type: "string", minLength: 1, maxLength: 10 },
      omitted: { type: "string" },
    }, ["color", "count", "enabled", "memo"]))!;
    expect(form.toolInput.questions.map((q) => q.allowFreeText)).toEqual([false, true, false, true, true]);
    expect(answer(form, ["蓝色", "3", "false", "Note"])).toEqual({ action: "accept", content: { color: "blue", count: 3, enabled: false, memo: "Note" } });
    expect(answer(form, ["blue", "3", "false", "Note"])).toEqual({ action: "decline" });
    expect(answer(form, ["蓝色", "", "false", "Note"])).toEqual({ action: "decline" });
    expect(form.response({ behavior: "deny" })).toEqual({ action: "cancel" });
    expect(form.response({ behavior: "allow" })).toEqual({ action: "decline" });
  });
  it.each(["5", "0", "1.5", "Infinity", "0x2", "NaN", "1e999"])("rejects invalid integer answer %s", (value) => {
    expect(answer(normalizeCodexMcpElicitation(request({ count: { type: "integer", minimum: 1, maximum: 4 } }))!, [value])).toEqual({ action: "decline" });
  });
  it("handles legacy names, duplicate titles and distinct repeated descriptions", () => {
    const form = normalizeCodexMcpElicitation(request({
      first: { type: "string", description: "Same", enum: ["a", "b"], enumNames: [" Choice ", "Choice"] },
      second: { type: "string", description: "Same" },
    }))!;
    expect(form.toolInput.questions[0]!.options).toEqual([{ label: "Choice (a)" }, { label: "Choice (b)" }]);
    expect(form.toolInput.questions[1]!.question).not.toBe(form.toolInput.questions[0]!.question);
    expect(answer(form, ["Choice (b)", "Other"])).toEqual({ action: "accept", content: { first: "b", second: "Other" } });
  });
  it("honors multi-select bounds and comma-bearing labels without guessing ambiguous selections", () => {
    const form = normalizeCodexMcpElicitation(request({ picks: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "ab", title: "A, B" }, { const: "c", title: "C" }] } } }))!;
    expect(answer(form, ["A, B, C"])).toEqual({ action: "accept", content: { picks: ["ab", "c"] } });
    expect(answer(form, ["C, C"])).toEqual({ action: "decline" });
    const ambiguous = normalizeCodexMcpElicitation(request({ picks: { type: "array", items: { type: "string", enum: ["A", "B", "A, B"] } } }))!;
    expect(answer(ambiguous, ["A, B"])).toEqual({ action: "decline" });
    expect(answer(form, ["C, "])).toEqual({ action: "decline" });
  });
  it.each([
    { type: "object", properties: {} }, { type: "string", format: "password" },
    { type: "string", pattern: ".*" }, { type: "string", enum: [] },
    { type: "string", enum: ["same", "same"] }, { type: "string", enum: ["a"], oneOf: [{ const: "b", title: "B" }] },
  ])("declines unsupported schemas without weakening their constraints", (field) => {
    expect(normalizeCodexMcpElicitation(request({ field }))).toBeUndefined();
  });
  it("cancels URL/auth and unknown formats without opening links or asking for secrets", () => {
    for (const mode of ["url", "openai/form", "openaiForm"]) expect(normalizeCodexMcpElicitation({ ...request({ color: { type: "string" } }), mode })).toBeUndefined();
    expect(normalizeCodexMcpElicitation(request({ color: { type: "string" } }, ["absent"]))).toBeUndefined();
  });
  it("validates textual limits and formats and refuses dropped required keys", () => {
    const form = normalizeCodexMcpElicitation(request({ email: { type: "string", format: "email" }, unicode: { type: "string", maxLength: 1 } }))!;
    expect(answer(form, ["test@example.com", "🌱"])).toEqual({ action: "accept", content: { email: "test@example.com", unicode: "🌱" } });
    expect(answer(form, ["invalid", "🌱"])).toEqual({ action: "decline" });
    expect(answer(form, ["test@example.com", "ab"])).toEqual({ action: "decline" });
    expect(normalizeCodexMcpElicitation(request(Object.fromEntries([["__proto__", { type: "string" }]])))).toBeUndefined();
  });
});

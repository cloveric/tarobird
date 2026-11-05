import { describe, expect, it } from "vitest";
import { normalizeCodexUserInput } from "../src/codex/codex-user-input.js";

const question = { id: "color", header: "Color", question: "Choose a color", options: [{ label: "Blue", description: "Calm" }, { label: "Green", description: "Fresh" }] };
const request = { threadId: "thread-1", turnId: "turn-1", itemId: "question-1", isBlocking: true, questions: [question] };
describe("native Codex user input", () => {
  it("keeps native answer IDs and accepts only offered choices without Other", () => {
    const form = normalizeCodexUserInput(request)!;
    expect(form.toolInput.questions[0]).toMatchObject({ allowFreeText: false, options: question.options });
    expect(form.response({ behavior: "allow", updatedInput: { answers: { [question.question]: "Blue" } } })).toEqual({ answers: { color: { answers: ["Blue"] } } });
    expect(form.response({ behavior: "allow", updatedInput: { answers: { [question.question]: "Red" } } })).toEqual({ answers: {} });
  });
  it("keeps duplicate question texts distinct and supports free answers", () => {
    const form = normalizeCodexUserInput({ ...request, questions: [question, { ...question, id: "other", isOther: true }, { ...question, id: "text", options: null }] })!;
    expect(new Set(form.toolInput.questions.map((q) => q.question)).size).toBe(3);
    expect(form.toolInput.questions.map((q) => q.allowFreeText)).toEqual([false, true, true]);
    const answers = Object.fromEntries(form.toolInput.questions.map((q, i) => [q.question, ["Blue", "Red", "One, two"][i]]));
    expect(form.response({ behavior: "allow", updatedInput: { answers } })).toEqual({ answers: { color: { answers: ["Blue"] }, other: { answers: ["Red"] }, text: { answers: ["One, two"] } } });
  });
  it.each([
    { ...request, questions: [] },
    { ...request, questions: [question, question] },
    { ...request, questions: [{ ...question, isSecret: true }] },
    { ...request, questions: [{ ...question, options: [{}] }] },
    { ...request, turnId: null },
  ])("declines unsupported or malformed requests without exposing a form", (input) => {
    expect(normalizeCodexUserInput(input)).toBeUndefined();
  });
  it("does not treat an approval or partial/malformed form as user answers", () => {
    const form = normalizeCodexUserInput(request)!;
    expect(form.response({ behavior: "deny" })).toEqual({ answers: {} });
    expect(form.response({ behavior: "allow", scope: "session" })).toEqual({ answers: {} });
    expect(form.response({ behavior: "allow", updatedInput: { answers: {} } })).toEqual({ answers: {} });
    expect(form.response({ behavior: "allow", updatedInput: { answers: { [question.question]: ["Blue"] } } })).toEqual({ answers: {} });
  });
  it("accepts native nonmodal questions without turning them into tool approvals", () => {
    expect(normalizeCodexUserInput({ ...request, isBlocking: false })!.toolInput.questions[0]).toMatchObject({ required: true, allowFreeText: false });
  });
  it("serializes reserved native IDs as ordinary data", () => {
    const form = normalizeCodexUserInput({ ...request, questions: [{ ...question, id: "__proto__" }] })!;
    const response = form.response({ behavior: "allow", updatedInput: { answers: { [question.question]: "Blue" } } });
    expect(JSON.stringify(response)).toBe('{"answers":{"__proto__":{"answers":["Blue"]}}}');
  });
});

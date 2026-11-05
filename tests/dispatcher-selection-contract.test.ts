import { expect, it } from "vitest";
import { dispatcherExecutionInstructions, dispatcherInstructions } from "../src/gateway/agent-instructions.js";

const id = "msg_97a1f169d4eb40eb948cf197d4d306d2";
const wrapped = (text: string) => `<tarobot.execution>${text}</tarobot.execution>`;

it("keeps quality and owner evidence generic, without a provider or topic table", () => {
  for (const contract of [dispatcherExecutionInstructions(id), dispatcherExecutionInstructions(id, { delegated: true })]) {
    expect(contract).toContain("quality before speed/cost");
    expect(contract).toContain("owner-reported outcome is evidence only for similar work");
    // Owner experience is evidence for the coordinator to weigh; the Host
    // contract itself never maps a topic to a provider or model family.
    expect(contract).not.toMatch(/video|视频|opus|sonnet|haiku|\bgpt|gemini|deepseek|kimi|claude|codex|antigravity/i);
    expect(wrapped(contract).length).toBeLessThan(3000);
  }
});

it("lets an unavailable preference fall back but never substitutes an owner-restricted target", () => {
  const short = dispatcherExecutionInstructions(id), full = dispatcherInstructions(id);
  expect(short).toContain("An unavailable preferred target may be replaced by a suitable one under the same ask/auto rules");
  expect(short).toContain("if the owner limited the request to it, report it unavailable instead of substituting");
  expect(short).toContain("Redispatch obeys the same confirmation, cost and owner-restriction rules");
  // The long contract must not reintroduce an unconditional fallback.
  expect(full).toContain("choose another suitable CLI unless the owner restricted the request to it");
  expect(full).toContain("obeying the same confirmation, cost and owner-restriction rules");
  expect(full).not.toMatch(/choose another suitable CLI \(/);
});

it("leaves the scheduled no-context contract unchanged by selection guidance", () => {
  const scheduled = dispatcherExecutionInstructions(undefined, { scheduled: true });
  expect(scheduled).toContain("Scheduled ticket dispatch is currently unavailable");
  expect(scheduled).not.toMatch(/quality|owner-reported|substitut/);
  expect(dispatcherInstructions(undefined, { scheduled: true })).toBe(scheduled);
});

it("requires acceptance-led selection and reassessment without mandatory model switching", () => {
  for (const delegated of [false, true]) {
    const contract = dispatcherExecutionInstructions(id, { delegated });
    expect(contract).toContain("acceptance criteria");
    expect(contract).toContain("quality before speed/cost");
    expect(contract).toContain("tickets capabilities --engine");
    expect(contract).toContain("substantive failure");
    expect(contract).toContain("same-model retry");
    expect(contract).not.toContain("Prefer a capable lightweight model");
    expect(wrapped(contract).length).toBeLessThan(3000);
  }
});

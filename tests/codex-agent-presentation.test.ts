import { describe, expect, it } from "vitest";
import type { RunEntry } from "../src/client-protocol/run.js";
import { codexAgentReports, runEntryTitle } from "../client/src/run-presentation.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";

const entry: RunEntry = { seq: 1, revision: 1, at: 1, kind: "tool", name: "CodexAgent", status: "done" };
describe("readable public Codex collaboration", () => {
  it("uses a readable action title while retaining identities in raw parameters", () => {
    expect(runEntryTitle({ ...entry, input: JSON.stringify({ action: "wait", description: "wait · child-1" }) })).toBe("等待子代理");
    expect(runEntryTitle({ ...entry, input: JSON.stringify({ action: "spawnAgent" }) })).toBe("启动子代理");
    expect(runEntryTitle({ ...entry, input: JSON.stringify({ action: "futureTool" }) })).toBe("子代理");
    const record = createRunRecord();
    recordRunEvent(record, { type: "tool_use", toolName: "CodexAgent", toolUseId: "wait-1", toolInput: { action: "wait", receiverThreadIds: ["child-1"] } });
    expect(runEntryTitle(summarizeRun(record, "running").current!)).toBe("等待子代理");
  });
  it("separates child states and authored reports without treating a successful wait as child success", () => {
    const output = JSON.stringify({ first: { status: "completed", message: "## Findings\n\nConfirmed **one** bug." }, second: { status: "errored", message: "Review failed." }, third: { status: "running", message: null } });
    expect(codexAgentReports({ ...entry, output })).toEqual([
      { id: "first", status: "completed", message: "## Findings\n\nConfirmed **one** bug." },
      { id: "second", status: "errored", message: "Review failed." },
      { id: "third", status: "running", message: null },
    ]);
    expect(codexAgentReports({ ...entry, output: "{}" })).toEqual([]);
  });
  it("keeps malformed, truncated and other-engine output on the raw fallback", () => {
    for (const output of ["plain text", '{"child":', "[]", "null", '{"capture":"unrecognized_agent_states","preview":"truncated raw source"}']) {
      expect(codexAgentReports({ ...entry, output })).toBeUndefined();
    }
    expect(codexAgentReports({ ...entry, name: "Agent", output: '{"child":{"status":"completed","message":"A report"}}' })).toBeUndefined();
  });
  it("keeps readable siblings when one state is new or malformed", () => {
    expect(codexAgentReports({ ...entry, output: JSON.stringify({ valid: { status: "completed", message: "Kept" }, future: { status: "queued" }, bad: { status: "completed", message: 12 } }) })).toEqual([
      { id: "valid", status: "completed", message: "Kept" }, { id: "future", status: "queued", message: null }, { id: "bad", status: "unknown", message: null, unreadable: true },
    ]);
  });
});

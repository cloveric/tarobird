import { describe, expect, it } from "vitest";
import type { Block, Message } from "../../src/client-protocol/index.js";
import { isAgentBusRecord } from "../src/agent-bus-record.js";

const marker = { runId: "run_one", workspaceId: "bus_one", stageId: "s1", status: "running" };
const card = (value: unknown): Block => ({ type: "card", elements: [], extra: { agentBusStage: value } });
const record = (value: unknown): Pick<Message, "authorType" | "blocks"> => ({ authorType: "bot", blocks: [card(value)] });

describe("independent Agent Bus record classification", () => {
  it("recognizes validated stage records throughout their real lifecycle, including terminal result text", () => {
    for (const status of ["running", "completed", "failed", "cancelled"]) expect(isAgentBusRecord(record({ ...marker, status }))).toBe(true);
    expect(isAgentBusRecord({ ...record(marker), blocks: [card(marker), { type: "text", text: "成员结果" }] })).toBe(true);
  });
  it("requires the complete bounded marker and does not infer a record from its title", () => {
    for (const value of [undefined, null, {}, true, { ...marker, runId: "" }, { ...marker, runId: "../run" }, { ...marker, workspaceId: "x".repeat(129) }, { ...marker, stageId: "native_task" }, { ...marker, stageId: "s10000" }, { ...marker, status: "streaming" }]) expect(isAgentBusRecord(record(value))).toBe(false);
    expect(isAgentBusRecord({ authorType: "bot", blocks: [{ type: "card", title: "Agent Bus · 记录", elements: [] }] })).toBe(false);
    expect(isAgentBusRecord({ ...record(marker), authorType: "user" })).toBe(false);
  });
  it("does not mask a genuine native foreground run in the same message or another message", () => {
    const native: Block = { type: "card", elements: [], extra: { nativeRun: { version: 1, id: "native", revision: 1, phase: "working", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false } } };
    expect(isAgentBusRecord({ ...record(marker), blocks: [card(marker), native] })).toBe(false);
    expect(isAgentBusRecord({ ...record(marker), blocks: [{ ...native, extra: { ...native.extra, agentBusStage: marker } }] })).toBe(false);
    expect(isAgentBusRecord({ authorType: "bot", blocks: [{ type: "text", text: "普通回复" }] })).toBe(false);
    expect(isAgentBusRecord(record(marker))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { createGroupDiscussionEventFilter, createGroupDiscussionEventHandler, splitGroupDiscussionOutput } from "../src/gateway/group-discussion-output.js";
import { parseGroupStance } from "../src/gateway/group-discussion.js";
import { applyCoreEngineEvent, initialCoreRunState } from "../src/core/card-renderer.js";

const block = (body: string, fence = "```") => `${fence}group_stance\n${body}\n${fence}`;
const agreement = '{"stance":"agree","proposalId":"P3","proposal":"","summary":"同意 P3 原文"}';
const streamedText = (events: EngineStreamEvent[]) => events.flatMap(event => event.type === "assistant_text" ? [event.text] : []).join("");

describe("discussion internal positions stay separate from visible answers", () => {
  it.each(["json group_stance", "group-stance", "JSON GROUP-STANCE", "group-stance json"])("hides explicit internal fence variant %s without accepting a vote", info => {
    const answer = `Answer\n${block(agreement).replace("group_stance", info)}`;
    expect(parseGroupStance(answer)).toEqual({ text: "Answer", invalid: true });
    for (let split = 1; split < answer.length; split++) {
      const filter = createGroupDiscussionEventFilter();
      const events = [...filter({ type: "assistant_text", text: answer.slice(0, split), delta: true }),
        ...filter({ type: "assistant_text", text: answer.slice(split), delta: true }), ...filter({ type: "result", text: answer })];
      expect(streamedText(events)).toBe("Answer\n");
      expect(events.at(-1)).toEqual({ type: "result", text: "Answer" });
    }
  });
  it("preserves ordinary source fences, marker mentions and nested documentation examples", () => {
    for (const info of ["json", "typescript group_stance", "json group_stance_example", "group-stances", "my_group_stance"]) {
      const answer = `Example\n${block(agreement).replace("group_stance", info)}`;
      expect(splitGroupDiscussionOutput(answer)).toMatchObject({ text: answer, controls: [] });
    }
    const nested = `\`\`\`\`markdown\n\`\`\`json group_stance\n${agreement}\n\`\`\`\n\`\`\`\``;
    expect(splitGroupDiscussionOutput(nested)).toMatchObject({ text: nested, controls: [] });
  });
  it.each(["{agree}", '{"stance":"agree"}', '{"stance":"propose","proposal":""}', '{"stance":"agree","proposalId":"P3","proposal":"changed conclusion"}', '{"stance":"agree","proposalId":""}', '{"stance":"agree","proposalId":"P3 ","proposal":""}', "null"])("hides invalid data without counting agreement: %s", body => {
    expect(parseGroupStance(`Readable answer\n\n${block(body)}`)).toEqual({ text: "Readable answer", invalid: true });
  });
  it.each(["disagree", "abstain", "propose"])("tolerates only empty unused fields for %s", stance => {
    const fields = { stance, proposalId: "", proposal: stance === "propose" ? "Conclusion" : "  ", summary: "Position" };
    expect(parseGroupStance(block(JSON.stringify(fields))).stance).toEqual({ stance, ...(stance === "propose" ? { proposal: "Conclusion" } : {}), summary: "Position" });
  });
  it("hides unclosed, duplicate and nonterminal control blocks but never accepts their votes", () => {
    expect(parseGroupStance(`Answer\n\n\`\`\`group_stance\n${agreement}`)).toEqual({ text: "Answer", invalid: true });
    expect(parseGroupStance(`Answer\n\n${block(agreement)}\n\nAfterword`)).toEqual({ text: "Answer\n\n\nAfterword", invalid: true });
    expect(parseGroupStance(`Answer\n\n${block(agreement)}\n${block(agreement)}`)).toEqual({ text: "Answer", invalid: true });
    for (const info of ["GROUP_STANCE", "group_stance json"]) expect(parseGroupStance(`Answer\n${block(agreement).replace("group_stance", info)}`)).toEqual({ text: "Answer", invalid: true });
  });
  it("supports CRLF, longer and tilde fences without interpreting quoted code samples", () => {
    for (const fence of ["```", "````", "~~~"]) {
      expect(parseGroupStance(`Answer\n${block(agreement, fence)}\n`.replaceAll("\n", "\r\n"))).toMatchObject({ text: "Answer", stance: { stance: "agree", proposalId: "P3" } });
    }
    const sample = `A code sample:\n\n\`\`\`\`markdown\n${block(agreement)}\n\`\`\`\`\nInline group_stance stays.`;
    expect(parseGroupStance(sample)).toEqual({ text: sample });
  });
  it("never flashes the marker or JSON at any token boundary", () => {
    const answer = `Normal answer.\n\n${block(agreement)}`;
    for (let split = 1; split < answer.length; split++) {
      const filter = createGroupDiscussionEventFilter();
      const first = filter({ type: "assistant_text", text: answer.slice(0, split), delta: true });
      const rest = filter({ type: "assistant_text", text: answer.slice(split), delta: true });
      const final = filter({ type: "result", text: answer });
      expect(streamedText([...first, ...rest, ...final])).toBe("Normal answer.\n\n");
      expect(final.at(-1)).toEqual({ type: "result", text: "Normal answer." });
    }
  });
  it("streams prose immediately and preserves normal code across character-sized fragments", () => {
    const filter = createGroupDiscussionEventFilter();
    expect(filter({ type: "assistant_text", text: "Hello", delta: true })).toEqual([{ type: "assistant_text", text: "Hello", delta: true }]);
    const code = '\n```typescript\nconst x = 1;\n```\n\n~~~markdown\n```group_stance\nexample\n```\n~~~';
    const events = [...code].flatMap(text => filter({ type: "assistant_text", text, delta: true }));
    events.push(...filter({ type: "result", text: "" }));
    expect(streamedText(events)).toBe(code);
    expect(streamedText(filter({ type: "assistant_text", text: '`npm` runs this', delta: true }))).toBe('`npm` runs this');
  });
  it("keeps split fence flushes before tool and text events when adapters do not await callbacks", async () => {
    let state = initialCoreRunState("gw:c", "group");
    const order: string[] = [];
    const handler = createGroupDiscussionEventHandler(async event => {
      state = applyCoreEngineEvent(state, event); order.push(event.type);
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    const events: EngineStreamEvent[] = [
      { type: "assistant_text", text: "Code:\n```js\nx\n```", delta: true },
      { type: "tool_use", toolName: "Read", toolInput: {} },
      { type: "assistant_text", text: "After the tool.", delta: true },
      { type: "result", text: "After the tool." },
    ];
    const pending = events.map(event => handler(event)); // Fire without waiting, like process-adapter.
    expect(order).toEqual(["assistant_text", "assistant_text", "tool_use", "assistant_text", "result"]);
    expect(state.blocks.filter(block => block.kind === "text").map(block => block.content)).toEqual(["Code:\n```js\nx\n```", "After the tool."]);
    await Promise.all(pending);
  });
  it("preserves tool, scoped and retry events and resets each assistant segment", () => {
    const filter = createGroupDiscussionEventFilter();
    expect(streamedText(filter({ type: "assistant_text", text: `View\n${block(agreement)}` }))).toBe("View\n");
    const tool: EngineStreamEvent = { type: "tool_use", toolName: "Read", toolInput: {} };
    expect(filter(tool)).toEqual([tool]);
    expect(streamedText(filter({ type: "assistant_text", text: "Later prose" }))).toBe("Later prose");
    const retry: EngineStreamEvent = { type: "engine_retry", status: "retrying", attempt: 1, delayMs: 0, reason: "capacity" };
    expect(filter(retry)).toEqual([retry]);
    expect(streamedText(filter({ type: "assistant_text", text: "Retry prose", delta: true }))).toBe("Retry prose");
  });
  it("does not retain a growing JSON body or delay long normal prose", () => {
    const filter = createGroupDiscussionEventFilter();
    const text = "正常回答".repeat(25_000);
    expect(streamedText(filter({ type: "assistant_text", text, delta: true }))).toBe(text);
    expect(filter({ type: "assistant_text", text: '\n```group_stance\n{"summary":"', delta: true })).toHaveLength(1); // only preceding newline
    expect(filter({ type: "assistant_text", text, delta: true })).toEqual([]);
    expect(splitGroupDiscussionOutput(`Answer\n${block("invalid")}`).text).toBe("Answer");
  });
});

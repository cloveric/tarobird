import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { handleDelegationCoreCommand } from "../src/core/shared/delegation-commands.js";
import { handleMiniBusCoreCommand } from "../src/core/shared/mini-bus-commands.js";
import { handleCrewCoreWorkflow } from "../src/core/shared/crew-workflow.js";
import { MiniBusStore } from "../src/state/mini-bus-store.js";

const longReply = "```text\n" + "完整的一行，不应该因 Telegram 字数限制拆开。😀\n".repeat(260) + "```";
const message = (text: string) => ({ chatId: 123, userId: 456, chatType: "private", text, attachments: [] });

it.each(["gateway", "lark", "telegram"] as const)("preserves %s reply delivery policy across collaboration modes", async (channel) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-bus-transport-"));
  try {
    for (const command of ["/btw question", "/ask peer question", "/fan question", "/chain question", "/verify question"]) {
      const sendMessage = vi.fn(async (_id: number, _text: string) => undefined);
      const handled = await handleDelegationCoreCommand({
        stateDir: root, startedAt: Date.now(), locale: "en", cfg: {}, normalized: message(command),
        context: { channel, instanceName: "owner", api: { sendMessage } },
        bridge: { handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: longReply }) },
        loadBusConfig: vi.fn().mockResolvedValue({ parallel: ["peer"], chain: ["peer", "writer"], verifier: "peer" }),
        delegateToInstance: vi.fn().mockResolvedValue({ success: true, text: longReply }),
      });
      expect(handled).toBe(true);
      const replies = sendMessage.mock.calls.map(([, text]) => text);
      if (channel === "telegram") {
        expect(replies.length).toBeGreaterThan(1);
        expect(replies.every(text => text.length <= 4000)).toBe(true);
      } else {
        // Core delivery owns platform limits. Pre-splitting inserts extra code
        // fences and breaks a single result into multiple logical App replies.
        expect(replies.some(text => text.includes(longReply)), command).toBe(true);
        expect(replies.filter(text => text.includes("完整的一行")), command).toHaveLength(1);
      }
    }
    const timeline = (await readFile(path.join(root, "timeline.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(timeline.filter(event => event.type === "command.handled").every(event => event.channel === channel)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["gateway", "telegram"] as const)("preserves %s research reports and Mini replies, including audit counts", async (channel) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-bus-reports-"));
  const sendMessage = vi.fn(async (_id: number, _text: string) => undefined);
  const context = { channel, instanceName: "owner", api: { sendMessage } };
  const assertDelivery = () => {
    const replies = sendMessage.mock.calls.map(([, text]) => text).filter(text => text.includes("完整的一行"));
    if (channel === "gateway") expect(replies).toEqual([expect.stringContaining(longReply)]);
    else { expect(replies.length).toBeGreaterThan(1); expect(replies.every(text => text.length <= 4000)).toBe(true); }
    return replies.length;
  };
  try {
    await handleCrewCoreWorkflow({
      stateDir: root, startedAt: Date.now(), locale: "en", cfg: {}, normalized: message("Research this"),
      context: { ...context, bridge: { handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: "1. What changed?" }) } },
      loadBusConfig: vi.fn().mockResolvedValue({ peers: "*", crew: {
        enabled: true, workflow: "research-report", coordinator: "owner",
        roles: { researcher: "researcher", analyst: "analyst", writer: "writer", reviewer: "reviewer" },
        maxResearchQuestions: 1, maxRevisionRounds: 0,
      } }),
      delegateToInstance: vi.fn().mockImplementation(async ({ targetInstance }) => ({ success: true, text:
        targetInstance === "reviewer" ? "VERDICT: PASS\nISSUES:\n- none" : targetInstance === "writer" ? longReply : "Finding" })),
    });
    assertDelivery();
    sendMessage.mockClear();
    const store = new MiniBusStore(root);
    await store.upsertPeer({ name: "writer", chatId: 123, messageThreadId: 22, conversationKey: "chat:123:topic:22" });
    await handleMiniBusCoreCommand({
      stateDir: root, startedAt: Date.now(), locale: "en", cfg: {},
      normalized: { ...message("/mini ask writer question"), chatType: "group", messageThreadId: 11 },
      context, bridge: { handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: longReply }) }, store,
    });
    const chunks = assertDelivery();
    const audit = (await readFile(path.join(root, "audit.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(audit).toContainEqual(expect.objectContaining({ type: "update.handle", outcome: "success",
      metadata: expect.objectContaining({ command: "mini", action: "ask", chunkCount: chunks }) }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["/chain question", "/verify question"])("keeps the completed App result intact when a later %s peer fails", async (command) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-bus-partial-"));
  const sendMessage = vi.fn(async (_id: number, _text: string) => undefined);
  const delegate = vi.fn().mockRejectedValue(new Error("peer unavailable"));
  if (command.startsWith("/chain")) delegate.mockResolvedValueOnce({ success: true, text: longReply });
  try {
    await handleDelegationCoreCommand({
      stateDir: root, startedAt: Date.now(), locale: "en", cfg: {}, normalized: message(command),
      context: { channel: "gateway", instanceName: "owner", api: { sendMessage } },
      bridge: { handleAuthorizedMessage: vi.fn().mockResolvedValue({ text: longReply }) },
      loadBusConfig: vi.fn().mockResolvedValue({ chain: ["peer", "writer"], verifier: "peer" }), delegateToInstance: delegate,
    });
    expect(sendMessage.mock.calls.filter(([, text]) => text.includes("完整的一行"))).toEqual([[123, expect.stringContaining(longReply)]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["gateway", "telegram"] as const)("records the actual %s chunk count for long Mini validation replies", async (channel) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-mini-validation-"));
  const sendMessage = vi.fn(async (_id: number, _text: string) => undefined);
  const names = Array.from({ length: 220 }, (_, index) => `missing_peer_${String(index).padStart(3, "0")}_long_name`);
  try {
    await handleMiniBusCoreCommand({
      stateDir: root, startedAt: Date.now(), locale: "en", cfg: {},
      normalized: { ...message(`/mini order ${names.join(" ")}`), chatType: "group" },
      context: { channel, api: { sendMessage } }, bridge: { handleAuthorizedMessage: vi.fn() },
    });
    const replies = sendMessage.mock.calls.map(([, text]) => text);
    expect(replies.join("")).toBe(`Mini topic peers not found: ${names.join(", ")}`);
    if (channel === "gateway") expect(replies).toHaveLength(1);
    else expect(replies.every(text => text.length <= 4000)).toBe(true);
    const audit = (await readFile(path.join(root, "audit.log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(audit).toContainEqual(expect.objectContaining({ type: "update.handle", outcome: "invalid",
      metadata: expect.objectContaining({ action: "order", chunkCount: replies.length }) }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["gateway", "lark", "telegram"] as const)("uses the actual %s surface in Mini Bus guidance", async (channel) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-mini-guidance-"));
  const sendMessage = vi.fn(async (_id: number, _text: string) => undefined);
  try {
    for (const locale of ["zh", "en"] as const) {
      await handleMiniBusCoreCommand({
        stateDir: root, startedAt: Date.now(), locale, cfg: {}, normalized: message("/mini status"),
        context: { channel, api: { sendMessage } }, bridge: { handleAuthorizedMessage: vi.fn() },
      });
      const reply = sendMessage.mock.calls.at(-1)![1];
      if (channel === "telegram") expect(reply).toContain("Telegram");
      else expect(reply).not.toContain("Telegram");
      if (channel === "gateway") expect(reply).toContain("Agent Bus");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

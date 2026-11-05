// Regression cases reproduced by the independent Opus review. No model or browser mocks alter the send logic.
import { test, expect } from "@playwright/test";
import { sendGroupComposerMessage, type GroupReplyMode } from "../src/group-composer-send.ts";
import { editGroupComposerIntent } from "../src/group-composer-intent.ts";

const group = { id: "c", type: "group", title: "G", ownerId: "owner", botIds: ["a", "b", "g"], archived: false, createdAt: 1 };
const view = (run: Record<string, unknown> | null) => ({ settings: { group, policy: { mode: "sequential", botOrder: ["a", "b", "g"], maxRounds: 2 }, revision: "gs1" }, run: run && {
  id: "gd1", conversationId: "c", mode: "sequential", topic: "T", phase: "opinion", round: 1, maxRounds: 2, participants: [{ botId: "a", name: "A" }, { botId: "b", name: "B" }, { botId: "g", name: "G" }], steps: [], createdAt: 1, ...run } });
function connection(get: unknown) {
  const posts: { route: string; body: Record<string, unknown> }[] = [];
  return { posts, value: {
    state: { status: "online", groupDiscussionComposerAvailable: true, groupDiscussionRecoveryAvailable: true, groupReplyGuardAvailable: true },
    cache: { draft: async () => "", saveDraft: async () => undefined, clearDraftIfMatches: async () => undefined },
    send: async () => undefined,
    http: async (route: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") { posts.push({ route, body: JSON.parse(init.body!) }); return view({ status: "running", revision: "r10", actions: ["pause", "end"] }); }
      return get;
    },
  } as never };
}
const frame = (text: string) => ({ v: 1 as const, type: "message.send" as const, conversationId: "c", clientMsgId: "m1", text, attachments: [] as string[], mentions: ["a", "b", "g"] });

test.describe("discussion control binding", () => {
  test("Enter during ending retains a new draft with the wait message", async () => {
    const mode: GroupReplyMode = { conversationId: "c", mode: "sequential", revision: "gs1", activeRun: { id: "gd1", conversationId: "c", status: "ending" } };
    const intent = editGroupComposerIntent(undefined, mode, false);
    expect(intent.target?.activeRun).toBeUndefined();
    const { value } = connection(view(null));
    await expect(sendGroupComposerMessage(value, frame("CORRECT"), mode, new AbortController().signal, undefined, () => mode, intent))
      .rejects.toThrow("请等待本次讨论停止或暂停完成，内容已保留。");
  });

  test("add-and-retry cannot adopt a different pause after another device continues", async () => {
    const seen: GroupReplyMode = { conversationId: "c", mode: "sequential", revision: "gs1", activeRun: { id: "gd1", conversationId: "c", status: "paused", revision: "r5", actions: ["resume", "retry", "end"], pauseReason: "turn_stopped" } };
    const intent = { ...editGroupComposerIntent(undefined, seen, false), discussionAction: "retry" as const };
    // Meanwhile another device resumed, a different speaker failed: same run, new pause.
    const { value, posts } = connection(view({ status: "paused", revision: "r9", actions: ["resume", "retry", "end"], pauseReason: "turn_failed" }));
    await expect(sendGroupComposerMessage(value, frame("CORRECT"), seen, new AbortController().signal, undefined, () => seen, intent)).rejects.toThrow("讨论或设置已变化，已保留输入。请核对最新状态后重试。");
    expect(posts).toEqual([]);
  });
});

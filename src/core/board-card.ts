import type { BoardTaskRecord } from "../state/board-store.js";
import type { Locale } from "../runtime/locale.js";
import { hostT } from "../locales/index.js";

export function renderCoreBoardTaskCard(input: {
  task: BoardTaskRecord;
  markdown: string;
  locale: Locale;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  bridgeChatId: number;
  replyInThread?: boolean;
}): Record<string, unknown> {
  const labels = boardLabels(input.locale);
  const actions = boardActions(input.task, input);
  const elements: unknown[] = [
    { tag: "markdown", content: input.markdown },
  ];
  if (actions.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "column_set",
      flex_mode: "flow",
      columns: actions.map((action) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          {
            tag: "button",
            text: { tag: "plain_text", content: action.label },
            type: action.type,
            width: "fill",
            behaviors: [callbackBehavior({
              cctb_lark: "board",
              command: action.command,
              conversationKey: input.conversationKey,
              bridgeChatType: input.bridgeChatType,
              bridgeChatId: input.bridgeChatId,
              ...(input.replyInThread ? { replyInThread: true } : {}),
            })],
          },
        ],
      })),
    });
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: `${labels.title} ${input.task.id}` },
    },
    header: {
      title: { tag: "plain_text", content: `${labels.title} ${input.task.id}` },
      template: input.task.status === "blocked" ? "red" : input.task.status === "done" ? "green" : "blue",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function boardActions(
  task: BoardTaskRecord,
  input: {
    locale: Locale;
  },
): Array<{ label: string; command: string; type: "primary" | "default" | "danger" }> {
  const labels = boardLabels(input.locale);
  if (task.status === "todo") {
    return [{ label: labels.ready, command: `/board ready ${task.id}`, type: "primary" }];
  }
  if (task.status === "ready") {
    return [{ label: labels.run, command: `/board run ${task.id}`, type: "primary" }];
  }
  if (task.status === "running") {
    return [
      { label: labels.heartbeat, command: `/board heartbeat ${task.id} card ping`, type: "default" },
      { label: labels.done, command: `/board done ${task.id}`, type: "primary" },
      { label: labels.block, command: `/board block ${task.id} blocked from card`, type: "danger" },
    ];
  }
  if (task.status === "blocked") {
    return [{ label: labels.unblock, command: `/board unblock ${task.id}`, type: "primary" }];
  }
  if (task.status === "review") {
    return [
      { label: labels.approve, command: `/board approve ${task.id}`, type: "primary" },
      { label: labels.reject, command: `/board reject ${task.id} rejected from card`, type: "danger" },
    ];
  }
  return [];
}

function boardLabels(locale: Locale): {
  title: string;
  ready: string;
  run: string;
  heartbeat: string;
  done: string;
  block: string;
  unblock: string;
  approve: string;
  reject: string;
} {
  return {
    title: hostT(locale, "Board 任务"),
    ready: hostT(locale, "标记 Ready"),
    run: hostT(locale, "运行"),
    heartbeat: hostT(locale, "心跳"),
    done: hostT(locale, "完成"),
    block: hostT(locale, "阻塞"),
    unblock: hostT(locale, "解除阻塞"),
    approve: hostT(locale, "通过"),
    reject: hostT(locale, "退回"),
  };
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return { type: "callback", value };
}

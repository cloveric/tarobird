import { createRoot } from "react-dom/client";
import { QuestionForm } from "../../src/QuestionForm.js";
import type { HubConnection } from "../../src/connection.js";
import type { QuestionData } from "../../src/question-draft.js";
import type { CardElement } from "../../../src/client-protocol/index.js";

// A quiet connection and delayed draft writes ensure no incidental network or
// cache update hides a same-state focus request. These promises own no timers.
const state = { status: "online", cacheRevision: 0 };
const connection = {
  state, subscribe: () => () => {}, identity: {},
  cache: {
    questionDraft: async () => undefined,
    outbox: async () => [],
    saveQuestionDraft: () => new Promise<void>(() => {}),
  },
} as unknown as HubConnection;
const data: QuestionData = {
  version: 1, requestId: "focus-fixture", questions: [
    { header: "第一题", question: "请再打开 https://example.test/login/device，输入新代码 `DEMO-CODE` 并完成授权。", required: true, multiSelect: false, allowFreeText: true, options: [] },
    { header: "第二题", question: "输入第二项", required: true, multiSelect: false, allowFreeText: true, options: [] },
  ],
};
const element: CardElement = { type: "form", children: [{ type: "button", name: "askq_submit", actionId: "fixture" }] };
createRoot(document.getElementById("root")!).render(<QuestionForm data={data} element={element} connection={connection} messageId="focus-message" values={{}} act={async () => false}/>);

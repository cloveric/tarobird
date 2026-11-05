import { createRoot } from "react-dom/client";
import { MessageContent } from "../../src/Content.js";
import { ClientCache } from "../../src/storage.js";
import type { HubConnection } from "../../src/connection.js";
import type { Message } from "../../../src/client-protocol/index.js";
import fixtures from "./generated-cards/index.json";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/viewport.css";
import "../../src/porcelain-details.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") ?? "light";
document.documentElement.dataset.palette = query.get("palette") ?? "white-blue";
const prose = `这是一篇关于学习与实践的分享，共 7 页。核心观点是：**把理解落实到日常行动，让好的习惯成为自己的力量。**

文章主要讲了五件事：

1. **为什么读了很多，还是觉得没有进步？**

   如果只追求阅读数量，却不了解含义、没有明确的目标，就容易流于形式，遇到事情仍然按照旧习惯处理。

2. **你反复想着什么，就会强化什么。**

   把注意力放在真正重要的事情上。通过反复练习，让理解慢慢转变为行动。

3. **从生活中的小事开始。**

   - 每天留一点时间回顾。
   - 遇到困难先停一停，再决定怎样回应。

4. **理解需要经过实践的检验。**

   不急于得出结论，观察自己的行为有没有发生变化。

5. **保持耐心，持续调整。**

   改变需要时间，重要的是一次次回到当下。

**一句话总结**：学习的价值，在于让我们更好地面对真实生活。`;
const itinerary = `你们今天的回程是南航 **CZ6050，芽庄金兰机场 → 广州白云**，目前显示正常。

- **计划时间**：16:00 起飞，19:50 到广州，预计会提前到达。
- **航站楼**：金兰机场 T2 出发，白云 T2 到达。
- **值机**：D1–D4 柜台，**15:10 截止**；登机口目前显示 5 号。
- **机型**：波音 737-800。
- **近几天准点情况**：
  - 10 月 4、5、7、8 日基本准点；
  - 10 月 6 日晚了约 1.5 小时；
  - 建议给路上交通多留一点余量。

### 出发建议

- 国际航班要过越南出境检查，建议 **13:00–13:30 到机场**。
- 从市区到机场大约 35 公里，建议 **12:00–12:30 从酒店出发**。
- 出发前再核对一次航班、登机口和天气。

以上为排版演示数据，不是实时航班信息。`;
const technical = `### 交付说明

第一行说明
第二行说明

1. 一个普通列表项${"  "}
   明确的换行仍然保留。

   > 一段引用，保留来源与上下文。

2. 检查代码与文件名：

   ~~~ts
   const path = "${"long-file-name-".repeat(20)}.txt";
   // second line
   ~~~

| 文件 | 结果 | 备注 |
| --- | --- | --- |
| ${"产品需求说明与交付文件".repeat(15)}.md | 完成 | 可下载 |

[产品说明](https://example.com/guide)

- [x] 已完成检查
- [ ] 等待确认`;
const text = query.get("case") === "itinerary" ? itinerary : query.get("case") === "technical" ? technical : prose;
const connection = { cache: new ClientCache("tarobot-card-reading-fixture"), identity: { deviceId: "fixture", hubPublicKey: "fixture" }, state: { status: "online" }, send: async () => undefined } as unknown as HubConnection;
let message: Message = { id: "reading", conversationId: "fixture", authorType: "bot", authorId: "fixture", status: "complete", version: 1, createdAt: 0, blocks: [{ type: "card", title: "已完成", elements: [
  { type: "markdown", text },
  { type: "collapsible", text: "过程 · 4 步", children: [{ type: "markdown", text: "阅读资料\n整理要点\n检查内容\n完成回复" }] },
] }] };
// Use the actual translated queue constructor with the production style stack.
if (query.get("case") === "queue") message.blocks = fixtures.find(entry => entry.name === "queue")!.blocks as Message["blocks"];
const legacyStream = query.get("case") === "legacy-stream";
if (legacyStream) message = { ...message, status: "streaming", blocks: [{ type: "card", title: "正在回复", elements: [{ type: "markdown", text: "检查中。" }], extra: { config: { streaming_mode: true } } }] };
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<main style={{ maxWidth: 760, margin: "24px auto", padding: "0 12px" }}>
  <article className="message bot" style={{ position: "relative" }}>
    <div className="message-avatar" style={{ borderRadius: "50%", background: "var(--accent)", color: "white" }}>G</div>
    <div className="message-body"><div className="message-meta"><strong>GG1</strong><time>20:41</time></div><MessageContent message={message} connection={connection}/></div>
  </article>
</main>);

render();
if (legacyStream) window.addEventListener("fixture:stream-patch", event => {
  const { text, complete } = (event as CustomEvent<{ text: string; complete: boolean }>).detail;
  message = { ...message, version: message.version + 1, status: complete ? "complete" : "streaming", blocks: [{ type: "card", title: complete ? "已完成" : "正在回复", elements: [{ type: "markdown", text }], extra: { config: { streaming_mode: !complete } } }] };
  render();
});

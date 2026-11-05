import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ScheduledTasks } from "../../src/ScheduledTasks.js";
import type { Bot, HubConnection } from "../../src/connection.js";
import type { Conversation } from "../../../src/client-protocol/index.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/expressive-themes.css";

document.documentElement.dataset.palette = "white-violet";
document.documentElement.dataset.theme = "light";

const base = { engine: "codex", model: "gpt-6.1-sol", effort: "high", online: 1 };
const initial: Bot[] = [
  { ...base, id: "alpha", name: "研究助手" }, { ...base, id: "beta", name: "日历与邮件助手" },
  { ...base, id: "offline", name: "离线的写作助手", online: 0 },
  { ...base, id: "long", name: "负责跨地区项目的资料整理与每周进展汇总的长名称助手" },
  ...Array.from({ length: 60 }, (_, i) => ({ ...base, id: `bot_${i}`, name: `工作助手 ${String(i).padStart(2, "0")}` })),
];
const requests: string[] = [];
let resolveHeld: ((value: unknown) => void) | undefined, hold = false;
const connection = {
  state: { status: "online", user: { id: "owner", role: "owner" } },
  http: async (path: string) => {
    requests.push(path);
    if (hold) { hold = false; return new Promise(resolve => { resolveHeld = resolve; }); }
    return { jobs: [], schedulerAvailable: true };
  },
} as unknown as HubConnection;
const conversations = [{ id: "result", title: "研究结果", botIds: ["alpha"], archived: false }] as Conversation[];
function Fixture() {
  const [bots, setBots] = useState(initial), [open, setOpen] = useState(true);
  Object.assign(window, { scheduleFixture: {
    requests,
    removeBot: (id: string) => setBots(old => old.filter(bot => bot.id !== id)),
    keepFirst: (count: number) => setBots(old => old.slice(0, count)),
    hold: () => { hold = true; },
    release: () => resolveHeld?.({ jobs: [], schedulerAvailable: true }),
  } });
  return <><h1>工作台</h1>{open && <ScheduledTasks connection={connection} bots={bots} conversations={conversations} initialBot="alpha" close={() => setOpen(false)} openConversation={() => {}} newBot={() => {}}/>}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);

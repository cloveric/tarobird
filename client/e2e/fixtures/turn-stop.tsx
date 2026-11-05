import { memo, useContext, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Message } from "../../../src/client-protocol/index.js";
import type { HubConnection } from "../../src/connection.js";
import { TurnStopContext, useTurnStop } from "../../src/use-turn-stop.js";
import "../../src/styles.css";
import "../../src/conversation-creation.css";

const rows = ["nativeRun", "scopedRun"].map((kind, i) => ({ id: `message-${i}`, conversationId: "chat", authorType: "bot", authorId: "bot", status: "complete", createdAt: 1, blocks: [{ type: "card", elements: [], extra: { [kind]: { version: 1, id: `run-${i}`, revision: 1, phase: "working", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false } } }] })) as Message[];
const evidence = { sent: [] as unknown[], reads: 0, renders: 0, results: [] as boolean[], lookups: 0, releaseLookup: () => {}, release: () => {} };
const connection = { state: { bots: [{ id: "bot", engine: "claude" }] }, send: async (value: unknown) => { evidence.sent.push(value); }, cache: { messages: async () => { evidence.reads++; await new Promise<void>(resolve => { evidence.release = resolve; }); return rows; } } } as unknown as HubConnection;
const StopButton = memo(function StopButton({ chat }: { chat: string }) {
  const request = useContext(TurnStopContext)!; evidence.renders++;
  return <button onClick={() => { void request(chat, "bot").then(value => evidence.results.push(value)); }}>停止</button>;
});
function Pane({ chat, visible }: { chat: string; visible: boolean }) {
  const [draft, setDraft] = useState("");
  const stop = useTurnStop(connection, chat, rows, visible);
  return <><input aria-label="草稿" value={draft} onChange={event => setDraft(event.target.value)}/><TurnStopContext.Provider value={stop.request}><StopButton chat={chat}/></TurnStopContext.Provider>{stop.dialog}</>;
}
function Fixture() {
  const [chat, setChat] = useState("chat"), [visible, setVisible] = useState(true), [mounted, setMounted] = useState(true);
  Object.assign(window, { turnStopFixture: { evidence, setChat, setVisible, setMounted, nativeTasks: () => {
    connection.state.engineTasksAvailable = true;
    connection.http = (async () => {
      evidence.lookups++;
      await new Promise<void>(resolve => { evidence.releaseLookup = resolve; });
      return { supported: true, foregroundStopScope: "subagents", tasks: [{id:"native",label:"原生后台检查",kind:"subagent",mode:"background",status:"running",canStop:true,updatedAt:1}] };
    }) as HubConnection["http"];
  } } });
  return mounted ? <Pane chat={chat} visible={visible}/> : null;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);

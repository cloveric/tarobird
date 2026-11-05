import React, { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ClientCache } from "../../src/storage.js";
import { HubConnection } from "../../src/connection.js";
import { useConversationMessages } from "../../src/conversation-messages.js";
import { useConversationOutbox } from "../../src/conversation-outbox.js";

const hosts = Object.fromEntries(["a", "b"].map(id => {
  const cache = new ClientCache(`outbox-view-${id}-${crypto.randomUUID()}`);
  return [id, { cache, connection: new HubConnection({ deviceId: id, name: id, publicKey: id, routes: [] }, cache), seq: 0 }];
}));
const holds: Record<string, { held: boolean; release: () => void }> = {};
const failHistory = new Set<string>();
let setScope: (scope: { host: string; conversationId: string; visible: boolean }) => void;
const refresh = (host: string) => Reflect.get(hosts[host].connection, "update").call(hosts[host].connection, {}, true);
const fixture = {
  hosts, holds, failHistory, refresh,
  select: (host: string, conversationId = "same", visible = true) => setScope({ host, conversationId, visible }),
  async send(id: string, text: string, host = "a", conversationId = "same") {
    await hosts[host].connection.send({ v: 1, type: "message.send", clientMsgId: id, conversationId, text, attachments: [], recipients: [] });
  },
  async card(id: string, host = "a") {
    await hosts[host].connection.send({ v: 1, type: "interaction.submit", clientActionId: id, conversationId: "same", messageId: "question", actionId: "answer", values: {} });
  },
  async accept(id: string, host = "a", card = false) {
    const { connection, cache } = hosts[host];
    const entry = (await cache.outbox()).find(entry => entry.id === id)!;
    if (!card && entry.frame.type === "message.send") {
      await this.publish(id, entry.frame.text, host, entry.frame.conversationId);
    }
    await Reflect.get(connection, "ack").call(connection, id, !card);
  },
  async publish(id: string, text: string, host = "a", conversationId = "same", deleted = false) {
    const source = hosts[host], previous = (await originalMessages.call(source.cache, conversationId)).find(message => message.id === id);
    await source.cache.apply({ v: 1, type: "event", conversationId, seq: ++source.seq, at: Date.now(), kind: "message.updated", payload: {
      id, clientMsgId: id, conversationId, authorId: "owner", authorType: "user", createdAt: previous?.createdAt ?? Date.now(), version: (previous?.version ?? 0) + 1,
      status: deleted ? "deleted" : "complete", blocks: [{ type: "text", text }],
    } });
    refresh(host);
  },
  async fail(id: string, host = "a") { await hosts[host].cache.fail(id, "fixture_failure"); refresh(host); },
  discard: (id: string, host = "a") => hosts[host].connection.discardFailed(id),
  holdHistory(host = "a") {
    const cache = hosts[host].cache, original = cache.messages;
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const hold = holds[`history-${host}`] = { held: false, release: () => { cache.messages = original; release(); } };
    cache.messages = async function(id) {
      const values = await originalMessages.call(cache, id); hold.held = true; await barrier;
      if (failHistory.has(host)) throw new Error("fixture_history_failure");
      return values;
    };
    refresh(host);
  },
  holdOutbox(host = "a") {
    const cache = hosts[host].cache, original = cache.outbox;
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const hold = holds[`outbox-${host}`] = { held: false, release };
    cache.outbox = async function() {
      cache.outbox = original;
      const entries = await original.call(cache); hold.held = true; await barrier; return entries;
    };
    refresh(host);
  },
};
const originalMessages = ClientCache.prototype.messages;
for (const [id, source] of Object.entries(hosts)) {
  const read = source.cache.messages.bind(source.cache);
  source.cache.messages = async conversationId => { if (failHistory.has(id)) throw new Error("fixture_history_failure"); return read(conversationId); };
}
function View({ scope }: { scope: { host: string; conversationId: string; visible: boolean } }) {
  const connection = hosts[scope.host].connection;
  const state = useSyncExternalStore(listener => connection.subscribe(listener), () => connection.state);
  const history = useConversationMessages(connection, scope.conversationId, scope.visible);
  const queued = useConversationOutbox(connection, scope.conversationId, scope.visible, history.readRevision, history.messages);
  return <><output>{JSON.stringify({ host: scope.host, visible: scope.visible, ready: history.ready, failed: history.failed })}</output>
    <button onClick={history.retry}>retry history</button>
    {scope.visible && <><section id="history">{history.messages.map(message => <div key={message.id} data-id={message.id}>{message.blocks.map(block => block.type === "text" ? block.text : "").join("")}</div>)}</section>
      <section id="queued">{queued.filter(entry => entry.error || !history.messages.some(message => message.clientMsgId === entry.id)).map(entry => <div key={entry.id} data-id={entry.id}>{entry.text} {entry.error ?? (entry.sent ? "sent" : entry.syncing ? "syncing" : "pending")}</div>)}</section></>}
  </>;
}
Object.assign(window, { outboxFixture: fixture });
function Shell() {
  const [current, change] = useState({ host: "a", selected: { a: "same", b: "same" } as Record<string, string>, visible: true });
  setScope = scope => change(previous => ({ host: scope.host, visible: scope.visible, selected: { ...previous.selected, [scope.host]: scope.conversationId } }));
  // Match HostApp: each visited host retains its own mounted workspace.
  return <>{Object.keys(hosts).map(host => <section className="fixture-workspace" hidden={current.host !== host} key={host}>
    <View scope={{ host, conversationId: current.selected[host], visible: current.host === host && current.visible }}/>
  </section>)}</>;
}
createRoot(document.getElementById("root")!).render(<Shell/>);

import React from "react";
import { createRoot } from "react-dom/client";
import { DispatchTickets } from "../../src/DispatchTickets.js";
import { HubHttpError } from "../../src/http-error.js";
import { setLocale } from "../../src/i18n.js";
import type { HubConnection } from "../../src/connection.js";

const params = new URLSearchParams(location.search), mode = params.get("mode");
setLocale(params.get("lang") === "en" ? "en" : "zh");
const ticket = { id: "ended", dispatcherBotId: "dispatcher", conversationId: "chat", title: "Completed ticket", request: "Fixture", status: mode === "reject-pause" ? "queued" : "done", paused: false, attempts: [], createdAt: 1, updatedAt: 1 };
const requests: Array<{ requestId: string; action: string }> = [];
Object.assign(window, { ticketRequests: requests });
let removed = false;
const connection = { http: async (url: string, options?: RequestInit) => {
  if (options?.method === "POST") {
    requests.push(JSON.parse(String(options.body)));
    if (mode === "reject" || mode === "reject-pause") throw new HubHttpError(400, "invalid_request");
    if (mode === "other-reject") throw new HubHttpError(400, "other_failure");
    if (mode === "uncertain" && requests.length === 1) throw new TypeError("Failed to fetch");
    removed = true; return ticket;
  }
  // 1.0.127 ignores the capability query and returns its original snapshot.
  // This fixture also exercises a stale advertised capability followed by a
  // definite old-Host action rejection, without starting a native App.
  return { tickets: removed ? [] : [ticket], engines: [], ...(mode !== "legacy" && url.includes("capabilities=1") ? { capabilities: { remove: true } } : {}) };
} } as unknown as HubConnection;
createRoot(document.getElementById("root")!).render(<DispatchTickets connection={connection} botId="dispatcher" active online open={() => undefined}/>);

import { hostBridge, subscribeCanvasAgentEvents } from "./host-bridge";

export function openAgentTransport(
    clientId: string,
    notify: (type: string, data: Record<string, unknown>) => void,
    onClose: () => void,
) {
    let disposed = false;
    let didConnect = false;
    const stop = subscribeCanvasAgentEvents(event => {
        if (disposed || event.clientId !== clientId) return;
        if (event.type === "canvas.agent.closed") {
            didConnect = false;
            onClose();
        } else if (event.type !== "canvas.agent.hello") {
            notify(event.type.slice("canvas.agent.".length), event);
        }
    });
    void hostBridge.agentConnect(clientId).then(connection => {
        didConnect = connection.connected;
        if (disposed) {
            if (didConnect) void hostBridge.agentDisconnect(clientId).catch(() => {});
        } else if (didConnect) {
            notify("hello", connection);
        } else onClose();
    }).catch(() => { if (!disposed) onClose(); });
    return () => {
        disposed = true;
        stop();
        if (didConnect) void hostBridge.agentDisconnect(clientId).catch(() => {});
    };
}

export async function agentRequest(clientId: string, path: string, data: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (path === "/canvas/state") {
        await hostBridge.agentState(clientId, (data as { snapshot: { projectId: string; title: string } | null }).snapshot);
    } else if (path === "/canvas/activate") {
        await hostBridge.agentActivate(clientId);
    } else if (path === "/canvas/result") {
        const { requestId, result, error } = data as { requestId: string; result?: unknown; error?: { code: string; message: string } };
        await hostBridge.agentResult(clientId, requestId, error ? { error } : { result });
    } else throw Error("CANVAS_AGENT_METHOD_DENIED");
}

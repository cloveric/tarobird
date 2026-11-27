import { useSyncExternalStore } from "react";
import { getCanvasMessages, subscribeCanvasLocale } from "./locale";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { AgentBeam } from "@workbench/components/agent/agent-beam";
import { useCanvasMcpStore } from "@workbench/stores/use-canvas-mcp-store";

export function ConfigExternalAgent() {
    const copy = useSyncExternalStore(subscribeCanvasLocale, getCanvasMessages);
    const { connected, enabled, error, connect, disconnect } = useCanvasMcpStore();
    return (
        <section className="agent-connection settings-network generation-workspace-controls flex flex-col gap-4">
            <AgentBeam />
            <p className="text-muted-foreground">{copy.agentDescription}</p>
            <p role="status">{connected ? copy.agentReady : enabled && !error ? copy.agentConnecting : copy.agentOffline}</p>
            {error && <p role="alert">{copy.agentError}</p>}
            <Button type="button" variant="ghost" onClick={enabled ? disconnect : connect}>{enabled ? copy.disconnect : copy.connect}</Button>
        </section>
    );
}

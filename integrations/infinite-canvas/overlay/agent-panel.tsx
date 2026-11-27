import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { AgentBeam } from "@workbench/components/agent/agent-beam";
import { useCanvasMcpStore } from "@workbench/stores/use-canvas-mcp-store";

export function ConfigExternalAgent() {
    const { connected, enabled, error, connect, disconnect } = useCanvasMcpStore();
    return (
        <section className="agent-connection settings-network generation-workspace-controls flex flex-col gap-4">
            <AgentBeam />
            <p className="text-muted-foreground">连接当前对话中的 TaroBird Bot，使其可以操作当前画布。</p>
            <p role="status">{connected ? "Agent 连接已就绪" : enabled && !error ? "正在连接…" : "尚未连接"}</p>
            {error && <p role="alert">{error}</p>}
            <Button type="button" variant="ghost" onClick={enabled ? disconnect : connect}>{enabled ? "断开连接" : "连接"}</Button>
        </section>
    );
}

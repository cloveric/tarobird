import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Blocks } from "lucide-react";
import { contribute, definePlugin, type CanvasNodeContentProps, type CanvasNodeDefinition, type CanvasNodePanelProps } from "@infinite-canvas/plugin-sdk";
import { nodes } from "@infinite-canvas/plugin-sdk/builtin";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { Input } from "@infinite-canvas/plugin-sdk/ui/input";
import { Textarea } from "@infinite-canvas/plugin-sdk/ui/textarea";
import {
    approvedNodeSource, NODE_TEXT_LIMIT, nodeAddonsApi, safeNodeOutput,
    type NodeAddonOutput, type NodeAddonState,
} from "./node-addons-api";

type Snapshot = NodeAddonState & { busy: boolean; error: boolean };
let snapshot: Snapshot = { enabled: false, plugins: [], busy: false, error: false };
const listeners = new Set<() => void>();
const getSnapshot = () => snapshot;
const subscribe = (listener: () => void) => {
    if (!listeners.size) window.addEventListener("focus", refresh);
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) window.removeEventListener("focus", refresh);
    };
};
function publish(next: Snapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
}

async function changeState(request: () => Promise<NodeAddonState>) {
    if (snapshot.busy) return;
    publish({ ...snapshot, busy: true, error: false });
    try {
        const state = await request();
        publish({ ...state, busy: false, error: false });
    } catch {
        publish({ ...snapshot, busy: false, error: true });
    }
}

function refresh() {
    void changeState(nodeAddonsApi.list);
}

function useAddons() {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    useEffect(refresh, []);
    return state;
}

function CanvasAcknowledgements() {
    const [expanded, setExpanded] = useState(false);
    const template = document.querySelector<HTMLTemplateElement>("template#tarobird-canvas-acknowledgements");
    return <details className="rounded-md border p-3" onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer">开源许可 · Open-source licenses · オープンソースライセンス</summary>
        {expanded && <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{template?.content.textContent}</pre>}
    </details>;
}

export function ConfigPlugins() {
    const state = useAddons();
    const [url, setUrl] = useState("");
    const [confirmation, setConfirmation] = useState<{ kind: "enable" } | { kind: "install"; url: string } | { kind: "remove"; id: string; title: string }>();
    const source = approvedNodeSource(url);
    const reviewSource = () => { if (source && !state.busy) setConfirmation({ kind: "install", url: source }); };
    const confirm = async () => {
        if (!confirmation) return;
        setConfirmation(undefined);
        if (confirmation.kind === "enable") {
            await changeState(() => nodeAddonsApi.enable(true));
        } else if (confirmation.kind === "install") {
            await changeState(() => nodeAddonsApi.install(confirmation.url));
        } else {
            await changeState(() => nodeAddonsApi.remove(confirmation.id));
        }
    };
    return <section className="grid max-w-2xl gap-4">
        <h2 className="text-base font-semibold">第三方节点</h2>
        <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
                <input type="checkbox" checked={state.enabled} disabled={state.busy} onChange={event => {
                    if (event.currentTarget.checked) setConfirmation({ kind: "enable" });
                    else { setConfirmation(undefined); void changeState(() => nodeAddonsApi.enable(false)); }
                }} />
                允许安装第三方节点
            </label>
            <Button type="button" variant="ghost" disabled={state.busy} onClick={() => void changeState(nodeAddonsApi.list)}>刷新</Button>
        </div>
        {state.error && <p role="status">第三方节点操作未完成。请确认权限后重试。</p>}
        {state.enabled && <div className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-64 flex-1 gap-1">源文件 URL
                <Input type="url" maxLength={1024} value={url} onChange={event => setUrl(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); reviewSource(); }
                    }} placeholder="https://raw.githubusercontent.com/…" />
            </label>
            <Button type="button" disabled={!source || state.busy} onClick={reviewSource}>检查并安装</Button>
            {url && !source && <p className="w-full text-sm" role="status">请输入包含完整提交 SHA 的 GitHub Raw JavaScript 文件地址。</p>}
        </div>}
        {confirmation && <section role="alertdialog" aria-label="确认第三方节点操作" className="grid gap-3 rounded-md border p-3">
            {confirmation.kind === "enable" && <p>第三方代码会处理你主动交给节点的文本，在独立运行环境中执行，无法使用 App 或网络或读取密钥。请只安装来源可信的节点。每个文件安装前还会显示来源与 SHA-256，供你确认。</p>}
            {confirmation.kind === "install" && <p>检查并下载此源文件？宿主会校验地址并显示 SHA-256。确认安装前，文件不会运行。<code className="mt-2 block break-all">{confirmation.url}</code></p>}
            {confirmation.kind === "remove" && <p>卸载「{confirmation.title}」？画布保留节点和文本，重新选择已安装插件后可继续使用。</p>}
            <div className="flex gap-2">
                <Button type="button" disabled={state.busy} onClick={() => void confirm()}>继续</Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmation(undefined)}>取消</Button>
            </div>
        </section>}
        {!state.enabled && state.plugins.length > 0 && <p className="text-sm">已停用第三方节点。安装记录仍保留。</p>}
        {!!state.plugins.length && <ul className="grid gap-2">
            {state.plugins.map(plugin => <li key={plugin.id} className="grid gap-1 rounded-md border p-3">
                <p><strong>{plugin.title}</strong> <span className="text-sm">第三方 · Third-party</span></p>
                <code className="break-all text-xs">{plugin.url}</code>
                <code className="break-all text-xs">SHA-256 {plugin.sha256}</code>
                <Button type="button" variant="ghost" className="justify-self-start" disabled={state.busy} onClick={() => setConfirmation({ kind: "remove", id: plugin.id, title: plugin.title })}>卸载</Button>
            </li>)}
        </ul>}
        <CanvasAcknowledgements />
    </section>;
}

function nodePluginId(ctx: CanvasNodeContentProps["ctx"]) {
    const id = ctx.node.metadata?.isolatedAddonId;
    return typeof id === "string" ? id : "";
}

function NodeContent({ ctx }: CanvasNodeContentProps) {
    const state = useAddons();
    const id = nodePluginId(ctx);
    const content = ctx.node.metadata?.content ?? "";
    const plugin = state.plugins.find(row => row.id === id);
    const title = ctx.node.title;
    const [rendered, setRendered] = useState<{ key: string; value: NodeAddonOutput }>();
    const [busy, setBusy] = useState(false);
    const [errorKey, setErrorKey] = useState("");
    const request = useRef<symbol | undefined>(undefined);
    const key = JSON.stringify([id, plugin?.sha256, title, content]);
    useEffect(() => {
        if (!state.enabled || !plugin) {
            request.current = undefined;
            setRendered(undefined);
            setBusy(false);
        }
    }, [state.enabled, plugin]);
    const run = async () => {
        if (!state.enabled || !plugin || request.current || !ctx.isSelected) return;
        const identity = Symbol();
        request.current = identity;
        setBusy(true);
        setErrorKey("");
        try {
            const value = safeNodeOutput(await nodeAddonsApi.render(plugin.id, content, title));
            if (request.current === identity && getSnapshot().enabled && !ctx.scope.signal.aborted) setRendered({ key, value });
        } catch {
            if (request.current === identity && !ctx.scope.signal.aborted) setErrorKey(key);
        } finally {
            if (request.current === identity) {
                request.current = undefined;
                if (!ctx.scope.signal.aborted) setBusy(false);
            }
        }
    };
    const output = state.enabled && plugin && rendered?.key === key ? rendered.value : undefined;
    return <div className="grid h-full content-start gap-2 overflow-auto p-3" data-canvas-no-zoom>
        <p className="whitespace-pre-wrap break-words" style={{ color: output?.color ?? ctx.theme.node.text }}>
            {output?.text ?? (!state.enabled ? "第三方节点已停用" : plugin ? "选择节点后运行" : "双击选择已安装的第三方插件")}
        </p>
        {state.enabled && plugin && ctx.isSelected && <Button type="button" size="sm" variant="outline" disabled={busy} onMouseDown={event => event.stopPropagation()} onClick={() => void run()}>运行节点</Button>}
        {errorKey === key && state.enabled && <p role="status">运行失败。请确认节点已启用并重试。</p>}
    </div>;
}

function NodePanel({ ctx, onClose }: CanvasNodePanelProps) {
    const state = useAddons();
    const [error, setError] = useState(false);
    const [pendingWrites, setPendingWrites] = useState(0);
    const [text, setText] = useState(ctx.node.metadata?.content ?? "");
    const save = (fields: Parameters<typeof ctx.updateMetadata>[0]) => {
        setError(false);
        setPendingWrites(count => count + 1);
        void ctx.updateMetadata(fields).catch(() => {
            if (!ctx.scope.signal.aborted) setError(true);
        }).finally(() => {
            if (!ctx.scope.signal.aborted) setPendingWrites(count => count - 1);
        });
    };
    return <div className="grid gap-3" data-canvas-no-zoom>
        <label className="grid gap-1">第三方插件
            <select value={nodePluginId(ctx)} onChange={event => save({ isolatedAddonId: event.target.value })}>
                <option value="">选择插件</option>
                {state.plugins.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.title}（第三方）</option>)}
            </select>
        </label>
        <label className="grid gap-1">节点文本
            <Textarea maxLength={NODE_TEXT_LIMIT} value={text} onChange={event => {
                setText(event.target.value);
                save({ content: event.target.value });
            }} />
        </label>
        {error && <p role="status">保存节点失败，请重试。</p>}
        <Button type="button" variant="ghost" disabled={pendingWrites > 0} onClick={onClose}>完成</Button>
    </div>;
}

const isolatedNode: CanvasNodeDefinition = {
    type: "third-party-nodes:isolated",
    title: "第三方节点",
    icon: <Blocks size={16} />,
    description: "使用隔离环境运行已安装的第三方文本插件",
    defaultSize: { width: 260, height: 160 },
    defaultMetadata: { content: "", isolatedAddonId: "" },
    hasSourceHandle: false,
    Content: NodeContent,
    Panel: NodePanel,
    onDoubleClick(ctx) { ctx.openPanel(); return true; },
};

export default definePlugin({ contributions: [contribute(nodes, { id: isolatedNode.type, value: isolatedNode })] });

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, ChevronDown, CircleHelp, LoaderCircle, Network, PanelRightClose, Play, RotateCcw, Save, ShieldCheck, Square, Trash2 } from "lucide-react";
import { agentBusConfigSchema, agentBusIsActive, hasVisibleAgentBusText, type AgentBusConfig, type AgentBusDetail, type AgentBusMode, type AgentBusRun, type AgentBusWorkspace } from "../../src/client-protocol/agent-bus.js";
import type { CollaborationSnapshot } from "../../src/client-protocol/collaboration.js";
import type { AdhdHost } from "./AdhdBoard.js";
import { AvatarProvider } from "./Avatar.js";
import { AgentBusDraftDialog } from "./AgentBusDraftDialog.js";
import { CreationDialog } from "./CreationDialog.js";
import { settleCollaborationRestarts } from "./collaboration-task.js";
import { agentBusPeerIds, agentBusCollaborationIssues, prepareAgentBusCollaboration } from "../../src/client-protocol/collaboration-prepare.js";
import { BUS_GOAL_CHARS, busBotLabel, busComparableConfig, busConfigIssue, busCoordinatorExecutes, busCreateRejected, busDraftSaved, busRecoverCreatedConfig, busErrorText, busPreparationErrorText, busReadErrorText, busRunErrorText, busMemberStatus, busModeDescription, busModeName, busModes, busRoleName, busStatusName, busStartRunId } from "./agent-bus-view.js";
import { refreshAgentBuses } from "./AgentBusList.js";
import { t, useLocale, formatList } from "./i18n.js";
import { AgentBusFlow } from "./AgentBusFlow.js";
import { AgentBusDivision, AgentBusSlots, revealInBusPanel } from "./AgentBusSlots.js";
import "./agent-bus.css";
import { isDispatcher } from "./dispatcher.js";

const configOf = (workspace: AgentBusWorkspace): AgentBusConfig => ({ name: workspace.name, mode: workspace.mode, coordinator: workspace.coordinator, members: workspace.members, maxResearchQuestions: workspace.maxResearchQuestions, maxRevisionRounds: workspace.maxRevisionRounds });
const blank = (): AgentBusConfig => ({ name: "", mode: "ask", coordinator: { botId: "" }, members: [{ botId: "" }], maxResearchQuestions: 5, maxRevisionRounds: 1 });
// Draft-only content hidden by a mode switch: members beyond the new mode's
// slots, and a coordinator task the new mode cannot execute.
type Parked = { members: AgentBusConfig["members"]; coordinatorInstruction?: string };
const noParked: Parked = { members: [] };
const busMissing = (cause: unknown) => cause instanceof Error && /agent_bus_not_found|agent_bus_deleted/.test(cause.message);
/** Preserve incomplete number edits; never turn Backspace into a new zero. */
function CrewLimitInput({ value, change, label, disabled, invalid, hintId }: { value: number; change: (value: number) => void; label: string; disabled: boolean; invalid: boolean; hintId: string }) {
  const [draft, setDraft] = useState(String(value));
  const parse = (text: string) => /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
  useEffect(() => { setDraft(current => Object.is(parse(current), value) ? current : String(value)); }, [value]);
  return <input type="text" inputMode="numeric" aria-label={label} disabled={disabled} value={draft} aria-invalid={invalid || undefined} aria-describedby={invalid ? hintId : undefined}
    onChange={event => { const next = event.target.value; setDraft(next); change(parse(next)); }} onBlur={() => { if (Number.isFinite(parse(draft))) setDraft(String(parse(draft))); }}/>;
}

export function AgentBusPanel({ host, hosts, workspaceId, visible, close, selectHost, saved, reveal, focusMember, removed, guard, changed }: {
  host: AdhdHost; hosts: AdhdHost[]; workspaceId?: string; visible: boolean; close: () => void; selectHost: (host: AdhdHost) => void;
  saved: (workspace: AgentBusWorkspace) => void; reveal: (workspace: AgentBusWorkspace) => void; focusMember: (conversationId: string) => void; removed: () => void;
  guard: (state: { dirty: boolean; busy: boolean }) => void;
  changed: (workspace: AgentBusWorkspace | undefined, run: AgentBusRun | undefined) => void;
}) {
  const locale = useLocale(), connection = host.connection!;
  const state = useSyncExternalStore(useCallback(listener => connection.subscribe(listener), [connection]), () => connection.state);
  const [detail, setDetail] = useState<AgentBusDetail>();
  const [config, setConfig] = useState<AgentBusConfig>(blank);
  const [nameTouched, setNameTouched] = useState(false);
  const [baseline, setBaseline] = useState(() => busComparableConfig(blank()));
  const [loading, setLoading] = useState(!!workspaceId), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [task, setTask] = useState(""), [permissions, setPermissions] = useState<CollaborationSnapshot>();
  const [permissionReading, setPermissionReading] = useState(false);
  const [permissionReview, setPermissionReview] = useState(false), [preparation, setPreparation] = useState("");
  const [waitingForServices, setWaitingForServices] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [recoveryWorkspace, setRecoveryWorkspace] = useState<AgentBusWorkspace>();
  // Deleted elsewhere: nothing here can be saved or run any more.
  const [gone, setGone] = useState(false), [discardGone, setDiscardGone] = useState(false);
  const [deleting, setDeleting] = useState(false), [stopping, setStopping] = useState<{ workspaceId: string; runId: string; abandon?: boolean }>(), [help, setHelp] = useState(false);
  const [selectedRunNode, setSelectedRunNode] = useState(-1);
  const scroll = useRef<HTMLDivElement>(null), editDivision = useRef(false);
  const [parked, setParked] = useState<Parked>(noParked);
  const [tab, setTab] = useState<"configure" | "run">("configure");
  const live = useRef(true), action = useRef(false), generation = useRef(0);
  const request = useRef<{ key: string; id: string } | undefined>(undefined), restartIds = useRef(new Map<string, string>()), abort = useRef<AbortController | undefined>(undefined);
  const pendingStart = useRef<{ userId: string; workspaceId: string; requestId: string; runId: string; draft: string; draftVersion: number } | undefined>(undefined);
  const taskVersion = useRef(0), errorRequestId = useRef<string | undefined>(undefined);
  // Keep the original payload as well as its owner/request identity. A missing
  // GET or a rejected response cannot prove that this request never committed.
  const pendingCreate = useRef<{ userId: string; requestId: string; originalConfig: AgentBusConfig; attemptedUpdate?: AgentBusConfig } | undefined>(undefined);
  const editRevision = useRef(""), permissionGeneration = useRef(0);
  const title = useRef<HTMLInputElement>(null), panel = useRef<HTMLElement>(null), initialReveal = useRef(false), reading = useRef(false), loaded = useRef(false), pendingReset = useRef(false);
  const workspace = detail?.workspace, latest = detail?.runs[0], active = agentBusIsActive(latest?.status);
  const stopConfirmationCurrent = !!stopping && stopping.workspaceId === workspace?.id && stopping.runId === latest?.id && active && (!stopping.abandon || latest?.canAbandon === true);
  const executionWorkspace = useMemo(() => workspace && latest ? { ...workspace, ...latest.snapshot } : workspace, [workspace, latest]);
  // A rename alone does not change what the next run executes.
  const changedSinceRun = !!workspace && !!latest && busComparableConfig({ ...configOf(executionWorkspace!), name: workspace.name }) !== busComparableConfig(configOf(workspace));
  // Parked tasks or members are hidden by the current mode, but are still the
  // owner's unsaved draft: the visible form can match the saved Bus while they
  // exist. Leaving, reloading and background adoption must treat them as edits.
  const configDirty = busComparableConfig(config) !== baseline;
  const parkedDraft = parked.members.length > 0 || !!parked.coordinatorInstruction?.trim();
  const dirty = configDirty || parkedDraft;
  // A poll may finish after typing began; inspect the current draft, not the
  // render that started the request. Only this device's confirmed start can
  // consume its unchanged task draft; unrelated runs cannot consume it.
  const preserveConfig = useRef(dirty); preserveConfig.current = dirty || permissionReview || deleting || !!stopping;
  const ownsDraft = !connection.isReadOnly && state.user?.role === "owner" && !host.blocked;
  const online = state.status === "online" && ownsDraft;
  const allBots = host.directory?.bots ?? state.bots;
  // A dispatcher keeps one conversation, so it cannot take a dedicated Bus chat.
  const botList = allBots.filter(bot => bot.managed && !bot.deletedAt && !isDispatcher(bot));
  const label = (id: string) => allBots.some(bot => bot.id === id) ? busBotLabel(allBots, id) : t("成员已不可用");
  const memberIds = config.members.map(member => member.botId).filter(Boolean);
  const conversationLabel = (id?: string) => id ? (host.directory?.conversations ?? []).find(chat => chat.id === id)?.title ?? t("对话已不可用") : t("专用对话 · 保存时创建");
  const unavailableIndex = [config.coordinator, ...config.members].findIndex(member => member.botId && !botList.some(bot => bot.id === member.botId));
  const unavailableIssue: ReturnType<typeof busConfigIssue> = unavailableIndex < 0 ? undefined : {
    field: unavailableIndex === 0 ? "coordinator" : "members", index: unavailableIndex - 1,
    message: t("{0} Bot 已不可用，请在配置中重新选择。", busRoleName(config.mode, unavailableIndex - 1)),
  };
  const configHintId = useId(), nameHintId = useId(), limitHintId = useId(), runHintId = useId(), configIssue = busConfigIssue(config) ?? unavailableIssue, valid = !configIssue;
  const nameIssue = configIssue?.field === "name" && (nameTouched || !!config.name) ? configIssue : undefined;
  const issues = permissions ? agentBusCollaborationIssues(permissions, config.coordinator.botId, memberIds) : [];
  const permissionsReady = !!permissions && !issues.length && !unavailableIssue;
  const checkingPermissions = permissionReading && !permissions && !unavailableIssue;
  const goalLength = task.trim().length, goalTooLong = goalLength > BUS_GOAL_CHARS, goalEmpty = !hasVisibleAgentBusText(task);
  const goneText = t("这个 Bus 已被删除。成员对话和消息仍然保留，请返回列表。");
  const runError = tab === "run" && !active && !permissionReview && !deleting && !stopping && !gone ? error : "";
  const runHint = gone ? goneText : !online ? state.user?.role !== "owner" ? t("只有主机所有者可以配置协作，请联系主机所有者。") : t("连接恢复后可继续，当前内容会保留。") : unavailableIssue ? unavailableIssue.message : configDirty ? t("请先保存配置修改。") : checkingPermissions ? t("正在检查成员权限…") : !permissionsReady ? t("需要先准备成员协作权限。") : goalEmpty ? t("填写共同目标后即可启动。") : goalTooLong ? t("共同目标最多 {0} 字，当前 {1} 字。", BUS_GOAL_CHARS, goalLength) : t("使用已保存的成员与分工。");
  // Editing a local draft needs no network; keep focus/IME intact during reconnect.
  // Remote actions retain their separate online gates.
  const fieldsAvailable = ownsDraft && !busy && !active && !loading && (!workspaceId || !!workspace);
  const canEdit = fieldsAvailable && !gone;
  const latestCallbacks = useRef({ changed, reveal }); latestCallbacks.current = { changed, reveal };
  useEffect(() => { guard({ dirty: dirty || !!task.trim(), busy }); return () => guard({ dirty: false, busy: false }); }, [dirty, task, busy, guard]);
  // Reload or window close bypasses the in-app leave prompt; ask there too.
  const unsaved = dirty || !!task.trim();
  useEffect(() => {
    if (!unsaved) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    addEventListener("beforeunload", protect); return () => removeEventListener("beforeunload", protect);
  }, [unsaved]);
  useEffect(() => { latestCallbacks.current.changed(gone ? undefined : executionWorkspace, gone ? undefined : latest); }, [executionWorkspace, latest, gone]);
  useEffect(() => { if (visible) panel.current?.focus({ preventScroll: true }); }, [visible]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
    if (tab !== "configure" || !editDivision.current) return;
    // "Edit division" lands on the first task field, not just the tab.
    editDivision.current = false;
    const field = unavailableIssue
      ? scroll.current?.querySelector<HTMLSelectElement>(`.agent-bus-slot[data-slot-index="${unavailableIssue.index}"] select[data-focus="bot"]`)
      : scroll.current?.querySelector<HTMLTextAreaElement>('.agent-bus-slot textarea[data-focus="instruction"]:not(:disabled)');
    if (field) { field.focus({ preventScroll: true }); revealInBusPanel(field.closest<HTMLElement>(".agent-bus-slot") ?? field); }
  }, [tab]);
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++; abort.current?.abort(); }; }, []);
  const confirmStart = useCallback((run: AgentBusRun) => {
    const pending = pendingStart.current;
    if (!pending || pending.userId !== connection.state.user?.id || run.workspaceId !== pending.workspaceId || run.id !== pending.runId) return;
    pendingStart.current = undefined;
    if (request.current?.id === pending.requestId) request.current = undefined;
    setTask(current => taskVersion.current === pending.draftVersion && current === pending.draft ? "" : current);
    if (errorRequestId.current === pending.requestId) { errorRequestId.current = undefined; setError(""); }
  }, [connection]);
  const read = useCallback(async (reset = false) => {
    if (reset) { pendingReset.current = true; setLoading(true); }
    if (!workspaceId || host.blocked || connection.state.status !== "online" || reading.current || action.current) return;
    const replace = pendingReset.current || !loaded.current; pendingReset.current = false;
    reading.current = true;
    const seq = ++generation.current;
    try {
      const value = await connection.http<AgentBusDetail>(`/api/agent-buses/${workspaceId}`);
      if (!live.current || seq !== generation.current) return;
      setDetail(value); setLoading(pendingReset.current); setReadError("");
      for (const run of value.runs) confirmStart(run);
      if (replace || !preserveConfig.current && editRevision.current !== value.workspace.revision) { if (!loaded.current) setTab("run"); loaded.current = true; const next = configOf(value.workspace); setParked(noParked); editRevision.current = value.workspace.revision; setConfig(next); setBaseline(busComparableConfig(next)); if (replace) { errorRequestId.current = undefined; setError(""); } }
      if (!initialReveal.current) { initialReveal.current = true; latestCallbacks.current.reveal(value.workspace); }
    } catch (cause) {
      if (live.current && seq === generation.current) {
        if (busMissing(cause)) { pendingReset.current = false; setGone(true); setLoading(false); setReadError(""); }
        else { setLoading(pendingReset.current); setReadError(busReadErrorText(cause)); }
      }
    }
    finally { reading.current = false; if (pendingReset.current && live.current && !host.blocked && connection.state.status === "online") void read(); }
  }, [connection, workspaceId, host.blocked, confirmStart]);
  useEffect(() => { void read(); }, [read, state.status]);
  useEffect(() => { if (visible) void read(); }, [read, visible]);
  useEffect(() => {
    if (!workspaceId || state.status !== "online" || gone) return;
    // A collapsed idle workspace needs only occasional reconciliation. Active
    // runs still drive the visible ADHD member badges, even with the dock shut.
    const refresh = () => { if (!document.hidden && !action.current) void read(); };
    const timer = setInterval(refresh, visible || active ? 3500 : 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [workspaceId, state.status, read, gone, visible, active]);
  const readPermissions = useCallback(async () => {
    const seq = ++permissionGeneration.current;
    if (!config.coordinator.botId || host.blocked || connection.state.status !== "online") { setPermissionReading(false); return; }
    setPermissionReading(true);
    try { const value = await connection.http<CollaborationSnapshot>(`/api/bots/${config.coordinator.botId}/collaboration`); if (live.current && permissionGeneration.current === seq) { settleCollaborationRestarts(value, config.coordinator.botId, restartIds.current); setPermissions(value); } }
    catch { if (live.current && permissionGeneration.current === seq) setPermissions(undefined); }
    finally { if (live.current && permissionGeneration.current === seq) setPermissionReading(false); }
  }, [connection, config.coordinator.botId, host.blocked]);
  useEffect(() => { setPermissions(undefined); void readPermissions(); }, [readPermissions, state.status]);
  useEffect(() => { if (permissionsReady) setWaitingForServices(false); }, [permissionsReady]);
  useEffect(() => { if (!waitingForServices || permissionsReady) return; const timer = setInterval(() => { void readPermissions(); }, 4000); return () => clearInterval(timer); }, [waitingForServices, permissionsReady, readPermissions]);
  const update = (next: AgentBusConfig) => { setConfig(next); errorRequestId.current = undefined; setError(""); setPermissionReview(false); setWaitingForServices(false); setPreparation(""); };
  const change = (next: AgentBusConfig, options?: { clearParked?: boolean }) => { if (options?.clearParked) setParked(old => ({ ...old, members: [] })); update(next); };
  const modeChange = (mode: AgentBusMode) => {
    // The selected mode is already laid out. Re-filtering it would drop blank
    // steps or move a Crew role into an empty earlier role.
    if (mode === config.mode) return;
    const max = mode === "ask" || mode === "verify" ? 1 : mode === "crew" ? 4 : 11;
    // Keep temporarily hidden roles until save/reload or an explicit add/remove.
    // An explicit binding chosen in the meantime owns its conversation; the
    // parked slot keeps its Bot and task and falls back to a dedicated record.
    // A slot with only a typed task is still the owner's draft and is kept too.
    const occupied = new Set([config.coordinator, ...config.members].map(member => member.conversationId).filter(Boolean));
    const restore = (member: AgentBusConfig["members"][number]) => { if (!member.conversationId || !occupied.has(member.conversationId)) return member; const { conversationId: _, ...rest } = member; return rest; };
    const pool = [...config.members, ...parked.members.map(restore)].filter(member => member.botId || member.instruction?.trim());
    const members = pool.slice(0, max);
    if (!members.length) members.push({ botId: "" });
    if (mode === "crew") while (members.length < 4) members.push({ botId: "" });
    // Ask and chain coordinators never execute. Park their task instead of
    // sending or silently dropping it; restore it for a mode that uses it.
    const { instruction, ...dispatcher } = config.coordinator;
    let coordinator = config.coordinator, coordinatorInstruction = parked.coordinatorInstruction;
    if (!busCoordinatorExecutes(mode)) { coordinator = dispatcher; if (instruction?.trim()) coordinatorInstruction = instruction; }
    else if (coordinatorInstruction && !instruction?.trim()) { coordinator = { ...config.coordinator, instruction: coordinatorInstruction }; coordinatorInstruction = undefined; }
    setParked({ members: pool.slice(max), coordinatorInstruction });
    const next = { ...config, mode, coordinator, members };
    // Hidden Crew options must not block another mode. Preserve valid choices;
    // restore only invalid fields to the shared schema's own defaults.
    if (config.mode === "crew" && mode !== "crew") for (const field of ["maxResearchQuestions", "maxRevisionRounds"] as const) {
      const schema = agentBusConfigSchema.shape[field];
      if (!schema.safeParse(next[field]).success) next[field] = schema.parse(undefined);
    }
    update(next);
  };
  const receipt = (key: string) => { if (request.current?.key !== key) request.current = { key, id: `bus_${crypto.randomUUID()}` }; return request.current.id; };
  const operate = async (work: () => Promise<void>, describeError: (cause: unknown) => string = busErrorText) => {
    if (action.current || !online) return;
    action.current = true; generation.current++; setBusy(true); errorRequestId.current = undefined; setError("");
    try { await work(); } catch (cause) { if (live.current) { if (busMissing(cause)) setGone(true); setError(describeError(cause)); } }
    finally { action.current = false; if (live.current) setBusy(false); }
  };
  const putConfig = (id: string, revision: string, parsed: AgentBusConfig) => connection.http<AgentBusWorkspace>(`/api/agent-buses/${id}`, { method: "PUT", body: JSON.stringify({ revision, config: parsed }) });
  const create = async (parsed: AgentBusConfig): Promise<AgentBusWorkspace> => {
    const userId = connection.state.user?.id;
    if (!userId || pendingCreate.current && pendingCreate.current.userId !== userId) throw new Error("owner_required");
    const pending = pendingCreate.current ??= { userId, requestId: receipt(JSON.stringify(["create", parsed])), originalConfig: parsed };
    // Replay first, even after local edits. The Hub either returns this exact
    // creation or its deletion tombstone; never turn a 404 into a new identity.
    let current: AgentBusWorkspace;
    try { current = await connection.http<AgentBusWorkspace>("/api/agent-buses", { method: "POST", body: JSON.stringify({ requestId: pending.requestId, config: pending.originalConfig }) }); }
    catch (cause) {
      if (busCreateRejected(cause) && pendingCreate.current === pending) {
        pendingCreate.current = undefined;
        if (request.current?.id === pending.requestId) request.current = undefined;
      }
      throw cause;
    }
    if (!live.current) return current;
    if (connection.state.user?.id !== pending.userId) throw new Error("owner_required");
    const recovered = busRecoverCreatedConfig(pending.originalConfig, current, parsed, pending.attemptedUpdate);
    if (!recovered) { setRecoveryWorkspace(current); refreshAgentBuses(); throw new Error("agent_bus_create_review_required"); }
    let value = current;
    if (!busDraftSaved(recovered, current)) {
      // Only the name differs from current; preserve its bindings and require
      // its revision. Opaque default IDs are not a saved-draft confirmation.
      // Keep this exact attempted PUT if its response is also lost.
      pending.attemptedUpdate = recovered;
      try { value = await putConfig(current.id, current.revision, recovered); }
      catch (cause) {
        if (!(cause instanceof Error && ["agent_bus_conflict", "agent_bus_revision_conflict"].includes(cause.message))) throw cause;
        setRecoveryWorkspace(current); refreshAgentBuses();
        throw new Error("agent_bus_create_review_required");
      }
    }
    pendingCreate.current = undefined;
    setRecoveryWorkspace(undefined);
    return value;
  };
  const save = () => operate(async () => {
    const parsed = agentBusConfigSchema.parse(config);
    let value: AgentBusWorkspace;
    if (!workspace) value = await create(parsed);
    else try { value = await putConfig(workspace.id, editRevision.current, parsed); }
    catch (cause) {
      // A save whose response was lost has already moved the revision. Its
      // retry adopts that save only when the Hub holds exactly this draft.
      if (!(cause instanceof Error && /agent_bus(_revision)?_conflict/.test(cause.message))) throw cause;
      const current = await connection.http<AgentBusDetail>(`/api/agent-buses/${workspace.id}`).catch(() => undefined);
      if (!current || !busDraftSaved(parsed, current.workspace)) throw cause;
      value = current.workspace;
    }
    if (!live.current) return;
    const next = configOf(value); setParked(noParked); editRevision.current = value.revision; setConfig(next); setBaseline(busComparableConfig(next)); setDetail(old => ({ workspace: value, runs: old?.runs ?? [] }));
    refreshAgentBuses(); saved(value); setTab("run");
  });
  const reloadCreated = () => operate(async () => {
    if (!recoveryWorkspace) return;
    // The discard dialog was accepted. Fetch again so review uses current
    // state, and preserve the entire draft if this read fails or was deleted.
    const value = await connection.http<AgentBusDetail>(`/api/agent-buses/${recoveryWorkspace.id}`);
    if (!live.current) return;
    const next = configOf(value.workspace);
    pendingCreate.current = undefined; setRecoveryWorkspace(undefined); setParked(noParked);
    editRevision.current = value.workspace.revision; setConfig(next); setBaseline(busComparableConfig(next)); setDetail(value);
    refreshAgentBuses(); saved(value.workspace); setTab("run");
  }, busReadErrorText);
  const prepare = () => operate(async () => {
    if (configDirty) { setError(t("请先保存配置修改。")); return; }
    if (unavailableIssue) { setError(unavailableIssue.message); return; }
    setWaitingForServices(false); setPreparation("");
    abort.current = new AbortController();
    try {
      await prepareAgentBusCollaboration(connection, config.coordinator.botId, memberIds, restartIds.current,
        step => { if (live.current) setPreparation(step.state === "connecting" ? t("正在连接 {0}…", label(step.botId)) : t("正在准备 {0}…", label(step.botId))); }, abort.current.signal);
      if (live.current) { setPermissionReview(false); setPreparation(t("权限已保存，正在等待服务就绪。")); setWaitingForServices(true); await readPermissions(); }
    } catch (cause) { if (live.current) { setPreparation(""); setWaitingForServices(false); } throw cause; }
  }, busPreparationErrorText);
  const start = () => operate(async () => {
    const userId = state.user?.id;
    if (!workspace || !userId || configDirty || active || goalEmpty || goalTooLong || gone || unavailableIssue) return;
    let fresh: CollaborationSnapshot;
    try { fresh = await connection.http<CollaborationSnapshot>(`/api/bots/${workspace.coordinator.botId}/collaboration`); }
    catch (cause) { if (live.current) setError(busReadErrorText(cause)); return; }
    if (!live.current) return;
    setPermissions(fresh);
    settleCollaborationRestarts(fresh, workspace.coordinator.botId, restartIds.current);
    if (agentBusCollaborationIssues(fresh, workspace.coordinator.botId, workspace.members.map(member => member.botId)).length) { setError(t("协作服务尚未就绪，请先完成权限准备。")); return; }
    const text = task.trim(), requestId = receipt(JSON.stringify(["run", workspace.id, editRevision.current, text]));
    pendingStart.current = { userId, workspaceId: workspace.id, requestId, runId: busStartRunId(userId, requestId), draft: task, draftVersion: taskVersion.current };
    let run: AgentBusRun;
    try { run = await connection.http<AgentBusRun>(`/api/agent-buses/${workspace.id}/runs`, { method: "POST", body: JSON.stringify({ requestId, revision: editRevision.current, text }) }); }
    catch (cause) { if (live.current) { errorRequestId.current = requestId; setError(busErrorText(cause)); } return; }
    if (!live.current) return;
    setDetail(old => old && ({ ...old, runs: [run, ...old.runs.filter(item => item.id !== run.id)] })); confirmStart(run); refreshAgentBuses(); reveal(workspace);
  });
  const stop = () => operate(async () => {
    if (!stopping) return;
    if (!stopConfirmationCurrent) { setStopping(undefined); setError(t("这次运行已结束或发生变化，请重新查看后操作。")); return; }
    const run = await connection.http<AgentBusRun>(`/api/agent-buses/${stopping.workspaceId}/runs/${stopping.runId}/stop`, { method: "POST", body: JSON.stringify({ requestId: receipt(`${stopping.abandon ? "abandon" : "stop"}:${stopping.runId}`), ...(stopping.abandon ? { abandon: true } : {}) }) });
    if (live.current) { setStopping(undefined); setDetail(old => old && ({ ...old, runs: old.runs.map(item => item.id === run.id ? run : item) })); refreshAgentBuses(); }
  });
  const remove = () => operate(async () => {
    if (!workspace) return;
    await connection.http(`/api/agent-buses/${workspace.id}`, { method: "DELETE", body: JSON.stringify({ revision: editRevision.current }) });
    if (live.current) { refreshAgentBuses(); removed(); }
  });
  const runIndex = Math.min(selectedRunNode, (executionWorkspace?.members.length ?? 1) - 1);
  const runMember = executionWorkspace && [executionWorkspace.coordinator, ...executionWorkspace.members][runIndex + 1];
  const showDivision = () => { editDivision.current = true; setTab("configure"); };
  return <AvatarProvider connection={connection} conversations={host.directory?.conversations ?? []} directory={host.directory?.bots}><aside ref={panel} tabIndex={-1} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !busy && !permissionReview && !deleting && !stopping && !reloading) { event.preventDefault(); event.stopPropagation(); close(); } }} className="agent-bus-panel" aria-label={t("Agent Bus 设置与运行")}>
    <header className="agent-bus-panel-header"><span className="agent-bus-emblem"><Network size={21}/></span><div><span className="agent-bus-eyebrow">AGENT BUS</span><h2>{gone ? t("Bus 已删除") : workspace?.name ?? t("新建协作")}</h2></div><button className="icon-button" aria-label={t("收起 Agent Bus")} onClick={close} disabled={busy}><PanelRightClose size={18}/></button></header>
    <div className={`agent-bus-scope ${workspaceId || hosts.length < 2 ? "is-static" : ""}`}><span className={`status-dot ${online ? "online" : "offline"}`}/>{workspaceId || hosts.length < 2 ? <span className="agent-bus-host-name" aria-label={t("Bus 所属主机")} title={host.host.name}>{host.host.name}</span> : <select aria-label={t("Bus 所属主机")} value={host.host.registrationId} disabled={!!workspaceId || busy} onChange={event => { const next = hosts.find(item => item.host.registrationId === event.target.value); if (next) selectHost(next); }}>{!hosts.some(item => item.host.registrationId === host.host.registrationId) && <option value={host.host.registrationId}>{host.host.name}</option>}{hosts.map(item => <option key={item.host.registrationId} value={item.host.registrationId}>{item.host.name}</option>)}</select>}<button className="icon-button" aria-label={t("了解 Agent Bus")} aria-expanded={help} onClick={() => setHelp(!help)}><CircleHelp size={15}/></button></div>
    {help && <div className="agent-bus-help">{t("Bus 保存成员与协作流程。成员来自同一主机；不会自动共享彼此的对话历史。关闭面板不会停止任务。")}<p>{t("发起者与成员都在独立会话中执行，不读取所选对话的历史。结果记录在所选对话，后续追问时可引用这些结果。")}</p></div>}
    <div className="agent-bus-tabs" role="tablist" aria-label={t("Bus 工作区")}><button role="tab" aria-selected={tab === "configure"} onClick={() => setTab("configure")}>{t("配置")}{dirty && <i/>}</button><button role="tab" aria-selected={tab === "run"} disabled={!workspace} onClick={() => setTab("run")}>{t("运行")}{active && <i className="is-running"/>}</button></div>
    {gone && <div className="agent-bus-gone" role="alert"><span>{goneText}</span><div className="agent-bus-gone-actions"><button type="button" onClick={() => { refreshAgentBuses(); close(); }}>{t("关闭")}</button>{!workspace && <button type="button" onClick={() => setDiscardGone(true)}>{t("放弃草稿")}</button>}</div></div>}
    <div ref={scroll} className="agent-bus-panel-scroll">
      {loading && <div className="agent-bus-loading" role="status"><LoaderCircle className="spin" size={18}/>{t("正在载入协作…")}</div>}
      {!online && <div className="agent-bus-notice" role="status">{state.user?.role !== "owner" ? t("只有主机所有者可以配置协作，请联系主机所有者。") : t("连接恢复后可继续，当前内容会保留。")}</div>}
      {tab === "configure" ? <div className="agent-bus-config" hidden={loading}>
        <label className="agent-bus-name-field">
          <span className="agent-bus-name-label"><span>{t("Bus 名称")}</span><small>{config.name.trim().length >= 72 ? `${config.name.trim().length}/80` : t("必填")}</small></span>
          <input ref={title} className="agent-bus-name-input" aria-label={t("Bus 名称")} required autoComplete="off" aria-invalid={!!nameIssue || undefined} aria-describedby={nameIssue ? nameHintId : undefined} value={config.name} disabled={!fieldsAvailable} readOnly={gone} placeholder={t("例如：产品评审、研究小组")} onBlur={() => setNameTouched(true)} onChange={event => { setNameTouched(true); update({ ...config, name: event.target.value }); }}/>
          <small id={nameHintId} className="agent-bus-name-hint" aria-live="polite">{nameIssue?.message ?? ""}</small>
        </label>
        <fieldset className="agent-bus-mode-picker"><legend>{t("协作方式")}</legend>{busModes.map(mode => <button type="button" key={mode} aria-pressed={config.mode === mode} disabled={!canEdit} className={config.mode === mode ? "is-selected" : ""} onClick={() => modeChange(mode)}>{busModeName(mode)}</button>)}</fieldset>
        <p className="agent-bus-mode-description">{busModeDescription(config.mode)}</p>
        {config.mode === "crew" && <div className="agent-bus-crew-limits"><div className="agent-bus-crew-options">{(["maxResearchQuestions", "maxRevisionRounds"] as const).map(field => <label key={field}>{field === "maxResearchQuestions" ? t("研究问题上限") : t("修订轮数上限")}<CrewLimitInput label={field === "maxResearchQuestions" ? t("研究问题上限") : t("修订轮数上限")} disabled={!canEdit} value={config[field]} invalid={configIssue?.field === field} hintId={limitHintId} change={value => update({ ...config, [field]: value })}/></label>)}</div>{(configIssue?.field === "maxResearchQuestions" || configIssue?.field === "maxRevisionRounds") && <small id={limitHintId} role="status">{configIssue.message}</small>}</div>}
        <AgentBusSlots config={config} change={change} bots={botList} conversations={host.directory?.conversations ?? []} label={label} editable={canEdit} readOnly={gone} visible={visible && !loading} issue={configIssue} hintId={configHintId} parked={{ members: parked.members.length, coordinatorInstruction: !!parked.coordinatorInstruction?.trim() }}/>

        {active && <div className="agent-bus-notice">{t("当前任务仍在执行，完成后可修改配置。")}</div>}
        {(workspace || recoveryWorkspace) && <div className="agent-bus-config-actions"><button disabled={!canEdit || !online} onClick={() => { if (recoveryWorkspace || dirty) setReloading(true); else void read(true); }}><RotateCcw size={13}/>{workspace ? t("重新载入配置") : t("重新载入已创建的 Bus")}</button>{workspace && <button className="text-danger" disabled={!canEdit || !online} onClick={() => setDeleting(true)}><Trash2 size={13}/>{t("删除 Bus")}</button>}</div>}
      </div> : workspace && executionWorkspace && <div className="agent-bus-run">
        <div className={`agent-bus-run-hero ${active ? "is-active" : ""}`}><div><span className="agent-bus-run-state">{busStatusName(latest?.status)}</span><span>{busModeName(executionWorkspace.mode)}</span></div>{latest && <p title={latest.text}>{latest.text}</p>}{latest?.error && <div className="agent-bus-notice" role="status">{busRunErrorText(latest.error)}</div>}</div>
        <div className="agent-bus-start-area" hidden={active}>
          {configDirty ? <div className="agent-bus-notice agent-bus-missing-member" role="status"><span>{t("请先保存配置修改。")}</span><button type="button" onClick={showDivision}>{t("返回配置")}</button></div> : unavailableIssue ? <div className="agent-bus-notice agent-bus-missing-member" role="alert"><span>{unavailableIssue.message}</span><button type="button" onClick={showDivision}>{t("重新选择 Bot")}</button></div> : checkingPermissions ? <div className="agent-bus-permission-check" role="status"><LoaderCircle className="spin" size={14}/>{t("正在检查成员权限…")}</div> : !permissionsReady && <div className="agent-bus-permissions"><ShieldCheck size={16}/><strong>{t("准备成员协作权限")}</strong><button disabled={busy || !online} onClick={() => setPermissionReview(true)}>{t("检查并准备")}</button></div>}
          {online && preparation && <p className="agent-bus-notice" role="status">{permissionsReady ? t("成员已就绪") : preparation}</p>}
          <label className="agent-bus-task"><span>{t("共同目标")}{goalLength > BUS_GOAL_CHARS * 0.9 && <small data-invalid={goalTooLong || undefined}>{goalLength}/{BUS_GOAL_CHARS}</small>}</span><textarea aria-label={t("Bus 共同目标")} aria-describedby={runHintId} aria-invalid={goalTooLong || undefined} rows={3} disabled={busy || active} readOnly={gone} value={task} placeholder={t("本次要达成的目标。每位成员都会收到它和自己的分工。")} onChange={event => { taskVersion.current++; setTask(event.target.value); }}/></label>
        </div>
        <AgentBusDivision config={executionWorkspace} heading={active ? t("本次分工") : changedSinceRun ? t("最近一次运行的分工") : t("分工")} label={label} edit={active ? undefined : showDivision}/>
        <AgentBusFlow config={executionWorkspace} workspace={executionWorkspace} run={latest} selected={runIndex} select={index => { setSelectedRunNode(index); const member = [executionWorkspace.coordinator, ...executionWorkspace.members][index + 1]; if (member) focusMember(member.conversationId); }} label={label} conversationLabel={conversationLabel} visible={visible}/>
        {runMember && <div className="agent-bus-record-link"><span><strong>{label(runMember.botId)} · {conversationLabel(runMember.conversationId)}</strong><small>{busMemberStatus(executionWorkspace, latest, runMember)}</small></span><button onClick={() => focusMember(runMember.conversationId)}>{t("查看记录对话")}<ArrowUp size={13}/></button></div>}
        <button className="agent-bus-reveal" onClick={() => reveal(executionWorkspace)}>{t("在面板中显示成员对话")}</button>
        {changedSinceRun && <div className="agent-bus-next-config" role="status"><span>{t("上方为最近一次运行；下次启动将使用新配置。")}</span><strong>{busModeName(workspace.mode)} · {label(workspace.coordinator.botId)} · {formatList(workspace.members.map(member => label(member.botId)))}</strong></div>}
        {!!detail?.runs.length && <details className="agent-bus-run-history"><summary data-disclosure-icon>{t("最近运行")}<span>{detail.runs.length}</span><ChevronDown size={13} aria-hidden="true"/></summary>{detail.runs.map(run => <article key={run.id}><div><span>{busStatusName(run.status)}</span><time>{new Date(run.createdAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div><p>{run.text}</p><small>{t("{0} 个已记录步骤", run.stages.length)}</small></article>)}</details>}
      </div>}
      {readError && <div className="agent-bus-notice" role="status">{readError}</div>}
      {error && !runError && !permissionReview && !deleting && !stopping && !gone && <div className="agent-bus-error" role="alert">{error}</div>}
    </div>
    <footer className="agent-bus-panel-footer">{tab === "configure" ? <><small id={configHintId} data-invalid={!!configIssue && (configIssue.field !== "name" || !!nameIssue)} aria-live="polite">{gone ? goneText : configIssue?.message ?? (workspace && !configDirty && parkedDraft ? t("暂存的分工尚未保存：切回能容纳它的方式即可恢复，重新载入配置可丢弃。") : t("保存后显示成员对话，任务需手动启动。"))}</small><button className="primary" aria-describedby={configHintId} disabled={!canEdit || !online || !valid || !!workspace && !configDirty} onClick={() => { void save(); }}>{busy ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>} {workspace ? t("保存配置") : t("创建 Bus")}</button></> : active ? <><small>{t("关闭此窗口不会中止协作。")}</small><button className="agent-bus-stop" disabled={busy || !online || latest?.status === "stopping" && !latest.canAbandon} onClick={() => { if (workspace && latest) setStopping({ workspaceId: workspace.id, runId: latest.id, abandon: latest.canAbandon === true }); }}><Square size={13}/>{latest?.canAbandon ? t("结束等待") : latest?.status === "stopping" ? t("正在停止") : t("停止本次协作")}</button></> : <><small id={runHintId} data-invalid={!!runError || goalTooLong} role={runError ? "alert" : undefined} aria-live={runError ? "assertive" : "polite"}>{runError || runHint}</small><button className="primary" aria-describedby={runHintId} disabled={busy || !online || gone || configDirty || checkingPermissions || goalEmpty || goalTooLong || !permissionsReady} onClick={() => { void start(); }}>{busy ? <LoaderCircle className="spin" size={16}/> : <Play size={15}/>} {t("启动协作")}</button></>}</footer>
    {discardGone && <AgentBusDraftDialog kind="leave" close={() => setDiscardGone(false)} discard={() => { setDiscardGone(false); refreshAgentBuses(); removed(); }}/>}
    {reloading && <AgentBusDraftDialog kind="reload" close={() => setReloading(false)} discard={() => { setReloading(false); if (recoveryWorkspace && !workspace) void reloadCreated(); else void read(true); }}/>}
    {permissionReview && <CreationDialog title={t("启用这组协作")} closeLabel={t("关闭协作准备")} showHost={false} busy={busy} close={() => setPermissionReview(false)}><p>{t("允许发起者与所选成员双向协作；未启动的服务会等待当前工作结束后连接。此操作不会发送任务。")}</p><p>{label(config.coordinator.botId)} ↔ {formatList(agentBusPeerIds(config.coordinator.botId, memberIds).map(label))}</p>{error && <p className="agent-bus-error" role="alert">{error}</p>}<footer><button disabled={busy} onClick={() => setPermissionReview(false)}>{t("取消")}</button><button className="primary" disabled={busy || !online || configDirty || !!unavailableIssue} onClick={() => { void prepare(); }}>{t("启用并连接")}</button></footer></CreationDialog>}
    {deleting && <CreationDialog title={t("删除这个 Bus？")} closeLabel={t("关闭")} showHost={false} busy={busy} close={() => setDeleting(false)}><p>{t("仅删除协作配置，成员对话和消息记录都会保留。")}</p>{error && <p className="agent-bus-error" role="alert">{error}</p>}<footer><button onClick={() => setDeleting(false)} disabled={busy}>{t("保留 Bus")}</button><button className="text-danger" disabled={busy || active || !online} onClick={() => { void remove(); }}>{t("删除 Bus")}</button></footer></CreationDialog>}
    {stopping && <CreationDialog title={stopConfirmationCurrent ? stopping.abandon ? t("结束等待？") : t("停止本次协作？") : t("确认已失效")} closeLabel={t("关闭")} showHost={false} busy={busy} close={() => setStopping(undefined)}>{stopConfirmationCurrent ? <><p>{stopping.abandon ? t("发起者已断开，尚未确认任务停止。结束等待会释放此 Bus 的配置，但原任务可能仍在主机上执行。请先查看成员对话，避免重复启动。") : t("已完成的步骤会保留，未执行的步骤不会继续。Bus 配置可以下次再用。")}</p>{error && <p className="agent-bus-error" role="alert">{error}</p>}<footer><button disabled={busy} onClick={() => setStopping(undefined)}>{t("继续协作")}</button><button className="primary" disabled={busy || !online} onClick={() => { void stop(); }}>{stopping.abandon ? t("结束等待") : t("停止本次协作")}</button></footer></> : <><p>{t("协作已结束或发生变化，请关闭此确认。")}</p><footer><button className="primary" disabled={busy} onClick={() => setStopping(undefined)}>{t("关闭")}</button></footer></>}</CreationDialog>}
  </aside></AvatarProvider>;
}

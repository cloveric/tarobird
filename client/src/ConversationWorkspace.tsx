import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, useSyncExternalStore } from "react";
import {
  Ban,
  Bell,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  CornerDownRight,
  ExternalLink,
  FolderOpen,
  Globe,
  HelpCircle,
  Layers,
  ListOrdered,
  LoaderCircle,
  Network,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { type Conversation, type Message } from "../../src/client-protocol/index.js";
import { engineTaskSnapshotSchema, type EngineTask, type SwarmSnapshot } from "../../src/client-protocol/engine-tasks.js";
import { promptQueueSnapshotSchema } from "../../src/client-protocol/prompt-queue.js";
import { conversationFilesPageSchema, type ConversationFile } from "../../src/client-protocol/conversation-files.js";
import { permissionSettingsSchema, type PermissionSettings } from "../../src/client-protocol/permissions.js";
import { BOT_COMMS_LIMIT, conversationBotCommsSchema, type BotCommItem, type ConversationBotComms } from "../../src/client-protocol/workspace-comms.js";
import { nativeRun } from "../../src/client-protocol/run.js";
import { runChangesSummarySchema } from "../../src/client-protocol/run-changes.js";
import { isAgentBusRecord } from "./agent-bus-record.js";
import { messageAttention } from "./attention.js";
import { useAvatarMotion } from "./avatar-motion.js";
import { BotName } from "./BotName.js";
import type { Bot, HubConnection } from "./connection.js";
import { WorkspaceRunChanges } from "./WorkspaceRunChanges.js";
import { engineTaskStatus } from "./EngineTasks.js";
import {
  buildReplyingEntries,
  createWorkspaceQueueReader,
  previewWorkspaceMessage,
  scopePromptQueue,
  type ScopedPromptQueueState,
  type WorkspaceQueueReader,
} from "./workspace-replying.js";
import { listWorkbenchLibrary, type WorkbenchLibraryEntry } from "./workbench-library.js";
import type { WorkbenchFileTarget } from "./workbench-library-context.js";
import { usageTone, type ContextView, type QuotaView } from "./usage-readings.js";
import { formatQuotaWindowLabel, formatResetCountdown } from "./quota-ui.js";
import {
  approvalPlainSummary,
  EmptyStateArt,
  fileKindInfo,
  findApprovalAllowAction,
  formatElapsedBrief,
  formatModelDisplayName,
  HelperCountArt,
  HostComputerArt,
  inspectPendingCardMessage,
  questionPlainSummary,
  SectionHelpButton,
  SignalBarsArt,
  signalStrength,
  WaitingHandArt,
  WorkingMotionArt,
  WorkspaceBotAvatar,
  type PendingCardResolution,
} from "./workspace-visuals.js";
import { localeIntlTag, t, useLocale } from "./i18n.js";
import { formatFileLimit } from "./files.js";
import "./conversation-workspace.css";

export type WorkspaceTab = "overview" | "comms" | "files";
type HelpSectionId = "waiting" | "who" | "doing" | "comms" | "made";

const FILES_PAGE_SIZE = 6;
// A page of Bot messages holds as many whole cards as the rail is tall: four left half of a tall rail empty,
// and a fixed larger number cut a card in two at the bottom edge. A card is about 104px plus the 8px gap (an
// approval card about 135px); the filter row, the pager and the body's padding take about 150px.
const COMMS_PAGE_MIN = 4, COMMS_CARD_PITCH = 114, COMMS_PAGE_CHROME = 150;
export function commsPageSize(bodyHeight: number): number {
  return Math.max(COMMS_PAGE_MIN, Math.floor((bodyHeight - COMMS_PAGE_CHROME) / COMMS_CARD_PITCH));
}

/** Small coloured type badge for a file row (MD, PDF, IMG, TSX, JSON…); the row's meta line names the type in words. */
function fileBadge(name: string, mime?: string): { label: string; tone: string } {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown" || mime === "text/markdown") return { label: "MD", tone: "is-md" };
  if (ext === "pdf" || mime === "application/pdf") return { label: "PDF", tone: "is-pdf" };
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext) || mime?.startsWith("image/")) return { label: "IMG", tone: "is-img" };
  if (["json", "ts", "tsx", "js", "jsx", "py", "go", "rs", "css", "html", "yml", "yaml", "sh", "sql"].includes(ext)) {
    return { label: ext.slice(0, 4).toUpperCase(), tone: "is-code" };
  }
  return { label: (ext || "FILE").slice(0, 4).toUpperCase(), tone: "" };
}

function formatRelativeTime(timestamp: number, locale: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 45) return t("刚刚");
  if (diffSec < 3600) return t("{0} 分钟前", Math.floor(diffSec / 60));
  if (diffSec < 86400) return t("{0} 小时前", Math.floor(diffSec / 3600));
  return new Date(timestamp).toLocaleDateString(localeIntlTag(locale), { month: "short", day: "numeric" });
}

function previewMessage(message: Message | undefined): string {
  return previewWorkspaceMessage(message, t("附件消息"));
}

function commStatusLabel(status: BotCommItem["status"]): string {
  switch (status) {
    case "needs_approval": return t("等你同意");
    case "running": return t("正在处理");
    case "steered": return t("已顺带告诉对方");
    case "queued": return t("排队等回复");
    case "replied": return t("已回复");
    case "failed": return t("失败了");
    case "cancelled": return t("已取消");
    case "uncertain": return t("没收到回音");
  }
}

function commStatusIcon(status: BotCommItem["status"]) {
  switch (status) {
    case "needs_approval": return <Bell size={10} aria-hidden="true"/>;
    case "running": return <LoaderCircle size={10} aria-hidden="true"/>;
    case "steered": return <CornerDownRight size={10} aria-hidden="true"/>;
    case "queued": return <Clock size={10} aria-hidden="true"/>;
    case "replied": return <CheckCircle2 size={10} aria-hidden="true"/>;
    case "failed": return <XCircle size={10} aria-hidden="true"/>;
    case "cancelled": return <Ban size={10} aria-hidden="true"/>;
    case "uncertain": return <HelpCircle size={10} aria-hidden="true"/>;
  }
}

function commDeliveryLabel(delivery: BotCommItem["delivery"]): string | undefined {
  switch (delivery) {
    case "steered": return t("已顺便加进正在进行的回复");
    case "fell_back_to_queue": return t("没赶上这轮，已排到下一轮");
    case "queued": return t("按顺序排队送达");
    case "not_delivered": return t("没有送出去");
    case "steer_uncertain": return t("不确定对方有没有收到");
    case "pending": return t("正在送过去");
    default: return undefined;
  }
}

function workbenchKindLabel(kind: WorkbenchLibraryEntry["kind"]): string {
  if (kind === "whiteboard") return t("白板");
  if (kind === "markdown") return t("文档");
  return t("设计稿");
}

type WaitingApprovalItem = {
  id: string;
  kind: "approval" | "question";
  botName: string;
  conversationId?: string;
  messageId: string;
  title?: string;
  detail?: string;
  allowActionId?: string;
  canOpen: boolean;
  isLocalMessage: boolean;
};

const BOT_COMMS_READ_MS = 20_000;

/** Lightweight hook shared by the header trigger badge and the Workspace panel. */
export function useConversationBotComms(
  connection: HubConnection,
  conversationId: string | undefined,
  enabled: boolean,
  /** The rail is showing. A closed rail only feeds the header badge. */
  visible: boolean,
  /** Changes when a reply in this conversation has ended. */
  turn: string,
) {
  const [data, setData] = useState<ConversationBotComms | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const scope = `${connection.identity.hubPublicKey}:${conversationId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const running = useRef<{ scope: string; again: boolean }>(undefined);
  const available = enabled && !!conversationId && connection.state.status === "online" && !!connection.state.botCommsAvailable;

  /** Resolves false only when the Host was asked and did not answer. */
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!available || !conversationId) return true;
    const reqScope = scopeRef.current;
    if (running.current?.scope === reqScope) { running.current.again = true; return true; }
    const mine = running.current = { scope: reqScope, again: false };
    setLoading(true);
    let answered = true;
    try {
      const raw = await connection.http(`/api/conversations/${encodeURIComponent(conversationId)}/bot-comms`, { signal: AbortSignal.timeout(BOT_COMMS_READ_MS) });
      if (scopeRef.current === reqScope) { setData(conversationBotCommsSchema.parse(raw)); setError(false); }
    } catch {
      if (scopeRef.current === reqScope) { setError(true); answered = false; }
    } finally {
      if (running.current === mine) running.current = undefined;
      if (scopeRef.current === reqScope) setLoading(false);
    }
    if (mine.again && scopeRef.current === reqScope) return latest.current();
    return answered;
  }, [connection, conversationId, available]);
  const latest = useRef(refresh); latest.current = refresh;

  useEffect(() => {
    setData(undefined);
    setError(false);
  }, [scope]);

  useEffect(() => { if (available) void refresh(); }, [available, visible, turn, refresh]);

  const inProgress = (data?.summary.active ?? 0) > 0;
  useEffect(() => {
    if (!available) return;
    const interval = visible ? inProgress ? 6_000 : 30_000 : inProgress ? 30_000 : 0;
    if (!interval) return;
    let delay = interval, stopped = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") delay = await refresh() ? interval : Math.min(delay * 2, 120_000);
      if (!stopped) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [available, visible, inProgress, refresh]);

  return { data, loading, error, refresh };
}

export interface ConversationWorkspaceProps {
  id: string;
  connection: HubConnection;
  conversation: Conversation;
  group?: Conversation;
  bots: Bot[];
  botLabels: ReadonlyMap<string, string>;
  hostName: string;
  connectionSummary: string;
  contextUsage?: ContextView;
  /** The direct Bot's engine quota (tightest window), when the Host can read it; same reading as the composer battery. */
  quotaUsage?: QuotaView;
  streamingBots: string[];
  messages: Message[];
  comms: ConversationBotComms | undefined;
  commsLoading: boolean;
  /** The newest read of the Bot messages failed. */
  commsError?: boolean;
  onRefreshComms: () => void;
  returnFocus?: React.RefObject<HTMLButtonElement | null>;
  /** Set by whoever opens the rail on the person's request; the rail then takes the focus once. */
  takeFocus?: React.RefObject<boolean>;
  onClose: () => void;
  onJumpConversation: (conversationId: string, messageId?: string) => void;
  onLocateMessage: (conversationId: string, messageId: string) => void;
  onOpenAllFiles: () => void;
  onOpenWorkbenchFile: (target: WorkbenchFileTarget) => void;
  onOpenTasksModal?: () => void;
  footerTools?: ReactNode;
  onOpenSwarmBoard?: () => void;
}

export function ConversationWorkspace({
  id,
  connection,
  conversation,
  group,
  bots,
  botLabels,
  hostName,
  connectionSummary,
  contextUsage,
  quotaUsage,
  streamingBots,
  messages,
  comms,
  commsLoading,
  commsError,
  onRefreshComms,
  returnFocus,
  takeFocus,
  onClose,
  onJumpConversation,
  onLocateMessage,
  onOpenAllFiles,
  onOpenWorkbenchFile,
  onOpenTasksModal,
  footerTools,
  onOpenSwarmBoard,
}: ConversationWorkspaceProps) {
  const locale = useLocale();
  const connState = useSyncExternalStore(cb => connection.subscribe(cb), () => connection.state);
  const animatedMotion = useAvatarMotion();
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [commFilter, setCommFilter] = useState<"all" | "active" | "cross_host">("all");
  const [commPage, setCommPage] = useState(0);
  const [fileFilter, setFileFilter] = useState<"all" | "diff" | "files">("all");
  const [filePage, setFilePage] = useState(0);
  const [expandedComms, setExpandedComms] = useState<ReadonlySet<string>>(() => new Set());
  const [openHelp, setOpenHelp] = useState<HelpSectionId | undefined>(undefined);
  const [tasks, setTasks] = useState<EngineTask[]>([]);
  const [swarmSnapshot, setSwarmSnapshot] = useState<SwarmSnapshot | undefined>(undefined);
  const [queueState, setQueueState] = useState<ScopedPromptQueueState | undefined>(undefined);
  const [permissions, setPermissions] = useState<PermissionSettings | undefined>(undefined);
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [filesHasMore, setFilesHasMore] = useState(false);
  const [workbenchItems, setWorkbenchItems] = useState<WorkbenchLibraryEntry[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [approvalLookups, setApprovalLookups] = useState<Record<string, PendingCardResolution>>({});
  const [approvingId, setApprovingId] = useState<string | undefined>(undefined);
  const [approvalNotice, setApprovalNotice] = useState<{ id: string; text: string } | undefined>(undefined);
  const [now, setNow] = useState(Date.now);
  const approveRefreshTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (approveRefreshTimer.current !== undefined) {
      window.clearTimeout(approveRefreshTimer.current);
      approveRefreshTimer.current = undefined;
    }
  }, []);

  const online = connState.status === "online";
  const signal = signalStrength(connState.status, connState.latency);
  const convBots = useMemo(
    () => bots.filter(bot => conversation.botIds.includes(bot.id)),
    [bots, conversation.botIds],
  );
  const directBot = conversation.type === "direct" && convBots.length === 1 ? convBots[0] : undefined;

  useEffect(() => {
    if (approveRefreshTimer.current !== undefined) {
      window.clearTimeout(approveRefreshTimer.current);
      approveRefreshTimer.current = undefined;
    }
    setExpandedComms(new Set());
    setOpenHelp(undefined);
    setCommPage(0);
    setFilePage(0);
    setTasks([]);
    setSwarmSnapshot(undefined);
    setQueueState(undefined);
    setPermissions(undefined);
    setFiles([]);
    setFilesHasMore(false);
    setWorkbenchItems([]);
    setApprovalLookups({});
    setApprovingId(undefined);
    setApprovalNotice(undefined);
    // Another conversation may have no changes, and then no "changes" filter to switch back with.
    setFileFilter("all");
  }, [conversation.id, connection.identity.hubPublicKey]);

  const [settledMessageCount, setSettledMessageCount] = useState(messages.length);
  useEffect(() => {
    const timer = setTimeout(() => setSettledMessageCount(messages.length), 1500);
    return () => clearTimeout(timer);
  }, [messages.length]);

  useEffect(() => { setCommPage(0); }, [commFilter]);
  useEffect(() => { setFilePage(0); }, [fileFilter]);
  useEffect(() => { setOpenHelp(undefined); }, [tab]);

  useEffect(() => {
    const abort = new AbortController();
    const convId = conversation.id;

    void listWorkbenchLibrary(connection, { maxScopes: 200, maxEntries: 500 })
      .then(listing => {
        if (abort.signal.aborted) return;
        setWorkbenchItems(listing.entries.filter(entry => entry.conversationId === convId && entry.state !== "missing").slice(0, 12));
      })
      .catch(() => undefined);

    if (!online) return () => abort.abort();

    const fileParams = new URLSearchParams({ conversationId: convId, q: "" });
    void connection.http(`/api/conversation-files?${fileParams}`, { signal: abort.signal })
      .then(raw => {
        if (abort.signal.aborted) return;
        const page = conversationFilesPageSchema.parse(raw);
        setFiles(page.items.slice(0, 24));
        setFilesHasMore(!!page.nextCursor || page.items.length > 24);
      })
      .catch(() => undefined);

    if (directBot) {
      if (connState.engineTasksAvailable && directBot.online) {
        // `swarmTasks=1`: opt into post-1.6.0 Swarm task metadata and board snapshots; older Hosts ignore it.
        void connection.http(`/api/conversations/${encodeURIComponent(convId)}/tasks?botId=${encodeURIComponent(directBot.id)}&swarmTasks=1`, { signal: abort.signal })
          .then(raw => {
            if (abort.signal.aborted) return;
            const snap = engineTaskSnapshotSchema.parse(raw);
            setTasks(snap.tasks);
            setSwarmSnapshot(snap.swarm);
          })
          .catch(() => undefined);
      }
    }

    return () => abort.abort();
  }, [
    connection,
    conversation.id,
    directBot?.id,
    directBot?.online,
    online,
    connState.engineTasksAvailable,
    refreshTick,
    settledMessageCount,
  ]);

  const queueScope = directBot ? `${connection.identity.hubPublicKey}:${conversation.id}:${directBot.id}` : "";
  const scopedQueue = useMemo(
    () => scopePromptQueue(queueState, queueScope, conversation.id, directBot?.id),
    [queueState, queueScope, conversation.id, directBot?.id],
  );
  const queuedItems = scopedQueue?.items ?? [];
  const dispatchedItems = useMemo(
    () => queuedItems.filter(item => item.state === "dispatched"),
    [queuedItems],
  );
  const waitingItems = useMemo(
    () => queuedItems.filter(item => item.state === "queued"),
    [queuedItems],
  );

  // Refresh the prompt queue promptly when messages arrive or active replies start/finish.
  const queueSignal = useMemo(() => {
    let count = 0;
    let streaming = "";
    let lastBot = "";
    for (const msg of messages) {
      if (msg.conversationId !== conversation.id) continue;
      count++;
      if (msg.authorType !== "bot" || msg.forwardedFrom || isAgentBusRecord(msg)) continue;
      if (msg.status === "streaming") streaming += `${msg.id}:${msg.replyTo ?? ""};`;
      else lastBot = `${msg.id}:${msg.status}`;
    }
    return `${count}|${streaming}|${lastBot}`;
  }, [messages, conversation.id]);

  const queueAvailable = online && !!directBot && !!connection.state.promptQueueAvailable;
  const queueNeedsPoll = queuedItems.length > 0 || (online && streamingBots.length > 0);
  const queueReaderRef = useRef<WorkspaceQueueReader | undefined>(undefined);

  useEffect(() => {
    if (!queueAvailable || !directBot) return;
    const convId = conversation.id;
    const botId = directBot.id;
    const scope = queueScope;
    const reader = createWorkspaceQueueReader({
      fetch: async signal => {
        const raw = await connection.http(
          `/api/conversations/${encodeURIComponent(convId)}/queue?${new URLSearchParams({ botId })}`,
          { signal },
        );
        return promptQueueSnapshotSchema.parse(raw);
      },
      onSnapshot: snapshot => {
        setQueueState({ scope, snapshot });
      },
    });
    queueReaderRef.current = reader;
    const onVisibility = () => reader.onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      reader.dispose();
      if (queueReaderRef.current === reader) queueReaderRef.current = undefined;
    };
  }, [connection, conversation.id, directBot?.id, queueAvailable, queueScope]);

  useEffect(() => {
    if (!queueAvailable) return;
    queueReaderRef.current?.trigger();
  }, [queueAvailable, queueScope, queueSignal, refreshTick]);

  useEffect(() => {
    queueReaderRef.current?.setPolling(queueAvailable && queueNeedsPoll);
  }, [queueAvailable, queueScope, queueNeedsPoll]);

  // The permission mode is a Bot setting, owner-only on the Host: read when the rail opens for a Bot and on a
  // manual refresh, not with every message.
  const mayReadPermissions = online && connState.user?.role === "owner" && !!directBot?.online;
  useEffect(() => {
    if (!directBot || !mayReadPermissions) return;
    const abort = new AbortController();
    void connection.http(`/api/bots/${encodeURIComponent(directBot.id)}/permissions`, { signal: abort.signal })
      .then(raw => { if (!abort.signal.aborted) setPermissions(permissionSettingsSchema.parse(raw)); })
      .catch(() => undefined);
    return () => abort.abort();
  }, [connection, directBot?.id, mayReadPermissions, refreshTick]);

  const diffMessages = useMemo(() => {
    if (connState.user?.role !== "owner") return [];
    const found: Message[] = [];
    for (let i = messages.length - 1; i >= 0 && found.length < 4; i--) {
      const msg = messages[i]!;
      if (msg.authorType !== "bot") continue;
      const block = msg.blocks.find(b => b.type === "card" && nativeRun(b));
      if (!block || block.type !== "card") continue;
      const run = nativeRun(block);
      const parsed = runChangesSummarySchema.safeParse(block.extra?.runChanges);
      if (run && parsed.success && parsed.data.runId === run.id && parsed.data.revision === run.revision && parsed.data.files > 0) {
        found.push(msg);
      }
    }
    return found;
  }, [messages, connState.user?.role]);

  const activeTasks = useMemo(() => tasks.filter(task => task.status === "running"), [tasks]);
  const subagentTasks = useMemo(() => activeTasks.filter(task => task.kind === "subagent"), [activeTasks]);
  const otherActiveTasks = useMemo(() => activeTasks.filter(task => task.kind !== "subagent"), [activeTasks]);

  const localMessagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const msg of messages) {
      if (msg.conversationId === conversation.id) map.set(msg.id, msg);
    }
    return map;
  }, [messages, conversation.id]);

  const replyingEntries = useMemo(
    () => buildReplyingEntries({
      messages,
      conversationId: conversation.id,
      online,
      directBotId: directBot?.id,
      dispatchedItems,
      streamingBots,
      resolveBotName: botId => botLabels.get(botId) ?? bots.find(bot => bot.id === botId)?.name ?? botId,
      attachmentLabel: t("附件消息"),
    }),
    [messages, conversation.id, online, directBot?.id, dispatchedItems, streamingBots, botLabels, bots, locale],
  );

  const hasReplying = replyingEntries.length > 0;
  useEffect(() => {
    if (!hasReplying || !online) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasReplying, online]);
  const observedNow = now + (connState.serverTimeOffset ?? 0);
  const commItems = comms?.items ?? [];

  const resolveCommPending = useCallback((comm: BotCommItem): PendingCardResolution | undefined => {
    const msgId = comm.pendingApproval?.messageId;
    if (!msgId) return undefined;
    const isIncoming = comm.direction === "incoming";
    const approvalConvId = isIncoming ? conversation.id : comm.targetConversationId;
    if (!approvalConvId) return undefined;
    if (approvalConvId === conversation.id) {
      const localMsg = localMessagesById.get(msgId);
      return localMsg ? inspectPendingCardMessage(localMsg) : { kind: "open_only" };
    }
    return approvalLookups[`${approvalConvId}:${msgId}`];
  }, [conversation.id, localMessagesById, approvalLookups]);

  // Pending approvals promoted to the highlighted amber Waiting for you block at the top of Overview.
  const waitingApprovals = useMemo<WaitingApprovalItem[]>(() => {
    const items: WaitingApprovalItem[] = [];
    const seenMessages = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.conversationId !== conversation.id || msg.historyContext) continue;
      if (messageAttention(msg)?.kind !== "approval") continue;
      const allowActionId = findApprovalAllowAction(msg);
      const card = msg.blocks.find((b): b is Extract<Message["blocks"][number], { type: "card" }> => b.type === "card");
      const detail = card ? card.elements.filter(e => e.type === "markdown").map(e => e.text ?? "").join(" ").trim() : "";
      seenMessages.add(`${msg.conversationId}:${msg.id}`);
      items.push({
        id: `msg:${msg.id}`,
        kind: "approval",
        botName: botLabels.get(msg.authorId) ?? bots.find(b => b.id === msg.authorId)?.name ?? msg.authorId,
        conversationId: msg.conversationId,
        messageId: msg.id,
        title: card?.title,
        detail: detail || undefined,
        allowActionId,
        canOpen: true,
        isLocalMessage: true,
      });
    }
    for (const comm of commItems) {
      if (comm.status !== "needs_approval" || !comm.pendingApproval) continue;
      const isIncoming = comm.direction === "incoming";
      const approvalConversationId = isIncoming ? conversation.id : comm.targetConversationId;
      const msgId = comm.pendingApproval.messageId;
      const msgKey = `${approvalConversationId ?? ""}:${msgId}`;
      if (seenMessages.has(msgKey)) continue;
      const resolution = resolveCommPending(comm);
      if (resolution?.kind === "excluded") continue;
      seenMessages.add(msgKey);
      items.push({
        id: `comm:${comm.id}`,
        kind: resolution?.kind === "question" ? "question" : "approval",
        botName: comm.targetBotName,
        conversationId: approvalConversationId,
        messageId: msgId,
        title: comm.pendingApproval.title,
        detail: comm.pendingApproval.detail,
        allowActionId: resolution?.kind === "approval" ? resolution.actionId : undefined,
        canOpen: isIncoming ? true : (comm.canJumpToTarget && !!comm.targetConversationId),
        isLocalMessage: isIncoming || approvalConversationId === conversation.id,
      });
    }
    return items;
  }, [messages, conversation.id, botLabels, bots, commItems, resolveCommPending]);

  // Lazily resolve direct approval button IDs and card kinds for jumpable outgoing Bot-to-Bot items.
  // Incoming items own their pending card in the current conversation and never fetch targetConversationId/messages.
  const remotePendingTargets = useMemo(() => {
    const out: { key: string; convId: string; msgId: string }[] = [];
    const seen = new Set<string>();
    for (const comm of commItems) {
      if (comm.status !== "needs_approval" || comm.direction === "incoming") continue;
      if (!comm.canJumpToTarget || !comm.targetConversationId || comm.targetConversationId === conversation.id) continue;
      const msgId = comm.pendingApproval?.messageId;
      if (!msgId) continue;
      const key = `${comm.targetConversationId}:${msgId}`;
      if (seen.has(key) || key in approvalLookups) continue;
      seen.add(key);
      out.push({ key, convId: comm.targetConversationId, msgId });
    }
    return out;
  }, [commItems, conversation.id, approvalLookups]);

  const remotePendingSignature = remotePendingTargets.map(target => target.key).join("\n");
  const remotePendingTargetsRef = useRef(remotePendingTargets);
  remotePendingTargetsRef.current = remotePendingTargets;

  useEffect(() => {
    if (!online || !remotePendingSignature) return;
    const targets = remotePendingTargetsRef.current;
    if (!targets.length) return;
    const abort = new AbortController();
    void Promise.all(targets.map(async ({ key, convId, msgId }) => {
      let resolution: PendingCardResolution = { kind: "open_only" };
      try {
        const cached = await connection.cache.messages(convId).catch(() => []);
        let target = cached.find(m => m.id === msgId);
        if (!target) {
          const raw = await connection.http<{ messages?: Message[] }>(`/api/conversations/${encodeURIComponent(convId)}/messages`, { signal: abort.signal });
          target = raw.messages?.find(m => m.id === msgId);
        }
        resolution = inspectPendingCardMessage(target);
      } catch {
        if (abort.signal.aborted) return;
        resolution = { kind: "open_only" };
      }
      if (!abort.signal.aborted) {
        setApprovalLookups(prev => key in prev ? prev : { ...prev, [key]: resolution });
      }
    }));
    return () => abort.abort();
  }, [online, connection, remotePendingSignature]);

  const handleApprove = async (item: WaitingApprovalItem) => {
    if (!online || connection.isReadOnly || !item.conversationId || item.kind !== "approval" || !item.allowActionId) return;
    setApprovingId(item.id);
    setApprovalNotice(undefined);
    let scheduled = false;
    try {
      await connection.send({
        v: 1,
        type: "interaction.submit",
        conversationId: item.conversationId,
        messageId: item.messageId,
        actionId: item.allowActionId,
        values: {},
        clientActionId: `action_${crypto.randomUUID()}`,
      });
      onRefreshComms();
      if (approveRefreshTimer.current !== undefined) window.clearTimeout(approveRefreshTimer.current);
      scheduled = true;
      approveRefreshTimer.current = window.setTimeout(() => {
        approveRefreshTimer.current = undefined;
        onRefreshComms();
        setApprovingId(current => current === item.id ? undefined : current);
      }, 450);
    } catch {
      setApprovalNotice({ id: item.id, text: t("暂时无法直接同意，点「去看看」在原对话里处理。") });
    } finally {
      if (!scheduled) setApprovingId(current => current === item.id ? undefined : current);
    }
  };

  const filteredComms = useMemo(() => {
    if (commFilter === "active") {
      return commItems.filter(item => item.status === "needs_approval" || item.status === "running" || item.status === "steered" || item.status === "queued");
    }
    if (commFilter === "cross_host") {
      return commItems.filter(item => item.crossHost);
    }
    return commItems;
  }, [commItems, commFilter]);

  const body = useRef<HTMLDivElement>(null);
  const [commPageSize, setCommPageSize] = useState(COMMS_PAGE_MIN);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const fit = () => setCommPageSize(commsPageSize(node.clientHeight));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || tab !== "comms" || expandedComms.size > 0 || commPageSize <= COMMS_PAGE_MIN) return;
    if (node.scrollHeight > node.clientHeight + 1) setCommPageSize(size => Math.max(COMMS_PAGE_MIN, size - 1));
  });
  const commTotalPages = Math.max(1, Math.ceil(filteredComms.length / commPageSize));
  useEffect(() => { if (commPage > commTotalPages - 1) setCommPage(commTotalPages - 1); }, [commPage, commTotalPages]);
  const shownCommPage = Math.min(commPage, commTotalPages - 1);
  const pagedComms = filteredComms.slice(shownCommPage * commPageSize, (shownCommPage + 1) * commPageSize);

  const fileArtifacts = useMemo(() => [
    ...workbenchItems.map(entry => ({
      kind: "workbench" as const,
      key: `wb:${entry.kind}:${entry.id}`,
      name: entry.title || workbenchKindLabel(entry.kind),
      badgeLabel: entry.kind === "whiteboard" ? "WB" : entry.kind === "markdown" ? "DOC" : "DES",
      badgeTone: "is-wb",
      meta: t("工作台 · {0}", workbenchKindLabel(entry.kind)),
      entry,
    })),
    ...files.map(file => {
      const info = fileKindInfo(file.name, file.mime), badge = fileBadge(file.name, file.mime);
      return {
        kind: "file" as const,
        key: `file:${file.attachmentId}:${file.messageId}`,
        name: file.name,
        badgeLabel: badge.label,
        badgeTone: badge.tone,
        meta: `${info.label} · ${formatFileLimit(file.size)} · ${formatRelativeTime(file.createdAt, locale)}`,
        file,
      };
    }),
  ], [workbenchItems, files, locale]);

  const fileTotalPages = Math.max(1, Math.ceil(fileArtifacts.length / FILES_PAGE_SIZE));
  useEffect(() => { if (filePage > fileTotalPages - 1) setFilePage(fileTotalPages - 1); }, [filePage, fileTotalPages]);
  const shownFilePage = Math.min(filePage, fileTotalPages - 1);
  const pagedFileArtifacts = fileArtifacts.slice(shownFilePage * FILES_PAGE_SIZE, (shownFilePage + 1) * FILES_PAGE_SIZE);

  const artifactsCount = diffMessages.length + fileArtifacts.length;
  const permissionLabel = useMemo(() => {
    if (!permissions) return undefined;
    return permissions.choices.find(c => c.id === permissions.choice)?.label ?? permissions.choice;
  }, [permissions]);

  const toggleCommExpand = (itemId: string) => {
    setExpandedComms(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const handleRefreshAll = () => {
    setRefreshTick(n => n + 1);
    onRefreshComms();
  };

  const openArtifact = (artifact: (typeof fileArtifacts)[number]) => {
    if (artifact.kind === "workbench") {
      onOpenWorkbenchFile({
        scope: artifact.entry.scope,
        conversationId: artifact.entry.conversationId,
        id: artifact.entry.id,
        kind: artifact.entry.kind,
        title: artifact.entry.title || workbenchKindLabel(artifact.entry.kind),
      });
    } else {
      onLocateMessage(artifact.file.conversationId, artifact.file.messageId);
    }
  };

  const renderCommCard = (item: BotCommItem, compact: boolean) => {
    const expanded = expandedComms.has(item.id);
    const deliveryLabel = commDeliveryLabel(item.delivery);
    const needsApproval = item.status === "needs_approval";
    const pendingResolution = needsApproval ? resolveCommPending(item) : undefined;
    const isQuestion = needsApproval && pendingResolution?.kind === "question";
    const statusClass =
      item.status === "needs_approval" ? "is-needs-approval"
        : item.status === "replied" ? "is-replied"
          : item.status === "running" ? "is-running"
            : item.status === "steered" ? "is-steered"
              : item.status === "failed" ? "is-failed"
                : item.status === "cancelled" ? "is-cancelled"
                  : item.status === "uncertain" ? "is-uncertain"
                    : "is-queued";
    return (
      <article key={item.id} className={`workspace-comm-card${compact ? " is-compact" : ""}${needsApproval ? " is-needs-approval" : ""}`}>
        <div className="workspace-comm-top">
          <div className="workspace-comm-route">
            <span className="workspace-comm-bot" title={item.sourceBotName}>
              <WorkspaceBotAvatar hostId={item.sourceHostId} botId={item.sourceBotId} name={item.sourceBotName} size={18} />
              <span className="workspace-comm-bot-name">{item.sourceBotName}</span>
            </span>
            <span className="workspace-comm-arrow" aria-hidden="true">→</span>
            <span className="workspace-comm-bot" title={item.targetBotName}>
              <WorkspaceBotAvatar hostId={item.targetHostId} botId={item.targetBotId} name={item.targetBotName} size={18} />
              <span className="workspace-comm-bot-name">{item.targetBotName}</span>
            </span>
          </div>
          <span className={`workspace-comm-status ${statusClass}`}>
            {commStatusIcon(item.status)}
            <span>{isQuestion ? t("等你回答") : commStatusLabel(item.status)}</span>
          </span>
        </div>
        {!compact && (
          <div className="workspace-comm-sub">
            {item.crossHost && (
              <span className="workspace-chip is-accent">
                <Globe size={10} aria-hidden="true"/>
                {t("另一台电脑 · {0}", item.direction === "outgoing" ? item.targetHostName : item.sourceHostName)}
              </span>
            )}
            {item.kind === "agent_bus_stage" && item.workspaceName && (
              <span className="workspace-chip">
                <Network size={10} aria-hidden="true"/>
                {item.workspaceName}
              </span>
            )}
            {item.direction === "incoming" && <span>{t("对方来找这边帮忙")}</span>}
            {deliveryLabel && item.kind !== "agent_bus_stage" && <span>{deliveryLabel}</span>}
            <span>{formatRelativeTime(item.updatedAt, locale)}</span>
          </div>
        )}
        {!compact && needsApproval && item.pendingApproval && (
          <div className="workspace-comm-alert-box">
            <strong>
              {isQuestion
                ? questionPlainSummary(item.targetBotName, item.pendingApproval.title)
                : approvalPlainSummary(item.targetBotName, item.pendingApproval.title, item.pendingApproval.detail)}
            </strong>
            {item.pendingApproval.detail && <span title={item.pendingApproval.detail}>{item.pendingApproval.detail}</span>}
          </div>
        )}
        {!expanded && (compact || !(needsApproval && item.pendingApproval)) && (item.replyExcerpt || item.pendingApproval?.detail || item.sentExcerpt) && (
          <p className="workspace-comm-excerpt" title={item.replyExcerpt ?? item.pendingApproval?.detail ?? item.sentExcerpt}>
            {item.replyExcerpt ?? item.pendingApproval?.detail ?? item.sentExcerpt}
          </p>
        )}
        {expanded && (
          <div className="workspace-comm-expanded">
            {item.sentExcerpt && (
              <div>
                <span className="workspace-comm-expanded-label">{t("托付给对方的话")}</span>
                <div>{item.sentExcerpt}</div>
              </div>
            )}
            {item.replyExcerpt && (
              <div>
                <span className="workspace-comm-expanded-label">{item.status === "failed" ? t("出了什么错") : t("对方回的话")}</span>
                <div>{item.replyExcerpt}</div>
              </div>
            )}
            {item.targetConversationTitle && (
              <div>
                <span className="workspace-comm-expanded-label">{t("所在对话")}</span>
                <div>{item.targetConversationTitle}</div>
              </div>
            )}
          </div>
        )}
        <div className="workspace-comm-actions">
          {(item.sentExcerpt || item.replyExcerpt) && (
            <button type="button" onClick={() => toggleCommExpand(item.id)}>
              {expanded ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
              <span>{expanded ? t("收起") : t("展开详情")}</span>
            </button>
          )}
          {item.canJumpToTarget && item.targetConversationId && (
            <button
              type="button"
              className={`workspace-jump-btn${needsApproval ? " is-alert" : ""}`}
              onClick={() => {
                if (needsApproval && item.pendingApproval && item.direction === "incoming") {
                  onLocateMessage(conversation.id, item.pendingApproval.messageId);
                } else {
                  onJumpConversation(item.targetConversationId!, item.pendingApproval?.messageId ?? item.targetMessageId);
                }
              }}
            >
              <span>{needsApproval ? (isQuestion ? t("去看看") : t("去批准")) : t("去看看")}</span>
              <ExternalLink size={11} aria-hidden="true"/>
            </button>
          )}
        </div>
      </article>
    );
  };

  const renderArtifactTile = (artifact: (typeof fileArtifacts)[number]) => (
    <button
      key={artifact.key}
      type="button"
      className="workspace-file-tile"
      title={artifact.name}
      onClick={() => openArtifact(artifact)}
    >
      <span className={`workspace-file-badge ${artifact.badgeTone}${artifact.badgeLabel.length > 3 ? " is-long" : ""}`} aria-hidden="true">{artifact.badgeLabel}</span>
      <span className="workspace-file-tile-text">
        <span className="workspace-file-tile-name">{artifact.name}</span>
        <span className="workspace-file-tile-meta">{artifact.meta}</span>
      </span>
    </button>
  );

  const tabList = useRef<HTMLDivElement>(null);
  const onTabKey = (event: React.KeyboardEvent) => {
    const order: WorkspaceTab[] = ["overview", "comms", "files"], at = order.indexOf(tab);
    const next = event.key === "ArrowRight" ? order[(at + 1) % order.length]
      : event.key === "ArrowLeft" ? order[(at + order.length - 1) % order.length]
        : event.key === "Home" ? order[0] : event.key === "End" ? order.at(-1) : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[order.indexOf(next)]?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!takeFocus?.current) return;
    takeFocus.current = false;
    tabList.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [takeFocus]);

  const close = () => {
    onClose();
    returnFocus?.current?.focus({ preventScroll: true });
  };

  const readableModel = directBot ? formatModelDisplayName(directBot.model, directBot.engine) : undefined;
  const rawModelTitle = directBot ? [directBot.engine, directBot.model, directBot.effort].filter(Boolean).join(" · ") : undefined;
  const overviewFileSlice = diffMessages.length > 0 ? 2 : 3;

  const content = (
    <>
      <div className="workspace-tabs" role="tablist" aria-label={t("工作区标签")} ref={tabList} onKeyDown={onTabKey}>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          id={`${id}-tab-overview`}
          aria-controls={`${id}-panel`}
          aria-selected={tab === "overview"}
          tabIndex={tab === "overview" ? 0 : -1}
          onClick={() => setTab("overview")}
        >
          <span>{t("总览")}</span>
        </button>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          id={`${id}-tab-comms`}
          aria-controls={`${id}-panel`}
          aria-selected={tab === "comms"}
          tabIndex={tab === "comms" ? 0 : -1}
          onClick={() => setTab("comms")}
        >
          <span>{t("Bot 通信")}</span>
          {commItems.length > 0 && (
            <span className={`workspace-tab-count${(comms?.summary.needsApproval ?? 0) > 0 ? " is-alert" : (comms?.summary.active ?? 0) > 0 ? " is-active" : ""}`}>
              {commItems.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          id={`${id}-tab-files`}
          aria-controls={`${id}-panel`}
          aria-selected={tab === "files"}
          tabIndex={tab === "files" ? 0 : -1}
          onClick={() => setTab("files")}
        >
          <span>{t("文件")}</span>
          {artifactsCount > 0 && <span className="workspace-tab-count">{artifactsCount}</span>}
        </button>
      </div>

      <div className="workspace-body" ref={body} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
        {tab === "overview" && (
          <>
            {/* 0. Waiting for you: promoted highlighted amber block whenever approvals are pending */}
            {waitingApprovals.length > 0 && (
              <section className="workspace-section workspace-waiting-section" aria-label={t("等你确认")}>
                <div className="workspace-section-header">
                  <span className="workspace-section-title is-waiting">
                    <span>{t("等你确认")}</span>
                    <span className="workspace-waiting-count">{waitingApprovals.length}</span>
                    <SectionHelpButton
                      title={t("等你确认")}
                      description={t("Bot 要运行命令或改动重要内容前，会先停下来请你点头。点「同意」就能继续，或点「去看看」查看完整上下文。")}
                      art={<WaitingHandArt />}
                      open={openHelp === "waiting"}
                      onToggle={() => setOpenHelp(prev => prev === "waiting" ? undefined : "waiting")}
                      onClose={() => setOpenHelp(undefined)}
                    />
                  </span>
                </div>
                <div className="workspace-list">
                  {waitingApprovals.slice(0, 2).map(item => {
                    const canApprove = item.kind === "approval" && !!item.allowActionId;
                    return (
                      <article key={item.id} className="workspace-waiting-card">
                        <div className="workspace-waiting-body">
                          <WaitingHandArt />
                          <div className="workspace-waiting-text">
                            <strong className="workspace-waiting-title">
                              {item.kind === "question"
                                ? questionPlainSummary(item.botName, item.title)
                                : approvalPlainSummary(item.botName, item.title, item.detail)}
                            </strong>
                            {item.detail && (
                              <span className="workspace-waiting-detail" title={item.detail}>
                                {item.detail}
                              </span>
                            )}
                          </div>
                        </div>
                        {(canApprove || item.canOpen) && (
                          <div className="workspace-waiting-actions">
                            {canApprove && (
                              <button
                                type="button"
                                className="workspace-approve-btn"
                                disabled={connection.isReadOnly || !online || approvingId === item.id}
                                onClick={() => { void handleApprove(item); }}
                              >
                                {approvingId === item.id ? t("正在同意…") : t("同意")}
                              </button>
                            )}
                            {item.canOpen && (
                              <button
                                type="button"
                                className="workspace-open-btn"
                                onClick={() => {
                                  if (item.isLocalMessage) onLocateMessage(item.conversationId!, item.messageId);
                                  else onJumpConversation(item.conversationId!, item.messageId);
                                }}
                              >
                                <span>{t("去看看")}</span>
                                <ExternalLink size={11} aria-hidden="true"/>
                              </button>
                            )}
                          </div>
                        )}
                        {approvalNotice?.id === item.id && (
                          <p className="workspace-waiting-notice" role="status">{approvalNotice.text}</p>
                        )}
                      </article>
                    );
                  })}
                  {waitingApprovals.length > 2 && (
                    <div className="workspace-more-hint">{t("还有 {0} 件事在等你同意", waitingApprovals.length - 2)}</div>
                  )}
                </div>
              </section>
            )}

            {/* 1. Who is helping you (Environment & Context) */}
            <section className="workspace-section" aria-label={t("环境与上下文")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <span>{t("环境与上下文")}</span>
                  <SectionHelpButton
                    title={t("环境与上下文")}
                    description={t("显示现在是谁在陪你聊天、它连在哪台电脑上，以及网络顺不顺畅、对话记忆还剩多少。")}
                    art={<HostComputerArt online={online} />}
                    open={openHelp === "who"}
                    onToggle={() => setOpenHelp(prev => prev === "who" ? undefined : "who")}
                    onClose={() => setOpenHelp(undefined)}
                  />
                </span>
              </div>
              <div className="workspace-env-card">
                <div className="workspace-env-top">
                  <span className="workspace-env-host" title={hostName}>
                    <HostComputerArt online={online} />
                    <span className="workspace-env-hostname">{hostName}</span>
                  </span>
                  <span className={`workspace-env-signal is-${signal.tone}`} title={connectionSummary}>
                    <SignalBarsArt bars={signal.bars} tone={signal.tone} />
                    <span>{signal.label}</span>
                  </span>
                </div>
                <div className="workspace-env-meta">
                  {directBot ? (
                    <>
                      <span className="workspace-env-bot">
                        <BotName id={directBot.id} name={botLabels.get(directBot.id) ?? directBot.name} bot={directBot} />
                      </span>
                      {readableModel && (
                        <span className="workspace-env-model" title={rawModelTitle}>{readableModel}</span>
                      )}
                      <span className={`workspace-chip${directBot.online ? " is-online" : " is-offline"}`}>
                        {directBot.online ? t("在线") : t("离线")}
                      </span>
                      {permissionLabel && (
                        <span className="workspace-chip is-accent">
                          <ShieldCheck size={10} aria-hidden="true"/>
                          <span>{permissionLabel}</span>
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="workspace-env-bot">
                        <Users size={11} aria-hidden="true"/> {t("{0} 位 Bot", convBots.length)}
                      </span>
                      {convBots.slice(0, 3).map(bot => (
                        <span key={bot.id} className={`workspace-chip${bot.online ? " is-online" : ""}`}>
                          {botLabels.get(bot.id) ?? bot.name}
                        </span>
                      ))}
                      {convBots.length > 3 && (
                        <span className="workspace-chip" title={convBots.slice(3).map(bot => botLabels.get(bot.id) ?? bot.name).join("、")}>
                          +{convBots.length - 3}
                        </span>
                      )}
                    </>
                  )}
                  {group && conversation.parentId && (
                    <span className="workspace-chip">{t("话题 · {0}", group.title)}</span>
                  )}
                </div>
                {directBot && contextUsage && (
                  <div className="workspace-memory-row" title={t("对话记忆已用 {0}%，还剩 {1}% 可用", 100 - contextUsage.left, contextUsage.left)}>
                    <span className="workspace-memory-label">{t("记忆")}</span>
                    <span className="workspace-memory-bar" role="meter" aria-label={t("记忆空间")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextUsage.left}>
                      <i className={`is-${usageTone(contextUsage.left)}`} style={{ width: `${contextUsage.left}%` }} />
                    </span>
                    <span className={`workspace-memory-pct is-${usageTone(contextUsage.left)}`}>
                      {t("剩 {0}%", contextUsage.left)}
                    </span>
                  </div>
                )}
                {directBot && quotaUsage && (
                  <div
                    className={`workspace-memory-row workspace-quota-row${quotaUsage.stale ? " is-stale" : ""}`}
                    title={quotaUsage.windows.map(window => {
                      const name = formatQuotaWindowLabel(window, quotaUsage.windows);
                      const reset = window.resetsAt ? formatResetCountdown(window.resetsAt, Date.now()).text : "";
                      return reset ? t("{0} 剩 {1}%，{2}", name, window.left, reset) : t("{0} 剩 {1}%", name, window.left);
                    }).join("\n")}
                  >
                    <span className="workspace-memory-label">{t("额度")}</span>
                    <span className="workspace-memory-bar" role="meter" aria-label={t("额度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quotaUsage.left}>
                      <i className={`is-${usageTone(quotaUsage.left)}`} style={{ width: `${quotaUsage.left}%` }} />
                    </span>
                    <span className={`workspace-memory-pct is-${usageTone(quotaUsage.left)}`}>
                      {t("剩 {0}%", quotaUsage.left)}
                    </span>
                  </div>
                )}
              </div>
            </section>

            {/* 2. Doing now (deduplicated replying vs waiting queue + helper count) */}
            <section className="workspace-section" aria-label={t("任务")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <span>{t("任务")}</span>
                  <SectionHelpButton
                    title={t("任务")}
                    description={t("看 Bot 这会儿正在忙什么、有没有请小帮手分担，以及后面还有几条话在排队等着处理。")}
                    art={<HelperCountArt />}
                    open={openHelp === "doing"}
                    onToggle={() => setOpenHelp(prev => prev === "doing" ? undefined : "doing")}
                    onClose={() => setOpenHelp(undefined)}
                  />
                </span>
                <span className="workspace-section-right">
                  {waitingItems.length > 0 && (
                    <span className="workspace-queue-pill">
                      {t("排队 {0}", waitingItems.length)}
                    </span>
                  )}
                  {onOpenSwarmBoard && swarmSnapshot && (
                    <button type="button" className="workspace-section-action" onClick={onOpenSwarmBoard}>
                      {t("查看看板")}
                    </button>
                  )}
                  {onOpenTasksModal && directBot && connState.engineTasksAvailable && (
                    <button type="button" className="workspace-section-action" onClick={onOpenTasksModal}>
                      {t("全部任务")}
                    </button>
                  )}
                </span>
              </div>
              {activeTasks.length > 0 || waitingItems.length > 0 || replyingEntries.length > 0 || swarmSnapshot ? (
                <div className="workspace-list">
                  {swarmSnapshot && (
                    <div className="workspace-item-row">
                      <span className="workspace-item-icon"><span className={`status-dot${swarmSnapshot.active ? " online" : ""}`}/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">{swarmSnapshot.title || "Swarm"}</span>
                        <span className="workspace-item-meta">
                          {swarmSnapshot.active
                            ? t("Swarm 进行中 · {0} 位活跃成员，{1} 条看板动态", swarmSnapshot.members.filter(m => m.state === "working" || m.state === "waiting" || m.state === "paused").length, swarmSnapshot.posts.length)
                            : swarmSnapshot.statusText === "Stopped by user"
                              ? t("Swarm 已停止 · {0} 位成员，{1} 条看板动态", swarmSnapshot.members.length, swarmSnapshot.posts.length)
                              : t("Swarm 已结束 · {0} 位成员，{1} 条看板动态", swarmSnapshot.members.length, swarmSnapshot.posts.length)}
                        </span>
                      </span>
                    </div>
                  )}
                  {replyingEntries.map(entry => (
                    <div key={entry.key} className="workspace-item-row workspace-replying-row">
                      <span className="workspace-item-icon"><WorkingMotionArt animated={animatedMotion} /></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title" title={entry.text || undefined}>{entry.text || t("正在回复")}</span>
                        <span className="workspace-item-meta">
                          {entry.text ? t("正在回复 · {0}", entry.botName) : entry.botName}
                          {entry.startedAt ? ` · ${t("已做 {0}", formatElapsedBrief(entry.startedAt, observedNow))}` : ""}
                        </span>
                      </span>
                    </div>
                  ))}
                  {subagentTasks.length > 0 && (
                    <div className="workspace-item-row workspace-helper-row">
                      <span className="workspace-item-icon"><HelperCountArt /></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">
                          {subagentTasks.length === 1 ? t("请了 1 个小帮手") : t("请了 {0} 个小帮手", subagentTasks.length)}
                        </span>
                        <span className="workspace-item-meta" title={subagentTasks.map(task => task.label || task.id).join(" · ")}>
                          {subagentTasks.slice(0, 2).map(task => task.label || task.id).join(" · ")}
                        </span>
                      </span>
                    </div>
                  )}
                  {otherActiveTasks.slice(0, 2).map(task => (
                    <div key={task.id} className="workspace-item-row">
                      <span className="workspace-item-icon"><WorkingMotionArt animated={animatedMotion} /></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">{task.label || task.id}</span>
                        <span className="workspace-item-meta">{task.swarmState ? `${t("Swarm Worker")} · ${engineTaskStatus(task)}` : task.kind === "shell" ? t("正在运行命令") : t("后台小任务")}</span>
                      </span>
                    </div>
                  ))}
                  {waitingItems.slice(0, 2).map((item, idx) => (
                    <div key={item.message.id} className="workspace-item-row workspace-queue-row">
                      <span className="workspace-item-icon"><ListOrdered size={12}/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title" title={previewMessage(item.message) || undefined}>{previewMessage(item.message) || t("排队消息 #{0}", idx + 1)}</span>
                        <span className="workspace-item-meta">{online ? t("队列第 {0} 位", idx + 1) : t("{0} · {1}", t("队列第 {0} 位", idx + 1), t("离线"))}</span>
                      </span>
                    </div>
                  ))}
                  {(otherActiveTasks.length > 2 || waitingItems.length > 2) && (
                    <div className="workspace-more-hint">
                      {[otherActiveTasks.length > 2 ? t("还有 {0} 个后台任务", otherActiveTasks.length - 2) : "", waitingItems.length > 2 ? t("另有 {0} 条排队消息", waitingItems.length - 2) : ""].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="workspace-idle-strip">
                  <span>{t("当前空闲，无运行中或排队任务。")}</span>
                </div>
              )}
            </section>

            {/* 3. Bot-to-Bot Comms (the ONE place with Bot avatars; auto-hidden in Overview when 0 items) */}
            {commItems.length > 0 && (
              <section className="workspace-section" aria-label={t("Bot 间通信")}>
                <div className="workspace-section-header">
                  <span className="workspace-section-title">
                    <span>{t("Bot 间通信")}</span>
                    <SectionHelpButton
                      title={t("Bot 间通信")}
                      description={t("当你的 Bot 请别的 Bot 帮忙（甚至在另一台电脑上），它们谁找谁、进展到哪一步、回说了什么，都会用头像连线展示在这里。")}
                      art={<EmptyStateArt kind="comms" />}
                      open={openHelp === "comms"}
                      onToggle={() => setOpenHelp(prev => prev === "comms" ? undefined : "comms")}
                      onClose={() => setOpenHelp(undefined)}
                    />
                  </span>
                  {commItems.length > 2 && (
                    <button type="button" className="workspace-section-action" onClick={() => setTab("comms")}>
                      {t("查看全部 ({0})", commItems.length)}
                    </button>
                  )}
                </div>
                <div className="workspace-list">
                  {commItems.slice(0, 2).map(item => renderCommCard(item, true))}
                </div>
              </section>
            )}

            {/* 4. What was made (code changes summary + bar + cute file-type art & thumbnails) */}
            <section className="workspace-section" aria-label={t("产物与改动")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <span>{t("产物与改动")}</span>
                  <SectionHelpButton
                    title={t("产物与改动")}
                    description={t("汇总这轮聊天里新做的文档、图片、表格，还有改过的代码行数，点一下就能打开或看详细改动。")}
                    art={<EmptyStateArt kind="files" />}
                    open={openHelp === "made"}
                    onToggle={() => setOpenHelp(prev => prev === "made" ? undefined : "made")}
                    onClose={() => setOpenHelp(undefined)}
                  />
                </span>
                {artifactsCount > 0 && (
                  <button type="button" className="workspace-section-action" onClick={() => setTab("files")}>
                    {t("全部 ({0})", artifactsCount)}
                  </button>
                )}
              </div>
              {diffMessages.length === 0 && fileArtifacts.length === 0 ? (
                <div className="workspace-idle-strip">
                  <span>{t("暂无本轮改动、工作台内容或对话文件。")}</span>
                </div>
              ) : (
                <div className="workspace-list">
                  {diffMessages.slice(0, 1).map(msg => <WorkspaceRunChanges key={`diff:${msg.id}`} connection={connection} message={msg}/>)}
                  {fileArtifacts.length > 0 && (
                    <div className="workspace-file-grid">
                      {fileArtifacts.slice(0, overviewFileSlice).map(renderArtifactTile)}
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}

        {tab === "comms" && (
          <section className="workspace-section" aria-label={t("Bot 间通信")}>
            <div className="workspace-filter-bar">
              <button type="button" className="workspace-filter-pill" aria-pressed={commFilter === "all"} onClick={() => setCommFilter("all")}>
                {t("全部")} ({commItems.length})
              </button>
              <button type="button" className="workspace-filter-pill" aria-pressed={commFilter === "active"} onClick={() => setCommFilter("active")}>
                {t("进行中 / 等你同意")} ({comms?.summary.active ?? 0})
              </button>
              <button type="button" className="workspace-filter-pill" aria-pressed={commFilter === "cross_host"} onClick={() => setCommFilter("cross_host")}>
                {t("跨电脑")} ({commItems.filter(i => i.crossHost).length})
              </button>
            </div>
            {pagedComms.length > 0 ? (
              <>
                <div className="workspace-list">{pagedComms.map(item => renderCommCard(item, false))}</div>
                {commTotalPages > 1 && (
                  <div className="workspace-pager">
                    <button type="button" disabled={shownCommPage === 0} onClick={() => setCommPage(p => Math.max(0, p - 1))}>{t("上一页")}</button>
                    <span>{shownCommPage + 1} / {commTotalPages}</span>
                    <button type="button" disabled={shownCommPage + 1 >= commTotalPages} onClick={() => setCommPage(p => Math.min(commTotalPages - 1, p + 1))}>{t("下一页")}</button>
                  </div>
                )}
              </>
            ) : (
              <div className="workspace-empty">
                <EmptyStateArt kind={commsError && !commsLoading ? "error" : "comms"} />
                {commItems.length > 0 ? (
                  <p>{t("当前筛选下没有匹配的往来记录。")}</p>
                ) : comms !== undefined ? (
                  <p>{t("这个对话里还没有 Bot 互相找过对方。需要多个 Bot 配合时，往来记录会出现在这里。")}</p>
                ) : commsError && !commsLoading ? (
                  <>
                    <p>{t("暂时读不到 Bot 之间的往来，可以点一下重试。")}</p>
                    <button type="button" className="workspace-retry-btn" onClick={onRefreshComms}>{t("重试")}</button>
                    <small className="workspace-error-code">comms_unavailable</small>
                  </>
                ) : (
                  <p>{t("正在读取…")}</p>
                )}
              </div>
            )}
            {commItems.length >= BOT_COMMS_LIMIT && (
              <div className="workspace-more-hint">{t("这里最多显示最近 {0} 条，更早的往来不在其中。", BOT_COMMS_LIMIT)}</div>
            )}
          </section>
        )}

        {tab === "files" && (
          <section className="workspace-section" aria-label={t("产物与改动")}>
            <div className="workspace-filter-bar">
              <button type="button" className="workspace-filter-pill" aria-pressed={fileFilter === "all"} onClick={() => setFileFilter("all")}>
                {t("全部")} ({artifactsCount})
              </button>
              {diffMessages.length > 0 && (
                <button type="button" className="workspace-filter-pill" aria-pressed={fileFilter === "diff"} onClick={() => setFileFilter("diff")}>
                  {t("代码改动")} ({diffMessages.length})
                </button>
              )}
              <button type="button" className="workspace-filter-pill" aria-pressed={fileFilter === "files"} onClick={() => setFileFilter("files")}>
                {t("文件与画板")} ({fileArtifacts.length})
              </button>
            </div>

            {artifactsCount === 0 ? (
              <div className="workspace-empty">
                <EmptyStateArt kind="files" />
                <p>{t("暂无本轮改动、工作台内容或对话文件。")}</p>
              </div>
            ) : (
              <div className="workspace-list">
                {fileFilter !== "files" && diffMessages.length > 0 && (
                  <>
                    <div className="workspace-group-label">{t("代码改动")}</div>
                    {diffMessages.map(msg => <WorkspaceRunChanges key={`diff:${msg.id}`} connection={connection} message={msg}/>)}
                  </>
                )}

                {fileFilter !== "diff" && pagedFileArtifacts.length > 0 && (
                  <>
                    <div className="workspace-group-label">{t("文件与画板")}</div>
                    <div className="workspace-file-grid">
                      {pagedFileArtifacts.map(renderArtifactTile)}
                    </div>
                  </>
                )}

                {fileFilter !== "diff" && fileTotalPages > 1 && (
                  <div className="workspace-pager">
                    <button type="button" disabled={shownFilePage === 0} onClick={() => setFilePage(p => Math.max(0, p - 1))}>{t("上一页")}</button>
                    <span>{shownFilePage + 1} / {fileTotalPages}</span>
                    <button type="button" disabled={shownFilePage + 1 >= fileTotalPages} onClick={() => setFilePage(p => Math.min(fileTotalPages - 1, p + 1))}>{t("下一页")}</button>
                  </div>
                )}

                {filesHasMore && (
                  <button type="button" className="workspace-section-action" onClick={onOpenAllFiles}>
                    <FolderOpen size={12}/>
                    <span>{t("查看全部对话文件")}</span>
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );

  return (
    <aside id={id} className="conversation-workspace-rail" aria-label={t("会话工作区")}
      onKeyDown={event => {
        const target = event.target as Element;
        if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(target) || target.closest("dialog,[role='dialog'],[role='menu']")) return;
        event.preventDefault(); close();
      }}>
      <header className="workspace-rail-header">
        <div className="workspace-rail-title">
          <Layers size={15} aria-hidden="true"/>
          <h2>{t("工作区")}</h2>
        </div>
        <div className="workspace-rail-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("刷新工作区")}
            title={t("刷新工作区")}
            disabled={commsLoading}
            onClick={handleRefreshAll}
          >
            <RefreshCw size={14} className={commsLoading ? "spin" : undefined}/>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("关闭工作区")}
            title={t("关闭工作区")}
            onClick={close}
          >
            <X size={15}/>
          </button>
        </div>
      </header>
      {content}
      {footerTools && (
        <footer className="workspace-rail-footer">
          {footerTools}
        </footer>
      )}
    </aside>
  );
}

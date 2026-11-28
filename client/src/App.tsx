import { useConversationHistory } from "./use-conversation-history.js";
import { HistoryForkMenu } from "./ConversationHistoryActions.js";
import { ConversationHistoryDialog, ConversationHistoryStatus, ConversationHistoryOrigin, HistoryExclusion } from "./ConversationHistoryDialog.js";
import { writeClipboardText } from "./clipboard-write.js";
import type { DesignBotDraft } from "./workbench-design-comments.js";
import { isElectron } from "./desktop-bridge.js";
import { WorkbenchLibraryContext, type WorkbenchFileRequest, type WorkbenchFileTarget } from "./workbench-library-context.js";
import { workbenchErrorText } from "./workbench-error.js";
import { RemoteScreenPanel } from "./RemoteScreenPanel.js";
import { isMobileScreenApp } from "./mobile-screen-viewer-transport.js";
import { annotationDraft, resolveWorkbenchDraft, bindWorkbenchDraft, mergeDesignCommentDraft } from "./workbench-draft.js";
import { designCommentVersions } from "./design-comment-delivery.js";
import { useWorkbench } from "./use-workbench.js";
import { useWorkbenchDesignOpener } from "./use-workbench-design-opener.js";
import { openWorkbenchDesign, waitForDesignSurface } from "./workbench-open-design.js";
import { WorkbenchContext as WorkbenchEntryContext } from "./workbench-context.js";
import type { WorkbenchContext, WorkbenchSource } from "../../src/client-protocol/workbench.js";
import type { BoardAnnotation } from "./workbench-board.js";
import { ConnectionNotice } from "./ConnectionNotice.js";
import { routeDiagnosisMessage } from "./route-diagnostics.js";
import { conversationPendingQuestionTotal, conversationUnreadTotal, isUnreadSelectionTarget, type InboxFilter } from './conversation-unread.js';
import { WidgetComposeProvider, widgetComposeText, appendWidgetDraft } from "./widget-compose.js";
import { useWidgetStateSelection } from "./use-widget-state-selection.js";
import { useClaudeSendChoice } from "./use-claude-send-choice.js";
import { isPiLiveCommand, isPiSessionCommand, type PiSessionCommand } from "../../src/client-protocol/pi-commands.js";
import { useCodexSendChoice } from "./use-codex-send-choice.js";
import { ClaudeSendChoice } from "./ClaudeSendChoice.js";
import { formatMessageTime, navigationItems } from "./conversation-inbox.js";
import { useLocalDay } from "./local-day.js";
import { selectionAfterArchive } from "./conversation-bulk.js";
import { NativeInputContext } from "./NativeInput.js";
import { controlNativeInput } from "./native-input-request.js";
import { nativeInputReason, nativeControlReason } from "./steering-reason.js";
import { clearNativeInputDraft, hasNativeInputDraft, retireEditedNativeInputDraft, hasSteeringDraft, clearSteeringDraft, retireEditedSteeringDraft, recoverSteeringDraft } from "./steering-request.js";
import { useSceneMotion } from "./use-scene-motion.js";
import { focusComposerBackground, useComposerPaste } from "./composer-paste.js";
import { ComposerVoiceButton, ComposerVoiceRecording } from "./ComposerVoice.js";
import { groupMentions } from "./group-mentions.js";
import { groupRecipientOptions, insertScopedGroupMention } from "./group-recipient-options.js";
import { blocksModalHistory } from "./modal-history.js";
import { isAgentBusRecord } from "./agent-bus-record.js";
import { isActiveTranscriptionMessage, isTranscriptionMessage } from "../../src/client-protocol/voice-presentation.js";
import { FolderTree, Hourglass, Layers, ListOrdered, Network as AgentBusIcon } from "lucide-react";
import { WorkspaceFilesPanel, WORKSPACE_FILE_DRAG_MIME, formatWorkspaceFileMention } from "./WorkspaceFilesPanel.js";
import { TurnStopContext, useTurnStop } from "./use-turn-stop.js";
import { timeoutSignal } from "./abort-signals.js";
import { DisconnectedBotsSwitch, SidebarLayoutSwitch, SidebarUnreadFilter } from "./SidebarLayoutSwitch.js";
import { assertMessageTextSize } from "./message-validation.js";
import { Sidebar } from "./Sidebar.js";
import { WorkspaceFooter } from "./WorkspaceFooter.js";
import { HostSourceBadge } from "./HostSourceBadge.js";
import { BotName } from "./BotName.js";
import { RichMessagePreview } from "./RichMessagePreview.js";
import type { MobileTab, MobileInboxState, MobileScrollPositions } from "./MobileHome.js";
import { ScheduledTasks } from "./ScheduledTasks.js";
import { CreationDialog } from "./CreationDialog.js";
import { RuntimeHostActiveContext, RuntimeHostContext } from "./RuntimeHost.js";
import type { WorkspaceProps } from "./HostApp.js";
import { CapabilitiesPanel } from "./CapabilitiesPanel.js";
import { CapabilityHelpDialog, type CapabilityHelpRequest } from "./CapabilityHelpDialog.js";
import { useHistorySearch } from "./history-search.js";
import { useSearchMessageHighlight } from "./search-message-highlight.js";
import { BotSettings } from "./BotSettings.js";
import { ComposerModelControls } from "./ComposerModelControls.js";
import { QuotaBattery, QuotaMark, quotaMarkLabel, UsageDetails, UsageIndicators } from "./UsageIndicators.js";
import { clearStoredQuotaHost } from "./quota-store.js";
import { useUsageReadings } from "./use-usage-readings.js";
import { usageTone } from "./usage-readings.js";
import { PiSessionControls } from "./PiSessionControls.js";
import { RemoveConversation } from "./RemoveConversation.js";
import { RenameConversation } from "./RenameConversation.js";
import { FolderListOptions } from "./ConversationFolders.js";
import { MoveToFolder } from "./ConversationFolders.js";
import { SideConversation } from "./SideConversation.js";
import { useSideWindowExpansion } from "./use-side-window-expansion.js";
import { useSideConversation } from "./use-side-conversation.js";
import { ConversationDetails } from "./ConversationDetails.js";
import { ConversationWorkspace, useConversationBotComms } from "./ConversationWorkspace.js";
import type { SwarmMember } from "../../src/client-protocol/engine-tasks.js";
import { useComposerSize } from "./useComposerSize.js";
import { ComposerSuggestions } from "./ComposerSuggestions.js";
import { useBackAction } from "./back-navigation.js";
import { steerReason } from "./Steering.js";
import { sendSteering, SteeringNotDeliveredError } from "./steering-request.js";
import { beginSendTiming, hasPendingBubbleTiming, hasPendingComposerTiming, markSendTimingBubbleVisible, markSendTimingComposerCleared, type SendTimingTrace } from "./send-timing.js";
import { applyAppearance } from "./appearance.js";
import { isDispatcher, isTicketNotice, listedConversations, setTicketConversationsVisible, useTicketConversationsVisible } from "./dispatcher.js";
import { routeTitle } from "./RouteFields.js";
import { Avatar, AvatarProvider, ConversationAvatar } from "./Avatar.js";
import { DelegationDialog, type DelegationMode } from "./DelegationDialog.js";
import { botLabels, type NamedBot } from "./bot-references.js";
import { BotReferences, ReferencePreview } from "./BotReferences.js";
import { SearchExcerpt } from "./SearchExcerpt.js";
import { useVoiceRecorder } from "./useVoiceRecorder.js";
import { VoiceMicButton } from "./VoiceMicButton.js";
import { HoldToTalk } from "./HoldToTalk.js";
import { useConversationDrafts } from "./conversation-drafts.js";
import { useConversationOutbox } from "./conversation-outbox.js";
import { forwardedAuthorName, messageRowKey, partitionOutboxItems, rememberForwardedMessage, rememberMessageAttachments } from "./pending-messages.js";
import { useConversationMessages } from "./conversation-messages.js";
import { DraftLinkPreview, selectedPreviewUrl } from "./LinkPreview.js";
import { ComposerAttachmentButton, useAttachmentPicker } from "./AttachmentPicker.js";
import { useAttachmentDrop } from "./attachment-drop.js";
import { AttachmentDraft } from "./AttachmentDraft.js";
import { ForwardMessage } from "./ForwardMessage.js";
import { useMessageHold } from "./useMessageHold.js";
import { useMessageDeletion } from "./MessageDeletion.js";
import { MessageContextMenu } from "./MessageContextMenu.js";
import { writeMessageSelection } from "./message-selection-clipboard.js";
import { copyMessagePlainText, MessageCopySuperseded, prepareMessagePlainText } from "./message-plain-text.js";
import { MessageActionSheet, type MessageSheetActions } from "./MessageActions.js";
import { MessageRail } from "./MessageRail.js";
import { buildMessageRailItems, resolveRailScrollAnchor, type MessageRailItem } from "./message-rail.js";
import { ReplyActivity } from "./ReplyActivity.js";
import { messageAuthor, messageExcerpt } from "./MessageReference.js";
import { GroupTopics, TopicSwitcher } from "./GroupTopics.js";
import { GroupDiscussionBar } from "./GroupDiscussionBar.js";
import { editGroupComposerIntent, type GroupComposerIntent } from "./group-composer-intent.js";
import { DiscussionParticipants, useDiscussionParticipants } from "./DiscussionParticipants.js";
import { controlComposerDiscussion } from "./group-discussion-control.js";
import { useGroupReplyMode } from "./group-reply-mode-cache.js";
import { groupMessageRetryAddress, unknownGroupReplyMode } from "./group-reply-guard.js";
import { automaticComposer, groupReplyModeFromView, sendGroupComposerMessage, type GroupReplyMode } from "./group-composer-send.js";
import { DesktopMenu, DesktopMenuPortalContext } from "./DesktopMenu.js";
import { NewBot } from "./NewBot.js";
import { NewConversation, type ConversationCreation } from "./NewConversation.js";
import { useShareInbox } from "./ShareInbox.js";
import { maintainUnifiedPush } from "./unifiedpush.js";
import { commandDescription, t, useLocale, setLocale } from "./i18n.js";
import { lazy, Suspense, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type SetStateAction } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { createReadingScroll } from "./reading-scroll.js";
import { useConnectionSelection } from "./connection-selection.js";
import { CalendarClock, Activity, Archive, ArrowLeft, AtSign, Folder, FolderInput, FolderOpen, ArrowUp, CornerDownLeft, Compass, Bot as BotIcon, Check, ChevronDown, ChevronLeft, ChevronRight, CircleStop, Copy, Forward, Hash, LoaderCircle, MoreHorizontal, MessageSquare, MessageSquarePlus, Monitor, MonitorPlay, PanelRight, Pencil, Plug, Plus, Puzzle, RotateCcw, Search, Settings, ShieldCheck, Trash2, Users, Wifi, WifiOff, X, MonitorCog } from "lucide-react";
import { workspaceDisplayName } from "../../src/client-protocol/saved-workspaces.js";
import { getPluginRegistry, resolvePluginScopeId, type PluginStoreState } from "./plugin-registry.js";
import { PluginsModal } from "./PluginsPanel.js";
import { PluginSandboxFrame } from "./PluginSandboxFrame.js";
import { MobilePluginSheet } from "./MobilePluginSheet.js";
import { SidePanelResize } from "./SidePanelResize.js";
import { BrandName } from "./BrandScenes.js";
import { DirectEmpty, WelcomeHome } from "./ChatEmpty.js";
import { blocksText, messageSchema, type Conversation, type Message } from "../../src/client-protocol/index.js";
import { isRunActive, runSummarySchema } from "../../src/client-protocol/run.js";
import { HubConnection, type Bot } from "./connection.js";
import { addGlobalListener, subscribeMediaQuery } from "./global-event-hub.js";
import { WorkspaceMessageRow } from "./WorkspaceMessageRow.js";
import { MessageOverlayContext, useMessageOverlayRows } from "./message-overlay.js";
import { GoogleExport } from "./Content.js";
import { ConversationMessageContent } from "./ConversationMessageContent.js";
import { ReplyWidthContext, desktopReplyWidth, observeReplyWidthRoom } from "./reply-width.js";
import { cache, defaultPreferences, type Preferences, type ConversationActivity } from "./storage.js";
import { uploadFile } from "./files.js";
import { ConnectionPanel } from "./ConnectionPanel.js";
import { ScreenControlPanel } from "./ScreenControlPanel.js";
import { PreferencesPanel } from "./PreferencesPanel.js";
import { ConversationList } from "./ConversationList.js";
import { ConversationPanel } from "./ConversationPanel.js";
import { ArchivedConversations } from "./ArchivedConversations.js";
import { ConversationFiles } from "./ConversationFiles.js";
import { BackgroundTaskGroup, BackgroundTaskDock } from "./BackgroundTaskGroup.js";
import { groupBackgroundTasks, taskCounts } from "./background-task-groups.js";
import { EngineTasks, swarmMemberStateLabel } from "./EngineTasks.js";
import { PromptQueue, useSteeringCapability } from "./PromptQueue.js";
import { DispatchNotice, DispatchTickets } from "./DispatchTickets.js";
import { UserReplyStatus } from "./UserReplyStatus.js";
import { userReplyStatuses } from "./user-reply-status.js";
import { FileCenter } from "./FileCenter.js";
import { OperationsPanel } from "./OperationsPanel.js";
import { Terminal as TerminalIcon } from "lucide-react";
import { TerminalPanel } from "./TerminalPanel.js";
import { MobileResourcesDialog, ResourcesManagerDialog, ResourcesTriggerButton, useAnyHostResourcesAvailable } from "./ResourcesPanel.js";
import { startDesktopUpdateChecks } from "./DesktopUpdates.js";
import { installPushActions } from "./notifications.js";
import { runtimeHostId } from "./host-registry.js";
import { ListenerScope } from "./listener-scope.js";

const MobileHome = lazy(() => import("./MobileHome.js").then(({ MobileHome }) => ({ default: MobileHome })));
/** While typing continues, a draft is written to IndexedDB at most this often. */
const DRAFT_SAVE_DELAY_MS = 250;
import { installNativeEvents, nativePlatform, nativeHaptic, nativeHoldHaptic, updateBadge } from "./native.js";

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
// Native phones and tablets copy a whole message as readable text at every
// window width: an unfolded phone or a tablet uses the desktop message bar and
// context menu. Desktop Apps and browsers keep the Markdown source there. Read
// when the action happens, never from the window size.
const copiesReadableMessages = () => ["ios", "android"].includes(nativePlatform());
// Avatar presence comes only from explicit reply states; being online never means "working".
// Host audio transcription is not a Bot reply, so it never shows Bot typing dots.
const presence = (message: Message) => message.authorType !== "bot" || isAgentBusRecord(message) || isTranscriptionMessage(message) ? "" : message.status === "streaming" ? " is-working" : message.status === "pending" ? " is-pending" : "";
const Workbench = lazy(() => import("./Workbench.js").then(module => ({default:module.Workbench})));

const EMPTY_PLUGIN_STORE: PluginStoreState = { allowThirdParty: false, developerMode: false, installed: {} };
const noopPluginSubscribe = () => () => {};
const emptyPluginSnapshot = () => EMPTY_PLUGIN_STORE;

export function Workspace({ connection, forget, shell, pane }: WorkspaceProps) {
  const visible = pane?.visible ?? shell?.active ?? true;
  const keyboardActive = visible && (!pane || pane.focused);
  const locale = useLocale();
  const macKeyboard = /Mac/.test(navigator.platform);
  const narrow = useSyncExternalStore(
    useCallback((notify: () => void) => subscribeMediaQuery("(max-width:760px)", notify), []),
    () => matchMedia("(max-width:760px)").matches,
  );
  const phone = !pane && narrow;
  // Panes and small desktop windows reserve the hover action row beside the
  // timestamp, so dated timestamps use their compact form there.
  const tightDesktop = useSyncExternalStore(
    useCallback((notify: () => void) => subscribeMediaQuery("(min-width:761px) and (max-width:860px)", notify), []),
    () => matchMedia("(min-width:761px) and (max-width:860px)").matches,
  );
  const coarseTouch = useSyncExternalStore(
    (notify) => { const query = matchMedia("(hover: none) and (pointer: coarse)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); },
    () => matchMedia("(hover: none) and (pointer: coarse)").matches,
  );
  const compactTime = !!pane || tightDesktop;
  // Message timestamps and the phone sheet line are worded relative to today,
  // so they are rendered again when the local day changes.
  const localDay = useLocalDay();
  const compactComposerTools = phone || !["ios", "android"].includes(nativePlatform());
  const cache = connection.cache;
  useEffect(() => { if (!shell && !pane) return startDesktopUpdateChecks(); }, []);
  // The shell already observes the inbox; message/outbox hooks below observe
  // this conversation. Streaming elsewhere has no other Workspace state change.
  const state = useConnectionSelection(connection, value => ({ ...value.state,
    cacheRevision: shell || pane ? 0 : value.state.cacheRevision,
  }));
  const [cachedBotNames, setCachedBotNames] = useState<NamedBot[]>([]);
  const receivedDirectory = useRef(false);
  useEffect(() => { receivedDirectory.current = false; let alive = true; void cache.botNames().then((value) => { if (alive && !receivedDirectory.current) setCachedBotNames(value); }); return () => { alive = false; }; }, [connection]);
  useEffect(() => { if (state.status === "online") { receivedDirectory.current = true; setCachedBotNames([...state.bots, ...(state.deletedBots ?? [])]); void cache.saveBotNames([...state.bots, ...(state.deletedBots ?? [])], connection.identity).catch(() => undefined); } }, [connection, state.status, state.bots, state.deletedBots]);
  // Engine workers are named here for their ticket chats; lists use state.bots.
  const botDirectory = useMemo(() => state.status === "online" || receivedDirectory.current ? [...state.bots, ...(state.deletedBots ?? []), ...(state.dispatchWorkers ?? [])] : cachedBotNames, [state.status, state.bots, state.deletedBots, state.dispatchWorkers, cachedBotNames]);
  const botsById = useMemo(() => new Map(botDirectory.map(bot => [bot.id, bot])), [botDirectory]);
  // Every navigation surface needs the same offline name fallback. The current
  // host overrides the background directory, so passing state.bots here loses
  // cached names during an offline cold start. Cached entries never imply online.
  const cachedNavigationBots = useMemo(() => cachedBotNames.filter(bot => !bot.deletedAt).map((bot) => ({ ...bot, engine: bot.engine ?? "", model: bot.model ?? "", effort: "", online: 0 })), [cachedBotNames]);
  const navigationBots = state.status === "online" || receivedDirectory.current ? state.bots : cachedNavigationBots;
  const labels = useMemo(() => botLabels(botDirectory), [botDirectory, locale]);
  const [fileCenter, setFileCenter] = useState(false);
  const [conversationFiles, setConversationFiles] = useState<Conversation>();
  const [delegation, setDelegation] = useState<DelegationMode>();
  const [operationBot, setOperationBot] = useState<{ botId: string; name: string; view?: "dashboard" }>();
  const [conversations, setConversations] = useState<Conversation[]>([]); const [normalSelected, setNormalSelected] = useState("");
  const [localInboxFilter, setLocalInboxFilter] = useState<InboxFilter>();
  const [localRetainedOpen, setLocalRetainedOpen] = useState<string>();
  const conversationIdSet = useMemo(() => new Set(conversations.map(c => c.id)), [conversations]);
  // Opening uses the full cache (a ticket panel may open a hidden worker chat); lists and pickers use listedChats.
  const showTickets = useTicketConversationsVisible(), listedChats = useMemo(() => listedConversations(conversations), [conversations, showTickets]);
  // Panes never own the device share inbox; the entry sits in the notice slots below.
  const share = useShareInbox({ connection, conversations: listedChats, active: visible, enabled: !pane, hosts: shell?.shareHosts });
  const requestedSelected = pane?.conversationId ?? normalSelected;
  // A hidden ADHD pane retains state through a bounded flush. A different Host
  // or revoked/deleted identity loses authority immediately, without a grace period.
  // A retained, hidden Host workspace may finish its state-only flush. Actual
  // permission loss still discards immediately; compose checks chatVisible.
  const widgetAllowed = (id: string) => !connection.isReadOnly && conversations.some(conversation => conversation.id === id);
  const { selected, owner: widgetOwner } = useWidgetStateSelection(requestedSelected, `${connection.identity.hubPublicKey}:${connection.identity.deviceId}:${state.user?.id ?? ""}`, widgetAllowed);
  const [groupReplyMode, setGroupReplyMode] = useGroupReplyMode(connection, selected);
  const groupReplyModeRef = useRef(groupReplyMode); groupReplyModeRef.current = groupReplyMode;
  const setSelected = (value: string | ((old: string) => string)) => {
    if (!pane) { setNormalSelected(value); return; }
    const id = typeof value === "function" ? value(selected) : value;
    if (id && id !== selected) pane.navigate(id);
  };
  const [activity, setActivity] = useState<Record<string, ConversationActivity>>({});
  const [focusTarget, setFocusTarget] = useState<{ conversationId: string; messageId?: string; searchQuery?: string }>();
  useEffect(() => { if (pane?.focusRequest && selected === requestedSelected) { setFocusTarget({ conversationId: selected, messageId: pane.focusRequest.messageId }); pane.focusHandled(pane.focusRequest.serial); } }, [pane?.focusRequest?.serial, selected, requestedSelected]);
  const conversationRevision = shell || pane ? connection.conversationRevision(selected) : state.cacheRevision;
  const [forwarding, setForwarding] = useState<Message>(); const forwardTrigger = useRef<HTMLElement | null>(null);
  // Phone message sheet. The target is an exact conversation + message ID and the
  // live message is looked up on each render, so a recycled row or a replaced
  // message can never receive an action meant for another message.
  const [messageSheet, setMessageSheet] = useState<{ conversationId: string; messageId: string }>();
  const sheetOrigin = useRef<{ conversationId: string; messageId: string; trigger: HTMLElement | null; next: HTMLElement | null } | undefined>(undefined);
  const forwardOrigin = useRef<{ conversationId: string; messageId: string } | undefined>(undefined);
  if (forwarding) forwardOrigin.current = { conversationId: forwarding.conversationId, messageId: forwarding.id };
  const [copied, setCopied] = useState<string>(); const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const { files, workbench: workbenchDraft, getWorkbenchDraft, addWorkbenchAnnotation, clearWorkbench, setFiles: setRichFiles, reply, setReply: setRichReply, previewChoice, setPreviewChoice, recipients: savedRecipients, setRecipients: saveRecipients, ready: richDraftReady, saving: richDraftSaving, pendingAny: richDraftPendingAny, failedAny: richDraftFailedAny, error: richDraftError, hasContent: richDraftContent, retry: retryRichDraft, clearSent: clearSentRichDraft, flush: flushRichDraft } = useConversationDrafts(selected, cache, connection.identity);
  const [voiceMode, setVoiceMode] = useState(false);
  const [draft, setDraft] = useState(""); const [draftScope, setDraftScope] = useState(""); const [uploadProgress, setUploadProgress] = useState<number>(); const [error, setError] = useState("");
  const [attachmentDropError, setAttachmentDropError] = useState("");
  useLayoutEffect(() => { setAttachmentDropError(""); }, [selected, visible]);
  const uploadController = useRef<AbortController | null>(null), sendBusy = useRef(false);
  const [uploadRecovering, setUploadRecovering] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => () => uploadController.current?.abort(), []);
  const [capabilities, setCapabilities] = useState(false);
  const [capabilityHelp, setCapabilityHelp] = useState<{ request: CapabilityHelpRequest; bot: Bot }>();
  const [details, setDetails] = useState(false), [detailBot, setDetailBot] = useState<string>();
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const [renameId, setRenameId] = useState<string>();
  const [removeTopicId, setRemoveTopicId] = useState<string>();
  const [settingsBotIds, setSettingsBotIds] = useState<string[]>();
  const settingsOrigin = useRef<{ trigger: HTMLElement | null; botId: string; hostId: string } | undefined>(undefined);
  const botSettingsReturn = useMemo(() => ({ get current() {
    const origin = settingsOrigin.current;
    if (origin?.trigger?.isConnected && origin.trigger.getClientRects().length) return origin.trigger;
    // A cross-host action switches workspaces. Restore focus to the equivalent
    // Bot row in the now-visible home, never the hidden host's original button.
    if (pane) return backRoot.current?.querySelector<HTMLElement>("[data-bot-settings]") ?? composer.current;
    return [...document.querySelectorAll<HTMLElement>(".host-workspace:not([hidden]) [data-bot-settings]")].find(node => node.dataset.botSettings === origin?.botId && node.dataset.settingsHost === origin?.hostId) ?? null;
  } }), []);
  const showBotSettings = (botIds: string[], trigger: HTMLElement | null) => {
    if (!botIds.length) return;
    settingsOrigin.current = { trigger, botId: botIds[0]!, hostId: shell?.host.id ?? "local" };
    setSettingsBotIds(botIds);
  };
  const [manage, setManage] = useState(false); const [operations, setOperations] = useState(false); const [resourcesOpen, setResourcesOpen] = useState(false); const resourcesDialogId = useId(); const resourcesTriggerRef = useRef<HTMLButtonElement>(null); const resourcesReturnFocus = useRef<HTMLButtonElement | null>(null); const [pins, setPins] = useState<string[]>([]); const [globalPins, setGlobalPins] = useState<string[]>([]);
  const [settings, setSettings] = useState(false); const [settingsSection, setSettingsSection] = useState<"general" | "notifications" | "connection" | "screen" | "devices" | "pairing" | "workbench">("general"); const [sidebar, setSidebar] = useState(() => matchMedia("(max-width:760px)").matches);
  const [mobileTab, setMobileTab] = useState<MobileTab>("messages");
  const [localMobileInbox, setLocalMobileInbox] = useState<MobileInboxState>({ query: "", filter: "all" });
  const localMobileScroll = useRef<MobileScrollPositions>({ messages: 0, bots: 0, me: 0 });
  const mobileInbox = shell?.mobileInbox ?? localMobileInbox;
  const updateMobileInbox = shell?.updateMobileInbox ?? setLocalMobileInbox;
  const mobileScroll = shell?.mobileScrollPositions ?? localMobileScroll;
  const chatMoreTrigger = useRef<HTMLButtonElement>(null);
  const [settingsFromMenu, setSettingsFromMenu] = useState(false);
  const [chatActions, setChatActions] = useState(false), [archives, setArchives] = useState(false);
  const [movingConversation, setMovingConversation] = useState<string>();
  const chatActionNote = useId();
  // Desktop popovers (create, workspace tools, chat details, group recipients).
  // At most one is open; each is closed when its chat, host or layout changes.
  const [menu, setMenu] = useState<"create" | "workspace" | "chat" | "recipients">();
  const closeMenu = () => setMenu(undefined), toggleMenu = (kind: NonNullable<typeof menu>) => setMenu((open) => open === kind ? undefined : kind);
  const menuId = useId(), createTrigger = useRef<HTMLButtonElement>(null), workspaceTrigger = useRef<HTMLButtonElement>(null), recipientTrigger = useRef<HTMLButtonElement>(null);
  const chatVisible = visible && (!phone || !sidebar); const [scheduledTasks, setScheduledTasks] = useState<"create" | "list">(); const [newBot, setNewBot] = useState(false); const [newChat, setNewChat] = useState<ConversationCreation>();
  const { messages, deletedClientMsgIds, readRevision: historyRevision, ready: messagesReady, failed: messageReadFailed, retry: retryMessageRead } = useConversationMessages(connection, selected, chatVisible, true);
  const [individualBackgroundRecords, setIndividualBackgroundRecords] = useState(false);
  const backgroundGroups = useMemo(() => groupBackgroundTasks(messages, state.runGroupsAvailable !== false && !individualBackgroundRecords), [messages, state.runGroupsAvailable, individualBackgroundRecords]);
  const replyStatuses = useMemo(() => userReplyStatuses(messages, selected, new Set(state.status === "online" ? state.bots.filter(bot => bot.online).map(bot => bot.id) : [])), [messages, selected, state.status, state.bots]);
  // A long-running reply can precede any number of follow-ups or deliveries.
  // Collect activity during the existing index pass, not from a truncated tail
  // or the virtualized rows. Draft/connection renders reuse this projection.
  const { messagesById, workingAuthors, pendingReply, transcribing } = useMemo(() => {
    const messagesById = new Map<string, Message>(), working = new Set<string>();
    let pendingReply = false;
    let transcribing = false;
    for (const message of messages) {
      if (message.conversationId !== selected) continue;
      messagesById.set(message.id, message);
      if (message.forwardedFrom || !["streaming", "pending"].includes(message.status)) continue;
      if (isActiveTranscriptionMessage(message)) { transcribing = true; continue; }
      const state = presence(message);
      if (state === " is-working") working.add(message.authorId);
      else if (state === " is-pending") pendingReply = true;
    }
    return { messagesById, workingAuthors: [...working], pendingReply, transcribing };
  }, [messages, selected]);
  // The newest finished Bot message of this conversation: when it changes, a reply has just ended.
  const lastBotReply = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) { const message = messages[index]!; if (message.conversationId === selected && message.authorType === "bot" && !["streaming", "pending"].includes(message.status)) return `${message.id}:${message.status}`; }
    return "";
  }, [messages, selected]);
  const replySource = reply && messages.find(message => message.id === reply.id && message.conversationId === selected);
  const replyReady = !reply || messagesReady && !!replySource;
  const [searchBot, setSearchBot] = useState(""); const [searchFrom, setSearchFrom] = useState(""); const [searchTo, setSearchTo] = useState(""); const [searchFiles, setSearchFiles] = useState(false);
  const [query, setQuery] = useState("");
  const [searchConversation, setSearchConversation] = useState<{ id: string; title: string }>();
  const conversationSearchTrigger = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const historySearch = useHistorySearch(connection);
  const { results: searchResults, busy: searchBusy, error: searchError, close: closeSearch } = historySearch;
  const searchPanel = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (!searchBusy) searchPanel.current?.scrollTo({ top: 0 }); }, [searchResults, searchBusy]);
  const [localPreferences, setLocalPreferences] = useState<Preferences>(defaultPreferences);
  const preferences = shell?.preferences ?? pane?.preferences ?? localPreferences, setPreferences = shell?.updatePreferences ?? pane?.updatePreferences ?? setLocalPreferences;
  // Sending follows the device setting; legacy per-draft style is retained only for compatibility.
  const previewStyle = preferences.linkPreviewStyle;
  const [preferencesReady, setPreferencesReady] = useState(false);
  const queued = useConversationOutbox(connection, selected, chatVisible, historyRevision, messages, true, deletedClientMsgIds);
  const { pendingMessages, pendingById, attentionQueued } = useMemo(
    () => partitionOutboxItems(connection, queued, messages, state.status === "online", state.user?.id ?? "user"),
    [connection, queued, messages, state.status, state.user?.id],
  );
  const displayedMessages = useMemo(
    () => (pendingMessages.length ? [...backgroundGroups.messages, ...pendingMessages] : backgroundGroups.messages),
    [backgroundGroups.messages, pendingMessages],
  );
  const offlinePending = pane ? queued.filter(item => !item.sent && !item.syncing && !item.error).length : state.outbox;
  const [commands, setCommands] = useState<{ command: string; description: { defaultValue?: string; i18n: Record<string, string | undefined> } }[]>([]);
  const [piCommands, setPiCommands] = useState<{ scope: string; values: PiSessionCommand[] }>({ scope: "", values: [] });
  const receivePiCommands = useCallback((conversationId: string, botId: string, values: PiSessionCommand[]) => {
    setPiCommands(previous => {
      const scope = `${connection.identity.hubPublicKey}:${conversationId}:${botId}`;
      if (!values.length && previous.scope !== scope) return previous;
      if (previous.scope === scope && JSON.stringify(previous.values) === JSON.stringify(values)) return previous;
      return { scope, values };
    });
  }, [connection]);
  const draftRevision = useRef(0), draftVersions = useRef(new Map<string, number>()), pendingDraftWrites = useRef(0), unsavedDrafts = useRef(new Map<string, string>());
  const lastDraftEdits = useRef(new Map<string, { version: number; text: string }>());
  type GroupDraftEntry = { intent?: GroupComposerIntent; savedId?: string; invalidIntent?: string; text?: string; loading: Promise<void>; error?: unknown };
  const groupDrafts = useRef(new Map<string, GroupDraftEntry>());
  const groupDraft = (id: string): GroupDraftEntry => {
    let value = groupDrafts.current.get(id);
    if (!value) {
      value = { loading: Promise.resolve() }; groupDrafts.current.set(id, value);
      const entry = value;
      entry.loading = cache.groupComposerDraft(id).then(saved => {
        entry.savedId = saved.intent?.id; entry.invalidIntent = saved.invalidIntent;
        entry.intent ??= saved.intent ?? { id: crypto.randomUUID(), empty: !saved.text, legacy: true };
        entry.text ??= saved.text;
      }).catch(error => { entry.error = error; });
    }
    return value;
  };
  const [draftSaving, setDraftSaving] = useState(false);
  const draftSaveFailed = !draftSaving && unsavedDrafts.current.has(selected);
  // Routine autosaves stay quiet, including live-region announcements while typing.
  const draftSaveNeedsAttention = draftSaveFailed || !!richDraftError;
  const draftStatusText = draftSaveNeedsAttention ? t("草稿未保存") : draftSaving || richDraftSaving ? t("正在保存草稿…") : draft || richDraftContent ? t("草稿已保存") : "";
  // The first change after a pause is written immediately (a reload or quit
  // right after typing keeps it). Continued typing, including each IME
  // composition step, is coalesced to one write per window plus the latest
  // text at its end, and is written at once on conversation change, page
  // hide, or before a send compares the saved draft.
  const draftWindows = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; text?: string }>());
  const lastDraftWrite = useRef(new Map<string, Promise<void>>());
  const flushDraft = useRef<(conversationId: string) => Promise<void>>(async () => {});
  useEffect(() => {
    const flushAll = () => { for (const id of [...draftWindows.current.keys()]) void flushDraft.current(id); };
    const hidden = () => { if (document.visibilityState === "hidden") flushAll(); };
    const protect = (event: BeforeUnloadEvent) => { flushAll(); if (pendingDraftWrites.current || unsavedDrafts.current.size) { event.preventDefault(); event.returnValue = ""; } };
    const cleanups = [
      addGlobalListener(window, "beforeunload", protect),
      addGlobalListener(window, "pagehide", flushAll),
      addGlobalListener(document, "visibilitychange", hidden),
    ];
    return () => { for (const cleanup of cleanups) cleanup(); flushAll(); };
  }, []);
  const pendingComposerFocus = useRef<string | undefined>(undefined);
  const readTail = useRef<HTMLSpanElement>(null);
  const scroll = useRef<HTMLDivElement>(null), queuedRows = useRef<HTMLDivElement>(null), historyRows = useRef<HTMLDivElement>(null); const composer = useRef<HTMLTextAreaElement>(null);
  const designDraftNotice = useRef<HTMLDivElement>(null);
  const pendingDesignNoticeFocus = useRef<{ connection: HubConnection; conversationId: string } | undefined>(undefined);
  const followLatest = useRef(true), touchY = useRef<number | undefined>(undefined); const [showLatest, setShowLatest] = useState(false);
  const scrollingTowardLatest = useRef(false);
  // The focus request last positioned, its row index, and whether the reader has
  // scrolled since. Reader gestures release it; only an explicit new request,
  // never a history refresh or reply, positions the conversation again.
  const focusPosition = useRef<{ target: object; index: number; released: boolean; settled: boolean; attempts: number } | undefined>(undefined);
  const releaseFocus = () => { if (focusPosition.current) focusPosition.current.released = true; };
  const readTowardLatest = () => { scrollingTowardLatest.current = true; releaseFocus(); };
  const touchTarget = useRef<EventTarget | null>(null), scrollbarOrigin = useRef<number | undefined>(undefined);
  const finishTouch = useCallback((event?: Event) => {
    touchY.current = undefined;
    if (event?.type === "touchcancel") scrollingTowardLatest.current = false;
    touchTarget.current?.removeEventListener("touchend", finishTouch);
    touchTarget.current?.removeEventListener("touchcancel", finishTouch);
    touchTarget.current = null;
  }, []);
  useEffect(() => {
    const finishPointer = () => {
      const node = scroll.current, origin = scrollbarOrigin.current;
      // A drag can leave the tail and return to its original position before
      // release. Once that mouse gesture ends at the actual bottom, resume.
      if (node && origin !== undefined && node.scrollHeight - node.scrollTop - node.clientHeight <= 2) {
        // Like "back to latest", returning to the tail ends a located message's
        // request, so live replies are followed again.
        followLatest.current = true; setShowLatest(false); setFocusTarget(undefined);
      }
      scrollbarOrigin.current = undefined;
    };
    const cleanups = [
      addGlobalListener(window, "pointerup", finishPointer, { capture: true }),
      addGlobalListener(window, "pointercancel", finishPointer, { capture: true }),
      addGlobalListener(window, "touchend", finishTouch, { capture: true }),
      addGlobalListener(window, "touchcancel", finishTouch, { capture: true }),
    ];
    return () => {
      finishTouch();
      for (const cleanup of cleanups) cleanup();
    };
  }, [finishTouch]);
  const readHistory = (force = false) => { scrollingTowardLatest.current = false; releaseFocus(); const node = scroll.current; if (node && (force || node.scrollHeight > node.clientHeight + 2)) { followLatest.current = false; setShowLatest(true); } };
  const current = conversations.find((c) => c.id === selected); const activeBot = state.bots.find((b) => b.id === current?.botIds[0]);
  const choosableBot = activeBot;
  const conversationDispatchers = current ? current.botIds.map(id => state.bots.find(bot => bot.id === id)).filter((bot): bot is NonNullable<typeof bot> => !!bot && isDispatcher(bot)) : [];
  const conversationTitles = useMemo(() => new Map(conversations.map(c => [c.id, c.title])), [conversations]);
  // The panel choice belongs to this conversation, just like its workbench
  // contents. Resolve it during render so navigation never opens B using A's mode.
  const rightModeScope = JSON.stringify([connection.identity.hubPublicKey, state.user?.id, selected]);
  // "workspace": the workspace rail is in front. A side conversation or the remote screen underneath stays
  // alive, as under the Workbench, and shows again when the rail closes.
  const [rightModes, setRightModes] = useState<ReadonlyMap<string, "side" | "workbench" | "files" | "screen" | "workspace" | "terminal" | "plugin">>(() => new Map());
  const rightMode = rightModes.get(rightModeScope) ?? "side";
  const setRightMode = useCallback((mode: "side" | "workbench" | "files" | "screen" | "workspace" | "terminal" | "plugin") => {
    setRightModes(previous => {
      if ((previous.get(rightModeScope) ?? "side") === mode) return previous;
      const next = new Map(previous);
      if (mode === "side") next.delete(rightModeScope); else next.set(rightModeScope, mode);
      return next;
    });
  }, [rightModeScope]);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [pluginInstallId, setPluginInstallId] = useState<string>();
  const [activePluginPanel, setActivePluginPanel] = useState<{ pluginId: string; contributionId: string; title: string }>();
  const [mobilePluginPanel, setMobilePluginPanel] = useState<{ pluginId: string; contributionId: string; title: string }>();
  const pluginSidePanelRef = useRef<HTMLElement>(null);
  const pluginSidePanelId = `plugin-side-panel-${useId()}`;
  const pluginScope = resolvePluginScopeId(connection.identity.hubPublicKey, state.user?.id, connection.identity.deviceId);
  const activePluginRegistry = useMemo(() => (pluginScope ? getPluginRegistry(pluginScope) : null), [pluginScope]);
  const pluginStore = useSyncExternalStore(
    activePluginRegistry ? activePluginRegistry.subscribe : noopPluginSubscribe,
    activePluginRegistry ? activePluginRegistry.getSnapshot : emptyPluginSnapshot,
  );
  const sidePanelPlugins = activePluginRegistry ? activePluginRegistry.enabledContributions(phone ? "phone" : "desktop", "side-panel") : [];
  const activePluginRecord = activePluginPanel ? pluginStore.installed[activePluginPanel.pluginId] : undefined;
  const mobilePluginRecord = mobilePluginPanel ? pluginStore.installed[mobilePluginPanel.pluginId] : undefined;
  const pluginSideVisible = !pane && !phone && rightMode === "plugin" && !!activePluginRecord?.enabled && visible && !details && searchResults === undefined;
  const desktopDevice = !["ios", "android"].includes(nativePlatform())
    && !/Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    && !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const [terminalAccess, setTerminalAccess] = useState<{ connection: HubConnection; allowed: boolean }>(() => ({ connection, allowed: false }));
  useEffect(() => {
    if (!desktopDevice || phone || !!pane || state.status !== "online" || !state.hostTerminalAvailable) {
      setTerminalAccess({ connection, allowed: false });
      return;
    }
    let active = true;
    let controller: AbortController | undefined;
    const refresh = () => {
      if (!active || document.visibilityState === "hidden") return;
      controller?.abort();
      const nextController = new AbortController();
      controller = nextController;
      void connection.terminalStatus(nextController.signal)
        .then((s) => { if (active && !nextController.signal.aborted) setTerminalAccess({ connection, allowed: s.allowed }); })
        .catch(() => { if (active && !nextController.signal.aborted) setTerminalAccess({ connection, allowed: false }); });
    };
    refresh();
    const onFocus = () => { if (visible) refresh(); };
    const onVisibility = () => { if (visible && document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [connection, desktopDevice, phone, pane, state.status, state.hostTerminalAvailable, settings, visible]);
  const terminalAllowed = desktopDevice && !phone && !pane && state.status === "online" && !!state.hostTerminalAvailable && terminalAccess.connection === connection && terminalAccess.allowed;
  const terminalEligible = terminalAllowed && !!selected && !connection.isReadOnly && !current?.archived && !(current?.parentId && conversations.find((c) => c.id === current.parentId)?.archived);
  const terminalVisible = terminalEligible && rightMode === "terminal" && visible && !details && searchResults === undefined && !settings;
  const [screenOpened, setScreenOpened] = useState(false);
  const screenVisible = screenOpened && rightMode === "screen" && visible && (!phone || isMobileScreenApp()) && (!pane || !isMobileScreenApp() && pane.expanded) && !details && searchResults === undefined && !settings;
  const closeScreen = () => {
    // The remote viewer is shared within this Host workspace. Closing that
    // viewer must also retire other conversations' references to it.
    setRightModes(previous => new Map([...previous].filter(([scope, mode]) => scope !== rightModeScope && mode !== "screen")));
    setScreenOpened(false);
  };
  const openScreen = () => { pane?.expandForWorkbench(); setSettings(false); setDetails(false); closeSearch(); setScreenOpened(true); setRightMode("screen"); };
  const workbenchTrigger = useRef<HTMLButtonElement>(null);
  const workbenchId = `conversation-workbench-${useId()}`;
  const filesTrigger = useRef<HTMLButtonElement>(null);
  const filesId = `conversation-files-panel-${useId()}`;
  const [paneWorkbenchCompact, setPaneWorkbenchCompact] = useState(true);
  const workbenchEligible = !!selected && !!state.user && !connection.isReadOnly && !current?.archived;
  const workbenchVisible = !!workbenchEligible && rightMode === "workbench" && visible && (!pane || pane.expanded) && !details && searchResults === undefined && (!sidebar || !!pane);
  const filesBotId = current?.botIds.length === 1 ? current.botIds[0] : activeBot?.id ?? current?.botIds[0];
  const filesEligible = !pane && !!selected && !!filesBotId && !!state.user && state.user.role === "owner" && !connection.isReadOnly && !current?.archived && !!state.workspaceFilesAvailable;
  const filesVisible = filesEligible && rightMode === "files" && visible && !details && searchResults === undefined && !sidebar;
  const workbench = useWorkbench(connection, selected, state.user?.id, workbenchVisible);
  const workbenchLibrary = useContext(WorkbenchLibraryContext);
  const [localLibraryRequest, setLocalLibraryRequest] = useState<WorkbenchFileRequest>();
  const libraryRequest = localLibraryRequest ?? workbenchLibrary?.request;
  const libraryNavigation = useRef({ selected, visible, connection }); libraryNavigation.current = { selected, visible, connection };
  const libraryHandled = useRef<number | undefined>(undefined), localLibrarySequence = useRef(0);
  const openLocalLibraryFile = async (file: WorkbenchFileTarget) => {
    const conversation = await cache.conversation(file.conversationId);
    if (!conversation || conversation.archived) throw new Error("workbench_library_conversation_unavailable");
    setSelected(file.conversationId); setSidebar(false); closeSearch();
    setLocalLibraryRequest({ serial: ++localLibrarySequence.current, host: { id: "local", name: hostName ?? "", connection }, file });
  };
  useEffect(() => {
    const request = libraryRequest;
    if (!request || request.host.connection !== connection || request.file.conversationId !== selected || !visible || !workbenchEligible || libraryHandled.current === request.serial) return;
    libraryHandled.current = request.serial;
    let active = true;
    const check = () => {
      const current = libraryNavigation.current;
      if (!active || current.connection !== connection || current.selected !== request.file.conversationId || !current.visible) throw new Error("workbench_cancelled");
    };
    pane?.expandForWorkbench(); setSettings(false); setDetails(false); closeSearch(); setSidebar(false); setRightMode("workbench");
    void workbench.ensure().then(async controller => { check(); await controller.openLibraryFile(request.file, { assertActive: check }); })
      .catch(cause => { if (active) setError(workbenchErrorText(cause instanceof Error ? cause.message : "workbench_failed", locale)); })
      .finally(() => { workbenchLibrary?.consumed(request.serial); setLocalLibraryRequest(old => old?.serial === request.serial ? undefined : old); });
    return () => { active = false; };
  }, [libraryRequest?.serial, selected, visible, connection, workbenchEligible, workbench.ensure]);
  useLayoutEffect(() => {
    const pending = pendingDesignNoticeFocus.current;
    if (!pending) return;
    pendingDesignNoticeFocus.current = undefined;
    // Run after React has mounted the draft notice. Returning focus from the
    // editor here lets normal draft revalidation finish before the next Send,
    // without opening the phone keyboard or skipping cross-window reads.
    const active = document.activeElement;
    if (pending.connection === connection && pending.conversationId === selected
      && chatVisible && workbenchVisible && document.visibilityState === "visible"
      && active instanceof HTMLIFrameElement && active.classList.contains("workbench-design-frame"))
      designDraftNotice.current?.focus({ preventScroll: true });
  });
  const workbenchExpanded = phone || workbench.expanded || !!pane && paneWorkbenchCompact;
  const historyVisible = chatVisible && !(workbenchVisible && workbenchExpanded);
  const openWorkbench = useCallback(async () => {
    pane?.expandForWorkbench();
    setDetails(false); closeSearch(); setRightMode("workbench");
    return workbench.ensure();
  }, [workbench.ensure, closeSearch, pane?.expandForWorkbench, setRightMode]);
  const reportWorkbenchOpenError = useCallback((cause: unknown) => {
    const current = libraryNavigation.current;
    // Opening can finish after navigation. Its error belongs to the originating
    // Host/user/conversation, never the interface the user switched to.
    if (current.connection === connection && current.selected === selected && connection.state.user?.id === state.user?.id)
      setError(workbenchErrorText(cause instanceof Error ? cause.message : "workbench_unavailable", locale));
  }, [connection, selected, state.user?.id, locale]);
  // ADHD panes are manual-only: a Bot must not expand a card or replace the
  // multi-conversation layout. Existing visible content targets remain usable.
  const designOpener = useWorkbenchDesignOpener(connection, selected,
    !pane && workbenchEligible && visible && !settings && !details && !manage && !fileCenter && !conversationFiles
      && !capabilities && !operations && !resourcesOpen && !settingsBotIds && !capabilityHelp && !newChat && !newBot && !scheduledTasks && !delegation
      && searchResults === undefined && (!sidebar || !!pane), workbenchVisible,
    async (requestId, check, signal, format) => {
      check();
      const controller = await openWorkbench();
      check();
      const opened = await openWorkbenchDesign(controller, requestId, check, signal, format);
      await waitForDesignSurface(workbenchId, opened.target.tabId!, check, signal);
      return opened;
    });
  useEffect(() => {
    if (rightMode === "workbench" && workbenchEligible) void workbench.ensure().catch(reportWorkbenchOpenError);
  }, [rightMode, workbenchEligible, workbench.ensure, reportWorkbenchOpenError]);
  const workbenchEntry = useMemo(() => workbenchEligible ? {
    openChart: async (source: WorkbenchSource) => { const controller = await openWorkbench(); await controller.openChart(source); },
    openBrowser: async (url: string) => { const controller = await openWorkbench(); await controller.openBrowser(url); },
    openImage: async (file: File, attachmentId?: string) => { const controller = await openWorkbench(); await controller.openImage(file, {attachmentId}); },
  } : undefined, [workbenchEligible, openWorkbench]);
  const sideTrigger = useRef<HTMLButtonElement>(null);
  const sideEligible = visible && !pane && desktopDevice && !!state.sideAvailable && !connection.isReadOnly && current?.type === "direct" && !current.parentId && current.botIds.length === 1 && !current.archived;
  const side = useSideConversation(connection, selected, activeBot?.id ?? "", !!sideEligible, state.status === "online" && !!activeBot?.online, JSON.stringify([activeBot?.engine, activeBot?.model, activeBot?.effort]), conversations);
  const previousSideSelection = useRef(selected);
  useLayoutEffect(() => {
    // Details may follow ordinary navigation, but must not cover the side chat
    // belonging to the conversation we are returning to.
    if (previousSideSelection.current !== selected && side.shown) setDetails(false);
    previousSideSelection.current = selected;
  }, [selected, side.shown]);
  const sideCanOpen = !!sideEligible && !phone && !!side.capability?.supported;
  const sideVisible = rightMode === "side" && side.shown && !!sideEligible && !phone && !details && searchResults === undefined;
  const workspaceRailTrigger = useRef<HTMLButtonElement>(null);
  const workspaceTakesFocus = useRef(false);
  const workspaceId = `conversation-workspace-${useId()}`;
  const [workspaceOpen, setWorkspaceOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("tarobird.workspaceRailOpen") === "1"; } catch { return false; }
  });
  const setDesktopWorkspaceOpen = useCallback((next: boolean) => {
    setWorkspaceOpen(next);
    try { localStorage.setItem("tarobird.workspaceRailOpen", next ? "1" : "0"); } catch { /* ignore */ }
  }, []);
  const workspaceEligible = !pane && !phone && !!current && visible && searchResults === undefined;
  const workspaceVisible = workspaceEligible && workspaceOpen && !details && !sideVisible && !workbenchVisible && !filesVisible && !screenVisible && !terminalVisible && !pluginSideVisible;
  const workspaceComms = useConversationBotComms(connection, selected, workspaceEligible, workspaceVisible, messagesReady ? lastBotReply : "");
  const workspaceNeedsApproval = workspaceComms.data?.summary.needsApproval ?? 0;
  const workspaceActiveComms = workspaceComms.data?.summary.active ?? 0;
  // What the rail was put in front of, per conversation, so closing the rail shows that panel again.
  const workspaceCovers = useRef(new Map<string, "side" | "workbench" | "files" | "screen" | "terminal" | "plugin">());
  useEffect(() => {
    if (activePluginPanel && !pluginStore.installed[activePluginPanel.pluginId]?.enabled) {
      setActivePluginPanel(undefined);
      setRightModes(previous => {
        let changed = false;
        const next = new Map(previous);
        for (const [scope, mode] of next) {
          if (mode === "plugin") { next.delete(scope); changed = true; }
        }
        return changed ? next : previous;
      });
      for (const [scope, covered] of workspaceCovers.current) {
        if (covered === "plugin") workspaceCovers.current.delete(scope);
      }
    }
    if (mobilePluginPanel && !pluginStore.installed[mobilePluginPanel.pluginId]?.enabled) {
      setMobilePluginPanel(undefined);
    }
  }, [activePluginPanel, mobilePluginPanel, pluginStore.installed]);
  const closeWorkspace = useCallback(() => {
    setDesktopWorkspaceOpen(false);
    // Whatever the rail was in front of shows again.
    const covered = workspaceCovers.current.get(rightModeScope); workspaceCovers.current.delete(rightModeScope);
    const unavailable = covered === "screen" && !screenOpened || covered === "files" && !filesEligible
      || covered === "terminal" && !terminalEligible || covered === "plugin" && !activePluginRecord?.enabled;
    if (rightMode === "workspace") setRightMode(unavailable ? "side" : covered ?? "side");
  }, [rightMode, rightModeScope, screenOpened, filesEligible, terminalEligible, activePluginRecord?.enabled, setRightMode, setDesktopWorkspaceOpen]);
  const toggleWorkspace = useCallback(() => {
    if (workspaceVisible) { closeWorkspace(); return; }
    if (details) setDetails(false);
    // Another panel is showing: the rail goes in front of it and closes nothing. A side conversation keeps its
    // session, draft and attachments, and the remote screen and terminal stay connected.
    if (workbenchVisible) designOpener.revoke();
    if (workbenchVisible || filesVisible || sideVisible || screenVisible || terminalVisible || pluginSideVisible) {
      workspaceCovers.current.set(
        rightModeScope,
        workbenchVisible ? "workbench" : filesVisible ? "files" : screenVisible ? "screen" : terminalVisible ? "terminal" : pluginSideVisible ? "plugin" : "side",
      );
      setRightMode("workspace");
    }
    workspaceTakesFocus.current = true;
    setDesktopWorkspaceOpen(true);
  }, [workspaceVisible, workbenchVisible, filesVisible, sideVisible, screenVisible, terminalVisible, pluginSideVisible, details, designOpener, rightModeScope, setRightMode, closeWorkspace, setDesktopWorkspaceOpen]);
  const toggleSide = useCallback(() => {
    if (sideVisible) { void side.close(); sideTrigger.current?.focus(); }
    else { setRightMode("side"); setDetails(false); closeSearch(); void side.open(); }
  }, [sideVisible, side.shown, side.close, side.open, closeSearch, setRightMode]);
  useEffect(() => {
    if (!sideCanOpen) return;
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k" && !event.repeat && !event.isComposing && !document.querySelector("dialog[open]")) { event.preventDefault(); toggleSide(); } };
    return addGlobalListener(window, "keydown", key);
  }, [sideCanOpen, toggleSide]);
  const nativePiCommands = activeBot?.engine === "pi" && piCommands.scope === `${connection.identity.hubPublicKey}:${selected}:${activeBot.id}` ? piCommands.values : [];
  const completedCommands = [...commands, ...nativePiCommands.filter(command => isPiSessionCommand(command.name)
    && command.name.toLowerCase().startsWith(draft.replace(/^\//, "").toLowerCase()) && !commands.some(existing => existing.command === command.name))
    .map(command => ({ command: command.name, description: { defaultValue: command.description || command.name, i18n: { zh_cn: command.description || command.name, en_us: command.description || command.name, ja_jp: command.description || command.name } } }))];
  const sideCommands = sideCanOpen && state.status === "online" && !!activeBot?.online && /^\/(?:s|si|sid|side)?$/.test(draft.trim()) ? [{ command: "side", description: { defaultValue: "Open a temporary side chat", i18n: { zh_cn: "打开临时侧边对话", en_us: "Open a temporary side chat", ja_jp: "一時サイドチャットを開く" } } }, ...completedCommands.filter(c => c.command !== "side")] : completedCommands.filter(c => c.command !== "side");
  // Cached names are sufficient for drafting recipients; membership still comes
  // from this conversation, and runtime controls continue to require live Bots.
  const conversationBots = navigationBots.filter((bot) => current?.botIds.includes(bot.id));
  const settingsTargets = (settingsBotIds ?? []).flatMap(id => {
    const bot = navigationBots.find(value => value.id === id);
    return bot ? [{ ...bot, name: labels.get(id) ?? bot.name }] : [];
  });
  const renameTarget = conversations.find(value => value.id === renameId);
  const removeTopicTarget = conversations.find(value => value.id === removeTopicId && value.parentId);
  const canRename = !!current && state.status === "online" && state.user?.id === current.ownerId;
  const group = current?.parentId ? conversations.find((c) => c.id === current.parentId) : current?.type === "group" ? current : undefined;
  const replyMode = groupReplyMode?.conversationId === selected ? groupReplyMode : undefined;
  const composerDiscussionRun = replyMode?.activeRun?.conversationId === selected ? replyMode.activeRun : undefined;
  const discussionComposer = state.groupDiscussionAvailable !== false && (automaticComposer(replyMode) || !!groupDrafts.current.get(selected)?.intent?.target?.activeRun);
  const discussionParticipants = useDiscussionParticipants(connection, selected, current?.botIds ?? []);
  const groupSending = current?.type === "group" && sending;
  const [, refreshDiscussionChoice] = useState(0);
  const discussionPaused = discussionComposer && replyMode?.activeRun?.status === "paused" && replyMode.activeRun.conversationId === selected;
  const discussionTransitioning = discussionComposer && ["ending", "pausing"].includes(replyMode?.activeRun?.status ?? "");
  const discussionMessageAction = groupDrafts.current.get(selected)?.intent?.discussionAction ?? (replyMode?.activeRun?.actions?.includes("retry") ? "retry" : "resume");

  const activeDiscussionParticipants = replyMode?.activeRun?.participants?.filter(bot => bot.active !== false).map(bot => bot.botId);
  const discussionControlAllowed = !!composerDiscussionRun?.actions?.includes("end");
  const discussionSendActionAllowed = !discussionPaused || !!composerDiscussionRun?.actions?.includes(discussionMessageAction === "new" ? "end" : discussionMessageAction);
  const discussionNewTopic = discussionPaused && discussionMessageAction === "new";
  const discussionMentionIds = !discussionNewTopic && activeDiscussionParticipants || discussionParticipants.ids;
  const hostName = shell?.host.name ?? pane?.host.name ?? t("我的主机");
  const isGroup = current?.type === "group";
  const groupRoster = isGroup && state.groupRecipientKeysAvailable !== false ? replyMode?.remoteMembers : undefined;
  const groupMembers = useMemo(() => isGroup ? groupRecipientOptions(current.botIds, navigationBots, labels, hostName, groupRoster) : undefined, [isGroup, current?.botIds, navigationBots, labels, hostName, groupRoster]);
  const recipientOptions = (!discussionComposer && groupMembers) || groupRecipientOptions(conversationBots.map(bot => bot.id), conversationBots, labels, hostName);
  const mentionQuery = /(?:^|[\s，。！？、（(]|[\p{Script=Han}])[@＠]([^\s@＠]*)$/u.exec(draft);
  const mentionSuggestions = mentionQuery ? recipientOptions.filter(member => (!discussionComposer || discussionMentionIds.includes(member.id)) && [member.botId, member.label].some(name => name.toLowerCase().includes(mentionQuery[1]!.toLowerCase()))) : [];
  const [swarmMembers, setSwarmMembers] = useState<SwarmMember[]>([]);
  const swarmMentionSuggestions = current?.type === "direct" && activeBot?.engine === "antigravity" && mentionQuery && swarmMembers.length > 0
    ? swarmMembers.filter(m => !m.helper && m.name.toLowerCase() !== "system" && (m.state === "working" || m.state === "waiting" || m.state === "paused") && m.name.toLocaleLowerCase().includes(mentionQuery[1]!.toLocaleLowerCase()))
    : [];

  // Only a confirmed live/cached legacy Host gets the historical first-member
  // default. Unknown offline capabilities must not invent that addressing rule.
  const recipientAvailable = (id: string) => current?.botIds.includes(id) || groupRoster?.some(member => member.memberKey === id);
  const recipients = (savedRecipients ?? (current?.type === "group" && (state.groupDiscussionAvailable === false || replyMode?.delivery === "legacy") ? current.botIds.slice(0, 1) : [])).filter(recipientAvailable);
  const unavailableRecipients = !discussionComposer && isGroup && !!savedRecipients?.some(id => !recipientAvailable(id));
  const recipientUnavailable = t("所选 Bot 不再可用或提及不明确，请重新选择回复的 Bot。");
  const setRecipients = (value: string[] | ((previous: string[]) => string[])) => saveRecipients(typeof value === "function" ? value(recipients) : value);
  const wireRecipients = (ids: string[], scopedLocalIds?: string[]) => discussionComposer ? ids : ids.map(id =>
    !id.includes(":") && (groupRoster?.length || scopedLocalIds?.includes(id)) ? `local:${id}` : id,
  );
  const mentionMembers = useMemo(() => [
    ...(current?.botIds ?? []).map(id => ({ id, names: [labels.get(id) ?? "", botDirectory.find(bot => bot.id === id)?.name ?? ""] })),
    ...(!discussionComposer && groupRoster ? groupRoster.map(member => ({ id: member.memberKey, names: [member.name, member.memberKey.split(":")[2]!] })) : []),
  ], [current?.botIds, labels, botDirectory, discussionComposer, groupRoster]);
  const draftMentions = useMemo(() => groupMentions(draft, mentionMembers), [draft, mentionMembers]);
  const discussionSendIds = draftMentions.ids.length ? draftMentions.ids : discussionParticipants.ids;
  const discussionSingleRecipient = !replyMode?.activeRun && discussionSendIds.length === 1 ? labels.get(discussionSendIds[0]!) ?? discussionSendIds[0] : undefined;
  const discussionSendHint = discussionPaused ? discussionMessageAction === "new" ? t("发送新课题") : discussionMessageAction === "retry" ? t("补充并重试") : t("补充并继续") : replyMode?.activeRun ? t("补充到本次讨论") : discussionSingleRecipient ? t("仅发送给 {0}", discussionSingleRecipient) : t("发送后开始讨论");
  const ambiguousMentions = draftMentions.ambiguous?.length;
  const mentionProblem = current?.type === "group" && draftMentions.unresolved.length && (discussionComposer || !recipients.length || (groupRoster?.length && ambiguousMentions)) ? ambiguousMentions ? t("提及 {0} 对应多个 Bot，请从 @ 候选中选择具体的 Bot。", draftMentions.ambiguous!.map(name => `@${name}`).join("、")) : (discussionComposer ? t("无法识别提及：{0}。请从 @ 候选中选择可发言的 Bot。", draftMentions.unresolved.map(name => `@${name}`).join("、")) : t("无法识别提及：{0}。请在“让谁回复”中选择 Bot。", draftMentions.unresolved.map(name => `@${name}`).join("、"))) : "";
  const checkedMentions = (literalUnknown = false) => {
    if (isGroup && draftMentions.unresolved.some(name => /^(local|remote):/i.test(name))) throw new Error(recipientUnavailable);
    if (mentionProblem && (!literalUnknown || ambiguousMentions)) throw new Error(mentionProblem);
    if (unavailableRecipients && !draftMentions.ids.length) throw new Error(recipientUnavailable);
    if (discussionComposer && draftMentions.ids.some(id => !discussionMentionIds.includes(id))) throw new Error(t("点名的 Bot 不在本次可发言范围内，请先调整参与者。"));
    return draftMentions.ids;
  };
  const composerRecipients = draftMentions.ids.length ? draftMentions.ids : recipients;
  const composerBot = discussionComposer ? undefined : current?.type === "direct" ? activeBot : composerRecipients.length === 1 ? state.bots.find(bot => bot.id === composerRecipients[0] && current?.botIds.includes(bot.id)) : undefined;
  // Row indices repeat across conversations; measured heights must belong to
  // message IDs. Anchor the tail while those estimates become real heights.
  // Disconnect observers while the chat is hidden instead of caching zero
  // heights and clearing every measurement when it becomes visible again.
  const messageOverlays = useMessageOverlayRows();
  const rowKey = useCallback((message: Message) => backgroundGroups.byAnchor.get(message.id)?.key ?? messageRowKey(message), [backgroundGroups.byAnchor]);
  const messageKey = useMemo(() => (index: number) => rowKey(displayedMessages[index]!), [displayedMessages, rowKey]);
  const retainMessageOverlay = messageOverlays.retain;
  const retainedMessageRows = new Set([...messageOverlays.rows.keys()].map(id => {
    const anchorId = backgroundGroups.anchors.get(id) ?? id;
    return backgroundGroups.byAnchor.get(anchorId)?.key ?? anchorId;
  }));
  const followingTail = chatVisible && followLatest.current && !focusTarget && !searchResults;
  const readingScroll = useMemo(() => createReadingScroll(() => historyRows.current), [connection]);
  useLayoutEffect(() => readingScroll.reset(), [readingScroll, selected, chatVisible]);
  // One reply can be widened in the desktop main chat: never in an ADHD pane,
  // the phone layout or on a touch platform, whatever the window width.
  const replyWidthDesktop = !pane && desktopReplyWidth(nativePlatform());
  const virtualizer = useVirtualizer({
    count: displayedMessages.length, getItemKey: messageKey,
    ...(replyWidthDesktop ? { observeElementRect: observeReplyWidthRoom } : {}),
    getScrollElement: () => chatVisible ? scroll.current : null,
    estimateSize: () => 160, overscan: 4, anchorTo: followingTail && !readingScroll.ios ? "end" : "start",
    observeElementOffset: readingScroll.observe,
    scrollToFn: readingScroll.scrollTo,
    onChange: readingScroll.changed,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      // Measure the destination on the first commit, before the browser's
      // scroll event advances the virtual range from the previous position.
      if (followingTail && range.count > 0 && !indexes.includes(range.count - 1)) indexes.push(range.count - 1);
      // A reader can restore focus to a row now outside the visible range.
      // Keep that focused row until focus leaves; otherwise removing the overlay
      // immediately removes its trigger and sends keyboard focus to <body>.
      const focused = historyRows.current?.contains(document.activeElement)
        ? document.activeElement?.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey : undefined;
      displayedMessages.forEach((message, index) => { const key = rowKey(message); if ((retainedMessageRows.has(key) || key === focused) && !indexes.includes(index)) indexes.push(index); });
      return indexes.sort((a, b) => a - b);
    },
    // Keep React measurement updates out of WebKit's ResizeObserver delivery.
    useAnimationFrameWithResizeObserver: true,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    const viewport = scroll.current, history = historyRows.current;
    if (!chatVisible || !viewport || !history || !viewport.clientHeight) return false;
    if (!readingScroll.canAdjust(viewport.scrollTop, instance.scrollOffset, instance.scrollAdjustments)) return false;
    // Worker-rendered rows above the viewport can change height even while
    // scrolling backward. Account for the intro before the virtual list, and
    // leave growth inside a visible row below the reader's anchor untouched.
    // On iOS, keep the visible origin steady during touch/inertia, then hand it
    // back to the native offset without replaying a visible jump after release.
    const origin = history.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - viewport.clientTop + readingScroll.shift;
    const fold = (instance.scrollOffset ?? 0) + instance.scrollAdjustments - origin;
    const adjust = instance.itemSizeCache.has(item.key) ? item.end <= fold : item.start < fold;
    return adjust && !readingScroll.defer(delta);
  };
  // measureElement() answers a known row from its cache; a row that has just
  // changed width needs the size its resize observer would report next frame.
  const replyWidth = useMemo(() => replyWidthDesktop && !phone ? { measure: (row: Element | null | undefined) => {
    if (!(row instanceof HTMLElement) || !row.isConnected) return;
    const index = virtualizer.indexFromElement(row);
    if (index >= 0) virtualizer.resizeItem(index, row.offsetHeight);
  } } : undefined, [replyWidthDesktop, phone, virtualizer]);
  const messageHeight = virtualizer.getTotalSize();
  const tailMessageId = displayedMessages.at(-1)?.id;
  const [tailElement, setTailElement] = useState<HTMLElement | null>(null);
  const measureTail = useCallback((node: HTMLElement | null) => {
    virtualizer.measureElement(node);
    setTailElement(node);
  }, [virtualizer]);
  useLayoutEffect(() => { followLatest.current = true; finishTouch(); scrollbarOrigin.current = undefined; scrollingTowardLatest.current = false; setShowLatest(false); }, [selected]);
  useLayoutEffect(() => {
    if (!chatVisible || focusTarget || searchResults || !followLatest.current || (!messages.length && !queued.length) || messages.length > 0 && messages[0]?.conversationId !== selected) return;
    // Follow the tail across replay batches and asynchronous Markdown measurement.
    // Measuring distance only after a large batch arrives mistakes it for scrolling up.
    // Do this before paint: a deferred frame exposes an intermediate history position.
    if (scroll.current && touchY.current === undefined && !scroll.current.dataset.touchHold) {
      // This is passive following, not an index-navigation request. A queued
      // virtualizer reconciliation can otherwise keep chasing the tail after
      // the reader starts a swipe. Measurements/our observer follow later growth.
      scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }, [messages, displayedMessages.length, selected, messageHeight, focusTarget, searchResults, virtualizer, chatVisible]);
  const pendingBubbleRange = hasPendingBubbleTiming(selected, "main")
    ? virtualizer.getVirtualItems().map((item) => item.index).join(",")
    : "";
  useLayoutEffect(() => {
    if (!hasPendingBubbleTiming(selected, "main") || !displayedMessages.length) return;
    markSendTimingBubbleVisible(selected, displayedMessages, (id) => {
      const children = historyRows.current?.children;
      if (!children) return false;
      for (let i = children.length - 1; i >= 0; i--) {
        if ((children[i] as HTMLElement).dataset?.messageId === id) return true;
      }
      return false;
    });
  }, [displayedMessages, selected, messagesReady, pendingBubbleRange]);
  useLayoutEffect(() => {
    if (!draft && hasPendingComposerTiming(selected, "main")) markSendTimingComposerCleared(selected, "main");
  }, [draft, selected]);
  useEffect(() => { let active = true; if (!shell && !pane) { void cache.preferences().then((saved) => { if (active) { setPreferences(saved); setPreferencesReady(true); } }).catch(() => { if (active) setPreferencesReady(true); }); void connection.start().catch(() => undefined); } return () => { active = false; if (!shell && !pane) connection.close(); }; }, [connection]);
  useEffect(() => {
    if (shell || pane) return;
    const navigate = (event: Event) => { const target = (event as CustomEvent<{ conversationId: string; messageId?: string; hostId?: string }>).detail; if (target?.conversationId) {
      if (target.hostId && target.hostId !== runtimeHostId(connection.identity.hubPublicKey!)) { setError(t("无法确定这条通知所属的主机，请从会话列表选择。")); event.preventDefault(); return; }
      setFocusTarget(target); event.preventDefault();
    } };
    window.addEventListener("tarocub-navigate", navigate);
    const scope = new ListenerScope();
    installNativeEvents(() => connection.resume(), scope); installPushActions(scope);
    return () => { scope.close(); window.removeEventListener("tarocub-navigate", navigate); };
  }, [connection]);
  useEffect(() => {
    if (shell || pane || state.status !== "online") return;
    let disposed = false; let remove: (() => void) | undefined;
    void maintainUnifiedPush(connection).then((cleanup) => { if (disposed) cleanup(); else remove = cleanup; }).catch(() => undefined);
    return () => { disposed = true; remove?.(); };
  }, [connection, state.status]);
  useEffect(() => {
    // Do not apply or persist initial defaults before IndexedDB has hydrated.
    if (shell || pane || !preferencesReady) return;
    setLocale(preferences.locale); applyAppearance(preferences); setTicketConversationsVisible(preferences.showTicketConversations);
    document.documentElement.style.setProperty("--font-size", `${preferences.fontSize}px`);
    void cache.savePreferences(preferences).catch(() => undefined);
  }, [preferences, preferencesReady]);
  useEffect(() => { if (selected && !pane) shell?.selection(selected); }, [selected]);
  useLayoutEffect(() => {
    const action = shell?.command; if (!action) return;
    if (action.kind === "select" && action.conversationId !== undefined) { setFocusTarget(action.messageId ? { conversationId: action.conversationId, messageId: action.messageId } : undefined); if (!action.messageId) { followLatest.current = true; setShowLatest(false); } setSelected(action.conversationId); if (!pane) shell?.selection(action.conversationId); closeSearch(); setSidebar(false); }
    else if (action.kind === "archive-selection") { const next = selectionAfterArchive(selected, action.conversationIds ?? [], conversations, navigationItems({ connection, bots: state.bots, conversations }, preferences.showDisconnectedBots).conversations, activity); if (next !== undefined) { setSelected(next); if (!pane) shell?.selection(next); setFocusTarget(undefined); closeSearch(); } }
    else if (action.kind === "connection-settings") { setSettingsSection("connection"); setSettings(true); }
    else if (action.kind === "bot-capabilities" && action.botId) { setDetailBot(action.botId); setCapabilities(true); }
    else if (action.kind === "bot-operations" && action.botId) { const bot = state.bots.find(bot => bot.id === action.botId); if (bot) { setOperationBot({ botId: bot.id, name: labels.get(bot.id) ?? bot.name, view: "dashboard" }); setOperations(true); } }
    else if (action.kind === "bot-settings" && action.botId) { setSidebar(true); setMobileTab("bots"); showBotSettings([action.botId], null); }
    else if (action.kind === "home") { setSidebar(true); setMobileTab("me"); }
    else if (action.kind === "schedule") setScheduledTasks("create");
    else if (action.kind === "bot") setNewBot(true);
    else if (action.kind === "direct" || action.kind === "group") setNewChat({ kind: action.kind, ...(action.botId ? { botId: action.botId } : {}) });
    shell?.consumed(action.serial);
    if (action.kind === "select" && !phone) pendingComposerFocus.current = action.conversationId;
  }, [shell?.command?.serial]);
  // Resolve explicit desktop focus after the new conversation has committed.
  // A frame scheduled in an async creation callback can precede React's commit
  // under load, find no textarea, and lose the focus request permanently.
  useLayoutEffect(() => {
    if (phone || !chatVisible) { pendingComposerFocus.current = undefined; return; }
    if (pendingComposerFocus.current !== selected || newChat || newBot || capabilityHelp || !composer.current) return;
    pendingComposerFocus.current = undefined;
    composer.current.focus({ preventScroll: true });
  }, [selected, newChat, newBot, capabilityHelp, phone, chatVisible, shell?.command?.serial]);
  // Record the selection before exposing its first paint, including a pending
  // recovery hint while the asynchronous IDB transaction is still queued.
  useLayoutEffect(() => { if (selected && !pane) void cache.saveSelectedConversation(selected, connection.identity).catch(() => setError(t("无法保存当前对话位置。"))); }, [selected]);
  const directory = shell?.directory, ownDirectoryRevision = directory ? -1 : conversationRevision;
  useEffect(() => {
    // A group displays activity from its topics too. Reuse HostApp's shared
    // directory updates; only message-body/outbox reads are conversation-scoped.
    if (pane) { setConversations(pane.directory.conversations); setActivity(pane.directory.activity); setPins(pane.directory.pins); setGlobalPins(pane.directory.globalPins ?? []); return; }
    // HostApp's DirectoryObserver already reads this host's directory once per
    // revision (coalesced). Reading it again here tripled the work per event.
    if (directory) { setActivity(directory.activity); setPins(directory.pins); setGlobalPins(directory.globalPins ?? []); }
    let alive = true; void Promise.all([directory ? Promise.resolve(directory.conversations) : cache.conversations(), selected ? Promise.resolve(selected) : cache.selectedConversation()]).then(([c, saved]) => {
      if (!alive) return; setConversations(c);
      if (!selected && c.length) {
        // Keep the local device's selection, not IndexedDB's random ID order.
        // Deep links and explicit clicks still win through their selected state.
        const candidates = c.filter(item => !item.archived && (!item.parentId || !c.some(parent => parent.id === item.parentId && parent.archived)));
        if (!candidates.length) return;
        // A hidden ticket conversation is restored only as an explicit saved choice.
        const latest = listedConversations(candidates).reduce<Conversation | undefined>((a, b) => a && a.createdAt > b.createdAt ? a : b, undefined);
        const initial = candidates.some((item) => item.id === saved) ? saved : latest?.id;
        if (initial) setSelected((current) => current || initial);
      }
    });
    if (!directory) {
      void cache.activity().then((value) => { if (alive) setActivity(value); });
      void cache.pins().then(value => { if (alive) setPins(value); }).catch(() => undefined);
      void cache.pins("global").then(value => { if (alive) setGlobalPins(value); }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [cache, directory, ownDirectoryRevision, selected, locale, visible, pane?.directory]);
  const localUnreadCount = useMemo(() => shell || pane ? 0 : conversationUnreadTotal(conversations, activity), [activity, conversations, shell, pane, showTickets]);
  useEffect(() => { if (shell || pane) return; document.title = localUnreadCount ? `(${localUnreadCount}) TaroBird` : "TaroBird"; void updateBadge(localUnreadCount).catch(() => undefined); }, [localUnreadCount, shell, pane]);
  const localPendingCount = useMemo(() => shell || pane ? 0 : conversationPendingQuestionTotal(conversations, activity), [activity, conversations, shell, pane, showTickets]);
  const changeLocalInboxFilter = (next: InboxFilter | undefined) => {
    if (next === localInboxFilter) return;
    setLocalInboxFilter(next);
    if (!next) { setLocalRetainedOpen(undefined); return; }
    if (selected && isUnreadSelectionTarget(conversations, activity, globalPins, selected, preferences.sidebarLayout, next)) {
      setLocalRetainedOpen(selected);
    } else {
      setLocalRetainedOpen(undefined);
    }
  };
  useEffect(() => {
    if (shell || pane || !localInboxFilter) return;
    if (!selected) { setLocalRetainedOpen(undefined); return; }
    setLocalRetainedOpen(previous => {
      if (previous === selected) return previous;
      return isUnreadSelectionTarget(conversations, activity, globalPins, selected, preferences.sidebarLayout, localInboxFilter) ? selected : undefined;
    });
  }, [shell, pane, localInboxFilter, selected, conversations, activity, globalPins, preferences.sidebarLayout]);
  // Logical pane visibility keeps streams and recordings alive. A read receipt
  // also requires the latest-message edge on screen, through both scroll roots.
  const [paneMessagesVisible, setPaneMessagesVisible] = useState(false);
  useEffect(() => {
    const node = readTail.current;
    if (!pane || !chatVisible || searchResults !== undefined || !node) { setPaneMessagesVisible(false); return; }
    const observer = new IntersectionObserver(([entry]) => setPaneMessagesVisible(!!entry?.isIntersecting && entry.intersectionRect.height > 0 && entry.intersectionRect.width > 0), { root: node.closest(".adhd-grid"), threshold: [0, 1] });
    observer.observe(node);
    return () => observer.disconnect();
  }, [!!pane, chatVisible, selected, searchResults]);
  useEffect(() => {
    // Several panes can be read at once. Keyboard ownership controls shortcuts,
    // not read receipts; the visible tail and loaded history gate those instead.
    const mark = () => { const item = activity[selected]; if (historyVisible && (!pane || paneMessagesVisible && !showLatest && historyRevision >= conversationRevision) && messagesReady && searchResults === undefined && state.status === "online" && document.visibilityState === "visible" && document.hasFocus() && item && Object.keys(item.unread).length) void connection.send({ v: 1, type: "read.mark", conversationId: selected, seq: Math.max(...Object.values(item.unread)) }).catch(() => undefined); };
    const timer = setTimeout(mark, 250);
    const stopFocus = addGlobalListener(window, "focus", mark);
    const stopVisibility = addGlobalListener(document, "visibilitychange", mark);
    return () => { clearTimeout(timer); stopFocus(); stopVisibility(); };
  }, [activity, selected, state.status, connection, historyVisible, searchResults, showLatest, paneMessagesVisible, messagesReady, historyRevision, conversationRevision]);
  useEffect(() => { if (focusTarget && conversations.some((c) => c.id === focusTarget.conversationId)) { if (pane && focusTarget.conversationId !== selected) { pane.navigate(focusTarget.conversationId, focusTarget.messageId); setFocusTarget(undefined); return; } setSelected(focusTarget.conversationId); closeSearch(); setSidebar(false); } }, [focusTarget, conversations, closeSearch]);
  // Position each search/reference/notification target once, after it loads in
  // the visible chat; the virtualizer reconciles its estimated heights. A later
  // refresh repositions only if rows before it changed and the reader has not
  // scrolled. New replies never pull the reader back; the highlight remains.
  useEffect(() => {
    if (!chatVisible || searchResults !== undefined || focusTarget?.conversationId !== selected || !focusTarget.messageId) return;
    const targetId = backgroundGroups.anchors.get(focusTarget.messageId!) ?? focusTarget.messageId;
    const index = displayedMessages.findIndex((m) => m.id === targetId), previous = focusPosition.current;
    if (index < 0 || previous?.target === focusTarget && (previous.released || previous.index === index && previous.settled)) return;
    let frame = 0, settle = 0;
    const align = () => {
      const node = scroll.current, state = focusPosition.current;
      if (!node || !state || state.target !== focusTarget || state.released || state.settled) return;
      virtualizer.scrollToIndex(index, { align: "center" });
      if (++state.attempts >= 4) { state.settled = true; return; }
      settle = requestAnimationFrame(() => {
        const current = scroll.current, latest = focusPosition.current;
        if (!current || !latest || latest.target !== focusTarget || latest.released || latest.settled) return;
        const row = historyRows.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetId)}"]`);
        if (row) {
          const rect = row.getBoundingClientRect(), vp = current.getBoundingClientRect();
          if (rect.bottom > vp.top + 8 && rect.top < vp.bottom - 8) { latest.settled = true; return; }
        }
        align();
      });
    };
    frame = requestAnimationFrame(() => {
      if (!scroll.current) return;
      const existing = focusPosition.current;
      if (existing?.target === focusTarget && existing.index === index) {
        if (existing.released || existing.settled) return;
      } else {
        // An earlier downward gesture must not turn this jump's scroll into a
        // return to the tail that ends the request.
        focusPosition.current = { target: focusTarget, index, released: false, settled: false, attempts: 0 };
      }
      scrollingTowardLatest.current = false;
      align();
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(settle); };
  }, [focusTarget, selected, displayedMessages, backgroundGroups.anchors, virtualizer, chatVisible, searchResults]);
  useSearchMessageHighlight(scroll, pane && chatVisible && searchResults === undefined && focusTarget?.conversationId === selected ? focusTarget.messageId : undefined, focusTarget?.searchQuery, range => {
    const node = scroll.current, positioned = focusPosition.current;
    if (!node || !positioned || positioned.target !== focusTarget || positioned.released) return;
    // Retire index centering before locating a word inside a very tall reply.
    // Reader gestures already release the request and always take precedence.
    positioned.released = true;
    const word = range.getBoundingClientRect(), viewport = node.getBoundingClientRect();
    const delta = word.top < viewport.top || word.bottom > viewport.bottom ? word.top - viewport.top - node.clientHeight / 3 : 0;
    virtualizer.scrollToOffset(node.scrollTop + readingScroll.shift + delta);
  });
  useLayoutEffect(() => { const conversationId = selected; return () => { void flushDraft.current(conversationId); }; }, [selected]);
  useLayoutEffect(() => { setDelegation(undefined); uploadController.current?.abort(); let active = true; const revision = ++draftRevision.current; setDraftScope(""); setDraft(""); if (!unsavedDrafts.current.has(selected) && !draftWindows.current.has(selected)) groupDrafts.current.delete(selected); const entry = groupDraft(selected); void entry.loading.then(() => { if (active && draftRevision.current === revision) { setDraft(unsavedDrafts.current.get(selected) ?? entry.text ?? ""); setDraftScope(selected); } }); return () => { active = false; }; }, [selected]);
  useEffect(() => {
    setCommands(previous => previous.length ? [] : previous);
    if (!keyboardActive || !draft.startsWith("/") || draft.includes(" ") || !activeBot || state.status !== "online") return;
    const query = draft.slice(1), botId = activeBot.id;
    const unsubscribe = connection.subscribeCommands((values, sourceBot, sourceQuery) => { if (sourceBot === botId && (sourceQuery === undefined || sourceQuery === query)) setCommands(values as typeof commands); });
    const timer = setTimeout(() => { void connection.send({ v: 1, type: "command.complete", botId, query }).catch(() => undefined); }, 180);
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [connection, draft, activeBot?.id, state.status, selected, keyboardActive]);
  const turnStop = useTurnStop(connection, selected, messages, visible);
  const discussionStopFlight = useRef(false);
  const [discussionStopping, setDiscussionStopping] = useState(false);
  const requestComposerStop = async () => {
    if (!discussionComposer || !composerDiscussionRun) return turnStop.request(selected);
    if (discussionStopFlight.current || composerDiscussionRun.status === "ending") return;
    if (!composerDiscussionRun.actions?.includes("end")) throw new Error(t("只有讨论发起人或群主可以控制这次讨论。"));
    discussionStopFlight.current = true; setDiscussionStopping(true);
    try {
      const view = await controlComposerDiscussion(connection, selected, composerDiscussionRun.id, "end");
      if (currentSelection.current === selected) setGroupReplyMode(groupReplyModeFromView(selected, view));
    } finally { discussionStopFlight.current = false; setDiscussionStopping(false); }
  };

  const report = (work: Promise<unknown>) => { void work.catch((e: unknown) => setError(e instanceof Error ? e.message : t("操作失败"))); };
  // pendingDraftWrites counts in-flight writes plus each window holding newer,
  // unwritten text, so the status never reports a failure while text is queued.
  const writeDraft = (conversationId: string, text: string) => {
    pendingDraftWrites.current++;
    const entry = groupDrafts.current.get(conversationId), intent = entry?.intent;
    const grouped = !!intent && !intent.legacy;
    const write = (lastDraftWrite.current.get(conversationId) ?? Promise.resolve()).then(async () => {
      if (grouped) {
        await entry!.loading;
        await cache.saveGroupComposerDraft(conversationId, text, intent!, entry!.savedId); entry!.savedId = intent!.id; entry!.error = undefined;
      } else await cache.saveDraft(conversationId, text);
      if (unsavedDrafts.current.get(conversationId) === text && (!grouped || entry!.intent?.id === intent!.id)) unsavedDrafts.current.delete(conversationId);
    }).catch(error => { if (grouped) entry!.error = error; throw error; })
      .finally(() => { if (--pendingDraftWrites.current === 0) setDraftSaving(false); });
    report(write.catch(error => {
      if (error instanceof Error && error.message === "draft_changed_elsewhere") throw new Error(t("另一窗口已更新此草稿。当前内容仍在此页，请备份后重新打开客户端。"));
      throw error;
    }));
    lastDraftWrite.current.set(conversationId, write.catch(() => undefined));
  };
  const closeDraftWindow = (conversationId: string) => {
    const slot = draftWindows.current.get(conversationId); if (!slot) return;
    if (slot.text === undefined) { draftWindows.current.delete(conversationId); return; }
    const text = slot.text; slot.text = undefined; pendingDraftWrites.current--;
    writeDraft(conversationId, text);
    slot.timer = setTimeout(() => closeDraftWindow(conversationId), DRAFT_SAVE_DELAY_MS);
  };
  flushDraft.current = (conversationId: string) => {
    const slot = draftWindows.current.get(conversationId);
    if (slot) {
      clearTimeout(slot.timer); draftWindows.current.delete(conversationId);
      if (slot.text !== undefined) { pendingDraftWrites.current--; writeDraft(conversationId, slot.text); }
    }
    return lastDraftWrite.current.get(conversationId) ?? Promise.resolve();
  };
  const queueDraftText = (conversationId: string, text: string) => {
    setDraftSaving(true); unsavedDrafts.current.set(conversationId, text);
    const slot = draftWindows.current.get(conversationId);
    if (slot) { if (slot.text === undefined) pendingDraftWrites.current++; slot.text = text; return; }
    writeDraft(conversationId, text);
    draftWindows.current.set(conversationId, { timer: setTimeout(() => closeDraftWindow(conversationId), DRAFT_SAVE_DELAY_MS) });
  };
  const editGroupDraft = (text: string, hasRichContent: boolean, target = replyMode) => {
    if (current?.type !== "group") return;
    const entry = groupDraft(selected);
    entry.intent = editGroupComposerIntent(entry.intent, target, !text && !hasRichContent); entry.text = text;
  };
  const changeDraft = (text: string) => {
    if (current?.type === "group" && sendBusy.current) return;
    setFocusTarget(undefined); draftRevision.current++; draftVersions.current.set(selected, (draftVersions.current.get(selected) ?? 0) + 1); setDraftScope(selected); setDraft(text);
    lastDraftEdits.current.set(selected, { version: draftVersions.current.get(selected)!, text });
    editGroupDraft(text, !!files.length || !!reply); groupDraft(selected).text = text;
    queueDraftText(selected, text);
    if (current?.type === "direct" && (activeBot?.engine === "codex" || activeBot?.engine === "pi" || activeBot?.engine === "omp")) void retireEditedSteeringDraft(connection, selected, current.botIds[0]!, text).catch(() => undefined);
    if (current?.type === "direct" && activeBot?.engine === "claude") void retireEditedNativeInputDraft(connection, selected, current.botIds[0]!, text).catch(() => undefined);
  };
  const composeWidget = (message: Message, raw: string): boolean => {
    const text = widgetComposeText(raw);
    if (!text || message.forwardedFrom || message.botSource || !chatVisible || currentSelection.current !== selected || message.conversationId !== selected ||
        !current || current.archived || group?.archived || connection.isReadOnly || deletion.active ||
        !richDraftReady || draftScope !== selected || sendBusy.current || sending || steeringBusy || recording ||
        uploadProgress !== undefined || !composer.current) return false;
    const next = appendWidgetDraft(unsavedDrafts.current.get(selected) ?? draft, text);
    try { assertMessageTextSize(next); } catch { return false; }
    // The ordinary composer retains attachments, quotation, recipients and the
    // user's supplement/queue choice. Widget code can never send or steer.
    changeDraft(next);
    requestAnimationFrame(() => { if (currentSelection.current === selected) composer.current?.focus({ preventScroll: true }); });
    return true;
  };
  const widgetComposer = useRef(composeWidget); widgetComposer.current = composeWidget;
  const dispatchWidgetCompose = useCallback((message: Message, text: string) => widgetComposer.current(message, text), []);
  const chooseDiscussionAction = (action: "resume" | "retry" | "new") => {
    changeDraft(draft);
    const entry = groupDraft(selected);
    entry.intent = { ...entry.intent!, discussionAction: action, target: replyMode };
    queueDraftText(selected, draft); refreshDiscussionChoice(value => value + 1);
  };
  const setFiles = (action: SetStateAction<File[]>) => setRichFiles(old => {
    const next = typeof action === "function" ? action(old) : action;
    if (next !== old && current?.type === "group") {
      const text = groupDraft(selected).text ?? draft;
      editGroupDraft(text, !!next.length || !!reply); queueDraftText(selected, text);
    }
    return next;
  });
  const setReply = (action: SetStateAction<Message | undefined>) => setRichReply(old => {
    if (current?.type === "group" && sendBusy.current) return old;
    const next = typeof action === "function" ? action(old) : action;
    if (next !== old && current?.type === "group") { const text = groupDraft(selected).text ?? draft; editGroupDraft(text, !!files.length || !!next); queueDraftText(selected, text); }
    return next;
  });
  const prepareGroupDraft = async (): Promise<GroupComposerIntent> => {
    const entry = groupDraft(selected), capturedId = entry.intent?.id;
    await entry.loading;
    let intent = entry.intent;
    const changed = () => !intent || entry.intent?.id !== intent.id || capturedId !== undefined && intent.id !== capturedId;
    await flushDraft.current(selected);
    const persisted = await cache.groupComposerDraft(selected);
    entry.invalidIntent = persisted.invalidIntent;
    if (entry.invalidIntent) throw new Error(t("上次发送结果无法确认，草稿已保留。请先核对聊天记录，避免重复发送。"));
    if (entry.error || !intent) throw new Error(t("草稿尚未保存或已在另一窗口修改，请保留当前内容并重新打开对话。"));
    if (changed()) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
    if (intent!.legacy) {
      // Only an untouched pre-upgrade draft may migrate a signature-only receipt.
      intent = { ...intent!, target: intent!.target ?? replyMode };
      await cache.saveGroupComposerDraft(selected, entry.text ?? draft, intent, entry.savedId); entry.savedId = intent.id;
      if (entry.intent?.id === intent.id) entry.intent = intent;
    } else if (persisted.intent?.id !== intent!.id) throw new Error(t("草稿尚未保存或已在另一窗口修改，请保留当前内容并重新打开对话。"));
    try { await flushRichDraft(); } catch (error) {
      // Local attachment quotas do not limit a legal Hub upload. Keep the
      // existing unsaved-files warning, but block identity/concurrency failures.
      if (!(error instanceof Error) || !["draft_capacity_exceeded", "draft_metadata_too_large", "draft_record_limit"].includes(error.message)) throw new Error(t("草稿尚未保存或已在另一窗口修改，请保留当前内容并重新打开对话。"));
    }
    if (changed()) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
    return intent!;
  };
  const clearSentDraft = async (conversationId: string, sentText: string, intent?: GroupComposerIntent) => {
    await flushDraft.current(conversationId);
    if (intent) {
      const entry = groupDraft(conversationId);
      // Clearing is a write too. New edits must wait for its own tombstone
      // before comparing revisions, without adopting another window's revision.
      const clear = (lastDraftWrite.current.get(conversationId) ?? Promise.resolve()).then(async () => {
        const cleared = await cache.clearGroupComposerDraft(conversationId, sentText, intent.id);
        if (!cleared) return;
        if (entry.savedId === intent.id) entry.savedId = cleared.id;
        if (entry.intent?.id !== intent.id) return;
        entry.intent = cleared; entry.text = "";
        if (unsavedDrafts.current.get(conversationId) === sentText) unsavedDrafts.current.delete(conversationId);
      });
      lastDraftWrite.current.set(conversationId, clear.catch(() => undefined));
      await clear;
    } else {
      await cache.clearDraftIfMatches(conversationId, sentText);
      const entry = groupDrafts.current.get(conversationId); if (entry?.text === sentText) entry.text = "";
      if (unsavedDrafts.current.get(conversationId) === sentText) unsavedDrafts.current.delete(conversationId);
    }
  };
  const rebindGroupDraft = async (resetReceipt = false) => {
    if (!replyMode) return;
    if (resetReceipt && !window.confirm(t("上次发送结果未确认，请先核对聊天记录，避免重复发送。继续后可重新发送当前内容。"))) return;
    await flushDraft.current(selected);
    if (resetReceipt) { const key = `discussion-composer:${selected}`, raw = await cache.draft(key); await cache.clearDraftIfMatches(key, raw); }
    const entry = groupDraft(selected); await entry.loading;
    const intent = editGroupComposerIntent(undefined, replyMode, !draft && !files.length && !reply);
    if (resetReceipt && entry.invalidIntent) {
      await cache.saveGroupComposerDraft(selected, draft, intent, entry.savedId, entry.invalidIntent);
      entry.savedId = intent.id; entry.invalidIntent = undefined; entry.error = undefined;
    }
    entry.intent = intent; entry.text = draft;
    queueDraftText(selected, draft); setError(""); focusComposer();
  };
  const focusComposer = () => {
    const field = composer.current;
    if (!phone) requestAnimationFrame(() => { if (field?.isConnected && currentSelection.current === selected) field.focus({ preventScroll: true }); });
  };
  const addFiles = (chosen: File[]) => {
    // Steering only sends text: newly recorded audio belongs to the next draft.
    if (!chosen.length) return false;
    if (uploadController.current) { setError(t("正在发送，请完成后再添加附件。")); return false; }
    setFiles((old) => [...old, ...chosen]); setAttachmentDropError(""); focusComposer(); return true;
  };
  const removeFile = (index: number) => {
    // The stored list can change while a focus read is pending. Replay against
    // this exact File, never the old index in another window's newer list.
    const file = files[index];
    setFiles(old => { const position = old.indexOf(file); return position < 0 ? old : old.filter((_, i) => i !== position); });
    focusComposer();
  };
  const composeDesign = async (value: DesignBotDraft):Promise<"opened"|"declined"> => {
    const controller=workbench.controller, text=widgetComposeText(value.text);
    if(!text || !controller || !chatVisible || currentSelection.current!==selected || !current || current.archived || group?.archived || connection.isReadOnly || deletion.active || !richDraftReady || draftScope!==selected || sendBusy.current || sending || steeringBusy || recording || uploadProgress!==undefined || !composer.current) return "declined";
    const registration=controller.getRegistration(),tab=registration?.tabs.find(tab=>tab.id===value.designId && tab.kind==="design");
    if(!registration?.visible || !tab || registration.conversationId!==selected)return "declined";
    const next=appendWidgetDraft(unsavedDrafts.current.get(selected)??draft,text);
    try{assertMessageTextSize(next);}catch{return "declined";}
    const session=controller.designSession(tab.id);if(!session)return "declined";
    try {
      const merged = mergeDesignCommentDraft(getWorkbenchDraft(), { context: { target: { deviceId: connection.identity.deviceId, windowId: registration.windowId, tabId: tab.id }, kind: "design", revision: session.document.revision }, files: [], designComments: value.threadIds, ...(value.threadSnapshot ? {designCommentVersions:designCommentVersions(value.threadSnapshot)} : {}) });
      addWorkbenchAnnotation([], merged);
    } catch { return "declined"; }
    if (phone || ["ios", "android"].includes(nativePlatform())) pendingDesignNoticeFocus.current = { connection, conversationId: selected };
    changeDraft(next);
    if (!pendingDesignNoticeFocus.current) focusComposer();
    return "opened";
  };
  const annotateWorkbench = async (annotation: BoardAnnotation) => {
    const controller = workbench.controller;
    if (!controller || !richDraftReady || connection.isReadOnly) throw new Error("workbench_draft_unavailable");
    const target = {deviceId:connection.identity.deviceId,windowId:controller.getSnapshot().windowId,tabId:annotation.boardId};
    const prepared = await annotationDraft(target,annotation);
    if (currentSelection.current !== selected) throw new Error("workbench_conversation_changed");
    if (files.length + prepared.files.length > 32) throw new Error(t("附件数量过多，请先移除部分附件。"));
    addWorkbenchAnnotation(prepared.files,prepared.workbench);
    const instruction = t("请按标注修改原图，保留未标注的内容。标注预览仅说明修改位置，不要把标注线画进结果。");
    const text = unsavedDrafts.current.get(selected) ?? draft;
    changeDraft(`${text}${text ? "\n\n" : ""}${instruction}`);
    focusComposer();
  };
  const pasteFiles = useComposerPaste({ scope: `${selected}:${visible}`, input: composer, disabled: connection.isReadOnly || groupSending || uploadProgress !== undefined, add: addFiles, change: changeDraft, fail: setAttachmentDropError });
  const [sideRecording, setSideRecording] = useState(false);
  const attachments = useAttachmentPicker({ scope: selected, hostActive: visible, active: chatVisible && !searchResults && !!selected && !current?.archived && !group?.archived, phone, disabled: connection.isReadOnly || groupSending || uploadProgress !== undefined, add: addFiles, fail: setError, settle: focusComposer });
  // A completed encoder may return after a host/chat/layout round trip. Only
  // the exact visible recording scope can auto-send; otherwise retain its draft.
  const voiceScope = useRef({ key: "", version: 0 });
  const voiceKey = `${selected}:${chatVisible}:${phone}:${voiceMode}:${searchResults !== undefined}:${!!current?.archived}:${!!group?.archived}`;
  if (voiceScope.current.key !== voiceKey) voiceScope.current = { key: voiceKey, version: voiceScope.current.version + 1 };
  const voiceVersion = voiceScope.current.version;
  const voice = useVoiceRecorder(
    selected && !current?.archived && !group?.archived ? selected : "",
    // Retained at recording start, this setter belongs to the original host/chat.
    // Another chat's active upload must not discard a late encoder result.
    (file, sendOnRelease) => {
      if (sendOnRelease) void sendVoice(file);
      else { setFiles(old => [...old, file]); if (voiceScope.current.version === voiceVersion && phone) setVoiceMode(false); }
    }, message => { pane?.releaseMicrophone(); setError(message); },
  );
  useEffect(() => {
    if (visible) return;
    setDetails(false); setChatActions(false); setRenameId(undefined); setRemoveTopicId(undefined); setSettingsBotIds(undefined); setArchives(false); setSettings(false); setManage(false); setNewBot(false); setNewChat(undefined); setDelegation(undefined); setFileCenter(false); setConversationFiles(undefined); setOperations(false); setCapabilities(false); setCapabilityHelp(undefined); setForwarding(undefined); setMessageSheet(undefined);
    if (voice.phase === "requesting") voice.cancel(); else if (voice.phase === "recording") voice.finish();
  }, [visible, voice.phase, voice.cancel, voice.finish]);
  // A popover never outlives the target it was opened for: another chat or host,
  // the phone layout, history search or archiving all close it.
  const searching = searchResults !== undefined, archivedHere = !!current?.archived || !!group?.archived;
  useEffect(() => { setMenu(undefined); }, [selected, phone, visible, searching, archivedHere]);
  useEffect(() => { setMovingConversation(undefined); }, [selected, phone, visible, searching, archivedHere, connection, preferences.sidebarLayout]);
  const [taskListRequest, setTaskListRequest] = useState<{ conversationId: string; id: number; tab?: "tasks" | "board" }>();
  const consumeTaskListRequest = useCallback((id: number) => setTaskListRequest(request => request?.id === id ? undefined : request), []);
  const [steeringBusy, setSteeringBusy] = useState(false);
  const currentSelection = useRef(selected); currentSelection.current = selected;
  const currentlyVisible = useRef(visible); currentlyVisible.current = visible;
  const copyRequest = useRef<object | undefined>(undefined);
  const copyMessages = useRef(messages); copyMessages.current = messages;
  // Each request owns its feedback. Leaving a scope invalidates it even if the
  // reader returns before the clipboard promise settles; unmount does too.
  useLayoutEffect(() => {
    copyRequest.current = undefined;
    return () => { copyRequest.current = undefined; };
  }, [connection, selected, visible]);
  // Focus after the message sheet or the forward dialog closes. Rows are virtualised
  // and may unmount while a dialog is open, so a trigger is reused only while it is
  // still mounted in the same conversation; then that message row; then a stable
  // control of the conversation (phone header menu, desktop composer). Refs only, so
  // the memoised getters below stay current.
  const conversationFocus = () => !pane && matchMedia("(max-width:760px)").matches ? chatMoreTrigger.current : composer.current;
  const messageFocus = (conversationId: string, messageId: string, trigger: HTMLElement | null): HTMLElement | null => {
    if (currentSelection.current !== conversationId) return conversationFocus();
    if (trigger?.isConnected) return trigger;
    const row = [...scroll.current?.querySelectorAll<HTMLElement>("article[data-message-id]") ?? []].find((node) => node.dataset.messageId === messageId);
    return row ?? conversationFocus();
  };
  const sheetReturn = useMemo(() => ({ get current() { const origin = sheetOrigin.current; return !origin ? null : origin.next?.isConnected ? origin.next : messageFocus(origin.conversationId, origin.messageId, origin.trigger); } }), []);
  const conversationReturn = useMemo(() => ({ get current() { return conversationFocus(); } }), []);
  const forwardReturn = useMemo(() => ({ get current() { const origin = forwardOrigin.current; return origin ? messageFocus(origin.conversationId, origin.messageId, forwardTrigger.current) : forwardTrigger.current; } }), []);
  const composerContent = useRef({ files, reply }); composerContent.current = { files, reply };
  const steer = async (ordinarySend = false, immediately = false, origin?: { context?: WorkbenchContext }, expectedTargetId?: string, queueIfRejected = false, parentTiming?: SendTimingTrace) => {
    if (!current || !richDraftReady || sendBusy.current) { parentTiming?.fail("aborted"); return; }
    const timing = parentTiming ?? beginSendTiming({
      conversationId: current.id,
      kind: current.type === "group" ? "group" : "direct",
      engine: current.type === "group" ? "group" : activeBot?.engine,
      messageLength: draft.length,
      historyCount: messages.length,
      matchText: draft,
    });
    try {
    history.assertCanSend();
    assertMessageTextSize(draft);
    setError("");
    if (state.status !== "online") throw new Error(ordinarySend ? t("当前离线，请恢复连接后核对或发送消息。") : t("引导需要在线连接，不会离线排队。"));
    if (recording || files.length || reply) throw new Error(immediately ? t("立即发送目前只支持纯文字；附件和引用已保留，可作为下一轮发送。") : ordinarySend ? t("这段文字有待确认的发送记录。请先核对消息回执，附件和引用保留在输入框。") : t("引导目前只接收纯文字。请移除附件或引用，或使用普通发送。"));
    const explicit = checkedMentions();
    const targets = explicit.length ? explicit : current.type === "group" ? recipients : current.botIds;
    if (targets.length !== 1 || targets[0]!.includes(":")) throw new Error(t("请先选中一个要引导的 Bot。"));
    const conversationId = current.id, text = draft, revision = draftRevision.current, textVersion = draftVersions.current.get(current.id) ?? 0;
    sendBusy.current = true; setSteeringBusy(true);
    try {
      if (!text.trim()) throw new Error(t("请先输入要补充给当前任务的文字。"));
      // Ordinary sending already captured this once; reading the immediate
      // snapshot avoids blocking chat sends or steers on background registration.
      const openContext = origin ? origin.context : designOpener.contextSnapshot();
      if (!origin) timing?.mark("workbenchDoneAt");
      if (currentSelection.current !== conversationId) { timing?.fail("conversation_changed"); return; }
      const boundTarget = expectedTargetId ?? (codexDirect ? steeringCapability.targetId : undefined);
      const receipt = await sendSteering(connection, conversationId, targets[0]!, text, () => currentSelection.current === conversationId, ordinarySend, immediately, openContext, boundTarget, timing);
      if (!receipt) { timing?.fail("conversation_changed"); return; }
      const result = receipt.blocks.find((block) => block.type === "steering");
      if (result?.outcome === "rejected") throw new SteeringNotDeliveredError(result.reason, ordinarySend);
      if (result?.outcome !== "accepted") throw new Error(ordinarySend ? nativeInputReason(result?.reason) : steerReason(result?.reason));
      timing?.mark("steeringStateDoneAt");
      const latestEdit = lastDraftEdits.current.get(conversationId);
      if (result.mode === "message") {
        // Settle the originating draft even after navigation. A confirmed send
        // must not leave a text-only retry identity that swallows a future
        // identical message. Preserve edits made while admission was in flight.
        if ((draftVersions.current.get(conversationId) ?? 0) === textVersion) {
          await clearSentDraft(conversationId, text);
          if ((draftVersions.current.get(conversationId) ?? 0) === textVersion) {
            clearSentRichDraft(true);
            if (currentSelection.current === conversationId) { if (text) timing?.expectComposerClear(); setDraft(""); }
            else timing?.skipComposerClear();
          } else timing?.skipComposerClear();
        } else timing?.skipComposerClear();
        if (receipt.clientMsgId) await clearNativeInputDraft(connection, conversationId, targets[0]!, receipt.clientMsgId);
      } else if (currentSelection.current === conversationId && draftRevision.current === revision) {
        if (text) timing?.expectComposerClear();
        setDraft(""); clearSentRichDraft(true); await clearSentDraft(conversationId, text);
        if (receipt.clientMsgId) await clearSteeringDraft(connection, conversationId, targets[0]!, receipt.clientMsgId);
      } else if (piOrOmpDirect && receipt.clientMsgId && latestEdit && latestEdit.version === draftVersions.current.get(conversationId) && latestEdit.version > textVersion && latestEdit.text !== text) {
        timing?.skipComposerClear();
        // Admission is confirmed and the originating draft has been edited.
        // Use its own version/text, even after navigation; never the new chat.
        // Keep that draft, but retire only this receipt so a later intentional
        // repeat is a new send. An uncertain attempt never reaches this branch.
        await clearSteeringDraft(connection, conversationId, targets[0]!, receipt.clientMsgId);
      } else timing?.skipComposerClear();
      if (immediately && result.mode === "message") {
        const control = await controlNativeInput(connection, conversationId, receipt.id, "send-now");
        if (control.outcome === "unknown") throw new Error(t("消息已投递，但立即发送结果待确认。请在消息下方核对，勿重复发送。"));
        if (control.outcome === "rejected") throw new Error(control.result === "not_queued" ? t("消息已开始处理或已不在原生队列，本次未改变任务。") : nativeControlReason(control.reason));
      }
    } catch (error) {
      // A normal send should still work if the observed turn just ended. Never
      // requeue uncertain delivery, a changed binding or a newly edited draft.
      const unchanged = currentSelection.current === conversationId && draftRevision.current === revision && composerContent.current.files === files && composerContent.current.reply === reply;
      if ((ordinarySend || queueIfRejected) && error instanceof SteeringNotDeliveredError) {
        // A send whose draft changed during the live preflight was not delivered
        // anywhere. Say so instead of blaming the task or the CLI.
        if (error.canQueue && !unchanged && currentSelection.current === conversationId) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
        // Only a fresh native status explicitly reporting idle permits the
        // terminal's idle Ctrl+Enter behavior. Missing capability or failed
        // probes never silently become an ordinary in-flight send.
        if (immediately && error.reason === "idle" && unchanged) { timing?.resetForFallback(); return "idle" as const; }
        if (!immediately && error.canQueue && unchanged) { timing?.resetForFallback(); return "queue" as const; }
        if (immediately) throw new Error(t("当前 CLI 或任务状态不支持立即发送，消息已保留。"));
      }
      throw error;
    } finally { sendBusy.current = false; setSteeringBusy(false); }
    } catch (error) { if (!parentTiming) timing?.fail(error); throw error; }
  };
  const sendImmediately = async () => {
    const useOrdinarySend = draft.trimStart().startsWith("/") || workbenchVisible || !!workbenchDraft;
    if (useOrdinarySend
      ? (!selected || !richDraftReady || recording || (!draft.trim() && !files.length) || sendBusy.current)
      : (!selected || !current || !richDraftReady || sendBusy.current)) return;
    const timing = beginSendTiming({
      conversationId: selected,
      kind: current?.type === "group" ? "group" : "direct",
      engine: current?.type === "group" ? "group" : activeBot?.engine,
      messageLength: draft.length,
      historyCount: messages.length,
      matchText: draft,
      existingMessages: current?.type === "group" ? messages : undefined,
    });
    try {
      // Commands retain their existing local/durable handling, never native text injection.
      if (useOrdinarySend) { await send(false, false, timing); return; }
      if (await steer(true, true, undefined, undefined, false, timing) === "idle") await send(false, false, timing);
    } catch (error) { timing?.fail(error); throw error; }
  };
  const startHeldVoice = () => {
    setError("");
    if (discussionComposer && (!discussionParticipants.ready || discussionParticipants.error)) { setError(t("参与者选择尚未读取或保存，请重新选择后发送。")); return; }
    if (discussionComposer && !replyMode?.activeRun && !discussionParticipants.ids.length) { setError(t("请至少选择一位可以发言的 Bot。")); return; }
    if (unavailableRecipients) { setError(recipientUnavailable); return; }
    if (current?.type === "group" && !recipients.length && !state.groupDiscussionAvailable) { setError(t("请先选择回复的 Bot。")); return; }
    composer.current?.blur(); void voice.startHeld();
  };
  const recording = voice.busy;
  const backRoot = useRef<HTMLDivElement>(null);
  // ADHD expands only its owning card, never the shared native window.
  const sideWindowLayout = useSideWindowExpansion(backRoot, !pane && (sideVisible || screenVisible || terminalVisible || (pluginSideVisible || workbenchVisible || filesVisible) && !phone));
  // Native expansion can finish before IndexedDB or the lazy Workbench chunk.
  // Reserve the same column in both stages; late loading after Close stays hidden.
  const workbenchLoading = workbenchVisible ? <aside className={`workbench-loading ${!phone && !pane ? "conversation-side-panel" : ""}`} hidden={!phone && sideWindowLayout === "pending"} aria-label={t("工作台")}>
    <div role="status">{t("正在打开工作台…")}</div>
  </aside> : null;
  useLayoutEffect(() => {
    const root = backRoot.current;
    if (!pane || !root) return;
    const measure = () => setPaneWorkbenchCompact(root.clientWidth < 760);
    const observer = new ResizeObserver(measure); observer.observe(root); measure();
    return () => observer.disconnect();
  }, [!!pane, pane?.expanded, visible]);
  useSceneMotion(backRoot, sidebar, phone && visible, sidebar ? -1 : 1, sidebar ? ":scope > .mobile-home" : ":scope > .conversation-main");
  const openMobileHome = () => {
    if (voice.phase === "requesting") voice.cancel();
    else if (voice.phase === "recording") voice.finish();
    setFocusTarget(undefined); closeSearch(); setSidebar(true); setMobileTab("messages");
  };
  const exitHistorySearch = () => {
    if (phone) openMobileHome();
    else { closeSearch(); requestAnimationFrame(() => conversationSearchTrigger.current?.focus({ preventScroll: true })); }
  };
  const browseBotConversations = (botId: string) => {
    mobileScroll.current.messages = 0;
    updateMobileInbox({ ...mobileInbox, query: "", filter: "all", botScope: { hostId: shell?.host.id ?? "local", botId } });
    setChatActions(false); setDetails(false); openMobileHome();
  };
  useBackAction(backRoot, () => {
    if (!keyboardActive) return false;
    if (recording) {
      if (voice.phase === "requesting") voice.cancel();
      else if (voice.phase === "recording") voice.finish();
      return;
    }
    if (searchResults !== undefined) { exitHistorySearch(); return; }
    if (!phone) return false;
    if (sidebar) { if (mobileTab !== "messages") { setMobileTab("messages"); return; } return false; }
    openMobileHome();
  }, 0);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!chatVisible || !node || focusTarget || searchResults !== undefined) return;
    // Keyboard/composer resizing can change the reading viewport without any
    // message height changing. Follow that resize explicitly, while preserving
    // the user's opt-out when reading earlier messages. No React state per frame.
    const tail = tailElement;
    let fitFrame = 0;
    const observer = new ResizeObserver(() => {
      if (!followLatest.current) {
        // Expanding a pane can make the entire history visible without a scroll
        // event. Reconcile after measurement, outside ResizeObserver delivery.
        if (showLatest && !fitFrame) fitFrame = requestAnimationFrame(() => {
          fitFrame = 0;
          const history = historyRows.current;
          if (followLatest.current || !messagesReady || !tail?.isConnected || tail.dataset.messageId !== tailMessageId || !history || history.childElementCount !== displayedMessages.length || history.querySelector(".markdown-pending") || touchY.current !== undefined || node.dataset.touchHold || node.dataset.contextMenu || scrollbarOrigin.current !== undefined || node.clientHeight <= 0 || node.scrollTop > 2 || node.scrollHeight > node.clientHeight + 2) return;
          const bottom = node.getBoundingClientRect().top + node.clientTop + node.clientHeight;
          // A virtual spacer may still underestimate freshly wrapped rows.
          // Require the real tail and all loaded rows to fit before following.
          if (tail.getBoundingClientRect().bottom > bottom + 2 || [...history.children].reduce((height, row) => height + row.getBoundingClientRect().height, 0) > node.clientHeight + 2) return;
          followLatest.current = true; setShowLatest(false);
        });
        return;
      }
      if (touchY.current !== undefined || node.dataset.touchHold) return;
      if (tail?.isConnected && !queuedRows.current?.childElementCount) {
        // Markdown can shrink before the virtual spacer is measured next frame.
        // Follow its actual bottom before paint without updating React/row sizes
        // inside this observer (which would cause WebKit observer loops).
        const bottom = node.getBoundingClientRect().top + node.clientTop + node.clientHeight;
        node.scrollTop += tail.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(node).paddingBottom) || 0) - bottom;
      } else node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    if (tail) observer.observe(tail);
    // The virtual spacer commits after row measurements. Its final shrink must
    // recheck the all-visible case even if the tail itself no longer resizes.
    if (historyRows.current) observer.observe(historyRows.current);
    // Pending rows live outside the virtual history. Their actual height can
    // change after sends, errors, localization or width/font changes.
    if (queuedRows.current) observer.observe(queuedRows.current);
    return () => { observer.disconnect(); cancelAnimationFrame(fitFrame); };
  }, [chatVisible, selected, focusTarget, searchResults, tailElement, tailMessageId, followingTail, showLatest, messagesReady, displayedMessages.length]);
  const send = async (nextTurn = false, literalUnknown = false, parentTiming?: SendTimingTrace) => {
    if (!selected || !richDraftReady || recording || (!draft.trim() && !files.length) || sendBusy.current) { parentTiming?.fail("aborted"); return; }
    const timing = parentTiming ?? beginSendTiming({
      conversationId: selected,
      kind: current?.type === "group" ? "group" : "direct",
      engine: current?.type === "group" ? "group" : activeBot?.engine,
      messageLength: draft.length,
      historyCount: messages.length,
      matchText: draft,
      existingMessages: current?.type === "group" ? messages : undefined,
    });
    try {
    history.assertCanSend();
    const workbenchSendOrigin = selected, workbenchSendRevision = draftRevision.current;
    let imageDraft;
    if (workbenchDraft) {
      try { imageDraft = bindWorkbenchDraft(workbenchDraft, connection.identity.deviceId, selected, workbench.controller?.getRegistration()); }
      catch { throw new Error(workbenchDraft.context.kind === "design" ? t("请先在工作台打开原设计，再发送评论。草稿已保留。") : t("请先在工作台打开原白板，再发送改图材料。草稿已保留。")); }
    }
    const activeWorkbenchContext = imageDraft?.context ?? await workbench.context();
    let workbenchContext = designOpener.contextSnapshot(activeWorkbenchContext);
    timing?.mark("workbenchDoneAt");
    if (sendBusy.current || currentSelection.current !== workbenchSendOrigin) { timing?.fail("aborted"); return; }
    if (draftRevision.current !== workbenchSendRevision) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
    if (discussionTransitioning) throw new Error(t("请等待本次讨论停止或暂停完成，内容已保留。"));
    if (discussionPaused && !discussionControlAllowed) throw new Error(t("只有讨论发起人或群主可以控制这次讨论。"));
    if (draft.trim() === "/tasks" && !files.length && !reply && current?.botIds.length === 1 && state.engineTasksAvailable) { timing?.fail("local_command"); setTaskListRequest({ conversationId: selected, id: Date.now() }); changeDraft(""); return; }
    const sideCommand = /^\/side(?:\s+([\s\S]*))?$/.exec(draft.trim());
    if (sideCommand) {
      if (state.status !== "online" || !activeBot?.online) throw new Error(t("侧边对话需要 Bot 在线连接。"));
      if (!sideCanOpen) throw new Error(t("当前视图或引擎不支持侧边对话。"));
      if (reply) throw new Error(t("请先取消主对话引用，再打开侧边对话。"));
      if (files.length && !side.capability?.attachments) throw new Error(t("当前主机或引擎暂不支持侧边附件，请升级后重试。"));
      const fileError = side.checkFiles(files); if (fileError) throw new Error(fileError);
      timing?.fail("local_command");
      setRightMode("side"); const opening = side.open(sideCommand[1]?.trim() ?? "", false, files); changeDraft(""); setFiles([]); setDetails(false); await opening; return;
    }
    if (nextTurn && current?.type === "direct" && activeBot?.engine === "claude") {
      const origin = selected, revision = draftRevision.current;
      const hasAttempt = await hasNativeInputDraft(connection, origin, current.botIds[0]!, draft);
      if (currentSelection.current !== origin || sendBusy.current) { timing?.fail("aborted"); return; }
      if (draftRevision.current !== revision) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
      if (hasAttempt) throw new Error(t("这段文字已有原生发送记录，本次未重复排队。请先查看原消息的状态；如需发送另一条消息，请修改内容。"));
    }
    // Pi also sends plain text into the current task. Retain its receipt before
    // that input can become a queued retry, including after an App reload.
    const retainedSupplement = codexSupplement || piChoice && continueCurrent && !activeWorkbenchContext && !workbenchDraft && !steerExplicit.length;
    if (codexDirect || piOrOmpDirect) {
      const origin = selected, revision = draftRevision.current;
      const hasAttempt = await hasSteeringDraft(connection, origin, current!.botIds[0]!, draft);
      if (currentSelection.current !== origin || sendBusy.current) { timing?.fail("aborted"); return; }
      if (draftRevision.current !== revision) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
      if (hasAttempt && (nextTurn || !retainedSupplement)) {
        sendBusy.current = true; setSteeringBusy(true);
        let recovered;
        try { recovered = await recoverSteeringDraft(connection, origin, current!.botIds[0]!, draft, () => currentSelection.current === origin && draftRevision.current === revision); }
        finally { sendBusy.current = false; setSteeringBusy(false); }
        if (currentSelection.current !== origin || sendBusy.current) { timing?.fail("aborted"); return; }
        if (draftRevision.current !== revision) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
        if (recovered === "accepted") throw new Error(t("这段文字已作为补充发送，本次未重复排队。如需发送新消息，请修改内容。"));
        if (recovered === "pending") throw new Error(t("这段文字已有引导发送记录，本次未重复排队。请先核对回执；如需发送新消息，请修改内容。"));
      }
      if (!nextTurn && retainedSupplement) {
        // Keep Pi/omp's durable run-bound receipt. Only a definite refusal with
        // an unchanged draft may fall back to the visible Host queue.
        const outcome = await steer(false, false, { context: workbenchContext }, codexDirect ? codexSendChoice.targetId : steeringCapability.targetId, piOrOmpDirect, timing);
        if (outcome !== "queue") return;
      }
    }
    if (!nextTurn) {
      const origin = selected, revision = draftRevision.current;
      const claude = current?.type === "direct" && state.bots.find(bot => bot.id === current.botIds[0])?.engine === "claude";
      const retryNative = claude && await hasNativeInputDraft(connection, origin, current!.botIds[0]!, draft);
      if (currentSelection.current !== origin || sendBusy.current) { timing?.fail("aborted"); return; }
      if (draftRevision.current !== revision) throw new Error(t("发送时内容已修改，未发送。请确认后再次发送。"));
      const ordinaryNative = claude && !!activeBot?.online && state.status === "online" && !files.length && !reply && !draft.trimStart().startsWith("/");
      if (!activeWorkbenchContext && (retryNative || ordinaryNative || !claude && !piOrOmpDirect && continueCurrent) && await steer(true, false, { context: workbenchContext }, undefined, false, timing) !== "queue") return;
    }
    timing?.mark("steeringStateDoneAt");
    assertMessageTextSize(draft);
    if (!replyReady) throw new Error(t("原消息已删除或当前不可访问"));
    if (current?.archived || group?.archived) throw new Error(t("对话已归档，恢复后可发送消息。"));
    if (current?.type === "group" && !replyMode) throw new Error(unknownGroupReplyMode(state.status === "online"));
    const explicit = checkedMentions(literalUnknown);
    if (discussionComposer && (!discussionParticipants.ready || discussionParticipants.error)) throw new Error(t("参与者选择尚未读取或保存，请重新选择后发送。"));
    if (discussionComposer && !replyMode?.activeRun && !discussionParticipants.ids.length) throw new Error(t("请至少选择一位可以发言的 Bot。"));
    sendBusy.current = true; setSending(true); setError(""); const version = draftVersions.current.get(selected) ?? 0, text = draft, uploads = [...files]; const attachments: string[] = [];
    const controller = new AbortController(); uploadController.current = controller;
    const sentFrom = composer.current, focusScope = sentFrom?.closest(".composer");
    let retainComposerFocus = true;
    // A send/IDB receipt may settle after the user starts typing elsewhere.
    // Track pointer intent too: clicking a non-focusable panel can leave body
    // active, which alone cannot prove that this composer still owns focus.
    const leaveComposer = (event: Event) => { if (!(event.target instanceof Node) || !focusScope?.contains(event.target)) retainComposerFocus = false; };
    document.addEventListener("focusin", leaveComposer, true);
    document.addEventListener("pointerdown", leaveComposer, true);
    try {
      const intent = current?.type === "group" ? await prepareGroupDraft() : undefined;
      if (uploads.length) { setUploadProgress(0); for (let i = 0; i < uploads.length; i++) attachments.push(await uploadFile(connection, selected, uploads[i]!, (n) => setUploadProgress((i + n) / uploads.length), { signal: controller.signal, recovering: setUploadRecovering })); }
      if (controller.signal.aborted) throw new Error(t("上传已取消，已完成的分块会保留。"));
      const mentions = explicit?.length ? explicit : current?.type === "group" ? discussionComposer ? discussionParticipants.ids : recipients : [];
      if (current?.type === "group" && !mentions.length && (state.groupDiscussionAvailable === false || replyMode?.delivery === "legacy")) throw new Error(t("请先选择回复的 Bot。"));
      await checkReplySource();
      if (controller.signal.aborted) throw new Error(t("上传已取消，已完成的分块会保留。"));
      if (imageDraft) workbenchContext = { ...await resolveWorkbenchDraft(imageDraft, uploads, attachments), ...(workbenchContext?.openTarget ? { openTarget: workbenchContext.openTarget } : {}) };
      // File hashing is asynchronous too: cancellation or navigation during
      // annotation resolution must not dispatch the abandoned conversation.
      if (controller.signal.aborted || currentSelection.current !== selected) throw new Error(t("上传已取消，已完成的分块会保留。"));
      const frame = { v: 1 as const, type: "message.send" as const, conversationId: selected, clientMsgId: newId("client"), text, attachments, ...(workbenchContext ? {workbench:workbenchContext} : {}), previewUrl: selectedPreviewUrl(text, previewChoice), previewStyle, ...(reply ? { replyTo: reply.id } : {}), ...(mentions?.length ? { mentions: wireRecipients(mentions, draftMentions.scopedLocalIds) } : {}) };
      let finishDiscussionSend: (() => Promise<void>) | undefined;
      if (current?.type === "group") {
        finishDiscussionSend = await sendGroupComposerMessage(connection, frame, replyMode, controller.signal, value => { if (currentSelection.current === selected) setGroupReplyMode(value); }, () => groupReplyModeRef.current, intent, imageDraft, timing);
      } else {
        timing?.setRoute("queue");
        timing?.setClientMsgId(frame.clientMsgId);
        await connection.send(frame, imageDraft?.context.kind === "design" ? imageDraft : undefined);
      }
      void nativeHaptic().catch(() => undefined);
      const unchangedText = (draftVersions.current.get(selected) ?? 0) === version && (!intent || groupDraft(selected).intent?.id === intent.id);
      try {
        clearSentRichDraft(unchangedText);
        if (unchangedText) { await clearSentDraft(selected, text, intent); if (currentSelection.current === selected && (draftVersions.current.get(selected) ?? 0) === version && (!intent || groupDraft(selected).intent?.empty)) { if (text) timing?.expectComposerClear(); else timing?.skipComposerClear(); setDraft(""); } else timing?.skipComposerClear(); } else timing?.skipComposerClear();
        if (finishDiscussionSend) { await flushRichDraft(); await finishDiscussionSend(); }
      } catch { timing?.skipComposerClear(); setError(t("消息已发送，但本机草稿清理未完成。请先核对聊天记录，避免重复发送。")); }
      if (retainComposerFocus && currentSelection.current === selected && composer.current === sentFrom && sentFrom?.isConnected && sentFrom.getClientRects().length) sentFrom.focus({ preventScroll: true });
    } finally { document.removeEventListener("focusin", leaveComposer, true); document.removeEventListener("pointerdown", leaveComposer, true); sendBusy.current = false; setSending(false); if (uploadController.current === controller) uploadController.current = null; setUploadProgress(undefined); setUploadRecovering(false); }
    } catch (error) { timing?.fail(error); throw error; }
  };
  const checkReplySource = async () => {
    if (reply && !(await cache.messages(selected)).some(message => message.id === reply.id && message.status !== "deleted")) {
      throw new Error(t("原消息已删除或当前不可访问"));
    }
  };
  const sendVoice = async (file: File) => {
    // Keep bytes in the originating durable draft before uploading. A successful
    // receipt removes only this file, never pre-existing text/attachments.
    setFiles(old => [...old, file]);
    const stillHere = () => voiceScope.current.version === voiceVersion && document.visibilityState === "visible";
    const retain = (message: string) => { if (stillHere()) { setVoiceMode(false); setError(message); } };
    if (!stillHere() || sendBusy.current || current?.archived || group?.archived) return;
    if (connection.state.status !== "online") { retain(t("当前离线，录音已保留为草稿，连接后可发送。")); return; }
    if (discussionComposer && (!discussionParticipants.ready || discussionParticipants.error)) { retain(t("参与者选择尚未读取或保存，请重新选择后发送。")); return; }
    if (discussionComposer && !replyMode?.activeRun && !discussionParticipants.ids.length) { retain(t("请至少选择一位可以发言的 Bot。")); return; }
    if (unavailableRecipients) { retain(recipientUnavailable); return; }
    if (current?.type === "group" && !recipients.length && !state.groupDiscussionAvailable) { retain(t("请先选择回复的 Bot。")); return; }
    sendBusy.current = true; setError(""); setUploadProgress(0);
    const controller = new AbortController(); uploadController.current = controller;
    try {
      const intent = current?.type === "group" ? await prepareGroupDraft() : undefined;
      const attachmentId = await uploadFile(connection, selected, file, setUploadProgress, { signal: controller.signal, recovering: setUploadRecovering });
      if (!stillHere() || controller.signal.aborted) return;
      await checkReplySource();
      if (!stillHere() || controller.signal.aborted) return;
      const frame = { v: 1 as const, type: "message.send" as const, conversationId: selected, clientMsgId: newId("voice"), text: "", attachments: [attachmentId], ...(reply ? { replyTo: reply.id } : {}), ...(current?.type === "group" ? { mentions: discussionComposer ? discussionParticipants.ids : wireRecipients(recipients) } : {}) };
      const finishDiscussionSend = current?.type === "group"
        ? await sendGroupComposerMessage(connection, frame, replyMode, controller.signal, value => { if (currentSelection.current === selected) setGroupReplyMode(value); }, () => groupReplyModeRef.current, intent)
        : (await connection.send(frame), undefined);
      try {
        setRichFiles(old => old.filter(item => item !== file));
        if (finishDiscussionSend) { await flushRichDraft(); await finishDiscussionSend(); }
        if (intent && !draft && !files.length) await clearSentDraft(selected, "", intent);
      } catch { retain(t("消息已发送，但本机草稿清理未完成。请先核对聊天记录，避免重复发送。")); }
      void nativeHaptic().catch(() => undefined);
    } catch (error) {
      retain(t("语音未发送，已保留为草稿：{0}", error instanceof Error ? error.message : t("操作失败")));
    } finally { sendBusy.current = false; if (uploadController.current === controller) uploadController.current = null; setUploadProgress(undefined); setUploadRecovering(false); }
  };
  const retryMessage = async (message: Message) => {
    history.assertCanSend();
    const source = message.authorType === "user" ? message : messages.find((m) => m.id === message.replyTo && m.authorType === "user");
    if (!source || source.botSource || source.groupDiscussion || source.clientMsgId?.startsWith("gdnote_")) return;
    const conversation = conversations.find(item => item.id === source.conversationId);
    if (conversation?.archived || conversation?.parentId && conversations.find(item => item.id === conversation.parentId)?.archived) { setError(t("对话已归档，恢复后可重新发送。")); return; }
    // A Bot's failed reply retries that recipient only. Replaying the user's
    // complete mention list would repeat other Bots' successful side effects.
    const botRetry = message.authorType === "bot";
    if (botRetry && !conversation?.botIds.includes(message.authorId)) { setError(t("此 Bot 已不可用，请选择其他 Bot")); return; }
    if (source.blocks.some((block) => block.type === "steering")) { changeDraft(blocksText(source.blocks)); setError(t("已放回输入框。请确认原任务的结果，再选择引导或普通发送。")); return; }
    if (source.forwardedFrom && botRetry) {
      const clientMsgId = newId("client");
      const sourceConversation = conversations.find((item) => item.id === source.conversationId);
      const sourceTitle = sourceConversation?.parentId
        ? `${conversations.find((parent) => parent.id === sourceConversation.parentId)?.title ?? ""} / ${sourceConversation.title}`
        : sourceConversation?.title;
      rememberForwardedMessage(connection, clientMsgId, source, sourceTitle, forwardedAuthorName(source, connection.state, botDirectory));
      await connection.send({ v: 1, type: "message.forward", conversationId: source.conversationId, sourceMessageId: source.id, clientMsgId, mentions: [message.authorId] });
      return;
    }
    if (source.forwardedFrom) { forwardTrigger.current = composer.current; setForwarding(source); return; }
    if (!conversation) throw new Error(t("原消息已删除或当前不可访问"));
    const address = conversation.type === "group" ? groupMessageRetryAddress(source, botRetry ? message.authorId : undefined, state)
      : { mentions: botRetry ? [message.authorId] : source.mentions };
    rememberMessageAttachments(connection, source.blocks);
    await connection.send({ v: 1, type: "message.send", conversationId: source.conversationId, clientMsgId: newId("client"), previewUrl: source.previewUrl, previewStyle: source.previewStyle, text: source.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"), attachments: source.blocks.flatMap((b) => "attachmentId" in b ? [b.attachmentId] : []), ...(source.replyTo ? { replyTo: source.replyTo } : {}), ...address });
  };
  const searchParams = useMemo(() => {
    const params = new URLSearchParams({ q: query });
    if (searchBot) params.set("botId", searchBot);
    if (searchConversation) params.set("conversationId", searchConversation.id);
    if (searchFrom) params.set("from", String(new Date(searchFrom + "T00:00:00").getTime()));
    if (searchTo) params.set("to", String(new Date(searchTo + "T23:59:59.999").getTime()));
    if (searchFiles) params.set("hasFile", "true");
    return params.toString();
  }, [query, searchBot, searchConversation, searchFrom, searchTo, searchFiles]);
  const search = (event: FormEvent, allConversations = false) => {
    event.preventDefault(); setSidebar(false); setFocusTarget(undefined);
    const params = new URLSearchParams(searchParams);
    if (allConversations) { setSearchConversation(undefined); params.delete("conversationId"); }
    historySearch.start(params.toString(), searchFrom && searchTo && searchFrom > searchTo ? t("开始日期不能晚于结束日期。") : "");
  };
  // Only entry/visibility changes autofocus; focusing a date field in another
  // pane must not send focus back to its keyword input.
  useLayoutEffect(() => { if (searching && !phone && keyboardActive) searchInput.current?.focus(); }, [searching, searchConversation?.id, phone, visible]);
  const searchCurrentConversation = () => {
    if (!current) return;
    if (searching && searchConversation?.id === current.id) { searchInput.current?.focus(); searchInput.current?.select(); return; }
    setSearchConversation({ id: current.id, title: current.title });
    setQuery(""); setSearchBot(""); setSearchFrom(""); setSearchTo(""); setSearchFiles(false);
    setSidebar(false); setFocusTarget(undefined); closeMenu();
    historySearch.start(new URLSearchParams({ q: "", conversationId: current.id }).toString());
  };
  useEffect(() => {
    if (!keyboardActive || phone || !current) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || backRoot.current?.closest("[hidden],[inert]")) return;
      // A file preview or settings dialog owns its own keyboard interactions.
      if ([...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')].some(node => node.getClientRects().length && !node.closest("[hidden],[inert]"))) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault(); searchCurrentConversation();
      } else if (event.key === "Escape" && searching) {
        event.preventDefault(); exitHistorySearch();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const localCommands = state.engineTasksAvailable && current?.botIds.length === 1 ? [{ command: "tasks", description: { defaultValue: "View subagents and background tasks", i18n: { zh_cn: "查看子代理与后台任务", en_us: "View subagents and background tasks", ja_jp: "サブエージェントとバックグラウンドタスクを表示" } } }, ...sideCommands.filter(command => command.command !== "tasks")] : sideCommands;
  const visibleCommands = draft.startsWith("/") && !/\s/.test(draft) ? localCommands.filter((command) => command.command.startsWith(draft.slice(1))) : [];
  const live = state.status === "online";
  const replying = !live ? "" : workingAuthors.length ? " is-working" : pendingReply ? " is-pending" : "";
  const transcribingActive = live && transcribing;
  const canStopActive = !!replying || transcribingActive;
  // Keep one action slot on phones; task activity must not expand the field.
  const phoneStop = phone && canStopActive && !draft.trim() && !files.length && uploadProgress === undefined && !recording;
  const directBotId = !group ? current?.botIds[0] : undefined;
  const steerExplicit = draftMentions.ids;
  const steerTargets = discussionComposer ? [] : steerExplicit.length ? steerExplicit : current?.type === "group" ? recipients : current?.botIds ?? [];
  // Claude can start reviewing a finished background task long after the
  // foreground reply ended. Its live report card makes the native status poll
  // promptly so ordinary input can reach that review's input-only target.
  const claudeConversation = activeBot?.engine === "claude";
  const backgroundReporting = useMemo(() => claudeConversation && messages.some(message => message.authorType === "bot" && message.blocks.some(block => {
    const run = block.type === "card" ? runSummarySchema.safeParse(block.extra?.scopedRun) : undefined;
    return !!run?.success && isRunActive(run.data.phase);
  })), [claudeConversation, messages]);
  const steeringCapability = useSteeringCapability(connection, selected, steerTargets.length === 1 && !steerTargets[0]!.includes(":") ? steerTargets[0] : undefined, visible && chatVisible && !archivedHere, replying || (transcribingActive ? " is-transcribing" : "") || (backgroundReporting ? " is-background" : ""));
  const steeringAvailable = steeringCapability.supported && (!!replying || !transcribingActive);
  const piDirect = current?.type === "direct" && activeBot?.engine === "pi";
  const piOrOmpDirect = current?.type === "direct" && (activeBot?.engine === "pi" || activeBot?.engine === "omp");
  const continueCurrent = (activeBot?.engine !== "claude" || activeBot.online) && (!!replying || !!steeringCapability.nativeInput && steeringAvailable) && steeringCapability.sendBehavior === "steer" && current?.type === "direct" && !recording && !files.length && !reply && (!draft.trimStart().startsWith("/") || piDirect && isPiLiveCommand(draft, nativePiCommands));
  // Native CLI input is a direct-chat contract. Groups keep explicit steering and group delivery.
  const nativeInput = current?.type === "direct" ? steeringCapability.nativeInput : undefined;
  const immediateAvailable = continueCurrent && !!nativeInput?.sendNow;
  const sendChoiceScope = `send-choice:${connection.identity.hubPublicKey}:${selected}:${current?.botIds[0] ?? ""}`;
  const sendChoice = useClaudeSendChoice(connection, selected, current?.botIds[0], steeringCapability, !!draft.trim() || !!files.length || !!reply);
  const claudeChoice = current?.type === "direct" && activeBot?.engine === "claude" && !!activeBot.online && !!nativeInput && steeringAvailable && !!steeringCapability.targetId && steeringCapability.sendBehavior === "steer";
  const piChoice = current?.type === "direct" && (activeBot?.engine === "pi" || activeBot?.engine === "omp") && !!activeBot.online && !!replying && steeringAvailable && !!steeringCapability.targetId && steeringCapability.sendBehavior === "steer";
  // Only an Antigravity Bot on the ACP runtime advertises in-flight steering; print mode never shows this choice.
  const agyChoice = current?.type === "direct" && activeBot?.engine === "antigravity" && !!activeBot.online && !!replying && steeringAvailable && !!steeringCapability.targetId && steeringCapability.sendBehavior === "steer";
  const codexDirect = current?.type === "direct" && activeBot?.engine === "codex";
  const codexSendChoice = useCodexSendChoice(connection, selected, current?.botIds[0], steerTargets.length === 1 && steerTargets[0] === directBotId && (!transcribingActive || !!replying) ? steeringCapability : { idle: true });
  const codexChoice = codexDirect && !!activeBot?.online && !!replying && steeringAvailable && !nativeInput && !!steeringCapability.targetId;
  const richNextTurn = !!files.length || !!reply;
  const codexLockedToNext = richNextTurn || workbenchVisible || !!workbenchDraft || !!steerExplicit.length;
  const codexSupplement = codexDirect && !!codexSendChoice.targetId && !codexLockedToNext && !draft.trimStart().startsWith("/");
  const queueChosen = !draft.trimStart().startsWith("/") && (current?.type === "direct" && (activeBot?.engine === "claude" || activeBot?.engine === "pi" || activeBot?.engine === "omp" || activeBot?.engine === "antigravity") && sendChoice.next || codexChoice && !codexSupplement);
  const showSendChoice = (claudeChoice || piChoice || agyChoice || codexChoice || codexSupplement) && !connection.isReadOnly && !recording && !draft.trimStart().startsWith("/");
  const composerQueues = queueChosen || (claudeChoice || piChoice || agyChoice || codexChoice) && richNextTurn;
  const sendFromComposer = () => send(queueChosen);
  const deferredNativeRestores = useRef(new Map<string, Message>());
  const nativeRestoreState = useRef({ draft, ready: richDraftReady && draftScope === selected, archived: archivedHere, change: changeDraft });
  nativeRestoreState.current = { draft, ready: richDraftReady && draftScope === selected, archived: archivedHere, change: changeDraft };
  const nativeContext = useMemo(() => ({
    capability: current?.type === "direct" && !connection.isReadOnly && !archivedHere ? nativeInput : undefined,
    editable: richDraftReady && draftScope === selected && !connection.isReadOnly && !archivedHere,
    draftText: (conversationId: string) => currentSelection.current === conversationId && nativeRestoreState.current.ready ? nativeRestoreState.current.draft : undefined,
    restore: (message: Message) => {
      if (sendBusy.current) { deferredNativeRestores.current.set(message.id, message); return; }
      const latest = nativeRestoreState.current;
      if (currentSelection.current !== message.conversationId || !latest.ready || connection.isReadOnly || latest.archived) return;
      latest.change(`${blocksText(message.blocks)}${latest.draft ? `\n\n${latest.draft}` : ""}`);
      composer.current?.focus({ preventScroll: true });
    },
  }), [nativeInput, current?.type, connection, connection.isReadOnly, richDraftReady, draftScope, selected, archivedHere]);
  useEffect(() => {
    if (sendBusy.current || !richDraftReady || draftScope !== selected || connection.isReadOnly || archivedHere) return;
    const restored = [...deferredNativeRestores.current.values()].filter(message => message.conversationId === selected);
    if (!restored.length) return;
    for (const message of restored) deferredNativeRestores.current.delete(message.id);
    const latest = nativeRestoreState.current;
    latest.change([...restored.map(message => blocksText(message.blocks)), latest.draft].filter(Boolean).join("\n\n"));
    composer.current?.focus({ preventScroll: true });
  }, [steeringBusy, sending, uploadProgress, selected, draftScope, richDraftReady, connection.isReadOnly, archivedHere]);
  const directBotName = directBotId ? labels.get(directBotId) ?? directBotId : undefined;
  // Inline activity names only streaming replies; acknowledged messages keep static typing dots.
  const streamingBots = live ? workingAuthors.map((id) => labels.get(id) ?? botDirectory.find((b) => b.id === id)?.name ?? "") : [];
  // Join only known parts: an unknown engine/model must not leave a dangling separator.
  const syncLabel = state.syncProgress?.indeterminate ? t("正在同步历史…") : state.syncProgress ? t("同步历史 {0}/{1}", state.syncProgress.completed, state.syncProgress.total) : "";
  const connectionSummary = state.status === "online" && state.syncProgress ? syncLabel : state.status === "online" ? [state.route && routeTitle(state.route, connection.identity.routes, connection.identity.deployment), `${state.latency ?? "–"}ms`].filter(Boolean).join(" · ") : state.status === "connecting" ? t("连接中") : t("离线");
  const archivedChats = listedChats.filter((c) => c.archived && !c.parentId);
  const resourceHosts = useMemo(
    () => shell?.resourceHosts?.length ? shell.resourceHosts : [{ id: shell?.host.id ?? "local", name: hostName, connection }],
    [shell?.resourceHosts, shell?.host.id, hostName, connection],
  );
  const desktopResourcesAvailable = useAnyHostResourcesAvailable(resourceHosts) && !pane && !phone;
  useEffect(() => {
    if (!visible && resourcesOpen) setResourcesOpen(false);
  }, [visible, resourcesOpen]);
  const routeDiagnosisText = routeDiagnosisMessage(state.routeDiagnosis, hostName);
  const connectionError = state.routeDiagnosis ? routeDiagnosisText : state.error;
  // A pane or phone already shows the host connection notice. Suppress only
  // the duplicate generic retry error; retain auth, TLS, message and local errors.
  const duplicatePaneRetry = (!!pane || phone) && !connection.isReadOnly && state.status !== "online"
    && (state.error === t("暂时无法连接「{0}」，正在自动重试。", hostName) || !!state.routeDiagnosis && !state.routeDiagnosis.actionRequired && state.error === state.routeDiagnosis.message);
  const advancedSearchFilters = <><label>{t("开始日期")}<input type="date" aria-label={t("搜索开始日期")} value={searchFrom} onChange={(e) => setSearchFrom(e.target.value)}/></label><label>{t("结束日期")}<input type="date" aria-label={t("搜索结束日期")} value={searchTo} onChange={(e) => setSearchTo(e.target.value)}/></label><label><input type="checkbox" checked={searchFiles} onChange={(e) => setSearchFiles(e.target.checked)}/>{t("含附件")}</label></>;
  const searchScope = searchConversation ? t("搜索范围：{0} · {1}", hostName, conversations.find(c => c.id === searchConversation.id)?.title ?? searchConversation.title) : t("搜索范围：{0} · 全部对话", hostName);
  useEffect(() => { setDetailBot(undefined); }, [selected]);
  const selectChat = (id: string) => { setFocusTarget(undefined); setSelected(id); closeSearch(); setSidebar(false); };
  // Desktop group composer: one selector naming who will reply (zero stays explicit).
  const recipientNames = recipients.map(id => recipientOptions.find(option => option.id === id)?.label ?? labels.get(id) ?? id);
  const defaultAllReplies = replyMode?.mode === "parallel";
  const defaultDesignatedReply = replyMode?.mode === "designated";
  const recipientSummary = unavailableRecipients ? t("重新选择 Bot") : !recipientNames.length
    ? defaultAllReplies ? t("全员回复")
      : defaultDesignatedReply ? (replyMode?.designatedName ? t("默认：{0}", replyMode.designatedName) : t("指定 Bot 回复"))
      : replyMode && replyMode.delivery !== "legacy" ? t("不指定回复") : t("选择回复的 Bot")
    : recipientNames.length === 1 ? recipientNames[0]! : t("{0} 等 {1} 个 Bot", recipientNames[0]!, recipientNames.length);
  const history = useConversationHistory({ connection, conversation: current, forkTitles: conversations.filter(value => current && value.historyOrigin?.sourceConversationId === current.id).map(value => value.title), enabled: visible && chatVisible && searchResults === undefined, activity: replying || (transcribingActive ? " is-transcribing" : ""), backgroundBusy: backgroundGroups.groups.some(item => taskCounts(item).running > 0), sideState: `${side.shown ? 1 : 0}:${side.view?.phase ?? ""}:${side.closingRevision}`, pendingMessages: queued.some(item => !item.error), localBusy: sending || steeringBusy || uploadProgress !== undefined || recording, fallback: scroll, opened: conversation => {
    setConversations(old => [...old.filter(value => value.id !== conversation.id), conversation]);
    setDetails(false); setManage(false); setChatActions(false); closeMenu();
    if (pane) pane.navigate(conversation.id, undefined, conversation.title); else setSelected(conversation.id);
    setSidebar(false); closeSearch(); setFocusTarget(undefined);
    if (!phone) pendingComposerFocus.current = conversation.id;
  } });
  const piSessionControls = visible && chatVisible && current?.type === "direct" && composerBot?.engine === "pi" && !composerBot.deletedAt && state.piSessionAvailable && <PiSessionControls key={`pi:${connection.identity.hubPublicKey}:${current.id}:${composerBot.id}`} connection={connection} conversationId={current.id} bot={composerBot} onCommands={receivePiCommands} active={visible && chatVisible} activity={replying} online={state.status === "online" && !!composerBot.online && !connection.isReadOnly} owner={state.user?.role === "owner" && !connection.isReadOnly}/>;
  const composerModelControls = !phone && !pane && visible && chatVisible && composerBot && !composerBot.deletedAt && (piSessionControls || <ComposerModelControls key={`${connection.identity.hubPublicKey}:${current?.id}:${composerBot.id}`} connection={connection} bot={composerBot} online={state.status === "online" && !!composerBot.online && !connection.isReadOnly} owner={state.user?.role === "owner" && !connection.isReadOnly}/>);
  // Evict device-saved quota readings if this Host confirms the user is no longer the owner.
  useEffect(() => {
    if (state.status === "online" && state.user && state.user.role !== "owner") clearStoredQuotaHost(connection);
  }, [connection, state.status, state.user?.role]);
  // Context and quota (issue 68 & 137): one conversation's own view only, never a board pane.
  // Fall back to cached navigationBots before WS ready arrives so device-saved quota appears immediately on cold start.
  const usageCandidate = discussionComposer ? undefined : current?.type === "direct"
    ? (activeBot ?? navigationBots.find(bot => bot.id === current.botIds[0]))
    : composerRecipients.length === 1
      ? (composerBot ?? navigationBots.find(bot => bot.id === composerRecipients[0] && current?.botIds.includes(bot.id)))
      : undefined;
  const usageBot = !pane && visible && chatVisible && current && usageCandidate && !usageCandidate.deletedAt ? usageCandidate : undefined;
  const quotaAllowed = !!usageBot && state.user?.role === "owner" && !connection.isReadOnly && state.engineQuotaAvailable !== false;
  const usage = useUsageReadings(connection, { conversationId: usageBot ? current?.id : undefined, botId: usageBot?.id, model: usageBot?.model ?? "",
    quota: quotaAllowed,
    quotaLive: quotaAllowed && state.status === "online" && state.engineQuotaAvailable === true,
    // The phone shows no context anywhere, so it does not ask for it.
    context: !!usageBot && !phone && state.contextUsageAvailable === true, turn: messagesReady ? lastBotReply : undefined });
  const [quotaDetails, setQuotaDetails] = useState(false);
  useEffect(() => { setQuotaDetails(false); }, [current?.id]);
  const openQuotaDetails = () => { setChatActions(false); usage.readForDetails(); setQuotaDetails(true); };
  const usageIndicators = !phone && usageBot && <UsageIndicators key={`usage:${connection.identity.hubPublicKey}:${current?.id}:${usageBot.id}`} context={usage.context} quota={usage.quota} serverTimeOffset={state.serverTimeOffset} onOpen={usage.readForDetails}/>;
  // Phone: nothing beside the composer. The battery alone, without a number, sits in the header whenever the
  // quota can be read: under the computer's name when several are paired, by itself otherwise.
  const phoneQuota = phone ? usage.quota : undefined;
  const locateMessage = useCallback((conversationId: string, messageId: string) => {
    void cache.messages(conversationId).then(items => {
      if (!items.some(item => item.id === messageId && item.status !== "deleted")) { setError(t("原消息已删除或当前不可访问")); return; }
      followLatest.current = false; setShowLatest(true); setFocusTarget({ conversationId, messageId });
    }).catch(error => setError(error instanceof Error ? error.message : String(error)));
  }, [cache]);
  const railEnabled = !phone && !pane && replyWidthDesktop && !coarseTouch;
  const railItems = useMemo(() => !railEnabled ? [] : buildMessageRailItems(displayedMessages, {
    attachmentFallback: t("附件消息"),
    cardFallback: t("卡片消息"),
    botName: (botId) => labels.get(botId) ?? botDirectory.find((bot) => bot.id === botId)?.name,
    isGroup: current?.type === "group",
  }), [railEnabled, displayedMessages, labels, botDirectory, current?.type, locale]);
  const [railPosition, setRailPosition] = useState<{ index: number; atBottom: boolean }>({ index: 0, atBottom: true });
  const syncRailPosition = useCallback(() => {
    if (!railEnabled || railItems.length < 2) return;
    const node = scroll.current;
    if (!node || !displayedMessages.length) return;
    const history = historyRows.current;
    const origin = history
      ? history.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop - node.clientTop + readingScroll.shift
      : 0;
    const next = resolveRailScrollAnchor({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      shift: readingScroll.shift,
      origin,
      messageCount: displayedMessages.length,
      virtualItems: virtualizer.getVirtualItems(),
    });
    setRailPosition((prev) => prev.index === next.index && prev.atBottom === next.atBottom ? prev : next);
  }, [railEnabled, railItems.length, displayedMessages.length, readingScroll, virtualizer]);
  useEffect(() => {
    if (!railEnabled || !chatVisible || searchResults !== undefined || railItems.length < 2) return;
    const frame = requestAnimationFrame(syncRailPosition);
    return () => cancelAnimationFrame(frame);
  }, [railEnabled, chatVisible, searchResults, selected, railItems.length, displayedMessages.length, syncRailPosition]);
  const jumpToRailItem = useCallback((item: MessageRailItem) => {
    if (!selected) return;
    const node = scroll.current;
    const canScroll = !!node && node.scrollHeight > node.clientHeight + 2;
    const atBottom = item.index >= displayedMessages.length - 1;
    if (!canScroll) {
      setFocusTarget(undefined);
      finishTouch();
      followLatest.current = true;
      scrollingTowardLatest.current = false;
      setShowLatest(false);
      setRailPosition({ index: item.index, atBottom });
      return;
    }
    if (atBottom) {
      setFocusTarget(undefined);
      finishTouch();
      followLatest.current = true;
      scrollingTowardLatest.current = false;
      setShowLatest(false);
      setRailPosition({ index: item.index, atBottom: true });
      node.scrollTop = node.scrollHeight;
      return;
    }
    followLatest.current = false;
    scrollingTowardLatest.current = false;
    setShowLatest(true);
    setRailPosition({ index: item.index, atBottom: false });
    setFocusTarget({ conversationId: selected, messageId: item.id });
  }, [selected, displayedMessages.length, finishTouch]);
  const authorName = (message: Message) => labels.get(message.authorId) ?? botDirectory.find((b) => b.id === message.authorId)?.name ?? (message.authorType === "user" ? t("我") : "TaroBird");
  const retryBlocked = !!current?.archived || !!group?.archived;
  // A human resend cannot preserve a signed Bot's origin or its reply receipt.
  // Discussion notes have always used this durable ID prefix, including old Hub history.
  // Like topic/input messages they belong to one run, so ordinary resend would
  // bypass note routing and silently create a recipient-less record. Quote/copy remain available.
  const canRetry = (message: Message) => !message.botSource && !message.groupDiscussion && !message.clientMsgId?.startsWith("gdnote_") && (message.authorType === "user" || message.authorType === "bot" && message.status === "error" && !!current?.botIds.includes(message.authorId) && messages.some((m) => m.id === message.replyTo && m.authorType === "user" && !m.botSource && !m.groupDiscussion && !m.clientMsgId?.startsWith("gdnote_")));
  // The sheet belongs to the visible phone chat it was opened in. Leaving it (other
  // conversation or host, inbox, search, rotation to the desktop layout) closes it.
  const expandedComposer = useComposerSize(composer, draft, selected, phone, details, `${preferences.palette}:${preferences.fontSize}`, !voiceMode);
  const sheetTarget = messageSheet && visible && phone && !sidebar && searchResults === undefined && selected === messageSheet.conversationId ? messageSheet : undefined;
  useEffect(() => { if (messageSheet && !sheetTarget) setMessageSheet(undefined); }, [messageSheet, sheetTarget]);
  const sheetMessage = sheetTarget && messages.find((m) => m.id === sheetTarget.messageId && m.conversationId === sheetTarget.conversationId);
  const closeSheet = () => setMessageSheet(undefined);
  const openMessageSheet = (message: Message, trigger: HTMLElement) => {
    if (message.groupDiscussion?.role === "input") return;
    history.inspect(message);
    sheetOrigin.current = { conversationId: message.conversationId, messageId: message.id, trigger, next: null };
    setMessageSheet({ conversationId: message.conversationId, messageId: message.id });
  };
  const deletion = useMessageDeletion(connection, selected, visible && chatVisible && searchResults === undefined, messages, scroll, ids => {
    if (reply && ids.includes(reply.id)) setReply(undefined);
    if (forwarding && ids.includes(forwarding.id)) setForwarding(undefined);
    if (focusTarget?.messageId && ids.includes(focusTarget.messageId)) setFocusTarget(undefined);
  });
  useLayoutEffect(() => setIndividualBackgroundRecords(deletion.active), [deletion.active]);
  // A different device can remove a quoted source while this composer stays open.
  // Other conversations' events cannot change this answer.
  const selectedRevision = connection.conversationRevision(selected);
  useEffect(() => {
    if (!reply && !forwarding) return;
    let cancelled = false;
    void cache.messages(selected).then(items => {
      if (cancelled) return;
      if (reply && items.some(item => item.id === reply.id && item.status === "deleted")) setReply(undefined);
      if (forwarding && items.some(item => item.id === forwarding.id && item.status === "deleted")) setForwarding(undefined);
    });
    return () => { cancelled = true; };
  }, [cache, selected, selectedRevision, reply, forwarding]);
  useMessageHold(scroll, selected, visible && phone && chatVisible && searchResults === undefined && !deletion.active, (messageId, trigger) => {
    const message = messages.find((item) => item.id === messageId && item.conversationId === selected && item.status !== "deleted");
    if (message) { openMessageSheet(message, trigger); void nativeHoldHaptic().catch(() => undefined); }
  });
  // The readable (Markdown-free) copy: the phone sheet at any platform, and
  // every whole-message copy on native iOS/Android. The clipboard write starts
  // inside the tap (Safari refuses it once the user activation ends) with the
  // blocks the tap saw; conversion may finish later. Report only what the
  // clipboard confirmed, and only to the conversation that asked: a failure
  // withdraws any earlier "copied".
  const copyReadableMessage = (message: Message, confirmed?: () => void) => {
    const request = {}; copyRequest.current = request;
    const write = copyMessagePlainText(message.blocks);
    const asked = () => copyRequest.current === request && currentlyVisible.current
      && currentSelection.current === message.conversationId
      && copyMessages.current.some(current => current.id === message.id && current.conversationId === message.conversationId && current.status !== "deleted");
    write.then(readable => { if (!asked()) return; confirmed?.(); if (!readable) setError(t("未能整理格式，已复制原文。")); },
      error => { if (error instanceof MessageCopySuperseded || !asked()) return; clearTimeout(copiedTimer.current); setCopied(undefined); setError(t("无法写入剪贴板，请检查权限后重试。")); });
  };
  // Apply actions to the live message the sheet targets; Copy uses readable text.
  const sheetActions: MessageSheetActions = {
    deletionAvailable: !!state.messageDeletionAvailable,
    history: sheetMessage ? Object.fromEntries(Object.entries(history.messageActions(sheetMessage) ?? {}).map(([name, action]) => [name, { ...action, run: (origin: HTMLElement | null) => { closeSheet(); action.run(origin); } }])) : undefined,
    select: () => { if (sheetMessage) { deletion.start(sheetMessage, sheetOrigin.current?.trigger ?? null); closeSheet(); } },
    delete: () => { if (sheetMessage) { deletion.ask([sheetMessage.id], sheetOrigin.current?.trigger); closeSheet(); } },
    copy: () => {
      const message = sheetMessage; if (!message) return;
      copyReadableMessage(message, () => { clearTimeout(copiedTimer.current); setCopied(message.id); copiedTimer.current = setTimeout(() => setCopied(undefined), 3000); });
      closeSheet();
    },
    quote: (dialog) => {
      const message = sheetMessage; if (!message || current?.archived || group?.archived) return;
      setReply(message); if (sheetOrigin.current && !composer.current?.disabled) sheetOrigin.current.next = composer.current;
      // Leave the modal first so the composer (and the phone keyboard) takes focus within this tap.
      dialog?.close(); composer.current?.focus(); closeSheet();
    },
    forward: () => {
      const message = sheetMessage; if (!message || !["complete", "error"].includes(message.status)) return;
      forwardTrigger.current = sheetOrigin.current?.trigger ?? null; closeSheet(); setForwarding(message);
    },
    retry: () => { const message = sheetMessage; if (!message || retryBlocked || !canRetry(message)) return; closeSheet(); report(retryMessage(message)); },
  };
  const paneBusy = sending || steeringBusy || uploadProgress !== undefined || recording || voice.phase === "requesting";
  const pendingSave = draftSaving || richDraftPendingAny;
  const anyDraftFailed = richDraftFailedAny || draftSaveNeedsAttention || (!draftSaving && unsavedDrafts.current.size > 0);
  const paneBusyChanged = pane?.busyChanged;
  const releaseMicrophone = pane?.releaseMicrophone;
  useEffect(() => { if (!recording) releaseMicrophone?.(); }, [recording, releaseMicrophone]);
  useEffect(() => () => releaseMicrophone?.(), [releaseMicrophone]);
  useLayoutEffect(() => { paneBusyChanged?.(paneBusy, anyDraftFailed, pendingSave); return () => paneBusyChanged?.(false, false, false); }, [paneBusyChanged, paneBusy, anyDraftFailed, pendingSave]);
  const shellLifecycle = shell?.lifecycleChanged, registration = shell?.host.registrationId;
  useLayoutEffect(() => { if (registration) shellLifecycle?.(registration, paneBusy, anyDraftFailed, pendingSave); return () => { if (registration) shellLifecycle?.(registration, false, false, false); }; }, [shellLifecycle, registration, paneBusy, anyDraftFailed, pendingSave]);
  const dropDisabledMessage = !selected ? t("请先打开一个对话，再拖入文件。")
    : current?.archived || group?.archived ? t("对话已归档，恢复后可重新发送。")
    : connection.isReadOnly ? t("当前为只读模式，无法添加附件。")
    : uploadProgress !== undefined ? t("正在上传附件，请完成后再添加。")
    : sending ? t("正在发送，请完成后再添加附件。")
    : t("当前对话暂时无法添加附件，请完成当前操作后重试。");
  const attachmentDrop = useAttachmentDrop(`${connection.identity.hubPublicKey}:${selected}:${visible}`,
    // Focus revalidates local drafts. File appends already queue and replay on
    // that read in useConversationDrafts; only Send must wait for ready.
    visible && chatVisible && !searchResults && !!selected && !current?.archived && !group?.archived && !connection.isReadOnly && uploadProgress === undefined && !sending && !deletion.active,
    addFiles, reason => setAttachmentDropError(reason === "directory" ? t("暂不支持拖入文件夹，请选择其中的文件。") : dropDisabledMessage),
    { windowFallback: !pane, label: current?.title, disabledMessage: dropDisabledMessage });
  const workbenchButton = !pane && workbenchEligible && <button ref={workbenchTrigger} className="icon-button workbench-trigger" aria-label={t("工作台")} title={t("工作台")} aria-expanded={workbenchVisible} aria-controls={workbenchId} onClick={() => { if (workbenchVisible) { designOpener.revoke(); setRightMode("side"); } else void openWorkbench().catch(reportWorkbenchOpenError); }}><Monitor size={18}/></button>;
  const openPluginContribution = (pluginId: string, contributionId: string, kind: "workbench-item" | "side-panel", title: string) => {
    if (kind === "workbench-item") {
      if (!workbenchEligible) {
        setError(
          current?.archived
            ? t("对话已归档，恢复后才能在工作台打开插件。")
            : connection.isReadOnly
              ? t("当前为只读模式，无法在工作台打开插件。")
              : t("请先选择一个活跃对话，再打开工作台插件。"),
        );
        return;
      }
      void openWorkbench().then((controller) => controller.openPlugin(pluginId, contributionId, title)).catch(reportWorkbenchOpenError);
    } else if (phone) {
      setDetails(false); closeSearch(); setMobilePluginPanel({ pluginId, contributionId, title });
    } else {
      setDetails(false); closeSearch(); setActivePluginPanel({ pluginId, contributionId, title }); setRightMode("plugin");
    }
  };
  const pluginPanelButtons = !pane && !phone && sidePanelPlugins.map(({ plugin, contribution }) => {
    const label = locale === "zh" ? contribution.titleZh ?? contribution.title : contribution.title;
    const isOpen = pluginSideVisible && activePluginPanel?.pluginId === plugin.manifest.id && activePluginPanel?.contributionId === contribution.id;
    return <button key={`${plugin.manifest.id}:${contribution.id}`} type="button" className={`plugin-panel-trigger${isOpen ? " is-active" : ""}`} aria-label={label} title={label} aria-expanded={isOpen} onClick={() => {
      if (isOpen) { setRightMode("side"); setActivePluginPanel(undefined); }
      else { setDetails(false); closeSearch(); setActivePluginPanel({ pluginId: plugin.manifest.id, contributionId: contribution.id, title: label }); setRightMode("plugin"); }
    }}><Puzzle size={18} aria-hidden="true"/></button>;
  });
  const openFiles = () => {
    designOpener.revoke();
    setSettings(false);
    setDetails(false);
    closeSearch();
    setSidebar(false);
    setRightMode("files");
  };
  const filesButton = filesEligible && <button ref={filesTrigger} className="icon-button files-trigger" aria-label={t("文件")} title={t("工作区文件")} aria-expanded={filesVisible} aria-controls={filesId} onClick={() => { if (filesVisible) setRightMode("side"); else openFiles(); }}><FolderTree size={18}/></button>;
  // Two ordinary header icons, spaced like the others: no shared frame around them.
  const rightPanelSwitcher = <>{workbenchButton}{filesButton}</>;
  const mentionWorkspaceFile = useCallback((relativePath: string) => {
    const token = formatWorkspaceFileMention(relativePath);
    const next = draft ? `${draft}${/\s$/.test(draft) ? "" : " "}${token} ` : `${token} `;
    changeDraft(next);
    if (phone) setRightMode("side");
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
  }, [changeDraft, draft, phone, setRightMode]);
  const terminalButton = terminalEligible && <button className="icon-button terminal-trigger" aria-label={t("终端")} title={`${t("主机终端")} · ${hostName}`} aria-expanded={terminalVisible} onClick={() => { if (terminalVisible) setRightMode("side"); else { setDetails(false); closeSearch(); setRightMode("terminal"); } }}><TerminalIcon size={18}/></button>;
  const screenButton = !pane && !phone && isElectron() && <button className="icon-button screen-trigger" aria-label={t("查看屏幕")} title={`${t("查看屏幕")} · ${hostName}`} aria-expanded={screenVisible} onClick={() => { if (screenVisible) closeScreen(); else openScreen(); }}><MonitorPlay size={18}/></button>;
  const sideButton = sideCanOpen && <button ref={sideTrigger} className="icon-button side-trigger" aria-label={t("侧边对话")} title={t("侧边对话") + " (⌘⇧K / Ctrl+Shift+K)"} aria-expanded={sideVisible} aria-controls="side-conversation" disabled={!side.shown && (state.status !== "online" || !activeBot?.online)} onClick={toggleSide}><PanelRight size={18}/></button>;
  const workspaceBadgeCount = workspaceNeedsApproval > 0 ? workspaceNeedsApproval : workspaceActiveComms;
  const workspaceButton = workspaceEligible && <button ref={workspaceRailTrigger} className="workspace-rail-trigger" aria-label={t("会话工作区")} title={t("会话工作区")} aria-expanded={workspaceVisible} aria-controls={workspaceId} onClick={toggleWorkspace}><Layers size={16}/><span className="workspace-rail-trigger-label">{t("工作区")}</span>{workspaceBadgeCount > 0 && <span className={`workspace-rail-trigger-badge${workspaceNeedsApproval > 0 ? " is-alert" : ""}`}>{workspaceBadgeCount}</span>}</button>;
  const rowActionsRef = useRef({
    copyReadableMessage,
    report,
    setReply,
    setForwarding,
    retryMessage,
    openMessageSheet,
    deletion,
    setFocusTarget,
    setSelected,
    setSidebar,
    closeSearch,
    setDetailBot,
    setCapabilities,
    setOperationBot,
    setOperations,
    setNewChat,
    labels,
    bots: state.bots,
    preferences,
    setPreferences,
    hasExternalPreferences: !!(shell?.updatePreferences ?? pane?.updatePreferences),
  });
  rowActionsRef.current = {
    copyReadableMessage,
    report,
    setReply,
    setForwarding,
    retryMessage,
    openMessageSheet,
    deletion,
    setFocusTarget,
    setSelected,
    setSidebar,
    closeSearch,
    setDetailBot,
    setCapabilities,
    setOperationBot,
    setOperations,
    setNewChat,
    labels,
    bots: state.bots,
    preferences,
    setPreferences,
    hasExternalPreferences: !!(shell?.updatePreferences ?? pane?.updatePreferences),
  };
  const onPreparePlainText = useCallback((message: Message) => { if (copiesReadableMessages()) prepareMessagePlainText(message.blocks); }, []);
  const onCopyRow = useCallback((message: Message) => {
    const actions = rowActionsRef.current;
    if (copiesReadableMessages()) actions.copyReadableMessage(message);
    else actions.report(writeClipboardText(blocksText(message.blocks)));
  }, []);
  const onQuoteRow = useCallback((message: Message) => {
    rowActionsRef.current.setReply(message);
    composer.current?.focus();
  }, []);
  const onForwardRow = useCallback((message: Message, trigger: HTMLElement) => {
    forwardTrigger.current = trigger;
    rowActionsRef.current.setForwarding(message);
  }, []);
  const onRetryRow = useCallback((message: Message) => {
    const actions = rowActionsRef.current;
    actions.report(actions.retryMessage(message));
  }, []);
  const onOpenSheetRow = useCallback((message: Message, trigger: HTMLElement) => rowActionsRef.current.openMessageSheet(message, trigger), []);
  const onDeletionToggle = useCallback((id: string) => rowActionsRef.current.deletion.toggle(id), []);
  const onDeletionClose = useCallback(() => rowActionsRef.current.deletion.close(), []);
  const renderDeletionCheck = useCallback((id: string) => rowActionsRef.current.deletion.check(id), []);
  const selectStandaloneChat = useCallback((id: string) => {
    const actions = rowActionsRef.current;
    actions.setFocusTarget(undefined);
    actions.setSelected(id);
    actions.setSidebar(false);
    actions.closeSearch();
  }, []);
  const newStandaloneDirectChat = useCallback((botId: string) => rowActionsRef.current.setNewChat({ kind: "direct", botId }), []);
  const openStandaloneBot = useCallback((botId: string, destination: "capabilities" | "operations") => {
    const actions = rowActionsRef.current;
    if (destination === "capabilities") { actions.setDetailBot(botId); actions.setCapabilities(true); return; }
    const bot = actions.bots.find(item => item.id === botId);
    if (bot) { actions.setOperationBot({ botId, name: actions.labels.get(botId) ?? bot.name, view: "dashboard" }); actions.setOperations(true); }
  }, []);
  const setStandaloneDisconnectedBots = useCallback((showDisconnectedBots: boolean) => {
    const actions = rowActionsRef.current;
    if (!actions.hasExternalPreferences) {
      setLocalPreferences(old => ({ ...old, showDisconnectedBots }));
      return;
    }
    actions.setPreferences({ ...actions.preferences, showDisconnectedBots });
  }, []);
  const standaloneSidebarHosts = useMemo(() => [{ id: "local", name: hostName ?? "", connection }], [hostName, connection]);
  const standaloneSidebarOptions = useMemo(() => <DisconnectedBotsSwitch menu checked={preferences.showDisconnectedBots} change={setStandaloneDisconnectedBots}/>, [preferences.showDisconnectedBots, locale, setStandaloneDisconnectedBots]);
  const phoneTurnActions = chatActions && (
    <div className="mobile-chat-action-list">
      {current?.botIds.length === 1 && !current.archived && !group?.archived && searchResults === undefined && state.engineTasksAvailable && <button onClick={() => { setChatActions(false); setTaskListRequest({ conversationId: selected, id: Date.now() }); }}><ListOrdered size={20}/><span>{t("子代理与后台任务")}</span></button>}
      {sidePanelPlugins.map(({ plugin, contribution }) => {
        const label = locale === "zh" ? contribution.titleZh ?? contribution.title : contribution.title;
        return <button key={`${plugin.manifest.id}:${contribution.id}`} onClick={() => { setChatActions(false); openPluginContribution(plugin.manifest.id, contribution.id, contribution.kind, label); }}><Puzzle size={20}/><span>{label}</span></button>;
      })}
      {immediateAvailable && <button aria-label={t("立即发送")} className="action-with-note" disabled={!draft.trim() || steeringBusy || sending} onClick={() => { setChatActions(false); report(sendImmediately()); }}><ArrowUp size={20}/><span className="action-text"><span>{t("立即发送")}</span><small>{t("由 CLI 后台继续工具或中断当前输出，再读入消息")}</small></span></button>}
      {continueCurrent && <button aria-label={t("作为下一轮发送")} className="action-with-note" disabled={!draft.trim() || steeringBusy || sending} onClick={() => { setChatActions(false); report(send(true)); }}><ListOrdered size={20}/><span className="action-text"><span>{t("作为下一轮发送")}</span><small>{t("等待当前任务结束后再处理")}</small></span></button>}
      {steeringAvailable && !nativeInput && <button className="action-with-note" aria-label={t("引导当前任务")} aria-describedby={`${chatActionNote}-steer`} disabled={connection.isReadOnly || !richDraftReady || steeringBusy || uploadProgress !== undefined || recording} onClick={() => { setChatActions(false); report(steer()); }}><Compass size={20}/><span className="action-text"><span>{t("引导当前任务")}</span><small id={`${chatActionNote}-steer`}>{t("补充到当前任务，不改变待执行顺序")}</small></span></button>}
      <button className="action-with-note" aria-label={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} aria-describedby={!canStopActive ? `${chatActionNote}-stop` : undefined} onClick={() => { setChatActions(false); report(requestComposerStop()); }}><CircleStop size={20}/><span className="action-text"><span>{discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")}</span>{!canStopActive && <small id={`${chatActionNote}-stop`}>{t("未检测到进行中的回复。仍会向 Bot 发送停止请求，结果显示在对话中。")}</small>}</span></button>
    </div>
  );
  return <WorkbenchEntryContext.Provider value={workbenchEntry}><NativeInputContext.Provider value={nativeContext}><DesktopMenuPortalContext.Provider value={!!pane}><RuntimeHostActiveContext.Provider value={visible}><RuntimeHostContext.Provider value={shell?.host.name ?? pane?.host.name}><AvatarProvider connection={connection} conversations={conversations} directory={botDirectory}><BotReferences bots={botDirectory}><div ref={backRoot} data-side-window={sideWindowLayout} data-widget-owner={widgetOwner} className={`app-shell ${sideVisible || screenVisible || pluginSideVisible || terminalVisible || (workbenchVisible || filesVisible) && !phone ? "has-side-panel" : ""} ${workbenchVisible && workbenchExpanded ? "workbench-expanded" : ""} ${workbenchVisible && phone ? "workbench-phone" : ""} ${pane ? "conversation-pane" : ""} ${sidebar ? "mobile-home-open" : "mobile-chat-open"}`}>{!pane && !phone && <><Sidebar shown={sidebar} active={visible && !phone}><div className="brand"><BrandName/>{shell?.openAgentBus && <button className="agent-bus-entry" aria-label={t("打开 Agent Bus")} title="Agent Bus" disabled={paneBusy || shell.adhdBlocked} onClick={shell.openAgentBus}><AgentBusIcon size={17}/></button>}<button ref={createTrigger} className="icon-button sidebar-create-trigger" aria-label={t("新建")} title={t("新建")} aria-expanded={menu === "create"} aria-controls={menu === "create" ? `${menuId}-create` : undefined} onClick={() => toggleMenu("create")}><Plus size={20}/></button><DesktopMenu id={`${menuId}-create`} label={t("新建")} open={menu === "create"} close={closeMenu} trigger={createTrigger} placement="down-end" className="create-menu">{([
    ["direct", MessageSquarePlus, t("新建对话"), t("为已有 Bot 开一个独立对话"), () => shell ? shell.create("direct") : setNewChat({ kind: "direct", ...(choosableBot ? { botId: choosableBot.id } : {}) })],
    ["bot", BotIcon, t("新建 Bot"), t("独立的工作区、人设与记忆"), () => shell ? shell.create("bot") : setNewBot(true)],
    ["group", Users, t("新建群组"), t("多个 Bot 同群，按话题分开讨论"), () => shell ? shell.create("group") : setNewChat({ kind: "group", ...(activeBot ? { botId: activeBot.id } : {}) })],
    ["schedule", CalendarClock, t("新建定时任务"), t("让 Bot 按计划自动完成工作"), () => shell ? shell.create("schedule") : setScheduledTasks("create")],
  ] as const).map(([kind, Icon, label, detail, run]) => <button key={kind} aria-labelledby={`${menuId}-create-${kind}`} aria-describedby={`${menuId}-create-${kind}-detail`} onClick={run}><Icon size={16}/><span className="desktop-menu-text"><span id={`${menuId}-create-${kind}`}>{label}</span><small id={`${menuId}-create-${kind}-detail`}>{detail}</small></span></button>)}</DesktopMenu></div>{shell?.controls}<form className="search-box" onSubmit={(event) => search(event, true)}><Search size={16}/><input aria-label={t("搜索历史消息")} placeholder={shell ? t("搜索 {0} 的消息…", shell.host.name) : t("搜索消息…")} maxLength={256} value={query} onChange={(e) => setQuery(e.target.value)}/><kbd>↵</kbd></form><SidebarLayoutSwitch value={preferences.sidebarLayout} change={sidebarLayout => setPreferences({ ...preferences, sidebarLayout })} adhd={shell?.openAdhd ? { open: shell.openAdhd, disabled: paneBusy || shell.adhdBlocked, reason: paneBusy || shell.adhdBlocked ? t("请先完成各对话的发送、上传或录音。") : undefined } : undefined}/><SidebarUnreadFilter filter={shell ? shell.inboxFilter : localInboxFilter} unreadCount={shell ? shell.unreadCount : localUnreadCount} pendingCount={shell ? shell.pendingCount : localPendingCount} change={shell ? shell.changeInboxFilter : changeLocalInboxFilter}/>{shell ? shell.navigation({ conversations, bots: navigationBots, selected, pins, globalPins, activity }) : <FolderListOptions hosts={standaloneSidebarHosts} defaultConnection={connection} visible={visible} scope={preferences.sidebarLayout} options={standaloneSidebarOptions}><ConversationList showDisconnectedBots={preferences.showDisconnectedBots} layout={preferences.sidebarLayout} inboxFilter={localInboxFilter} retainedConversationId={localInboxFilter ? localRetainedOpen : undefined} openBot={openStandaloneBot} connection={connection} newChat={newStandaloneDirectChat} conversations={conversations} bots={navigationBots} selected={selected} pins={pins} globalPins={globalPins} activity={activity} select={selectStandaloneChat}/></FolderListOptions>}<WorkspaceFooter hostName={hostName} status={state.status} userId={state.user?.id} archivedCount={archivedChats.length} menuId={`${menuId}-workspace`} menuOpen={menu === "workspace"} trigger={workspaceTrigger} toggleMenu={() => toggleMenu("workspace")} closeMenu={closeMenu} openAdhd={shell?.openAdhd} adhdBlocked={paneBusy || shell?.adhdBlocked} manageHosts={shell?.manageHosts} addHost={shell?.addHost} resourcesAvailable={desktopResourcesAvailable} open={tool => {
      if (tool === "profile" || tool === "settings" || tool === "connection" || tool === "screen") { setSettingsFromMenu(false); setSettingsSection(tool === "connection" || tool === "screen" ? tool : "general"); setSettings(true); }
      else if (tool === "files") setFileCenter(true);
      else if (tool === "capabilities") { setDetailBot(undefined); setCapabilities(true); }
      else if (tool === "plugins") setPluginsOpen(true);
      else if (tool === "schedules") setScheduledTasks("list");
      else if (tool === "operations") setOperations(true);
      else if (tool === "resources") { resourcesReturnFocus.current = workspaceTrigger.current; setResourcesOpen(true); }
      else if (tool === "archives") setArchives(true);
    }}/></Sidebar>{sidebar && <button className="sidebar-backdrop" aria-label={t("关闭会话列表")} onClick={() => setSidebar(false)}/>}</>}
  {phone && <Suspense fallback={<div className="mobile-home loading-screen" role="status">{t("正在打开 TaroBird…")}</div>}><MobileHome showDisconnectedBots={preferences.showDisconnectedBots} changeShowDisconnectedBots={showDisconnectedBots => setPreferences({ ...preferences, showDisconnectedBots })} density={preferences.layoutDensity} groupByHost={preferences.sidebarGroupByHost} changeGroupByHost={sidebarGroupByHost => setPreferences({ ...preferences, sidebarGroupByHost })} notice={visible && sidebar && (shell?.networkNotice || share.entry) ? <>{shell?.networkNotice}{share.entry}</> : undefined} hosts={shell?.mobileHosts({ conversations, bots: navigationBots, activity, pins, globalPins }) ?? [{ id: "local", name: t("我的主机"), connection, conversations, bots: navigationBots, activity, pins, globalPins }]} registeredHostCount={shell?.registeredHostCount} activeHostId={shell?.host.id ?? "local"} visible={visible && sidebar} scrollPositions={mobileScroll} inbox={mobileInbox} updateInbox={updateMobileInbox} tab={mobileTab} setTab={setMobileTab}
    archived={(hostId, ids) => { if (shell) shell.conversationsArchived(hostId, ids); else { const next = selectionAfterArchive(selected, ids, conversations, navigationItems({ connection, bots: state.bots, conversations }, preferences.showDisconnectedBots).conversations, activity); if (next !== undefined) { setSelected(next); setFocusTarget(undefined); closeSearch(); } } }}
    select={(hostId, id, messageId) => { if (shell) shell.mobileSelect(hostId, { kind: "select", conversationId: id, messageId }); else { setFocusTarget(messageId ? { conversationId: id, messageId } : undefined); setSelected(id); closeSearch(); setSidebar(false); } }}
    newChat={(hostId, botId) => { if (shell) shell.mobileSelect(hostId, { kind: "direct", botId }); else setNewChat({ kind: "direct", botId }); }}
    settingsBot={(hostId, botId) => { if (shell && hostId !== shell.host.id) shell.mobileSelect(hostId, { kind: "bot-settings", botId }); else showBotSettings([botId], document.activeElement as HTMLElement | null); }}
    create={(kind) => { if (shell) shell.create(kind); else if (kind === "bot") setNewBot(true); else if (kind === "schedule") setScheduledTasks("create"); else setNewChat({ kind }); }}
    selectHost={(hostId) => shell?.mobileSelect(hostId, { kind: "home" })}
    open={(kind) => { if (kind === "plugins") setPluginsOpen(true); else if (kind === "settings" || kind === "notifications" || kind === "devices" || kind === "connection" || kind === "screen") { setSettingsFromMenu(false); setSettingsSection(kind === "notifications" ? "notifications" : kind === "devices" ? "devices" : kind === "connection" ? "connection" : kind === "screen" ? "screen" : "general"); setSettings(true); } else if (kind === "files") setFileCenter(true); else if (kind === "capabilities") { setDetailBot(undefined); setCapabilities(true); } else if (kind === "schedules") setScheduledTasks("list"); else if (kind === "operations") setOperations(true); else if (kind === "resources") setResourcesOpen(true); else if (kind === "archives") setArchives(true); else if (kind === "hosts") shell?.manageHosts(); }}
    openPluginContribution={openPluginContribution}
    searchHistory={(text) => { setSearchConversation(undefined); setQuery(text); setSearchBot(""); setSearchFrom(""); setSearchTo(""); setSearchFiles(false); setSidebar(false); setFocusTarget(undefined); historySearch.start(new URLSearchParams({ q: text }).toString(), ""); }}/></Suspense>}
  <main ref={attachmentDrop.ref} className={`conversation-main${attachmentDrop.hover ? " is-file-drop-target" : ""}`} {...attachmentDrop.events}>{searching ? <header className="conversation-header history-search-header">
    {phone ? <button className="icon-button" aria-label={t("打开会话列表")} onClick={exitHistorySearch}><ChevronLeft size={24}/></button> : <Search className="history-search-symbol" size={20} aria-hidden="true"/>}
    {pane?.headerLeading}<div className="header-title"><h1>{searchConversation ? t("搜索当前对话") : t("搜索历史消息")}</h1><span title={searchScope}>{searchScope}</span></div>{side.shown && sideButton}{pane?.headerTrailing}
  </header> : <header className="conversation-header"><button className="icon-button mobile-menu" aria-label={t("打开会话列表")} onClick={openMobileHome}><ChevronLeft size={24}/></button>{!phone && group && current?.parentId && <button className="icon-button header-group-back" aria-label={t("返回群组「{0}」", group.title)} title={t("返回群组「{0}」", group.title)} onClick={() => selectChat(group.id)}><ArrowLeft size={18}/></button>}{pane?.headerLeading}<div className="header-title">
    <div className="header-heading-row"><h1 aria-label={current?.title}>{current ? <button ref={detailTrigger} className="chat-identity" aria-label={t("查看对话详情")} aria-expanded={details} onClick={() => setDetails(value => !value)}><ConversationAvatar conversation={current} size={30}/><span title={current.title}>{current.title}</span><ChevronDown size={14}/></button> : t("欢迎回来")}</h1>
      {pane?.headerMeta}
      {!phone && directBotName && <span className="header-bot-name" title={directBotName}><BotName id={directBotId!} name={directBotName} compact/></span>}
      {current?.workspacePath && <span className="header-workspace-name" title={current.workspacePath}><Folder size={12} aria-hidden="true"/><span>{workspaceDisplayName(current.workspacePath)}</span></span>}
      {current && <ReplyActivity group={!!group} names={streamingBots} offline={live && !!directBotId && state.bots.some(bot => bot.id === directBotId && !bot.online)}/>}
    </div>
  </div>{shell?.multiHost && phoneQuota ? <button type="button" className="header-host-source header-host-usage" aria-label={`${t("运行于 {0}", shell.host.name)}${t("，")}${quotaMarkLabel(phoneQuota.left, phoneQuota.stale, phoneQuota.observedAt, locale)}`} onClick={openQuotaDetails}><HostSourceBadge name={shell.host.name} header/><QuotaBattery left={phoneQuota.left} stale={phoneQuota.stale} height={11}/></button>
    : shell?.multiHost ? <HostSourceBadge name={shell.host.name} header/> : phoneQuota ? <QuotaMark left={phoneQuota.left} stale={phoneQuota.stale} observedAt={phoneQuota.observedAt} onOpen={openQuotaDetails}/> : null}{!phone && visible && searchResults === undefined && group && current && <TopicSwitcher compact={!!pane} connection={connection} key={`topic:${current.id}`} group={group} current={current} conversations={conversations} activity={activity} select={selectChat} create={() => setNewChat({ kind: "topic", group })}/>}{sideButton}{rightPanelSwitcher}{terminalButton}{pluginPanelButtons}{screenButton}{workspaceButton}{!phone && current && <button ref={conversationSearchTrigger} className="icon-button conversation-search-trigger" aria-label={t("搜索当前对话")} title={t("搜索当前对话") + " (⌘F / Ctrl+F)"} aria-keyshortcuts="Meta+F Control+F" onClick={searchCurrentConversation}><Search size={18}/></button>}<button className={`connection-pill ${state.status}`} title={state.route?.url} aria-label={t("打开连接设置")} onClick={(event) => { event.currentTarget.focus(); setSettingsFromMenu(false); setSettingsSection("connection"); setSettings(true); }}>{state.status === "online" ? <Wifi size={14}/> : <WifiOff size={14}/>}<span>{connectionSummary}</span></button>{(phone || current) && <button ref={chatMoreTrigger} className="icon-button mobile-chat-more" aria-label={t("更多聊天操作")} aria-expanded={phone ? undefined : menu === "chat"} aria-controls={!phone && menu === "chat" ? `${menuId}-chat` : undefined} onClick={(event) => { event.currentTarget.focus(); history.refresh(); if (phone) setChatActions(true); else toggleMenu("chat"); }}><MoreHorizontal size={phone ? 24 : 18}/></button>}
      {pane?.headerTrailing}{!phone && current && <DesktopMenu id={`${menuId}-chat`} label={t("聊天操作")} open={menu === "chat"} close={closeMenu} trigger={chatMoreTrigger} placement="down-end" className="chat-menu">
        {!pane&&isMobileScreenApp()&&<button className="screen-mobile-entry" onClick={()=>{closeMenu();openScreen();}}><MonitorPlay size={16}/><span className="desktop-menu-label">{t("查看屏幕")}</span></button>}
        {!pane&&isMobileScreenApp()&&<button className="screen-mobile-entry" onClick={()=>{closeMenu();setSettingsFromMenu(true);setSettingsSection("screen");setSettings(true);}}><MonitorCog size={16}/><span className="desktop-menu-label">{t("屏幕控制设置")}</span></button>}
        {current.botIds.length === 1 && !current.archived && !group?.archived && searchResults === undefined && state.engineTasksAvailable && <button onClick={() => { closeMenu(); setTaskListRequest({ conversationId: selected, id: Date.now() }); }}><ListOrdered size={16}/><span className="desktop-menu-label">{t("子代理与后台任务")}</span></button>}
        {immediateAvailable && <button aria-label={t("立即发送")} disabled={!draft.trim() || steeringBusy || sending} onClick={() => report(sendImmediately())}><ArrowUp size={16}/><span className="desktop-menu-text"><span>{t("立即发送")}</span><small>{t("由 CLI 后台继续工具或中断当前输出，再读入消息")}</small></span></button>}
        {continueCurrent && <button aria-label={t("作为下一轮发送")} disabled={!draft.trim() || steeringBusy || sending} onClick={() => report(send(true))}><ListOrdered size={16}/><span className="desktop-menu-text"><span>{t("作为下一轮发送")}</span><small>{t("等待当前任务结束后再处理")}</small></span></button>}
        <button onClick={() => setConversationFiles(current)}><FolderOpen size={16}/><span className="desktop-menu-label">{t("文件")}</span></button>
        <button onClick={() => setDetails(true)}><Settings size={16}/><span className="desktop-menu-label">{t("对话详情")}</span></button>
        {!current.parentId && !current.archived && <button disabled={state.status !== "online" || !state.foldersAvailable} title={state.status !== "online" || !state.foldersAvailable ? t("连接恢复或主机升级后可编辑分组") : undefined} onClick={() => setMovingConversation(current.id)}><FolderInput size={16}/><span className="desktop-menu-label">{t("移至分组")}</span></button>}
        {current.parentId && !current.archived && <><button disabled={!canRename || group?.archived} onClick={() => setRenameId(current.id)}><Pencil size={16}/><span className="desktop-menu-label">{t("重命名话题")}</span></button><button className="text-danger" disabled={!canRename || group?.archived} onClick={() => setRemoveTopicId(current.id)}><Trash2 size={16}/><span className="desktop-menu-label">{t("删除话题")}</span></button></>}
        <HistoryForkMenu action={history.fork}/>
        <button title={t("为当前 Bot 开一个独立对话")} onClick={() => setNewChat({ kind: "direct", ...(activeBot ? { botId: activeBot.id } : {}) })}><MessageSquarePlus size={16}/><span className="desktop-menu-label">{t("新对话")}</span></button>
        {group && <button disabled={!!group.archived} onClick={() => setNewChat({ kind: "topic", group })}><Hash size={16}/><span className="desktop-menu-label">{t("新建话题")}</span></button>}
        {/* Keep explicit steering reachable when the selector replaces its
            desktop button. The extra stop entry is only for unobserved runs. */}
        {(!canStopActive || showSendChoice && steeringAvailable && !nativeInput) && <><hr/>
          {steeringAvailable && !nativeInput && <button aria-label={t("引导当前任务")} aria-describedby={`${chatActionNote}-menu-steer`} disabled={connection.isReadOnly || !richDraftReady || steeringBusy || uploadProgress !== undefined || recording} onClick={() => report(steer())}><Compass size={16}/><span className="desktop-menu-text"><span>{t("引导当前任务")}</span><small id={`${chatActionNote}-menu-steer`}>{t("补充到当前任务，不改变待执行顺序")}</small></span></button>}
          {!canStopActive && <button aria-label={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} aria-describedby={`${chatActionNote}-menu-stop`} onClick={() => report(requestComposerStop())}><CircleStop size={16}/><span className="desktop-menu-text"><span>{discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")}</span><small id={`${chatActionNote}-menu-stop`}>{t("未检测到进行中的回复。仍会向 Bot 发送停止请求，结果显示在对话中。")}</small></span></button>}
        </>}
      </DesktopMenu>}</header>}
    {visible && (!phone || !sidebar) && shell?.networkNotice}
    {visible && (!phone || !sidebar) && share.entry}
    {/* Phones keep the topic strip; desktop uses the header's TopicSwitcher. */}
    {phone && visible && searchResults === undefined && group && current && <GroupTopics connection={connection} key={group.id} group={group} current={current} conversations={conversations} activity={activity} select={selectChat} create={() => setNewChat({ kind: "topic", group })}/>}
    {searchResults === undefined && group && current && <GroupDiscussionBar key={`${connection.identity.hubPublicKey}:${current.id}`} connection={connection} conversation={current} group={group} active={visible && chatVisible} select={selectChat} modeChanged={setGroupReplyMode} participants={discussionParticipants} participantNames={labels}/>}
    <div className="conversation-notices"><div className="conversation-notices-content">
    {!connection.isReadOnly && state.status !== "online" && (phone ? <ConnectionNotice key={connection.identity.hubPublicKey} host={hostName} pending={offlinePending} retrying={!connection.isNetworkBlocked && (state.status === "connecting" || duplicatePaneRetry)} reason={!connection.isNetworkBlocked ? routeDiagnosisText : undefined}/> : <div className="offline-banner"><WifiOff size={15}/>{t("与「{0}」的连接已断开，已缓存的消息仍可阅读。", hostName)}{offlinePending > 0 && t("{0} 条消息将在重连后发送。", offlinePending)}{!!pane && !connection.isNetworkBlocked && duplicatePaneRetry && routeDiagnosisText ? ` ${routeDiagnosisText}` : ""}</div>)}
    {state.status === "online" && state.syncProgress && <div className="history-sync-status" role="status"><span>{syncLabel}</span><progress aria-label={syncLabel} value={state.syncProgress.indeterminate ? undefined : state.syncProgress.completed} max={state.syncProgress.total}/></div>}
    {(error || !connection.isNetworkBlocked && !duplicatePaneRetry && connectionError) && <div role="alert" className="error-banner">{mentionProblem && error === mentionProblem ? <div className="mention-send-recovery"><span>{error}</span>{!ambiguousMentions && <button type="button" className="text-button" disabled={sending || connection.isReadOnly} onClick={() => report(send(false, true))}>{t("将未识别的 @ 作为正文发送")}</button>}</div> : error || connectionError}{!error && !connection.isReadOnly && state.status !== "online" && state.error && <button type="button" className="text-button" onClick={() => { setSettingsFromMenu(true); setSettingsSection("connection"); setSettings(true); }}>{t("检查连接状态与线路")}</button>}{!error && connection.isRevoked && shell?.manageConnections &&<button type="button" className="text-button" onClick={() => shell.manageConnections()}>{t("此设备的连接")}</button>}<button className="icon-button" aria-label={t("关闭提示")} onClick={() => { setError(""); connection.clearError(); }}><X size={14}/></button></div>}
    {messageReadFailed && searchResults === undefined && <div role="alert" className="error-banner">{messages.length ? t("消息暂时无法刷新，已显示的内容仍可阅读。请重试。") : t("暂时无法读取消息，请重试。")}<button onClick={retryMessageRead}>{t("重试")}</button></div>}
    {attachmentDropError && <div role="alert" className="error-banner">{attachmentDropError}<button className="icon-button" aria-label={t("关闭提示")} onClick={() => setAttachmentDropError("")}><X size={14}/></button></div>}
    </div></div>
    {searchResults ? <><section className="search-results" ref={searchPanel} aria-busy={searchBusy}><header><h2 aria-live="polite">{searchBusy ? t("正在搜索…") : historySearch.page || historySearch.hasNext ? t("搜索结果 · 本页 {0} 条", searchResults.length) : t("搜索结果 · {0}", searchResults.length)}</h2><button className="icon-button" aria-label={t("关闭搜索")} onClick={exitHistorySearch}><X size={18}/></button></header><form className="search-filters" onSubmit={search}><label className="search-keywords">{t("关键词")}<input ref={searchInput} aria-label={t("搜索关键词")} maxLength={256} value={query} onChange={(e) => setQuery(e.target.value)}/></label>{!searchConversation && <label>Bot<select aria-label={t("搜索 Bot")} value={searchBot} onChange={(e) => setSearchBot(e.target.value)}><option value="">{t("全部")}</option>{state.bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}{pane ? <details className="pane-search-options"><summary>{t("筛选条件")}{(searchFrom || searchTo || searchFiles) && <small> · {[!!searchFrom, !!searchTo, searchFiles].filter(Boolean).length}</small>}</summary><div>{advancedSearchFilters}</div></details> : advancedSearchFilters}<button className="primary" type="submit">{pane ? t("搜索") : t("应用筛选")}</button></form>{historySearch.params !== searchParams && <p className="muted" role="status">{t("筛选条件已修改，点击“应用筛选”更新结果。")}</p>}{searchError ? <p className="error-text" role="alert">{searchError}</p> : !searchBusy && !searchResults.length ? <p className="muted">{t("没有找到匹配的消息。试试其他关键词或放宽筛选条件。")}</p> : null}{searchResults.map((m) => <button key={m.id} onClick={() => { setFocusTarget({ conversationId: m.conversationId, messageId: m.id, searchQuery: pane ? historySearch.appliedQuery : undefined }); closeSearch(); }}><strong>{conversations.find((c) => c.id === m.conversationId)?.title}</strong><p><SearchExcerpt excerpt={m.excerpt} query={historySearch.appliedQuery}/></p><small>{new Date(m.createdAt).toLocaleString()}</small></button>)}</section>{(historySearch.page > 0 || historySearch.hasNext) && <nav className="search-pagination" aria-label={t("搜索翻页")}><button type="button" disabled={searchBusy || historySearch.page === 0} onClick={() => historySearch.turnPage(-1)}>{t("上一页")}</button><span>{t("第 {0} 页", historySearch.page + 1)}</span><button type="button" disabled={searchBusy || !historySearch.hasNext} onClick={() => historySearch.turnPage(1)}>{t("下一页")}</button></nav>}</>
    : selected ? <div ref={scroll} tabIndex={-1} className="message-scroll" data-hold-root={visible && phone && chatVisible && searchResults === undefined || undefined} onWheel={(event) => { if (!event.currentTarget.contains(event.target as Node)) return; if (event.deltaY < 0) readHistory(); else if (event.deltaY > 0) readTowardLatest(); }}
      onTouchStart={(event) => { if (!event.currentTarget.contains(event.target as Node)) return; finishTouch(); touchY.current = event.touches[0]?.clientY; scrollingTowardLatest.current = false;
        // The touch target can leave the DOM during a server acknowledgement.
        // Its native listeners still receive touchend when React no longer can.
        touchTarget.current = event.target; event.target.addEventListener("touchend", finishTouch); event.target.addEventListener("touchcancel", finishTouch); }}
      onTouchMove={(event) => {
        // Process/file/table dialogs use portals; their gestures must not change chat following.
        if (!event.currentTarget.contains(event.target as Node)) return;
        const y = event.touches[0]?.clientY;
        if (y !== undefined && touchY.current !== undefined) {
          if (y > touchY.current + 1) readHistory();
          else if (y < touchY.current - 1) readTowardLatest();
          else return; // Accumulate small movements instead of losing a slow drag.
        }
        touchY.current = y;
      }}
      onTouchEnd={(event) => { if (event.currentTarget.contains(event.target as Node)) finishTouch(); }}
      onTouchCancel={(event) => { if (!event.currentTarget.contains(event.target as Node)) return; finishTouch(); scrollingTowardLatest.current = false; }}
      onPointerDown={(event) => { if (event.target === event.currentTarget) { readHistory(); if (event.pointerType === "mouse") scrollbarOrigin.current = event.currentTarget.scrollTop; } }}
      onKeyDown={(event) => { if (!event.currentTarget.contains(event.target as Node)) return; if (["ArrowUp", "PageUp", "Home"].includes(event.key)) readHistory(); else if (["ArrowDown", "PageDown", "End"].includes(event.key)) readTowardLatest(); }}
      onScroll={(event) => {
        const node = event.currentTarget;
        if (node.dataset.contextMenu) return;
        // Being near the bottom is not consent to follow: the first few pixels
        // of a pull are still near it. Rejoin only on an intentional return.
        if ((scrollingTowardLatest.current || scrollbarOrigin.current !== undefined && node.scrollTop > scrollbarOrigin.current) && node.scrollHeight - node.scrollTop - node.clientHeight <= 2) { followLatest.current = true; setShowLatest(false); setFocusTarget(undefined); }
        syncRailPosition();
      }}>{phone && <div className="conversation-intro"><ShieldCheck size={14}/>{t("仅已授权设备可访问")}</div>}{messagesReady && group && current && !messages.length && !pendingMessages.length && !attentionQueued.length && <div className="conversation-empty"><MessageSquare size={28}/><h2>{current.parentId ? t("从这个话题开始") : t("默认讨论")}</h2><p>{current.parentId ? t("这里的消息只属于「{0}」。", current.title) : t("日常交流留在这里，不同事项可以新建话题。")}</p>{!group.archived && !current.parentId && !conversations.some((c) => c.parentId === group.id) && <button onClick={() => setNewChat({ kind: "topic", group })}><Plus size={16}/>{t("创建第一个话题")}</button>}</div>}{messagesReady && current?.historyOrigin && <ConversationHistoryOrigin conversation={current} source={conversations.find(value => value.id === current.historyOrigin?.sourceConversationId)} open={selectChat}/>}{messagesReady && !group && current && !current.historyOrigin && !messages.length && !pendingMessages.length && !attentionQueued.length && <DirectEmpty botId={current.botIds[0] ?? "unknown"} name={labels.get(current.botIds[0] ?? "") ?? activeBot?.name ?? current.title} archived={!!current.archived} online={state.status === "online"} draftEmpty={!draft} commands={() => { if (draft) return; changeDraft("/"); composer.current?.focus(); }} attach={attachments.show} dispatcher={isDispatcher(activeBot)}/>}<div ref={historyRows} className="virtual-messages" style={{ height: Math.max(0, virtualizer.getTotalSize() - readingScroll.shift), transform: readingScroll.shift ? `translateY(${-readingScroll.shift}px)` : undefined }}><TurnStopContext.Provider value={turnStop.request}><MessageOverlayContext.Provider value={retainMessageOverlay}><ReplyWidthContext.Provider value={replyWidth}>{virtualizer.getVirtualItems().map((item) => {
  const message = displayedMessages[item.index]!;
  const bot = botsById.get(message.authorId);
  const original = message.replyTo ? messagesById.get(message.replyTo) : undefined;
  const backgroundGroup = backgroundGroups.byAnchor.get(message.id);
  const key = rowKey(message);
  const pending = pendingById.get(message.id);
  const focusedHere = (backgroundGroups.anchors.get(focusTarget?.messageId ?? "") ?? focusTarget?.messageId) === message.id;
  const rowFocusRequest = focusTarget && (focusedHere || message.authorType === "user" && !!message.botSource && focusTarget.conversationId === message.conversationId) ? focusTarget : undefined;
  const botLabel = labels.get(message.authorId);
  const authorLabel = botLabel ?? (message.authorType === "user" ? t("我") : "TaroBird");
  const scheduledName = labels.get(message.groupDiscussion?.botId ?? "") ?? botsById.get(message.groupDiscussion?.botId ?? "")?.name ?? t("Bot");
  return <WorkspaceMessageRow
    key={key}
    rowKey={key}
    pending={pending}
    message={message}
    index={item.index}
    start={item.start}
    measureRef={message.id === tailMessageId ? measureTail : virtualizer.measureElement}
    connection={connection}
    locale={locale}
    localDay={localDay}
    phone={phone}
    compactTime={compactTime}
    live={live}
    isGroup={!!group}
    archived={!!current?.archived || !!group?.archived}
    groupSending={groupSending}
    retryBlocked={retryBlocked}
    canRetryMessage={canRetry(message)}
    isTicketNoticeRow={isTicketNotice(message, conversationDispatchers.length > 0)}
    copiedHere={copied === message.id}
    focusedHere={focusedHere}
    focusRequest={rowFocusRequest}
    sheetExpanded={phone && !deletion.active && message.groupDiscussion?.role !== "input" && !backgroundGroup ? sheetTarget?.messageId === message.id : undefined}
    deletionActive={deletion.active}
    deletionSelected={deletion.active ? deletion.selected.has(message.id) : false}
    renderDeletionCheck={deletion.active ? renderDeletionCheck : undefined}
    authorLabel={authorLabel}
    botLabel={botLabel}
    botName={bot?.name}
    scheduledName={scheduledName}
    original={original}
    referenceAuthor={original ? messageAuthor(original, botDirectory) : undefined}
    referenceAvailable={!message.forwardedFrom || conversationIdSet.has(message.forwardedFrom.conversationId)}
    backgroundGroup={backgroundGroup}
    userReplies={message.authorType === "user" ? replyStatuses.get(message.id) : undefined}
    labels={labels}
    widgetOwner={widgetOwner}
    widgetActive={!pending && !message.historyContext && widgetAllowed(selected)}
    widgetScope={`${connection.identity.hubPublicKey}:${state.user?.id ?? ""}:${message.conversationId}:${message.id}`}
    onLocate={locateMessage}
    onWidgetCompose={dispatchWidgetCompose}
    onPreparePlainText={onPreparePlainText}
    onCopy={onCopyRow}
    onQuote={onQuoteRow}
    onForward={onForwardRow}
    onRetry={onRetryRow}
    onOpenSheet={onOpenSheetRow}
    onDeletionToggle={onDeletionToggle}
    onDeletionClose={onDeletionClose}
  />;
})}</ReplyWidthContext.Provider></MessageOverlayContext.Provider></TurnStopContext.Provider></div><div ref={queuedRows} style={{ display: "flow-root" }}>{attentionQueued.map((q) => <div className="queued-message" key={q.id}><span><ReferencePreview text={q.text}/></span><small>{q.error ? q.expired ? q.error : t("发送失败：{0}", q.error) : q.blocked ? t("等待前一条消息处理") : t("等待发送")}</small>{q.error && <>{current?.type === "group" && q.copyable && <button onClick={() => { clearTimeout(copiedTimer.current); setCopied(undefined); let write: Promise<void>; try { write = writeClipboardText(q.text); } catch (error) { write = Promise.reject(error); } write.then(() => { setCopied(q.id); copiedTimer.current = setTimeout(() => setCopied(undefined), 3000); }, () => setError(t("无法写入剪贴板，请检查权限后重试。"))); }}>{copied === q.id ? t("已复制") : t("复制文字")}</button>}{!q.expired && <button disabled={retryBlocked} title={retryBlocked ? t("对话已归档，恢复后可重新发送。") : undefined} onClick={() => { if (retryBlocked) return; report(connection.retryFailed(q.id)); }}>{t("重试")}</button>}<button onClick={() => report(connection.discardFailed(q.id))}>{t("移除待发送项")}</button></>}</div>)}</div>{pane && <span ref={readTail} aria-hidden="true" style={{ display: "block", height: 1 }}/>}</div>
    : <WelcomeHome pairDevice={["macos", "windows"].includes(nativePlatform()) && state.status === "online" && state.user?.role === "owner" ? () => { setSettingsSection("pairing"); setSettings(true); } : undefined} hasBots={state.status !== "online" || state.bots.length > 0} newChat={() => setNewChat({ kind: "direct", ...(choosableBot ? { botId: choosableBot.id } : {}) })} newBot={() => shell ? shell.create("bot") : setNewBot(true)} newGroup={() => setNewChat({ kind: "group", ...(choosableBot ? { botId: choosableBot.id } : {}) })}/>}
    {railEnabled && !searchResults && selected && railItems.length >= 2 && <MessageRail items={railItems} scrollRef={scroll} anchorIndex={railPosition.index} atBottom={railPosition.atBottom} onJump={jumpToRailItem} onWheelDirection={(deltaY) => { if (deltaY < 0) readHistory(); else if (deltaY > 0) readTowardLatest(); }}/>}
    {deletion.toolbar}
    {!searchResults && selected && (current?.archived || group?.archived) && <div className="archived-notice"><span>{!current?.botIds.length || current.botIds.some(id => state.deletedBots?.some(bot => bot.id === id)) ? t("Bot 已删除，此对话仅保留历史记录。") : t("已归档，历史记录仍可查看。恢复后可继续讨论。")}</span><button onClick={() => { if (group?.archived) setSelected(group.id); setManage(true); }}>{current?.parentId && !group?.archived ? t("管理话题") : t("管理对话")}</button></div>}
    {!searchResults && selected && !current?.archived && !group?.archived && <div className="composer-wrap" hidden={deletion.active}><ConversationHistoryStatus history={history}/>{workbenchDraft && <div ref={designDraftNotice} className="workbench-draft-notice" role="status" tabIndex={-1}><span>{workbenchDraft.context.kind === "design" ? t("设计请求已加入草稿；修改回到原设计项目。") : t("已附原图、标注预览与参考图；修改结果回到原白板。") }</span><button className="icon-button" aria-label={workbenchDraft.context.kind === "design" ? t("取消设计关联") : t("取消白板回填")} title={workbenchDraft.context.kind === "design" ? t("取消设计关联") : t("取消白板回填")} onClick={clearWorkbench}><X size={14}/></button></div>}{current && state.dispatchAvailable && state.user?.role === "owner" && conversationDispatchers.map(dispatcher => <DispatchTickets key={`tickets:${connection.identity.hubPublicKey}:${current.id}:${dispatcher.id}`} connection={connection} botId={dispatcher.id} conversationId={current.id} botLabel={conversationDispatchers.length > 1 ? (labels.get(dispatcher.id) ?? dispatcher.name) : undefined} conversationTitles={conversationTitles} active={visible && chatVisible} online={state.status === "online" && !connection.isReadOnly} open={selectChat}/>)}<div className={`composer-accessories${compactComposerTools ? " is-compact" : ""}${phone ? " is-phone" : ""}${codexDirect ? " is-codex-direct" : ""}`}><BackgroundTaskDock groups={backgroundGroups.groups} connection={connection} viewport={scroll} active={visible && chatVisible && !deletion.active} locate={locateMessage}>{(dock, hasActiveGroups) => current?.botIds.length === 1 ? <EngineTasks dock={dock} hasActiveGroups={hasActiveGroups} compactLabel={compactComposerTools && !!showSendChoice} key={`tasks:${connection.identity.hubPublicKey}:${selected}:${current.botIds[0]}`} connection={connection} conversationId={selected} botId={current.botIds[0]!} available={!!state.engineTasksAvailable} active={visible && chatVisible && !archivedHere} online={state.status === "online" && !!state.bots.find(bot => bot.id === current.botIds[0])?.online && !connection.isReadOnly} activity={replying} openRequest={taskListRequest?.conversationId === selected ? taskListRequest.id : 0} openTab={taskListRequest?.conversationId === selected ? taskListRequest.tab : undefined} onOpenRequestConsumed={consumeTaskListRequest} onSwarmMembersChange={setSwarmMembers} onMentionWorker={current?.type === "direct" && activeBot?.engine === "antigravity" ? (name) => { changeDraft(`@${name} ${draft.replace(/^@[A-Za-z0-9._-]+\s*/, "")}`); composer.current?.focus({ preventScroll: true }); requestAnimationFrame(() => { const input = composer.current; if (!input) return; input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }); } : undefined}/> : dock}</BackgroundTaskDock>{(phone || pane) && piSessionControls}{current?.type === "direct" && current.botIds.length === 1 && <PromptQueue key={`${connection.identity.hubPublicKey}:${current.id}:${current.botIds[0]}`} connection={connection} conversationId={current.id} botId={current.botIds[0]!} phone={phone} active={visible && chatVisible} available={!!state.promptQueueAvailable} online={state.status === "online" && !connection.isReadOnly} cacheRevision={connection.conversationRevision(current.id)} messageCount={messages.length} locate={locateMessage}/>} {showSendChoice && <ClaudeSendChoice explicitSteering={codexDirect} compact={compactComposerTools} key={sendChoiceScope} next={queueChosen || richNextTurn} lockedToNext={(codexDirect ? codexLockedToNext : richNextTurn) || !(claudeChoice || piChoice || agyChoice || codexChoice || codexSupplement)} disabled={connection.isReadOnly || !richDraftReady || sending || steeringBusy || uploadProgress !== undefined} change={codexDirect ? codexSendChoice.choose : sendChoice.choose}/>}</div>{showLatest && <button className="jump-latest" onClick={() => { setFocusTarget(undefined); finishTouch(); followLatest.current = true; setShowLatest(false); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>{t("回到最新消息")}</button>}{phone && current?.type === "group" && discussionComposer && <DiscussionParticipants phone key={`${connection.identity.hubPublicKey}:${selected}`} members={conversationBots.map(bot => ({ id: bot.id, name: labels.get(bot.id) ?? bot.name }))} selected={discussionMentionIds} change={ids => { discussionParticipants.change(ids); changeDraft(draft); }} locked={!!replyMode?.activeRun && !discussionNewTopic} disabled={!discussionParticipants.ready || sending || uploadProgress !== undefined}/>}{phone && current?.type === "group" && !discussionComposer && <button ref={recipientTrigger} className={`phone-recipient-trigger${recipients.length || defaultAllReplies ? "" : " is-empty"}`} aria-label={t("让谁回复：{0}", recipientSummary)} aria-haspopup="dialog" onClick={() => toggleMenu("recipients")}><AtSign size={14}/><span>{recipientSummary}</span><ChevronDown size={14}/></button>}{current?.type === "group" && mentionQuery && mentionSuggestions.length > 0 && <ComposerSuggestions label={t("选择 Bot")}>{mentionSuggestions.map(member => <button type="button" key={member.id} aria-label={member.label} disabled={groupSending} onClick={() => { if (discussionComposer) changeDraft(draft.replace(/[@＠][^\s@＠]*$/, `@${member.name} `)); else if (groupRoster?.length) changeDraft(insertScopedGroupMention(draft, member)); else { setRecipients(old => [...new Set([...old, member.id])]); changeDraft(draft.replace(/[@＠][^\s@＠]*$/, "")); } composer.current?.focus(); }}><strong>{member.name}</strong><span>{member.source ?? (member.bot?.model || member.bot?.engine)}</span></button>)}</ComposerSuggestions>}{swarmMentionSuggestions.length > 0 && <ComposerSuggestions label={t("选择 Swarm 成员")}>{swarmMentionSuggestions.map((member) => <button type="button" key={member.name} onClick={() => { changeDraft(draft.replace(/[@＠][^\s@＠]*$/, `@${member.name} `)); composer.current?.focus(); }}><strong>@{member.name}</strong><span>{member.model || member.role || swarmMemberStateLabel(member.state)}</span></button>)}</ComposerSuggestions>}{visibleCommands.length > 0 && <ComposerSuggestions label={t("查看命令")} piCommands={activeBot?.engine === "pi"}>{visibleCommands.map((c) => <button key={c.command} title={activeBot?.engine === "pi" ? `/${c.command}` : undefined} disabled={groupSending} onClick={() => { if (c.command === "tasks") { changeDraft(""); setTaskListRequest({ conversationId: selected, id: Date.now() }); return; } if (c.command === "side") { changeDraft(""); setDetails(false); void side.open(); return; } if (richDraftReady && ["ask", "fan", "chain", "verify"].includes(c.command) && !files.length && !reply && !recording) { changeDraft(""); setDelegation(c.command as DelegationMode); } else { changeDraft(`/${c.command} `); composer.current?.focus(); } }}><strong>/{c.command}</strong><span>{commandDescription(c.description, locale)}</span></button>)}</ComposerSuggestions>}{reply && <div className="reply-preview"><div className="reply-preview-heading"><strong>{t("回复 {0}", messageAuthor(reply, botDirectory))}</strong><button type="button" className="icon-button" aria-label={t("取消引用")} disabled={groupSending} onClick={() => setReply(undefined)}><X size={14}/></button></div>{!messagesReady ? <p role="status">{t("正在加载…")}</p> : replySource ? <RichMessagePreview key={replySource.id} message={replySource} connection={connection}/> : <p role="alert">{t("原消息已删除或当前不可访问")}</p>}</div>}{discussionPaused && <div className="discussion-composer-choice" role="group" aria-label={t("暂停后如何发送")}><span>{t("原讨论已暂停")}</span><div role="radiogroup" aria-label={t("这条消息如何处理")}><button type="button" role="radio" disabled={groupSending || !composerDiscussionRun?.actions?.some(action => action === "resume" || action === "retry")} aria-checked={discussionMessageAction !== "new"} onClick={() => chooseDiscussionAction(replyMode?.activeRun?.actions?.includes("retry") ? "retry" : "resume")}>{replyMode?.activeRun?.actions?.includes("retry") ? t("补充并重试") : t("补充并继续")}</button><button type="button" role="radio" disabled={groupSending || !discussionControlAllowed} aria-checked={discussionMessageAction === "new"} onClick={() => chooseDiscussionAction("new")}>{t("作为新课题")}</button></div></div>}{discussionPaused && !discussionControlAllowed && <p className="discussion-composer-wait" role="status">{t("请讨论发起人或群主继续讨论后，再发送补充。")}</p>}{discussionTransitioning && <p className="discussion-composer-wait" role="status">{!composerDiscussionRun ? t("群内另一个话题正在停止或暂停，请稍候；草稿会保留。") : composerDiscussionRun.status === "ending" ? t("正在停止本次讨论，草稿会保留。") : t("等待当前发言结束后暂停，草稿会保留。")}</p>}<div className="composer-input-row">{phone && voiceMode ? <HoldToTalk voice={voice} disabled={connection.isReadOnly || history.sendBlocked || groupSending || !richDraftReady || steeringBusy} progress={uploadProgress} recovering={uploadRecovering} cancelUpload={() => uploadController.current?.abort()} hasDraft={!!draft || !!files.length || !!reply} close={() => { voice.cancel(); setVoiceMode(false); requestAnimationFrame(() => composer.current?.focus()); }} start={startHeldVoice} stop={canStopActive ? <button type="button" className="icon-button composer-stop is-live" title={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} aria-label={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} disabled={discussionStopping} onClick={() => report(requestComposerStop())}><CircleStop size={19}/></button> : undefined}/> : <div className={`composer${canStopActive ? " is-live" : ""}${expandedComposer ? " is-expanded" : ""}`} onPaste={pasteFiles} onDragOver={event => { if (event.dataTransfer.types.includes(WORKSPACE_FILE_DRAG_MIME)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => { const filePath = event.dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME); if (filePath) { event.preventDefault(); event.stopPropagation(); mentionWorkspaceFile(filePath); } }} onPointerDown={event => focusComposerBackground(event, composer)}>{files.length > 0 && <AttachmentDraft key={`${selected}:${visible}`} maxFileBytes={state.maxFileBytes} files={files} returnFocus={phone ? undefined : composer} busy={connection.isReadOnly || groupSending || uploadProgress !== undefined} add={attachments.show} remove={removeFile}/>}{recording && !phone && <ComposerVoiceRecording voice={voice}/>}<DraftLinkPreview text={draft} choice={previewChoice} choose={setPreviewChoice} style={previewStyle} conversationId={selected} connection={connection} busy={groupSending || uploadProgress !== undefined}/><textarea ref={composer} readOnly={connection.isReadOnly || groupSending} aria-busy={groupSending || undefined} disabled={uploadProgress !== undefined} aria-label={pane ? t("发给 {0} · {1} 的消息", pane.host.name, current?.title ?? selected) : t("消息")} placeholder={discussionPaused && discussionMessageAction === "new" ? t("输入新问题…") : discussionComposer ? discussionSingleRecipient ? t("发给 {0}…", discussionSingleRecipient) : (groupDrafts.current.get(selected)?.intent?.target?.activeRun || replyMode?.activeRun) ? t("补充本次讨论…") : t("输入问题，开始讨论…") : files.length ? t("添加说明…") : queueChosen ? phone ? t("排到下一轮…") : t("排到下一轮，当前任务结束后处理") : phone ? t("发消息…") : t("发消息，/ 查看命令{0}", current?.type === "group" ? t("，@bot 指定实例") : "")} value={draft} rows={1} onChange={(e) => { if (blocksModalHistory((e.nativeEvent as InputEvent).inputType, e.currentTarget)) { e.currentTarget.value = draft; return; } changeDraft(e.target.value); }} onKeyDown={(e) => {
        if (connection.isReadOnly) return;
        if (current?.type === "direct" && activeBot?.engine === "claude" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
          e.preventDefault();
          if (!e.repeat) report(sendImmediately());
          return;
        }
        // WebKit can deliver compositionend before the confirming Enter, making
        // isComposing false. 229 still marks that key as owned by the IME.
        if (e.key === "Enter" && !e.repeat && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && matchMedia("(pointer:fine)").matches) {
          if (e.altKey || (macKeyboard && e.metaKey)) {
            e.preventDefault();
            const input = e.currentTarget;
            const text = input.value, start = input.selectionStart, end = input.selectionEnd;
            // Native insertion preserves undo and fires the normal draft-saving
            // input event. Command+Return on Mac and Alt+Enter need explicit insertion.
            if (!document.execCommand("insertLineBreak") && input.value === text) {
              input.setRangeText("\n", start, end, "end");
              changeDraft(input.value);
            }
          } else if (!e.shiftKey) { e.preventDefault(); report(sendFromComposer()); }
        }
      }}/>{current?.type === "group" && draftSaveFailed && <button type="button" className="text-button" onClick={() => queueDraftText(selected, draft)}>{t("重试保存")}</button>}{current?.type === "group" && (error.includes(t("群聊回复方式已变化，草稿已保留。请确认后按当前群聊方式发送。")) || error.includes(t("原讨论已结束，补充内容已保留。请确认后按当前群聊方式发送。")) || error.includes(t("群内已有进行中的讨论，原问题已保留。请明确选择作为补充发送。")) || error.includes(t("上次发送结果无法确认，草稿已保留。请先核对聊天记录，避免重复发送。"))) && <button type="button" className="text-button" onClick={() => report(rebindGroupDraft(error.includes(t("上次发送结果无法确认，草稿已保留。请先核对聊天记录，避免重复发送。"))))}>{error.includes(t("上次发送结果无法确认，草稿已保留。请先核对聊天记录，避免重复发送。")) ? t("核对后重新发送") : replyMode?.activeRun ? t("作为补充") : automaticComposer(replyMode) ? t("作为新讨论") : t("按当前方式")}</button>}{richDraftError && <div className="error draft-save-error" role="alert">{richDraftError === "draft_capacity_exceeded" ? <><p>{t("草稿未自动保存，仍可直接发送。请保持此页打开，或移除附件后重试。")}</p><details className="draft-save-limits"><summary>{t("本地草稿保存上限")}</summary><p>{t("每个对话最多 32 个附件、64 MB；本机每个主机共 128 MB。此限制不影响直接发送。")}</p></details></> : richDraftError === "draft_metadata_too_large" ? t("引用或附件信息过大，完整草稿尚未自动保存。仍可直接发送，或取消引用、减少附件后重试。") : richDraftError === "draft_record_limit" ? t("本机已达到 1,000 个活跃对话草稿上限。当前内容仍可直接发送，但尚未保存。") : richDraftError === "draft_identity_revoked" ? t("设备授权已失效，新的草稿修改无法保存。请先备份当前内容，再重新配对。") : richDraftError === "draft_changed_elsewhere" ? t("另一窗口已更新此草稿。当前内容仍在此页，请备份后重新打开客户端。") : t("完整草稿未保存，请保持此页打开并重试。") }<button onClick={retryRichDraft}>{t("重试")}</button></div>}<div className="composer-toolbar">{phone && !voiceMode && <button ref={attachments.trigger} className="composer-add" aria-label={t("添加附件")} aria-haspopup="dialog" aria-expanded={attachments.expanded} disabled={connection.isReadOnly || groupSending || uploadProgress !== undefined} onClick={attachments.show}><Plus size={20}/></button>}{!phone && <ComposerAttachmentButton picker={attachments} disabled={connection.isReadOnly || groupSending || uploadProgress !== undefined}/>}{phone ? <VoiceMicButton key={`${voiceKey}:${visible}`} voice={voice} disabled={connection.isReadOnly || !richDraftReady || steeringBusy || uploadProgress !== undefined} start={startHeldVoice} open={() => { setError(""); composer.current?.blur(); setVoiceMode(true); }}/> : <ComposerVoiceButton busy={recording} disabled={connection.isReadOnly || groupSending || uploadProgress !== undefined || !!pane?.microphoneBusy || sideRecording} start={() => { if (pane && !pane.claimMicrophone()) return; setError(""); void voice.start(); }}/>}<>{uploadProgress !== undefined && <button className="composer-cancel-upload" onClick={() => uploadController.current?.abort()} aria-label={t("取消上传")}>{t("取消上传")}</button>}</>{!phone && <button className="icon-button composer-collaborate" title={t("发起 Bot 协作")} aria-label={t("发起 Bot 协作")} disabled={connection.isReadOnly || !richDraftReady || uploadProgress !== undefined || recording || !!files.length || !!reply || state.status !== "online"} onClick={() => setDelegation("ask")}><BotIcon size={18}/><span>{t("协作")}</span></button>}{!phone && current?.type === "group" && discussionComposer && <DiscussionParticipants key={`${connection.identity.hubPublicKey}:${selected}`} members={conversationBots.map(bot => ({ id: bot.id, name: labels.get(bot.id) ?? bot.name }))} selected={discussionMentionIds} change={ids => { discussionParticipants.change(ids); changeDraft(draft); }} locked={!!replyMode?.activeRun && !discussionNewTopic} disabled={!discussionParticipants.ready || sending || uploadProgress !== undefined}/>}{!phone && current?.type === "group" && !discussionComposer && <><button ref={recipientTrigger} type="button" className={`composer-recipients${recipients.length || defaultAllReplies || defaultDesignatedReply ? "" : " is-empty"}`} aria-label={t("让谁回复：{0}", recipientSummary)} title={t("回复的 Bot")} aria-expanded={menu === "recipients"} aria-controls={menu === "recipients" ? `${menuId}-recipients` : undefined} onClick={() => toggleMenu("recipients")}><AtSign size={14}/><span>{recipientSummary}</span><ChevronDown size={12}/></button>
        <DesktopMenu id={`${menuId}-recipients`} label={t("回复的 Bot")} open={menu === "recipients"} close={closeMenu} trigger={recipientTrigger} placement="up-start" className="recipient-menu"><p className="desktop-menu-heading"><span>{t("让谁回复")}</span></p>{recipientOptions.map(member => <button key={member.id} role="checkbox" aria-checked={recipients.includes(member.id)} aria-label={member.label} data-menu-keep="" onClick={() => setRecipients(old => old.includes(member.id) ? old.filter(id => id !== member.id) : [...old, member.id])}><span className="recipient-check" aria-hidden="true">{recipients.includes(member.id) && <Check size={13}/>}</span>{member.bot ? <Avatar kind="bot" id={member.botId} name={member.name} size={20}/> : <BotIcon size={20} aria-hidden="true"/>}<span className="desktop-menu-label" title={member.label}>{member.label}</span></button>)}{unavailableRecipients && <button type="button" onClick={() => setRecipients([])}>{t("清除回复选择")}</button>}</DesktopMenu></>}<span className="draft-save-status" hidden={recording || uploadProgress !== undefined || canStopActive} role={draft || draftSaving || draftSaveFailed || richDraftSaving || richDraftError || richDraftContent ? "status" : undefined} aria-label={t("草稿状态")} aria-live={draftSaveNeedsAttention ? "polite" : "off"}>{draftStatusText && <span className={!draftSaveNeedsAttention ? "screen-reader-only" : undefined}>{draftStatusText}</span>}</span><span className={`composer-hint${uploadProgress === undefined && !recording ? canStopActive ? " is-queue" : " is-tip" : ""}`}>{uploadProgress !== undefined ? uploadRecovering ? t("连接中断，等待恢复…") : t("上传 {0}%", Math.round(uploadProgress * 100)) : recording ? t("正在录音…") : current?.type === "group" && sending ? t("正在发送…") : discussionComposer ? discussionSendHint : (piOrOmpDirect || agyChoice) && composerQueues ? t("等待当前任务结束后再处理") : codexSupplement ? t("发送可补充当前任务") : continueCurrent ? nativeInput ? queueChosen ? t("等待当前任务结束后再处理") : t("发送后由 CLI 适时读入") : t("发送可补充当前任务") : nativeInput && (files.length || reply) ? t("附件和引用将在当前任务结束后处理") : canStopActive ? t("普通发送将排队") : macKeyboard ? t("Shift / ⌘ + Enter 换行") : t("Shift / Alt + Enter 换行")}</span>{!phone && canStopActive && <>{!!replying && steeringAvailable && !nativeInput && !continueCurrent && !showSendChoice && !(piOrOmpDirect && draft.trimStart().startsWith("/") && !(piDirect && isPiLiveCommand(draft, nativePiCommands))) && <button className="composer-steer" aria-label={t("引导当前任务")} title={t("补充到当前任务，不改变待执行顺序")} disabled={connection.isReadOnly || !richDraftReady || steeringBusy || uploadProgress !== undefined || recording} onClick={() => report(steer())}>{steeringBusy ? <LoaderCircle size={16} className="spin"/> : <Compass size={16}/>}<span>{t("引导")}</span></button>}<button className={`icon-button composer-stop${canStopActive ? " is-live" : ""}`} title={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} aria-label={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} disabled={discussionStopping} onClick={() => report(requestComposerStop())}><CircleStop size={19}/></button></>}{usageIndicators}{composerModelControls}{phoneStop ? <button key="stop" className="icon-button composer-stop is-live" title={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} aria-label={discussionComposer && composerDiscussionRun ? t("停止本次讨论") : t("停止当前轮次")} disabled={discussionStopping} onClick={() => report(requestComposerStop())}><CircleStop size={19}/></button> : <button aria-busy={groupSending || undefined} key="send" className={`send-button${discussionPaused ? " has-discussion-action" : ""}`} aria-label={pane ? t("发送到 {0} · {1}", pane.host.name, current?.title ?? selected) : t("发送消息")} title={groupSending ? t("正在发送…") : composerQueues ? t("等待当前任务结束后再处理") : discussionComposer ? discussionSendHint : codexSupplement ? t("补充到当前任务，不改变待执行顺序") : continueCurrent ? nativeInput ? nativeInput.sendNow ? t("普通发送，不打断当前任务；Ctrl+Enter 立即发送") : t("普通发送，不打断当前任务") : t("补充当前任务，不停止子代理") : canStopActive ? t("发送消息，任务执行中会排队") : t("发送消息")} disabled={connection.isReadOnly || history.sendBlocked || !richDraftReady || !replyReady || sending || steeringBusy || recording || discussionTransitioning || !discussionSendActionAllowed || (!draft.trim() && !files.length) || uploadProgress !== undefined} onClick={() => report(sendFromComposer())}>{discussionPaused && <span>{discussionSendHint}</span>}{groupSending ? <Hourglass size={18} aria-hidden="true"/> : composerQueues ? <ListOrdered size={18} aria-hidden="true"/> : preferences.palette === "cli" ? <CornerDownLeft size={18} aria-hidden="true"/> : <ArrowUp size={18} aria-hidden="true"/>}</button>}</div></div>}</div></div>}
  </main>
  {terminalEligible && <TerminalPanel connection={connection} conversationId={selected} hostName={hostName} visible={terminalVisible && sideWindowLayout !== "pending"} close={() => setRightMode("side")} onUnauthorized={() => setTerminalAccess({ connection, allowed: false })}/>}
  {screenOpened && <RemoteScreenPanel connection={connection} hostName={hostName} visible={screenVisible && (!!pane || sideWindowLayout !== "pending")} close={closeScreen} openSettings={() => { setSettingsFromMenu(false); setSettingsSection("screen"); setSettings(true); }}/> }
  {workbench.controller ? <Suspense fallback={workbenchLoading}><Workbench id={workbenchId} compact={!!pane && paneWorkbenchCompact} controller={workbench.controller} pluginRegistry={activePluginRegistry ?? undefined} visible={workbenchVisible && (phone || sideWindowLayout !== "pending")} phone={phone} onManageFiles={() => { setSettingsFromMenu(false); setSettingsSection("workbench"); setSettings(true); }} onOpenPlugins={() => setPluginsOpen(true)} onAnnotate={annotateWorkbench} onDesignCompose={composeDesign} onCompose={dispatchWidgetCompose} onRequestInstallPlugin={(pluginId) => { setPluginInstallId(pluginId); setPluginsOpen(true); }} onClose={() => { designOpener.revoke(); setRightMode("side"); workbenchTrigger.current?.focus({preventScroll:true}); }}/></Suspense> : !phone && !pane ? workbenchLoading : null}
  {filesEligible && selected && filesBotId && <WorkspaceFilesPanel id={filesId} connection={connection} conversationId={selected} botId={filesBotId} visible={filesVisible && (phone || sideWindowLayout !== "pending")} phone={phone} turnVersion={messages.length + connection.conversationRevision(selected)} onMentionFile={mentionWorkspaceFile} onClose={() => { setRightMode("side"); filesTrigger.current?.focus({ preventScroll: true }); }}/>}
  {activePluginRegistry && pluginSideVisible && activePluginRecord && activePluginPanel && <aside id={pluginSidePanelId} ref={pluginSidePanelRef} className="conversation-side-panel plugin-side-panel" hidden={sideWindowLayout === "pending"} aria-label={activePluginPanel.title}><SidePanelResize panel={pluginSidePanelRef} visible={pluginSideVisible && sideWindowLayout !== "pending"} controls={pluginSidePanelId} label={t("调整插件面板宽度")}/><header className="plugin-side-panel-header"><span className="plugin-side-panel-title"><Puzzle size={16}/><strong>{activePluginPanel.title}</strong></span><button type="button" className="icon-button" aria-label={t("关闭侧边面板")} onClick={() => { setRightMode("side"); setActivePluginPanel(undefined); }}><X size={16}/></button></header><div className="plugin-side-panel-body"><PluginSandboxFrame plugin={activePluginRecord} title={activePluginPanel.title} registry={activePluginRegistry} connection={connection} conversationId={selected}/></div></aside>}
  {activePluginRegistry && phone && !pane && visible && mobilePluginPanel && mobilePluginRecord?.enabled && <MobilePluginSheet plugin={mobilePluginRecord} title={mobilePluginPanel.title} registry={activePluginRegistry} connection={connection} conversationId={selected} close={() => setMobilePluginPanel(undefined)}/>}
  {pluginsOpen && <PluginsModal platform={phone ? "phone" : "desktop"} registry={activePluginRegistry} connection={connection} initialInstallId={pluginInstallId} close={() => { setPluginsOpen(false); setPluginInstallId(undefined); }} onOpenContribution={openPluginContribution}/>}
  {side.shown && sideEligible && <SideConversation key={side.scope} side={side} appearance={`${preferences.palette}:${preferences.fontSize}`} mainRecording={recording} recordingChanged={setSideRecording} online={state.status === "online" && !!activeBot?.online} visible={sideVisible && sideWindowLayout !== "pending"} trigger={sideTrigger} close={() => { void side.close(); }} returnToComposer={() => composer.current?.focus({ preventScroll: true })} insert={text => { changeDraft(`${draft}${draft ? "\n\n" : ""}${text.split("\n").map(line => `> ${line}`).join("\n")}`); composer.current?.focus({ preventScroll: true }); }}/>}
  {workspaceVisible && current && <ConversationWorkspace id={workspaceId} connection={connection} conversation={current} group={group} bots={state.bots} botLabels={labels} hostName={hostName} connectionSummary={connectionSummary} contextUsage={current.type === "direct" && current.botIds.length === 1 ? usage.context : undefined} quotaUsage={current.type === "direct" && current.botIds.length === 1 ? usage.quota : undefined} streamingBots={streamingBots} messages={messages} comms={workspaceComms.data} commsLoading={workspaceComms.loading} commsError={workspaceComms.error} onRefreshComms={() => { void workspaceComms.refresh(); }} returnFocus={workspaceRailTrigger} takeFocus={workspaceTakesFocus} onClose={closeWorkspace} onJumpConversation={(conversationId, messageId) => {
    // The rail can be a little behind: the other conversation may have been deleted or left since it was read.
    if (!conversations.some(item => item.id === conversationId)) { setError(t("协作对话已不存在，或当前不可访问。")); void workspaceComms.refresh(); return; }
    selectChat(conversationId); if (messageId) setFocusTarget({ conversationId, messageId });
    // The button that was pressed is gone with the old conversation's list: the keyboard continues in the
    // conversation that opened, as after any other move between conversations.
    requestAnimationFrame(() => requestAnimationFrame(() => conversationFocus()?.focus({ preventScroll: true })));
  }} onLocateMessage={(conversationId, messageId) => { setSelected(conversationId); setSidebar(false); closeSearch(); setFocusTarget({ conversationId, messageId }); }} onOpenAllFiles={() => setConversationFiles(current)} onOpenWorkbenchFile={target => { void openLocalLibraryFile(target).catch(reportWorkbenchOpenError); }} footerTools={desktopResourcesAvailable ? <ResourcesTriggerButton ref={resourcesTriggerRef} connection={connection} open={resourcesOpen} controlsId={resourcesDialogId} onOpen={() => { resourcesReturnFocus.current = resourcesTriggerRef.current; setResourcesOpen(true); }} /> : undefined} onOpenTasksModal={current.botIds.length === 1 && !current.archived && !group?.archived && state.engineTasksAvailable ? () => setTaskListRequest({ conversationId: selected, id: Date.now(), tab: "tasks" }) : undefined} onOpenSwarmBoard={current.botIds.length === 1 && !current.archived && !group?.archived && state.engineTasksAvailable ? () => setTaskListRequest({ conversationId: selected, id: Date.now(), tab: "board" }) : undefined}/>}
  {details && current && chatVisible && !searching && <ConversationDetails historySource={conversations.find(value => value.id === current.historyOrigin?.sourceConversationId)} openHistorySource={id => { setDetails(false); selectChat(id); }} key={`details:${current.id}`} suspended={manage || !!conversationFiles || fileCenter || capabilities || operations || resourcesOpen || settings} phone={phone} browseBot={phone ? browseBotConversations : undefined} returnFocus={detailTrigger} connection={connection} conversation={current} group={group} groupMembers={groupMembers} bots={state.bots} hostName={hostName} connectionSummary={connectionSummary} close={() => setDetails(false)} newChat={botId => { setDetails(false); setNewChat({ kind: "direct", botId }); }} open={(destination, botId) => { setDetailBot(botId); if (destination === "manage") setManage(true); else if (destination === "conversation-files") setConversationFiles(current); else if (destination === "files") setFileCenter(true); else if (destination === "capabilities") setCapabilities(true); else if (destination === "operations") { const bot = state.bots.find(value => value.id === botId); setOperationBot(bot ? { botId: bot.id, name: labels.get(bot.id) ?? bot.name, view: "dashboard" } : undefined); setOperations(true); } else { setSettingsSection("connection"); setSettings(true); } }}/>}
  {phone && !discussionComposer && menu === "recipients" && <CreationDialog title={t("回复的 Bot")} closeLabel={t("关闭回复选择")} close={closeMenu} returnFocus={recipientTrigger}><div className="mobile-chat-action-list">{recipientOptions.map(member => <button key={member.id} role="checkbox" aria-label={member.label} aria-checked={recipients.includes(member.id)} onClick={() => setRecipients(old => old.includes(member.id) ? old.filter(id => id !== member.id) : [...old, member.id])}><span className="recipient-check" aria-hidden="true">{recipients.includes(member.id) && <Check size={14}/>}</span>{member.bot ? <Avatar kind="bot" id={member.botId} name={member.name} size={26}/> : <BotIcon size={26} aria-hidden="true"/>}{member.bot && !member.source ? <BotName id={member.botId} name={member.name} bot={member.bot}/> : <span>{member.label}</span>}</button>)}{unavailableRecipients && <button type="button" onClick={() => setRecipients([])}>{t("清除回复选择")}</button>}</div><button className="primary full" onClick={closeMenu}>{t("完成")}</button></CreationDialog>}
  {attachments.input}{attachments.sheet}
  {delegation && current && <DelegationDialog key={current.id} connection={connection} bots={state.bots} members={current.botIds} initialBot={recipients.length === 1 && current.botIds.includes(recipients[0]!) ? recipients[0] : current.botIds[0]} initialMode={delegation} prompt={draft} changePrompt={changeDraft} close={() => setDelegation(undefined)} createBot={() => { setDelegation(undefined); setNewBot(true); }} send={async (text, botId, clientMsgId) => {
    const revision = draftRevision.current, sentDraft = draft;
    await connection.send({ v: 1, type: "message.send", conversationId: current.id, clientMsgId, text, attachments: [], mentions: wireRecipients([botId]) });
    // The wire command adds /ask, /fan, etc.; the saved draft contains only the prompt.
    if (draftRevision.current === revision) { setDraft(""); await clearSentDraft(current.id, sentDraft); }
    setRecipients([botId]);
  }}/>}
  {share.dialog}
  {visible && !phone && current && movingConversation === current.id && !current.parentId && !archivedHere && <MoveToFolder key={current.id} connection={connection} conversationId={current.id} showLayoutHint={preferences.sidebarLayout === "bots"} returnFocus={chatMoreTrigger} close={() => setMovingConversation(undefined)}/>}
  {renameTarget && visible && <RenameConversation key={renameTarget.id} connection={connection} conversation={renameTarget} returnFocus={conversationReturn} close={() => setRenameId(undefined)}/>}
  {removeTopicTarget && visible && <RemoveConversation key={removeTopicTarget.id} connection={connection} conversation={removeTopicTarget} returnFocus={conversationReturn} close={() => setRemoveTopicId(undefined)} removed={() => { setRemoveTopicId(undefined); if (currentSelection.current === removeTopicTarget.id) { setDetails(false); setManage(false); if (pane) pane.replace(removeTopicTarget.parentId!); else selectChat(removeTopicTarget.parentId!); } }}/>}
  {settingsTargets[0] && visible && <BotSettings key={settingsBotIds?.join("\0")} connection={connection} bot={settingsTargets[0]} name={settingsTargets[0].name} choices={settingsTargets} returnFocus={botSettingsReturn} close={() => setSettingsBotIds(undefined)}/>}
  {manage && current && <ConversationPanel initialBot={detailBot} key={current.id} returnFocus={conversationReturn} group={group} chooseRecipient={(botId) => setRecipients([botId])} externalError={connectionError} newChat={(botId) => { setDetails(false); setManage(false); setNewChat({ kind: "direct", botId }); }} connection={connection} conversation={current} pinned={pins.includes(current.id)} globallyPinned={globalPins.includes(current.id)} globalPin={value => connection.pinConversation(current.id, value, "global")} pin={value => connection.pinConversation(current.id, value)} close={() => setManage(false)}/>}
  {conversationFiles && <ConversationFiles connection={connection} conversation={conversationFiles} bots={state.bots} close={() => setConversationFiles(undefined)} locate={(conversationId, messageId) => { setConversationFiles(undefined); setDetails(false); setSelected(conversationId); setSidebar(false); closeSearch(); setFocusTarget({ conversationId, messageId }); }}/> }
  {fileCenter && <FileCenter connection={connection} bots={state.bots} close={() => setFileCenter(false)} locate={(conversationId, messageId) => { setDetails(false); setSelected(conversationId); setSidebar(false); closeSearch(); setFocusTarget({ conversationId, messageId }); }}/>}
  {capabilities && <CapabilitiesPanel connection={connection} bots={state.bots} initialBot={detailBot ?? activeBot?.id} close={() => setCapabilities(false)} help={(request) => { const bot = state.bots.find(value => value.id === request.botId); if (bot) setCapabilityHelp({ request, bot }); }}/> }
  {capabilityHelp && <CapabilityHelpDialog request={capabilityHelp.request} connection={connection} bot={capabilityHelp.bot} close={() => setCapabilityHelp(undefined)} created={(conversation, savedText) => {
    setConversations(old => [...old.filter(c => c.id !== conversation.id), conversation]);
    if (pane) pane.navigate(conversation.id, undefined, conversation.title); else setSelected(conversation.id);
    // First-chat discovery may select this conversation before the draft write
    // finishes. Selecting the same ID again does not rerun its loading effect.
    // Apply the persisted receipt and retire any earlier empty draft read.
    if (currentSelection.current === conversation.id) {
      draftRevision.current++; draftVersions.current.set(conversation.id, (draftVersions.current.get(conversation.id) ?? 0) + 1);
      setDraft(savedText);
    }
    setCapabilityHelp(undefined); setCapabilities(false); setSidebar(false); closeSearch(); setFocusTarget(undefined); if (!phone) pendingComposerFocus.current = conversation.id;
  }}/> }
  {operations && <OperationsPanel connection={connection} initialBot={operationBot} initialView={operationBot?.view} close={() => { setOperations(false); setOperationBot(undefined); }}/> }
  {resourcesOpen && !pane && (
    phone
      ? <MobileResourcesDialog hosts={resourceHosts} activeHostId={shell?.host.id ?? "local"} visible={visible} onClose={() => setResourcesOpen(false)}/>
      : <ResourcesManagerDialog id={resourcesDialogId} hosts={resourceHosts} activeHostId={shell?.host.id ?? "local"} visible={visible} onClose={() => setResourcesOpen(false)} returnFocus={resourcesReturnFocus}/>
  )}
  <MessageContextMenu historyActions={history.messageActions} opened={(message) => {
    history.inspect(message);
    readHistory(true);
    // Retire a pending follow-to-end target at the reader's current position.
    if (scroll.current) virtualizer.scrollToOffset(scroll.current.scrollTop);
    if (copiesReadableMessages()) prepareMessagePlainText(message.blocks);
  }} copyMessage={(message) => { if (copiesReadableMessages()) copyReadableMessage(message); else report(writeMessageSelection(blocksText(message.blocks))); }} root={scroll} scope={selected} enabled={visible && !phone && !!selected && searchResults === undefined && !deletion.active} deletionAvailable={!!state.messageDeletionAvailable} select={deletion.start} remove={(message, trigger) => deletion.ask([message.id], trigger)} messages={messages} quoteBlocked={groupSending || !!current?.archived || !!group?.archived} quote={(message) => { setReply(message); composer.current?.focus(); }} forward={(message, trigger) => { forwardTrigger.current = trigger; setForwarding(message); }} copy={(text, html) => report(writeMessageSelection(text, html))}/>
  {forwarding && <ForwardMessage message={forwarding} conversations={listedChats} connection={connection} returnFocus={forwardReturn} close={() => setForwarding(undefined)} sent={(id) => { setForwarding(undefined); setSelected(id); setFocusTarget(undefined); closeSearch(); setSidebar(false); followLatest.current = true; }}/>}
    {settings && settingsSection === "connection" && <ConnectionPanel connection={connection} openScreen={pane&&isMobileScreenApp()?undefined:openScreen} close={() => setSettings(false)} returnFocus={settingsFromMenu ? chatMoreTrigger : undefined}/>}
    {settings && settingsSection === "screen" && <ScreenControlPanel connection={connection} openScreen={pane&&isMobileScreenApp()?undefined:openScreen} close={() => setSettings(false)} returnFocus={settingsFromMenu ? chatMoreTrigger : undefined}/>}
    {settings && settingsSection !== "connection" && settingsSection !== "screen" && <PreferencesPanel returnFocus={settingsFromMenu ? chatMoreTrigger : undefined} openWorkbenchFile={openLocalLibraryFile} onOpenPluginContribution={openPluginContribution} initialSection={settingsSection === "pairing" ? "devices" : settingsSection} initialPairingStep={settingsSection === "pairing" ? 0 : undefined} connection={connection} manageNetwork={shell ? (beforeLeave, hostKey, options) => shell.manageHosts(beforeLeave, hostKey ?? connection.identity.hubPublicKey, options) : undefined} manageConnections={shell?.manageConnections} forget={async () => { if (shell) setSettings(false); await forget(); }} preferences={preferences} update={setPreferences} close={() => setSettings(false)}/>}
  {/* Keep active turn controls first in the phone menu, including with a draft.
      Idle fallbacks stay below conversation/place actions for runs the tail cannot see. */}
  {turnStop.dialog}
  <ConversationHistoryDialog history={history}/>
  {quotaDetails && <CreationDialog title={t("额度")} closeLabel={t("关闭额度")} returnFocus={chatMoreTrigger} close={() => setQuotaDetails(false)}>
    <div className="usage-sheet">{usage.quota ? <UsageDetails quota={usage.quota} serverTimeOffset={state.serverTimeOffset}/> : <p className="usage-note" role="status">{t("现在读不到额度")}</p>}</div>
  </CreationDialog>}
  {chatActions && <CreationDialog title={t("聊天操作")} closeLabel={t("关闭聊天操作")} returnFocus={chatMoreTrigger} close={() => setChatActions(false)}>
    {canStopActive && phoneTurnActions}
    <div className="mobile-chat-action-list">
      {directBotId && <button className="action-with-note" aria-label={t("查看此 Bot 的全部对话")} onClick={() => browseBotConversations(directBotId)}><MessageSquare size={20}/><span className="action-text"><span>{t("查看此 Bot 的全部对话")}</span><small>{directBotName}</small></span><ChevronRight className="action-chevron" size={18}/></button>}
      <button disabled={!canRename} onClick={() => { if (!canRename) return; setChatActions(false); setRenameId(current!.id); }}><Pencil size={20}/>{current?.parentId ? t("重命名话题") : t("重命名对话")}</button>
      {current?.parentId && !current.archived && <button className="text-danger" disabled={!canRename || group?.archived} onClick={() => { setChatActions(false); setRemoveTopicId(current.id); }}><Trash2 size={20}/>{t("删除话题")}</button>}
      <button disabled={!conversationBots.length} aria-label={t("Bot 设置")} className="action-with-note" onClick={() => { setChatActions(false); showBotSettings(conversationBots.map(bot => bot.id), chatMoreTrigger.current); }}><Settings size={20}/><span className="action-text"><span className="action-label">{t("Bot 设置")}</span><small className="action-note">{t("思考强度与审批权限")}</small></span></button>
      <button disabled={connection.isReadOnly || !richDraftReady || uploadProgress !== undefined || recording || !!files.length || !!reply || state.status !== "online"} onClick={() => { setChatActions(false); setDelegation("ask"); }}><BotIcon size={20}/>{t("发起 Bot 协作")}</button>
      <button onClick={() => { setChatActions(false); setConversationFiles(current); }} disabled={!current}><FolderOpen size={20}/>{t("文件")}</button>
      <button onClick={() => { setChatActions(false); setDetails(true); }}><Settings size={20}/>{t("对话详情")}</button>
      <HistoryForkMenu phone action={history.fork && { ...history.fork, run: origin => { setChatActions(false); history.fork!.run(origin); } }}/>
      <button onClick={() => { setChatActions(false); setNewChat({ kind: "direct", ...(activeBot ? { botId: activeBot.id } : {}) }); }}><Plus size={20}/>{t("新对话")}</button>
    </div>
    <div className="mobile-chat-action-list">
      {filesEligible && <button onClick={() => { setChatActions(false); openFiles(); }}><FolderTree size={20}/><span className="action-label">{t("工作区文件")}</span><ChevronRight className="action-chevron" size={18}/></button>}
      {!pane&&isMobileScreenApp()&&<button onClick={()=>{setChatActions(false);openScreen();}}><MonitorPlay size={20}/><span className="action-label">{t("查看屏幕")}</span><ChevronRight className="action-chevron" size={18}/></button>}
      {!pane&&isMobileScreenApp()&&<button onClick={()=>{setChatActions(false);setSettingsFromMenu(true);setSettingsSection("screen");setSettings(true);}}><MonitorCog size={20}/><span className="action-label">{t("屏幕控制设置")}</span><ChevronRight className="action-chevron" size={18}/></button>}
      {phone && usage.quota && <button aria-label={t("额度")} aria-describedby={`${chatActionNote}-quota`} onClick={openQuotaDetails}><QuotaBattery left={usage.quota.left} stale={usage.quota.stale}/><span className="action-label">{t("额度")}</span><span id={`${chatActionNote}-quota`} className="action-value" data-tone={usage.quota.stale ? undefined : usageTone(usage.quota.left)} data-stale={usage.quota.stale ? "true" : undefined}>{usage.quota.left}%</span><ChevronRight className="action-chevron" size={18}/></button>}
      <button aria-label={t("打开连接设置")} aria-describedby={`${chatActionNote}-connection`} onClick={() => { setChatActions(false); setSettingsFromMenu(true); setSettingsSection("connection"); setSettings(true); }}>{state.status === "online" ? <Wifi size={20}/> : <WifiOff size={20}/>}<span className="action-label">{t("连接状态与线路")}</span><span id={`${chatActionNote}-connection`} className="action-value">{connectionSummary}</span><ChevronRight className="action-chevron" size={18}/></button>
      <button onClick={() => { setChatActions(false); setArchives(true); }}><Archive size={20}/><span className="action-label">{t("已归档对话")}</span>{archivedChats.length > 0 && <span className="action-value">{archivedChats.length}</span>}<ChevronRight className="action-chevron" size={18}/></button>
    </div>
    {!canStopActive && phoneTurnActions}
  </CreationDialog>}
  {deletion.dialog}
  {sheetTarget && <MessageActionSheet connection={connection} message={sheetMessage} meta={sheetMessage ? `${authorName(sheetMessage)} · ${formatMessageTime(sheetMessage.createdAt, locale)}` : ""} quoteBlocked={groupSending || !!current?.archived || !!group?.archived} canRetry={!!sheetMessage && canRetry(sheetMessage)} retryBlocked={retryBlocked} returnFocus={sheetReturn} close={closeSheet} actions={sheetActions}/>}
  {archives && <ArchivedConversations connection={connection} conversations={listedChats} close={() => setArchives(false)} open={id => { setSelected(id); setSidebar(false); setArchives(false); }}/>}
  {newBot && <NewBot hostName={shell?.host.name} localHost={(shell?.localHost ?? pane?.localHost)} setup={(bot, features) => { setNewBot(false); setCapabilityHelp({ bot, request: { botId: bot.id, kind: "integrations", features } }); }} connection={connection} close={() => setNewBot(false)} chat={(bot) => { setNewBot(false); report(connection.createConversation({ v: 1, type: "conversation.create", conversationType: "direct", botIds: [bot.id], title: t("与 {0} 的新对话", bot.name), clientActionId: `first_${bot.id}` }).then((conversation) => { if (pane) pane.navigate(conversation.id, undefined, conversation.title); else setSelected(conversation.id); setSidebar(false); closeSearch(); if (!phone) pendingComposerFocus.current = conversation.id; })); }}/>}
  {scheduledTasks && visible && <ScheduledTasks connection={connection} bots={state.bots} conversations={listedChats} initialBot={activeBot?.id} startCreating={scheduledTasks === "create"} close={() => setScheduledTasks(undefined)} newBot={() => { setScheduledTasks(undefined); if (shell) shell.create("bot"); else setNewBot(true); }} openConversation={id => { setScheduledTasks(undefined); selectChat(id); }}/> }
  {newChat && <NewConversation hostName={shell?.host.name} connection={connection} bots={state.bots} request={newChat} close={() => setNewChat(undefined)} newBot={() => { setNewChat(undefined); if (shell) shell.create("bot"); else setNewBot(true); }} created={(conversation) => { setConversations((old) => [...old.filter((c) => c.id !== conversation.id), conversation]); if (pane) pane.navigate(conversation.id, undefined, conversation.title); else setSelected(conversation.id); setNewChat(undefined); setSidebar(false); closeSearch(); setFocusTarget(undefined); if (!phone) pendingComposerFocus.current = conversation.id; }}/>}
  </div></BotReferences></AvatarProvider></RuntimeHostContext.Provider></RuntimeHostActiveContext.Provider></DesktopMenuPortalContext.Provider></NativeInputContext.Provider></WorkbenchEntryContext.Provider>;
}

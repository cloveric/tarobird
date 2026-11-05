// Transport boundary DTOs. No runtime SDK dependency.
export type ChatType = "p2p" | "group";
export type RejectReason = string;
export interface NormalizedMessage {
    reviewAdmission?: "native";
    nativeInput?: import("../client-protocol/native-input.js").NativeInputObserver;
    botSource?: import("../client-protocol/bot-messages.js").BotSource;
    /** Hub-owned Agent Bus run marker; never derived from message text. */
    agentBus?: import("../client-protocol/agent-bus.js").AgentBusDispatch;
    /** Hub-owned group discussion turn; never derived from message text. */
    groupDiscussion?: import("../client-protocol/group-discussion.js").GroupDiscussionDispatch;
    /** Hub-owned dispatcher ticket model/effort for this conversation's engine turns. */
    engineOverride?: import("../state/instance-config.js").EngineOverride;
    /** Hub-owned dispatcher ticket directory for this conversation's turns. */
    workspaceOverride?: string;
    messageId: string;
    chatId: string;
    chatType: ChatType;
    senderId: string;
    senderName?: string;
    content: string;
    /** Current human-authored text only; never attachment names or forwarded/Bot content. */
    asrRoutingText?: string;
    rawContentType: string;
    resources: ResourceDescriptor[];
    mentions: MentionInfo[];
    mentionAll: boolean;
    mentionedBot: boolean;
    rootId?: string;
    threadId?: string;
    replyToMessageId?: string;
    createTime: number;
    raw?: unknown;
}
export interface ResourceDescriptor {
    type: 'image' | 'file' | 'audio' | 'video' | 'sticker';
    fileKey: string;
    fileName?: string;
    durationMs?: number;
    coverImageKey?: string;
}
export interface MentionInfo {
    key: string;
    openId?: string;
    userId?: string;
    name?: string;
    isBot?: boolean;
}
export interface RejectEvent {
    messageId: string;
    chatId: string;
    senderId: string;
    reason: RejectReason;
}
export interface CardActionEvent {
    messageId: string;
    chatId: string;
    operator: {
        openId: string;
        userId?: string;
        name?: string;
    };
    action: {
        value: unknown;
        tag: string;
        name?: string;
        option?: string;
    };
    raw?: unknown;
}
export interface CommentEvent {
    fileToken: string;
    fileType: string;
    commentId: string;
    replyId?: string;
    operator: {
        openId: string;
        userId?: string;
        unionId?: string;
    };
    mentionedBot: boolean;
    timestamp: number;
    raw?: unknown;
}

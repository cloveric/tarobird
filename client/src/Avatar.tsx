import { BotName } from "./BotName.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Bot, Camera, MessageSquare, UserRound, Users } from "lucide-react";
import { avatarKey, type AvatarTarget } from "../../src/client-protocol/avatars.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import { HubConnection, type ConnectionState } from "./connection.js";
import { t } from "./i18n.js";
import { defaultBotAvatar, type BotAvatar } from "./bot-avatar-catalog.js";
import { botAvatarImage } from "./bot-avatar-images.js";
import { AgentAvatarContext, AgentFace, RoleStar, RoleStarSuppressed } from "./AgentAvatar.js";
import { isDispatcher } from "./dispatcher.js";
import { useAvatarFace } from "./avatar-face.js";

export const Profiles = createContext<{ connection: HubConnection; state: ConnectionState; conversations: readonly Conversation[]; defaults: ReadonlyMap<string, string | undefined>; dispatchers: ReadonlySet<string> } | null>(null);
export function AvatarProvider({ connection, conversations, directory, children }: { connection: HubConnection; conversations: readonly Conversation[]; directory?: readonly { id: string; defaultAvatar?: string; role?: string }[]; children: ReactNode }) {
  const subscribe = useCallback((notify: () => void) => connection.subscribe(notify), [connection]);
  const state = useSyncExternalStore(subscribe, () => connection.state);
  // Avatar consumers read only these fields (unchanged fields keep identity in
  // connection.update). Other updates, such as stream events, must not
  // re-render every avatar below this provider, including frozen hidden lists.
  const { avatars, bots, deletedBots, status, user, conversationAvatarsAvailable } = state;
  const defaults = useMemo(() => new Map((directory ?? [...bots, ...(deletedBots ?? [])]).map(bot => [bot.id, bot.defaultAvatar])), [directory, bots, deletedBots]);
  // Cached directories carry the role too, so an offline cold start keeps the star.
  const dispatchers = useMemo(() => new Set([...(directory ?? []), ...bots, ...(deletedBots ?? [])].filter(isDispatcher).map(bot => bot.id)), [directory, bots, deletedBots]);
  const value = useMemo(() => ({ connection, state, conversations, defaults, dispatchers }), [connection, conversations, avatars, bots, status, user, conversationAvatarsAvailable, defaults, dispatchers]);
  return <Profiles.Provider value={value}>{children}</Profiles.Provider>;
}
/** One decoded object URL per picture revision, shared by every visible
 * instance (message rows, lists, headers). Released URLs linger briefly so
 * virtualized rows that remount while scrolling reuse the same image. */
type SharedAvatarUrl = { refs: number; url: Promise<string>; resolved?: string; timer?: ReturnType<typeof setTimeout> };
const avatarUrls = new Map<string, SharedAvatarUrl>();
export const AVATAR_URL_LINGER_MS = 30_000;
export function acquireAvatarUrl(key: string, load: () => Promise<Blob>): SharedAvatarUrl {
  let entry = avatarUrls.get(key);
  if (!entry) {
    const created: SharedAvatarUrl = { refs: 0, url: Promise.resolve("") };
    created.url = load().then((blob) => {
      const url = created.resolved = URL.createObjectURL(blob);
      // Every user left (and the linger expired) before the bytes arrived.
      if (avatarUrls.get(key) !== created) URL.revokeObjectURL(url);
      return url;
    });
    // A failed load is not cached; a later mount or reconnect retries it.
    created.url.catch(() => { if (avatarUrls.get(key) === created) avatarUrls.delete(key); });
    avatarUrls.set(key, created); entry = created;
  }
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
  entry.refs++;
  return entry;
}
export function releaseAvatarUrl(key: string, entry: SharedAvatarUrl): void {
  if (--entry.refs > 0) return;
  entry.timer = setTimeout(() => {
    if (entry.refs > 0) return;
    if (avatarUrls.get(key) === entry) avatarUrls.delete(key);
    if (entry.resolved) URL.revokeObjectURL(entry.resolved);
  }, AVATAR_URL_LINGER_MS);
}
export function Avatar({ kind, id, name, size = 32, fallback, appearance }: AvatarTarget & { name: string; size?: number; fallback?: ReactNode; appearance?: "conversation" }) {
  const context = useContext(Profiles), [loaded, setLoaded] = useState<{ key: string; url: string }>();
  const avatar = context?.state.avatars.find((a) => a.kind === kind && a.id === id);
  const key = avatar?.hasImage ? `${context?.connection.identity.hubPublicKey}:${avatarKey(avatar)}:${avatar.revision}` : "";
  // A loaded picture is kept across reconnects; only a missing one retries
  // when the connection status changes.
  const retry = loaded?.key === key ? "" : context?.state.status;
  useEffect(() => {
    if (!context || !avatar?.hasImage || !key) return;
    let alive = true;
    const entry = acquireAvatarUrl(key, () => context.connection.avatarBlob(avatar));
    void entry.url.then((url) => { if (alive) setLoaded({ key, url }); }).catch(() => undefined);
    return () => { alive = false; releaseAvatarUrl(key, entry); };
  }, [context?.connection, key, retry]);
  const Icon = kind === "user" ? UserRound : kind === "group" ? Users : Bot;
  // Custom pictures win, including while loading. Default mascots use the
  // Host-persisted choice, with the legacy Bot-ID fallback for older Hosts/Bots.
  const preset = kind === "bot" && !fallback && !avatar?.hasImage ? defaultBotAvatar(id, context?.defaults.get(id)) : undefined;
  // Derive from this host's live/cached membership, never a saved collage.
  // Individual Avatars retain authenticated custom pictures and revision updates.
  const memberIds = kind === "group" && !avatar?.hasImage && !fallback
    ? [...new Set(context?.conversations.find(c => c.id === id)?.botIds ?? [])].slice(0, 9) : [];
  const tone = kind === "group" && !avatar?.hasImage && !memberIds.length ? hue(id) : undefined;
  // A list row in a non-idle state redraws the picture's eyes when it has any.
  const agent = useContext(AgentAvatarContext);
  const face = useAvatarFace(agent ? key && loaded?.key === key ? loaded.url : preset ? botAvatarImage(preset).url : undefined : undefined);
  // Dispatcher Bots (and a dispatcher's own conversation picture) carry a static
  // star; list rows and group collages draw or suppress it outside this box.
  const starBot = kind === "bot" ? id : appearance === "conversation" ? context?.conversations.find(c => c.id === id)?.botIds[0] : undefined;
  const suppressed = useContext(RoleStarSuppressed), star = !suppressed && !!starBot && !!context?.dispatchers.has(starBot);
  return <span className={`profile-avatar profile-avatar-${kind}${appearance === "conversation" ? " profile-avatar-conversation" : ""}${memberIds.length ? " profile-avatar-composite" : ""}${face ? " has-agent-face" : ""}`} style={{ width: size, height: size }} data-avatar={`${kind}:${id}`} data-preset={preset?.id} data-hue={tone} data-composite={memberIds.length || undefined} data-role={star ? "dispatcher" : undefined} role={memberIds.length ? "img" : undefined} aria-label={memberIds.length ? t("{0}的头像", name) : undefined}>
    <RoleStarSuppressed.Provider value={star || suppressed}>{key && loaded?.key === key ? <img src={loaded.url} alt={t("{0}的头像", name)} draggable={false}/> : preset ? <BotPortrait avatar={preset} alt={t("{0}的头像", name)}/> : memberIds.length ? <GroupPortrait size={size} members={memberIds.map(id => ({ id, name: context?.state.bots.find(bot => bot.id === id)?.name ?? id }))}/> : fallback ?? <Icon size={Math.round(size * .56)} aria-hidden="true"/>}</RoleStarSuppressed.Provider>
    {face && <AgentFace face={face}/>}
    {star && <RoleStar/>}
  </span>;
}
/** Conversation identity is distinct from the authors inside its messages. */
export function ConversationAvatar({ conversation, size = 32 }: { conversation: Conversation; size?: number }) {
  const context = useContext(Profiles);
  const root = conversation.parentId ? context?.conversations.find(c => c.id === conversation.parentId) : conversation;
  const id = root?.id ?? conversation.parentId ?? conversation.id;
  if (conversation.parentId || root?.type === "group") {
    return <Avatar kind="group" id={id} name={root?.title ?? conversation.title} size={size}/>;
  }
  const botId = conversation.botIds[0], bot = context?.state.bots.find(b => b.id === botId);
  const inherited = <Avatar kind="bot" id={botId ?? conversation.id} name={bot?.name ?? conversation.title} size={size} fallback={!botId ? <MessageSquare size={Math.round(size * .56)}/> : undefined}/>;
  return context?.state.avatars.some(a => a.kind === "group" && a.id === id && a.hasImage)
    ? <Avatar kind="group" id={id} name={conversation.title} size={size} appearance="conversation" fallback={inherited}/>
    : inherited;
}
export function canEditConversationAvatar(state: Pick<ConnectionState, "status" | "user" | "conversationAvatarsAvailable">, conversation: Conversation): boolean {
  return state.status === "online" && !conversation.parentId && !conversation.archived &&
    (conversation.type === "group" ? state.user?.role === "owner" || state.user?.id === conversation.ownerId : !!state.conversationAvatarsAvailable && state.user?.id === conversation.ownerId);
}
function GroupPortrait({ members, size }: { members: { id: string; name: string }[]; size: number }) {
  const columns = members.length === 1 ? 1 : members.length <= 4 ? 2 : 3;
  const padding = Math.max(2, Math.round(size * .06)), gap = Math.max(1, Math.round(size * .025));
  const edge = (size - padding * 2 - gap * (columns - 1)) / columns;
  return <span className="group-avatar-members" aria-hidden="true" style={{ padding, gap }}>
    <AgentAvatarContext.Provider value={undefined}><RoleStarSuppressed.Provider value={true}>{members.map(member => <Avatar key={member.id} kind="bot" id={member.id} name={member.name} size={edge}/>)}</RoleStarSuppressed.Provider></AgentAvatarContext.Provider>
  </span>;
}
export function BotPortrait({ avatar, alt }: { avatar: BotAvatar; alt: string }) {
  const source = botAvatarImage(avatar);
  return <span className="bot-portrait"><img src={source.url} alt={alt} draggable={false} loading="lazy" style={{ width: `${source.width / source.edge * 100}%`, height: `${source.height / source.edge * 100}%`, transform: `translate(${-source.x / source.width * 100}%, ${-source.y / source.height * 100}%)` }}/></span>;
}
/** FNV-1a over the id, folded onto the eight hues in brand-theme.css. */
function hue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 8;
}
export function PersonalAvatarEditor() {
  const context = useContext(Profiles), user = context?.state.user;
  return user ? <AvatarEditor kind="user" id={user.id} name={t("我")} label={t("个人头像")}/> : null;
}
export function AvatarEditor({ kind, id, name, label, ownerId, conversation }: AvatarTarget & { name: string; label: string; ownerId?: string; conversation?: Conversation }) {
  const context = useContext(Profiles), [open, setOpen] = useState(false), [saved, setSaved] = useState(false);
  const [Editor, setEditor] = useState<typeof import("./AvatarEditorDialog.js").default>();
  const [loadFailed, setLoadFailed] = useState(false);
  // Loading disables the trigger and can blur it before the dialog mounts.
  // Keep an explicit return target for cancel, save and native Back.
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || Editor) return;
    let active = true;
    // A missing optional chunk must never unmount the chat or its unsent draft.
    void import("./AvatarEditorDialog.js").then(module => { if (active) setEditor(() => module.default); }, () => {
      if (active) { setLoadFailed(true); setOpen(false); }
    });
    return () => { active = false; };
  }, [open, Editor]);
  const user = context?.state.user;
  const allowed = conversation ? user?.id === conversation.ownerId : kind === "user" ? user?.id === id : kind === "bot" ? user?.role === "owner" : user?.role === "owner" || user?.id === ownerId;
  return <div className="avatar-setting">{conversation ? <ConversationAvatar conversation={conversation} size={48}/> : <Avatar kind={kind} id={id} name={name} size={48}/>}<div><strong>{label}</strong><small>{kind === "bot" ? <BotName id={id} name={name} bot={context?.state.bots.find(bot => bot.id === id)}/> : name}</small>{saved && <small role="status">{t("头像已更新")}</small>}</div>
    {allowed && <button ref={trigger} disabled={context?.state.status !== "online" || !!conversation && !canEditConversationAvatar(context.state, conversation) || open && !Editor} title={conversation && !context?.state.conversationAvatarsAvailable ? t("升级此主机后即可设置对话头像") : undefined} aria-label={t("设置{0}", label)} onClick={() => { setSaved(false); setLoadFailed(false); setOpen(true); }}><Camera size={16}/>{open && !Editor ? t("正在加载…") : t("设置头像")}</button>}
    {conversation?.type === "direct" && context?.state.status === "online" && !context.state.conversationAvatarsAvailable && <p className="muted">{t("升级此主机后即可设置对话头像")}</p>}
    {loadFailed && <p className="error-text" role="alert">{t("头像编辑暂不可用，请稍后重试。聊天和草稿已保留。")}</p>}
    {open && context && Editor && <Editor key={`${kind}:${id}`} target={{ kind, id }} name={name} label={label} conversation={conversation} returnFocus={trigger} close={() => setOpen(false)} saved={() => { setSaved(true); setOpen(false); }}/>}</div>;
}

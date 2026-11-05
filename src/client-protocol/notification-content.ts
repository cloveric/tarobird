import { AGENT_BUS_STAGE_EXTRA, agentBusStageRecordSchema } from "./agent-bus.js";
import { backgroundTaskNotice, backgroundTaskStatus } from "./background-task.js";
import { queueNotice } from "./queue-notice.js";
import { isRunActive, anyRun, nativeRun } from "./run.js";
import type { CardElement, Message } from "./index.js";
import type { NotificationTopic, PushPayload } from "./push.js";

/** Shared by Hub push admission and desktop notifications. Pure: no Node or DOM. */
export type NotificationGeneric = "reply" | "files" | "update" | "action" | "error" | "message";
export type NotificationClass = { kind: PushPayload["kind"]; incomplete: boolean; uncertainBackground: boolean; generic: NotificationGeneric; topics: NotificationTopic[] };
export type NotificationLocale = "zh" | "en";

const MAX_BODY = 200;
/** UTF-16 bounds match the existing wire schema without splitting an emoji. */
function clip(value: string, length: number): string {
  if (value.length <= length) return value;
  let head = value.slice(0, length - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head.trimEnd() + "…";
}
function markup(value: string, image: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, image)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Only presentation tags: broad <...> removal corrupts comparisons and
    // generic types such as Map<String, String> in technical replies.
    .replace(/<\/?(?:br|p|div|span|strong|b|em|i|del|s|code|pre|h[1-6]|ul|ol|li|blockquote)(?:\s[^<>]*?)?\s*\/?>/gi, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s*)?)/gm, "")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_match, bold, underline) => bold ?? underline)
    // Emphasis delimiters must flank non-space content. Globs and arithmetic
    // such as *.ts / *.tsx and 2 * 3 * 4 are literal technical text.
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])|~~(?=\S)([^~\n]*?\S)~~/g, (_match, star, underscore, strike) => star ?? underscore ?? strike)
    .replace(/^[\t ]*\|(.+)\|[\t ]*$/gm, (_match, row: string) => {
      const cells = row.split("|").map(cell => cell.trim());
      return cells.every(cell => /^:?-{3,}:?$/.test(cell)) ? "" : cells.join(" · ");
    });
}
function plain(value: string, copy: Copy = COPY.zh): string {
  const text = value.slice(0, 8192)
    .replace(/<oai-mem-citation>[\s\S]*?(?:<\/oai-mem-citation>|$)/g, "")
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, copy.code);
  // Protect code while still recognizing surrounding links/emphasis/tables.
  // Choose a prefix absent from the bounded input so authored text cannot be
  // mistaken for an internal placeholder (including inside another code span).
  let marker = "\uE000";
  while (text.includes(marker)) marker += "\uE000";
  const spans: string[] = [];
  const encoded = text.replace(/(?<!`)(`+)([\s\S]*?)\1(?!`)/g, (_match, _ticks, code: string) => {
    spans.push(code); return `${marker}${spans.length - 1}\uE001`;
  });
  return markup(encoded, copy.image).replace(new RegExp(`${marker}(\\d+)\uE001`, "g"), (_match, index: string) => spans[Number(index)]!)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
}
const statusOnly = /^(?:已完成|部分完成|执行失败|已被中断|已中断|已停止|无响应已自动终止|交付未完成|Done|Completed|Partially completed|Failed|Interrupted|Stopped|Auto-stopped \(no response\)|Delivery incomplete)$/i;

type Copy = {
  image: string; code: string; untitled: string; open: (name: string, bot: string) => string;
  files: (names: string, count: number) => string; images: (count: number) => string; audio: (count: number) => string;
  unconfirmed: string; unconfirmedEmpty: string; incomplete: string; incompleteEmpty: string; failedEmpty: string;
  action: string; actionEmpty: string; update: string; updateEmpty: string; received: (artifacts: string) => string;
  reply: string; replyEmpty: string; generic: Record<NotificationGeneric, string>;
};
// Hub output stays Chinese: installed Android clients recognize these exact
// prefixes and generic sentences. English is used only for local desktop text.
const COPY: Record<NotificationLocale, Copy> = {
  zh: {
    image: "[图片]", code: "[代码]", untitled: "未命名对话", open: (name, bot) => `「${name}」${bot ? ` · ${bot}` : ""}`,
    files: (names, count) => `文件：${names}${count > 2 ? ` 等 ${count} 个` : ""}`, images: count => `${count} 张图片`, audio: count => `${count} 条音频`,
    unconfirmed: "交付未确认：", unconfirmedEmpty: "请打开对话核对文件和回报。", incomplete: "任务未完成：", incompleteEmpty: "点按查看当前进展。", failedEmpty: "任务遇到错误，点按查看。",
    action: "待处理：", actionEmpty: "有一项操作等待你确认。", update: "后台任务更新：", updateEmpty: "最终状态未确认，点按查看进展。", received: artifacts => `收到${artifacts}`,
    reply: "回复完成：", replyEmpty: "点按查看回复。",
    generic: { reply: "Bot 已完成回复，点按查看。", files: "Bot 发来了文件，点按查看。", update: "后台任务有更新，点按查看。", action: "有一项操作等待你确认。", error: "任务未完成，点按查看当前进展。", message: "收到新消息，打开 TaroBird 查看。" },
  },
  en: {
    image: "[Image]", code: "[Code]", untitled: "Untitled conversation", open: (name, bot) => `“${name}”${bot ? ` · ${bot}` : ""}`,
    files: (names, count) => `File: ${names}${count > 2 ? ` and ${count - 2} more` : ""}`, images: count => count === 1 ? "1 image" : `${count} images`, audio: count => count === 1 ? "1 audio clip" : `${count} audio clips`,
    unconfirmed: "Delivery unconfirmed: ", unconfirmedEmpty: "Open the conversation to check files and reports.", incomplete: "Task incomplete: ", incompleteEmpty: "Tap to see the current progress.", failedEmpty: "The task hit an error. Tap to view.",
    action: "Needs attention: ", actionEmpty: "An action is waiting for your confirmation.", update: "Background task update: ", updateEmpty: "Final status unconfirmed. Tap to see progress.", received: artifacts => `Received ${artifacts}`,
    reply: "Reply complete: ", replyEmpty: "Tap to view the reply.",
    generic: { reply: "A Bot finished replying. Tap to view.", files: "A Bot sent files. Tap to view.", update: "A background task was updated. Tap to view.", action: "An action is waiting for your confirmation.", error: "A task is incomplete. Tap to see the current progress.", message: "New message. Open TaroBird to view." },
  },
};

type Digest = { summary: string; files: string[]; images: number; audio: number };
/** Only user-facing answer elements: no run journal, thinking, tool output,
 * action values or collapsed process panels, even when a panel is expanded. */
function digest(message: Message, copy: Copy): Digest {
  const parts: string[] = [], files: string[] = [];
  let visited = 0, remaining = 1024, images = 0, audio = 0;
  const append = (value?: string) => {
    if (!value || remaining <= 0) return;
    const text = plain(value, copy);
    if (!text || statusOnly.test(text)) return;
    const next = clip(text, remaining); parts.push(next); remaining -= next.length;
  };
  const walk = (elements: CardElement[], depth = 0) => {
    for (const element of elements) {
      if (++visited > 256 || depth > 8) return;
      if (element.type === "collapsible" || element.id === "run_goal_banner" || element.id === "run_background_note") continue;
      if (element.type === "image") { images++; continue; }
      if (element.type === "markdown") append(element.text);
      if (element.type === "columns" || element.type === "column" || element.type === "form") walk(element.children ?? [], depth + 1);
    }
  };
  for (const block of message.blocks) {
    if (++visited > 256) break;
    if (block.type === "text") append(block.text);
    else if (block.type === "card" && !block.extra?.promptQueue) {
      // The structured notice owns this header/context; neither is answer text.
      const elements = backgroundTaskNotice(block) && block.elements.some(element => element.id === "background_context")
        ? block.elements.filter((element, index) => element.id !== "background_context" && (index !== 0 || !["done", "unknown", "running"].includes(backgroundTaskStatus(block) ?? ""))) : block.elements;
      walk(elements);
    }
    else if (block.type === "file") files.push(plain(block.name, copy));
    else if (block.type === "image") images++;
    else if (block.type === "audio") audio++;
  }
  return { summary: parts.join(" "), files, images, audio };
}

/** Decide whether a terminal Bot message is a notification and which device
 * preferences govern it. Attention (approval, failure, unconfirmed delivery or
 * an incomplete run) takes precedence and is governed only by needsAttention.
 * Other notices belong to replyCompleted when they carry answer text (or have
 * neither text nor artifacts) and to filesReceived when they carry files,
 * images or audio; either enabled topic admits a mixed reply-with-files. */
export function classifyNotification(message: Message): NotificationClass | undefined {
  if (message.authorType !== "bot" || !["complete", "error"].includes(message.status)) return;
  // Queue bookkeeping is neither an answer nor a request requiring attention.
  // The actual run or delivery failure publishes its own notification.
  if (message.blocks.some(block => block.type === "card" && queueNotice(block, message))) return;
  // A stopped independent Bus record is not a completed answer. Keep its
  // terminal message lifecycle for unread tracking; suppress only its notice.
  // Native foreground evidence takes precedence over any record metadata.
  if (!message.blocks.some(block => block.type === "card" && nativeRun(block)) && message.blocks.some(block => {
    if (block.type !== "card") return false;
    const stage = agentBusStageRecordSchema.safeParse(block.extra?.[AGENT_BUS_STAGE_EXTRA]);
    return stage.success && stage.data.status === "cancelled";
  })) return;
  const runs = message.blocks.flatMap(block => block.type === "card" ? anyRun(block) ?? [] : []);
  // Older Gateways can mark the envelope complete while artifacts are still
  // being delivered. Wait for the native run's actual terminal update.
  if (runs.some(run => isRunActive(run.phase))) return;
  // A terminal message envelope can contain an interrupted or partial run.
  // Never announce success based only on that envelope's status.
  // A scoped partial receipt means the engine did not confirm a final state;
  // routine monitor updates use it too. Preserve foreground delivery failures.
  const backgroundFailure = message.blocks.some(block => block.type === "card" && (backgroundTaskNotice(block)?.delivery === "unconfirmed" || ["error", "stopped"].includes(backgroundTaskStatus(block) ?? "")));
  const uncertainBackground = message.blocks.some(block => block.type === "card" && !nativeRun(block) && anyRun(block)?.phase === "partial") || message.blocks.some(block => block.type === "card" && ["unknown", "running"].includes(backgroundTaskStatus(block) ?? ""));
  const incomplete = runs.some(run => ["error", "interrupted", "stopped"].includes(run.phase))
    || message.blocks.some(block => block.type === "card" && nativeRun(block)?.phase === "partial");
  const hasAction = (elements: CardElement[]): boolean => elements.some((e) => !!e.actionId && !e.disabled || hasAction(e.children ?? []));
  const kind: PushPayload["kind"] = message.status === "error" || incomplete || backgroundFailure ? "error" : message.blocks.some((b) => b.type === "card" && hasAction(b.elements)) ? "action" : "answer";
  if (kind !== "answer") return { kind, incomplete, uncertainBackground, generic: kind, topics: ["needsAttention"] };
  const { summary, files, images, audio } = digest(message, COPY.zh);
  const artifacts = files.length + images + audio > 0;
  const topics: NotificationTopic[] = [...(!artifacts || summary ? ["replyCompleted" as const] : []), ...(artifacts ? ["filesReceived" as const] : [])];
  return { kind, incomplete, uncertainBackground, topics, generic: uncertainBackground ? "update" : artifacts && !summary ? "files" : "reply" };
}

/** Content-free text for a device that hides previews: no conversation, Bot,
 * file name or excerpt. The Chinese sentences are recognized by installed APKs. */
export function genericNotificationBody(generic: NotificationGeneric, locale: NotificationLocale = "zh"): string {
  return COPY[locale].generic[generic];
}

/** A compact class stored with a queued push, so the worker can re-check the
 * device's current preferences before sending without re-reading the message. */
export function encodeNotificationClass(value: Pick<NotificationClass, "generic" | "topics">): string { return `${value.generic}:${value.topics.join(",")}`; }
export function decodeNotificationClass(raw: string | null | undefined, kind: PushPayload["kind"]): Pick<NotificationClass, "generic" | "topics"> {
  const match = /^(reply|files|update|action|error|message):((?:replyCompleted|filesReceived|needsAttention)(?:,(?:replyCompleted|filesReceived|needsAttention))*)$/.exec(raw ?? "");
  if (match) return { generic: match[1] as NotificationGeneric, topics: match[2]!.split(",") as NotificationTopic[] };
  // Rows admitted by an older Hub carry no class. Fall back to the wire kind.
  return kind === "answer" ? { generic: "message", topics: ["replyCompleted", "filesReceived"] } : { generic: kind, topics: ["needsAttention"] };
}

/** Bounded two-line preview: a conversation/Bot heading and the event excerpt. */
export function notificationPreview(message: Message, title: string, botName: string, kind: PushPayload["kind"], incomplete: boolean, backgroundUpdate = false, locale: NotificationLocale = "zh"): string {
  const copy = COPY[locale];
  const { summary, files, images, audio } = digest(message, copy);
  // Preserve the v1 wire fields (including its historical title literal).
  // The first line is readable on older clients; Android uses it as the title.
  const name = clip(plain(title, copy).replace(locale === "zh" ? /[「」]/g : /[“”]/g, "").trim() || copy.untitled, 48);
  const bot = clip(plain(botName, copy), 24);
  const heading = copy.open(name, bot && bot !== name ? bot : "");
  const artifacts = [files.length ? copy.files(files.slice(0, 2).map(name => clip(name, 40)).join(locale === "zh" ? "、" : ", "), files.length) : "", images ? copy.images(images) : "", audio ? copy.audio(audio) : ""].filter(Boolean).join(locale === "zh" ? "、" : ", ");
  const deliveryUnconfirmed = message.blocks.some(block => block.type === "card" && backgroundTaskNotice(block)?.delivery === "unconfirmed");
  const detail = deliveryUnconfirmed ? `${copy.unconfirmed}${summary || copy.unconfirmedEmpty}` : kind === "error" ? `${copy.incomplete}${summary || (incomplete ? copy.incompleteEmpty : copy.failedEmpty)}`
    : kind === "action" ? `${copy.action}${summary || copy.actionEmpty}`
    : backgroundUpdate ? `${copy.update}${summary || copy.updateEmpty}${artifacts ? ` · ${artifacts}` : ""}`
    : artifacts ? `${copy.received(artifacts)}${summary ? ` · ${summary}` : ""}`
    : `${copy.reply}${summary || copy.replyEmpty}`;
  return `${heading}\n${clip(detail, MAX_BODY - heading.length - 1)}`;
}

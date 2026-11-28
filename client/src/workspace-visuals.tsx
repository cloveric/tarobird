import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HelpCircle, X } from "lucide-react";
import type { Conversation, Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { Avatar, AvatarProvider, Profiles } from "./Avatar.js";
import { RoleStarSuppressed } from "./AgentAvatar.js";
import { messageAttention } from "./attention.js";
import { BotMessageHostsContext, botMessageHostId } from "./bot-message-hosts.js";
import { t } from "./i18n.js";

const EMPTY_CONVERSATIONS: readonly Conversation[] = [];

/** Format a raw model ID (e.g. "claude-sonnet-4-6") into an everyday readable label. */
export function formatModelDisplayName(model?: string, engine?: string): string | undefined {
  const raw = (model ?? "").trim();
  if (!raw || raw === "default" || raw === "auto") {
    return engine ? formatEngineDisplayName(engine) : undefined;
  }
  const leaf = raw.split("/").pop() ?? raw;
  const cleaned = leaf
    .replace(/-\d{8}(?:[-_].*)?$/, "")
    .replace(/:\d+$/, "");

  const claudeNew = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-(.*))?$/i.exec(cleaned);
  if (claudeNew) {
    const family = claudeNew[1]![0]!.toUpperCase() + claudeNew[1]!.slice(1).toLowerCase();
    return `Claude ${family} ${claudeNew[2]}.${claudeNew[3]}`;
  }
  const claudeOld = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)(?:-(.*))?$/i.exec(cleaned);
  if (claudeOld) {
    const family = claudeOld[3]![0]!.toUpperCase() + claudeOld[3]!.slice(1).toLowerCase();
    return `Claude ${claudeOld[1]}.${claudeOld[2]} ${family}`;
  }
  if (/^claude-/i.test(cleaned)) {
    return cleaned.split("-").filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join(" ");
  }
  if (/^gpt-/i.test(cleaned)) {
    return cleaned
      .replace(/^gpt-/i, "GPT-")
      .replace(/-codex$/i, " Codex")
      .replace(/-mini$/i, " mini")
      .replace(/-turbo$/i, " Turbo");
  }
  if (/^gemini-/i.test(cleaned)) {
    return cleaned.split("-").filter(Boolean).map(part => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part[0]!.toUpperCase() + part.slice(1);
    }).join(" ");
  }
  if (/^deepseek-/i.test(cleaned)) {
    return cleaned.split("-").filter(Boolean).map(part => part.toLowerCase() === "deepseek" ? "DeepSeek" : part[0]!.toUpperCase() + part.slice(1)).join(" ");
  }
  if (/^kimi-/i.test(cleaned)) {
    return cleaned.split("-").filter(Boolean).map(part => part.toLowerCase() === "kimi" ? "Kimi" : part.toUpperCase() === part ? part : part[0]!.toUpperCase() + part.slice(1)).join(" ");
  }
  return cleaned;
}

export function formatEngineDisplayName(engine?: string): string | undefined {
  switch ((engine ?? "").trim().toLowerCase()) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "antigravity":
    case "agy": return "Antigravity";
    case "deepseek": return "DeepSeek";
    case "kimi": return "Kimi";
    case "pi": return "Pi";
    default: return engine?.trim() || undefined;
  }
}

export type SignalStrength = {
  bars: 0 | 1 | 2 | 3 | 4;
  tone: "ok" | "warn" | "bad" | "muted";
  label: string;
};

/** Turn connection status + latency into plain-language signal strength. */
export function signalStrength(status: "online" | "connecting" | "offline", latency?: number): SignalStrength {
  if (status === "offline") return { bars: 0, tone: "bad", label: t("未连上") };
  if (status === "connecting") return { bars: 1, tone: "warn", label: t("正在连接…") };
  if (latency === undefined || !Number.isFinite(latency)) return { bars: 4, tone: "ok", label: t("已连上") };
  const ms = Math.max(0, Math.round(latency));
  if (ms <= 80) return { bars: 4, tone: "ok", label: t("很好 · {0}ms", ms) };
  if (ms <= 220) return { bars: 3, tone: "ok", label: t("不错 · {0}ms", ms) };
  if (ms <= 500) return { bars: 2, tone: "warn", label: t("有点慢 · {0}ms", ms) };
  return { bars: 1, tone: "bad", label: t("较卡顿 · {0}ms", ms) };
}

/** Plain-language summary of what a Bot is asking permission to do. */
export function approvalPlainSummary(botName: string, title?: string, detail?: string): string {
  const combined = `${title ?? ""} ${detail ?? ""}`.toLowerCase();
  if (/(命令|shell|bash|command|exec|run\b|npm|pnpm|yarn|pytest|vitest|psql|git\s)/.test(combined)) {
    return t("{0} 想运行一条命令，需要你同意", botName);
  }
  if (/(修改|写入|删除|文件|edit|write|patch|delete|rm\b|file)/.test(combined)) {
    return t("{0} 想修改或写入文件，需要你同意", botName);
  }
  if (/(网页|联网|网络|fetch|http|url|browser|curl)/.test(combined)) {
    return t("{0} 想访问网络或网页，需要你同意", botName);
  }
  const cleanTitle = title?.trim();
  if (cleanTitle && !/^(请求执行命令审批|approve|approval|等待审批|需要审批)$/i.test(cleanTitle)) {
    return t("{0} 想「{1}」，需要你同意", botName, cleanTitle);
  }
  return t("{0} 有操作需要你点头同意", botName);
}

/** Plain-language summary of a Bot's pending question card. */
export function questionPlainSummary(botName: string, title?: string): string {
  const cleanTitle = title?.trim();
  if (cleanTitle && !/^(?:问题|question)(?:\s*\d+)?$/i.test(cleanTitle)) {
    return t("{0} 想确认「{1}」，需要你回答", botName, cleanTitle);
  }
  return t("{0} 有问题需要你回答", botName);
}

export function formatElapsedBrief(startedAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return t("{0} 秒", Math.max(1, sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return t("{0} 分钟", min);
  return t("{0}小时", Math.floor(min / 60));
}

export type WorkspaceFileKind = "doc" | "sheet" | "image" | "code" | "pdf" | "workbench" | "file";

export function fileKindInfo(name: string, mime?: string): { kind: WorkspaceFileKind; ext: string; label: string; tone: string } {
  const filename = name.split(/[\\/]/).at(-1)?.trim() ?? "";
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const mediaType = (mime ?? "").split(";", 1)[0]!.trim().toLowerCase();

  // Match recognized extensions before generic MIME fallbacks (e.g. text/plain on source files).
  if (ext === "pdf") {
    return { kind: "pdf", ext: "PDF", label: t("PDF 文档"), tone: "is-pdf" };
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "heic", "heif", "avif", "tif", "tiff"].includes(ext)) {
    return { kind: "image", ext: ext.slice(0, 4).toUpperCase(), label: t("图片"), tone: "is-img" };
  }
  if (ext === "json") {
    return { kind: "sheet", ext: "JSON", label: t("数据文件"), tone: "is-sheet" };
  }
  if (["csv", "tsv", "xlsx", "xls", "ods"].includes(ext)) {
    return { kind: "sheet", ext: ext.slice(0, 4).toUpperCase(), label: t("表格"), tone: "is-sheet" };
  }
  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "css", "scss", "html", "htm", "xml", "yml", "yaml", "toml", "sh", "bash", "zsh", "sql"].includes(ext)) {
    return { kind: "code", ext: ext.slice(0, 4).toUpperCase(), label: t("代码"), tone: "is-code" };
  }
  if (["md", "markdown", "txt", "log", "doc", "docx", "rtf", "odt"].includes(ext)) {
    return { kind: "doc", ext: (ext === "markdown" ? "MD" : ext).slice(0, 4).toUpperCase(), label: t("文档"), tone: "is-md" };
  }

  // Generic MIME fallbacks for extensionless or uncommon filenames.
  if (mediaType === "application/pdf") {
    return { kind: "pdf", ext: "PDF", label: t("PDF 文档"), tone: "is-pdf" };
  }
  if (mediaType.startsWith("image/")) {
    return { kind: "image", ext: (ext || "IMG").slice(0, 4).toUpperCase(), label: t("图片"), tone: "is-img" };
  }
  if (mediaType === "application/json") {
    return { kind: "sheet", ext: (ext || "JSON").slice(0, 4).toUpperCase(), label: t("数据文件"), tone: "is-sheet" };
  }
  if (["text/csv", "text/tab-separated-values", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.oasis.opendocument.spreadsheet"].includes(mediaType)) {
    return { kind: "sheet", ext: (ext || "CSV").slice(0, 4).toUpperCase(), label: t("表格"), tone: "is-sheet" };
  }
  if (["text/javascript", "application/javascript", "text/html", "text/css", "application/xml", "text/xml", "application/yaml", "text/yaml"].includes(mediaType)) {
    return { kind: "code", ext: (ext || "CODE").slice(0, 4).toUpperCase(), label: t("代码"), tone: "is-code" };
  }
  if (["text/markdown", "text/x-markdown", "text/plain", "application/rtf", "text/rtf"].includes(mediaType)) {
    return { kind: "doc", ext: (ext || (mediaType.includes("markdown") ? "MD" : "DOC")).slice(0, 4).toUpperCase(), label: t("文档"), tone: "is-md" };
  }
  return { kind: "file", ext: (ext || "FILE").slice(0, 4).toUpperCase(), label: t("文件"), tone: "" };
}

export type PendingCardResolution =
  | { kind: "approval"; actionId: string }
  | { kind: "question" }
  | { kind: "open_only" }
  | { kind: "excluded" };

/** Extract the direct "allow once" button actionId from an approval card message, if present. */
export function findApprovalAllowAction(message: Message | undefined): string | undefined {
  if (!message || message.authorType !== "bot" || message.forwardedFrom || message.historyContext || message.status === "deleted" || message.status === "error") return undefined;
  type CardEl = Extract<Message["blocks"][number], { type: "card" }>["elements"][number];
  const visit = (elements: CardEl[]): string | undefined => {
    for (const element of elements) {
      if (element.disabled) continue;
      if (element.type === "button" && element.actionId && !element.url) {
        const value = element.value;
        if (value && typeof value === "object" && !Array.isArray(value) && value.cctb_lark === "approval" && value.decision === "allow_once") {
          return element.actionId;
        }
      }
      const nested = visit(element.children ?? []);
      if (nested) return nested;
    }
    return undefined;
  };
  for (const block of message.blocks) {
    if (block.type === "card") {
      const actionId = visit(block.elements);
      if (actionId) return actionId;
    }
  }
  return undefined;
}

/** Classify a pending card message so approvals, question forms, open-only cards, and rolled-back cards are handled accurately. */
export function inspectPendingCardMessage(message: Message | undefined): PendingCardResolution {
  if (!message) return { kind: "open_only" };
  if (message.historyContext || message.forwardedFrom || message.status === "deleted" || message.status === "error") {
    return { kind: "excluded" };
  }
  const attention = messageAttention(message);
  if (attention?.kind === "question") return { kind: "question" };
  const actionId = findApprovalAllowAction(message);
  if (actionId) return { kind: "approval", actionId };
  return { kind: "open_only" };
}

/** Small computer illustration with integrated online indicator dot. */
export function HostComputerArt({ online }: { online: boolean }) {
  return (
    <span className={`ws-computer-art${online ? " is-online" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 28 24" width="26" height="22" fill="none">
        <rect x="2.5" y="2.5" width="23" height="15" rx="3" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9.5 21h9M14 17.5V21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M7.5 8.5h6M7.5 11.5h9" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className={`ws-computer-dot${online ? " online" : ""}`} />
    </span>
  );
}

/** Four-bar signal strength meter. */
export function SignalBarsArt({ bars, tone }: { bars: 0 | 1 | 2 | 3 | 4; tone: SignalStrength["tone"] }) {
  const heights = [4, 7, 10, 13];
  return (
    <span className={`ws-signal-bars is-${tone}`} aria-hidden="true">
      {heights.map((h, i) => (
        <i key={h} className={i < bars ? "is-lit" : undefined} style={{ height: h }} />
      ))}
    </span>
  );
}

/** Friendly amber bell / hand spot illustration for Waiting for you. */
export function WaitingHandArt() {
  return (
    <span className="ws-waiting-art" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <circle cx="16" cy="16" r="14" fill="currentColor" fillOpacity="0.14" />
        <path d="M16 7.5a5.5 5.5 0 0 0-5.5 5.5v3.2c0 .9-.35 1.76-.97 2.4L8.5 19.7h15l-1.03-1.1a3.4 3.4 0 0 1-.97-2.4V13A5.5 5.5 0 0 0 16 7.5Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M13.6 21.8a2.5 2.5 0 0 0 4.8 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M7.2 10.6c-.8 1.1-1.2 2.4-1.2 3.8M24.8 10.6c.8 1.1 1.2 2.4 1.2 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.65" />
      </svg>
    </span>
  );
}

/** Gentle working indicator: rhythmic pulsing dots when motion is enabled, calm badge when reduced. */
export function WorkingMotionArt({ animated }: { animated: boolean }) {
  return (
    <span className={`ws-working-art${animated ? " is-animated" : ""}`} aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

/** Simple helper badge icon for subagents (explicitly NOT Bot avatars). */
export function HelperCountArt() {
  return (
    <span className="ws-helper-art" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
        <circle cx="9" cy="8.5" r="3" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4 18.5c0-2.6 2.2-4.5 5-4.5s5 1.9 5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M17.5 6.5v4M15.5 8.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="17.5" cy="16" r="2.3" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.7" />
      </svg>
    </span>
  );
}

/** Friendly spot illustrations for empty and error states. */
export function EmptyStateArt({ kind }: { kind: "comms" | "files" | "error" }) {
  if (kind === "comms") {
    return (
      <svg className="ws-empty-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <rect x="6" y="10" width="24" height="18" rx="6" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="14" cy="19" r="1.6" fill="currentColor" /><circle cx="22" cy="19" r="1.6" fill="currentColor" />
        <rect x="34" y="18" width="24" height="18" rx="6" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="42" cy="27" r="1.6" fill="currentColor" /><circle cx="50" cy="27" r="1.6" fill="currentColor" />
        <path d="M29 14c3-3 7-3 10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 3" />
      </svg>
    );
  }
  if (kind === "files") {
    return (
      <svg className="ws-empty-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M12 14a4 4 0 0 1 4-4h10l4 4h18a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V14Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M24 26h16M24 31h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
        <circle cx="48" cy="11" r="2.2" fill="currentColor" fillOpacity="0.5" />
      </svg>
    );
  }
  return (
    <svg className="ws-empty-art is-error" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
      <circle cx="32" cy="24" r="16" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M32 16v10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="32" cy="31.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** First-use "?" help button with a compact, friendly popover containing a small illustration and plain words. */
export function SectionHelpButton({
  title,
  description,
  art,
  open,
  placement = "auto",
  onToggle,
  onClose,
}: {
  title: string;
  description: string;
  art: ReactNode;
  open: boolean;
  placement?: "auto" | "up" | "down";
  onToggle: () => void;
  onClose: () => void;
}) {
  const popoverId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(placement === "up");

  useLayoutEffect(() => {
    if (!open) {
      setFlipUp(placement === "up");
      return;
    }
    if (placement === "up") { setFlipUp(true); return; }
    if (placement === "down") { setFlipUp(false); return; }
    const wrap = wrapRef.current;
    const pop = popoverRef.current;
    if (!wrap || !pop) return;
    const container = wrap.closest(".workspace-body") ?? document.documentElement;
    const containerRect = container.getBoundingClientRect();
    const header = wrap.closest(".workspace-section-header") ?? wrap;
    const headerRect = header.getBoundingClientRect();
    const popHeight = pop.getBoundingClientRect().height;
    // Stay above the 16px bottom fade mask and scroll viewport edge.
    const bottomSafeEdge = containerRect.bottom - 18;
    const spaceBelow = bottomSafeEdge - (headerRect.bottom + 5);
    const spaceAbove = (headerRect.top - 5) - containerRect.top;
    setFlipUp(spaceBelow < popHeight && spaceAbove >= spaceBelow);
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);

  return (
    <span className="ws-help-wrap" ref={wrapRef}>
      <button
        type="button"
        className="ws-help-btn"
        aria-label={t("说明：{0}", title)}
        title={t("这是什么？")}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={onToggle}
      >
        <HelpCircle size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={popoverId}
          ref={popoverRef}
          className={`ws-help-popover${flipUp ? " is-up" : ""}`}
          role="region"
          aria-label={title}
        >
          <div className="ws-help-popover-art">{art}</div>
          <div className="ws-help-popover-body">
            <div className="ws-help-popover-head">
              <strong>{title}</strong>
              <button type="button" className="ws-help-close" aria-label={t("关闭说明")} onClick={onClose}>
                <X size={11} aria-hidden="true" />
              </button>
            </div>
            <p>{description}</p>
          </div>
        </div>
      )}
    </span>
  );
}

/** Resolve a Bot's real Avatar across the current Hub and any connected peer Hosts (used ONLY in Bot-to-Bot comms). */
export function WorkspaceBotAvatar({
  hostId,
  botId,
  name,
  size = 22,
}: {
  hostId?: string;
  botId?: string;
  name: string;
  size?: number;
}) {
  const profiles = useContext(Profiles);
  const hostEntries = useContext(BotMessageHostsContext);
  const resolvedId = botId || name;

  const currentPub = profiles?.connection?.identity.hubPublicKey;
  const isRemoteHost = !!hostId && !!currentPub && botMessageHostId(currentPub) !== hostId;
  const remoteConnection = isRemoteHost
    ? hostEntries.find(
        entry => entry.host.publicKey && botMessageHostId(entry.host.publicKey) === hostId && entry.connection && !entry.host.networkBlocked && !entry.connection.isNetworkBlocked,
      )?.connection
    : undefined;

  if (remoteConnection) {
    return (
      <AvatarProvider connection={remoteConnection} conversations={EMPTY_CONVERSATIONS}>
        <RoleStarSuppressed.Provider value={true}>
          <Avatar kind="bot" id={resolvedId} name={name} size={size} />
        </RoleStarSuppressed.Provider>
      </AvatarProvider>
    );
  }

  if (isRemoteHost) {
    return (
      <Profiles.Provider value={null}>
        <RoleStarSuppressed.Provider value={true}>
          <Avatar kind="bot" id={`${hostId}:${resolvedId}`} name={name} size={size} />
        </RoleStarSuppressed.Provider>
      </Profiles.Provider>
    );
  }

  return (
    <RoleStarSuppressed.Provider value={true}>
      <Avatar kind="bot" id={resolvedId} name={name} size={size} />
    </RoleStarSuppressed.Provider>
  );
}

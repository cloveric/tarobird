import type { ReplyChannel } from "../../runtime/reply-channel.js";
import type { CronChannel, CronJobRecord, CronSessionMode } from "../../state/cron-store-schema.js";
import type { CronStore } from "../../state/cron-store.js";
import type { CronScheduler } from "../../runtime/cron-scheduler.js";
import { validateCronExpression } from "../../runtime/cron-scheduler.js";
import { formatInCronTimezone } from "../../state/cron-timezone.js";
import { hostT } from "../../locales/index.js";
import type { Locale } from "../../runtime/locale.js";

export type CronLocale = Locale;

export interface CronCommandContext {
  api: Pick<ReplyChannel, "sendMessage">;
  store: CronStore;
  scheduler: CronScheduler;
  chatId: number;
  userId: number;
  channel?: CronChannel;
  chatType?: string;
  messageThreadId?: number;
  conversationKey?: string;
  larkChatId?: string;
  larkThreadId?: string;
  larkMessageId?: string;
  locale: CronLocale;
}

const CRON_COMMAND_RE = /^\/cron(?:@\w+)?(?:\s|$)/i;

export function isCronCommand(text: string): boolean {
  return CRON_COMMAND_RE.test(text.trim());
}

interface ParsedCommand {
  sub: string;
  rest: string;
}

function parseCronCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  // Strip the leading "/cron" or "/cron@bot"
  const stripped = trimmed.replace(/^\/cron(?:@\w+)?/i, "").trim();
  if (!stripped) {
    return { sub: "list", rest: "" };
  }
  const firstSpace = stripped.search(/\s/);
  if (firstSpace === -1) {
    return { sub: stripped.toLowerCase(), rest: "" };
  }
  return {
    sub: stripped.slice(0, firstSpace).toLowerCase(),
    rest: stripped.slice(firstSpace + 1).trim(),
  };
}

function humanizeCronExpr(expr: string, locale: CronLocale): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return hostT(locale, "每分钟");
  }
  if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return hostT(locale, "每小时整点");
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    const hh = String(Number(hour)).padStart(2, "0");
    const mm = String(Number(minute)).padStart(2, "0");
    return hostT(locale, "每天 {0}:{1}", hh, mm);
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dom === "*" &&
    month === "*" &&
    /^[0-6]$/.test(dow)
  ) {
    const hh = String(Number(hour)).padStart(2, "0");
    const mm = String(Number(minute)).padStart(2, "0");
    const dayKeys = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
    const idx = Number(dow);
    return hostT(locale, "每{0} {1}:{2}", hostT(locale, dayKeys[idx]!), hh, mm);
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dom) &&
    month === "*" &&
    dow === "*"
  ) {
    const hh = String(Number(hour)).padStart(2, "0");
    const mm = String(Number(minute)).padStart(2, "0");
    return hostT(locale, "每月 {0} 日 {1}:{2}", dom, hh, mm);
  }
  return null;
}

function humanizeRelative(iso: string, locale: CronLocale): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  let value: string;
  if (sec < 60) {
    value = sec === 1 ? hostT(locale, "1 秒") : hostT(locale, "{0} 秒", sec);
  } else if (min < 60) {
    value = min === 1 ? hostT(locale, "1 分钟") : hostT(locale, "{0} 分钟", min);
  } else if (hr < 24) {
    value = hr === 1 ? hostT(locale, "1 小时") : hostT(locale, "{0} 小时", hr);
  } else {
    value = day === 1 ? hostT(locale, "1 天") : hostT(locale, "{0} 天", day);
  }

  return future ? hostT(locale, "{0}后", value) : hostT(locale, "{0}前", value);
}

function renderJob(job: CronJobRecord, index: number, locale: CronLocale): string {
  const lines: string[] = [];
  const enabledLabel = hostT(locale, job.enabled ? "✓ 已启用" : "✗ 已停用");
  lines.push(`${index}. ID  ${job.id}  ${enabledLabel}`);
  const human = job.runOnce && job.targetAt
    ? hostT(locale, "仅一次 {0} ({1})", formatInCronTimezone(job.targetAt, job.timezone), humanizeRelative(job.targetAt, locale))
    : humanizeCronExpr(job.cronExpr, locale);
  const exprLine = job.runOnce && job.targetAt
    ? human
    : human ? `${job.cronExpr}  (${human})` : job.cronExpr;
  const timezone = job.timezone && !job.runOnce ? `  TZ ${job.timezone}` : "";
  lines.push(`   ⏰ ${exprLine}${timezone}`);
  lines.push(`   🧵 session=${job.sessionMode}`);
  lines.push(`   📝 ${job.prompt}`);
  if (job.lastRunAt) {
    const rel = humanizeRelative(job.lastRunAt, locale);
    const status = job.lastError
      ? hostT(locale, "失败：{0}", job.lastError)
      : hostT(locale, "成功");
    const label = hostT(locale, "上次");
    lines.push(`   ⏱ ${label}: ${rel} (${formatInCronTimezone(job.lastRunAt, job.timezone)}) ${status}`);
  }
  return lines.join("\n");
}

function renderHelp(locale: CronLocale): string {
  return hostT(
    locale,
    "📅 /cron 命令用法：\n\n/cron              查看所有任务\n/cron list         同上\n/cron add <cron 表达式> <提示词>\n                   例：/cron add 0 9 * * * 早安总结\n/cron rm <id>      删除任务（别名 delete / del）\n/cron toggle <id>  启用/停用任务\n/cron mode <id> new_per_run|reuse  修改上下文模式\n/cron run <id>     立即运行一次\n/cron help         显示本帮助",
  );
}

async function handleList(context: CronCommandContext): Promise<void> {
  const jobs = await context.store.listByConversation(context.chatId, context.messageThreadId);
  if (jobs.length === 0) {
    const msg = hostT(context.locale, "暂无定时任务。用 `/cron add 0 9 * * * 早安总结` 添加一个。");
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const header = jobs.length === 1
    ? hostT(context.locale, "📅 已安排 1 个任务：")
    : hostT(context.locale, "📅 已安排 {0} 个任务：", jobs.length);
  const entries = jobs.map((job, idx) => renderJob(job, idx + 1, context.locale));
  const chunks = splitCronListMessages(header, entries);
  for (const chunk of chunks) {
    await context.api.sendMessage(context.chatId, chunk);
  }
}

const CRON_LIST_MESSAGE_MAX_CHARS = 3800;

function splitCronListMessages(header: string, entries: string[]): string[] {
  const chunks: string[] = [];
  let current = header;
  for (const entry of entries) {
    const sections = splitTextByCodePoints(entry, CRON_LIST_MESSAGE_MAX_CHARS);
    for (const section of sections) {
      const candidate = `${current}\n\n${section}`;
      if (candidate.length <= CRON_LIST_MESSAGE_MAX_CHARS) {
        current = candidate;
      } else {
        chunks.push(current);
        current = section;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitTextByCodePoints(text: string, maxChars: number): string[] {
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += maxChars) {
    chunks.push(codePoints.slice(offset, offset + maxChars).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

async function handleAdd(rest: string, context: CronCommandContext): Promise<void> {
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 6) {
    const msg = hostT(context.locale, "用法：/cron add <分 时 日 月 周> <提示词>\n例：/cron add 0 9 * * * 早安总结");
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const cronExpr = tokens.slice(0, 5).join(" ");
  const prompt = tokens.slice(5).join(" ");

  if (validateCronExpression(cronExpr) === null) {
    const msg = hostT(context.locale, "无效的 cron 表达式：`{0}`", cronExpr);
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  if (prompt.length > 4000) {
    const msg = hostT(context.locale, "提示词过长（最多 4000 字符）。");
    await context.api.sendMessage(context.chatId, msg);
    return;
  }

  let record: CronJobRecord;
  try {
    record = await context.store.add({
      channel: context.channel ?? "telegram",
      chatId: context.chatId,
      messageThreadId: context.messageThreadId,
      userId: context.userId,
      chatType: context.chatType ?? "private",
      conversationKey: context.conversationKey,
      larkChatId: context.larkChatId,
      larkThreadId: context.larkThreadId,
      larkMessageId: context.larkMessageId,
      locale: context.locale,
      cronExpr,
      prompt,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const msg = hostT(context.locale, "添加任务失败：{0}", detail);
    await context.api.sendMessage(context.chatId, msg);
    return;
  }

  await context.scheduler.refresh();

  const human = humanizeCronExpr(cronExpr, context.locale);
  const exprLine = human ? `${cronExpr}  (${human})` : cronExpr;
  const timezone = record.timezone ? `  TZ ${record.timezone}` : "";
  const msg = hostT(context.locale, "✓ 已添加任务  ID  {0}\n⏰ {1}{2}\n📝 {3}", record.id, exprLine, timezone, prompt);
  await context.api.sendMessage(context.chatId, msg);
}

async function ensureChatJob(
  id: string,
  context: CronCommandContext,
): Promise<CronJobRecord | null> {
  if (!/^[a-f0-9]{8}$/.test(id)) {
    const msg = hostT(context.locale, "无效的 ID：{0}（应为 8 位十六进制）", id);
    await context.api.sendMessage(context.chatId, msg);
    return null;
  }
  const job = await context.store.get(id);
  if (!job || job.chatId !== context.chatId || job.messageThreadId !== context.messageThreadId) {
    const msg = hostT(context.locale, "未找到任务：{0}", id);
    await context.api.sendMessage(context.chatId, msg);
    return null;
  }
  return job;
}

async function handleRemove(rest: string, context: CronCommandContext): Promise<void> {
  const id = rest.split(/\s+/)[0] ?? "";
  if (!id) {
    const msg = hostT(context.locale, "用法：/cron rm <id>");
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const job = await ensureChatJob(id, context);
  if (!job) return;

  const removed = await context.store.remove(id);
  if (!removed) {
    const msg = hostT(context.locale, "未找到任务：{0}", id);
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  await context.scheduler.refresh();
  const msg = hostT(context.locale, "✓ 已删除任务  ID  {0}", id);
  await context.api.sendMessage(context.chatId, msg);
}

async function handleToggle(rest: string, context: CronCommandContext): Promise<void> {
  const id = rest.split(/\s+/)[0] ?? "";
  if (!id) {
    const msg = hostT(context.locale, "用法：/cron toggle <id>");
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const job = await ensureChatJob(id, context);
  if (!job) return;

  const updated = await context.store.toggleEnabled(id);
  if (!updated) {
    const msg = hostT(context.locale, "未找到任务：{0}", id);
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  await context.scheduler.refresh();
  const stateLabel = hostT(context.locale, updated.enabled ? "已启用" : "已停用");
  const msg = hostT(context.locale, "✓ 任务 {0} {1}", id, stateLabel);
  await context.api.sendMessage(context.chatId, msg);
}

function parseSessionMode(value: string): CronSessionMode | null {
  return value === "new_per_run" || value === "reuse" ? value : null;
}

async function handleMode(rest: string, context: CronCommandContext): Promise<void> {
  const [id = "", modeToken = ""] = rest.split(/\s+/).filter(Boolean);
  const mode = parseSessionMode(modeToken);
  if (!id || !mode) {
    const msg = hostT(context.locale, "用法：/cron mode <id> new_per_run|reuse");
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const job = await ensureChatJob(id, context);
  if (!job) return;

  const updated = await context.store.update(id, { sessionMode: mode });
  if (!updated) {
    const msg = hostT(context.locale, "未找到任务：{0}", id);
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  await context.scheduler.refresh();
  const msg = hostT(context.locale, "✓ 任务 {0} 上下文模式已改为 {1}", id, updated.sessionMode);
  await context.api.sendMessage(context.chatId, msg);
}

async function handleRun(rest: string, context: CronCommandContext): Promise<void> {
  const id = rest.split(/\s+/)[0] ?? "";
  if (!id) {
    const msg = hostT(context.locale, "用法：/cron run <id>");
    await context.api.sendMessage(context.chatId, msg);
    return;
  }
  const job = await ensureChatJob(id, context);
  if (!job) return;
  if (!job.enabled) {
    const msg = hostT(context.locale, "任务 {0} 已停用；请先 /cron toggle {0} 启用后再运行。", id);
    await context.api.sendMessage(context.chatId, msg);
    return;
  }

  const ack = hostT(context.locale, "▶ 正在运行任务 {0}…", id);
  await context.api.sendMessage(context.chatId, ack);

  void context.scheduler.runJobNow(id).catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    const msg = hostT(context.locale, "任务 {0} 运行失败：{1}", id, detail);
    await context.api.sendMessage(context.chatId, msg);
  });

  const done = hostT(context.locale, "✓ 任务 {0} 已触发", id);
  await context.api.sendMessage(context.chatId, done);
}

export async function handleCronCommand(
  text: string,
  context: CronCommandContext,
): Promise<{ handled: boolean; subcommand?: string }> {
  if (!isCronCommand(text)) {
    return { handled: false };
  }

  const { sub, rest } = parseCronCommand(text);

  switch (sub) {
    case "list":
      await handleList(context);
      return { handled: true, subcommand: "list" };
    case "add":
      await handleAdd(rest, context);
      return { handled: true, subcommand: "add" };
    case "rm":
    case "delete":
    case "del":
      await handleRemove(rest, context);
      return { handled: true, subcommand: "rm" };
    case "toggle":
      await handleToggle(rest, context);
      return { handled: true, subcommand: "toggle" };
    case "mode":
    case "session":
    case "session-mode":
      await handleMode(rest, context);
      return { handled: true, subcommand: "mode" };
    case "run":
      await handleRun(rest, context);
      return { handled: true, subcommand: "run" };
    case "help":
      await context.api.sendMessage(context.chatId, renderHelp(context.locale));
      return { handled: true, subcommand: "help" };
    default: {
      const msg = hostT(context.locale, "未知子命令：{0}\n\n{1}", sub, renderHelp(context.locale));
      await context.api.sendMessage(context.chatId, msg);
      return { handled: true, subcommand: "unknown" };
    }
  }
}

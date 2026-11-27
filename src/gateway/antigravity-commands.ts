import type { CoreSlashCommandDefinition } from "../core/slash-command-registry.js";

function command(name: string, en: string, zh: string): CoreSlashCommandDefinition {
  return { command: name, description: { defaultValue: en, i18n: { en_us: en, zh_cn: zh } } };
}

/**
 * Antigravity CLI/Desktop commands intentionally excluded from the TaroBird App
 * picker even if advertised dynamically over ACP `available_commands_update`.
 */
export const ANTIGRAVITY_EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
  "remote-control",
]);

/**
 * Curated Antigravity built-in slash commands for the TaroBird App picker.
 * Surfaced immediately for Antigravity Bots (before the first ACP session emits
 * `available_commands_update`) with bilingual descriptions, ahead of generic
 * workspace skills. Host-owned commands (`/goal`, `/compact`, `/btw`, etc.)
 * stay in `CORE_SLASH_COMMANDS` so the Host keeps a single authoritative entry.
 */
export const ANTIGRAVITY_APP_COMMANDS: readonly CoreSlashCommandDefinition[] = [
  command(
    "swarm",
    "Run a multi-agent swarm coordinated on a shared message board (Preview & Quota Heavy)",
    "启动多代理协同编排（共享消息板与分工核验，Preview & Quota Heavy · 预览 · 高配额消耗）",
  ),
  command(
    "grill-me",
    "Interview me to align on a plan, one question at a time with suggested answers",
    "动手前逐题访谈对齐需求并附建议答案，再进入规划",
  ),
  command(
    "plan",
    "Plan carefully and produce a written plan for sign-off before changing files",
    "先产出书面方案供确认，批准后再修改文件",
  ),
  command(
    "teamwork",
    "Project-lead mode: break long tasks into milestones with reviewer sign-off",
    "项目负责人模式：拆解阶段里程碑并由审校代理逐段把关",
  ),
  command(
    "run-workflow",
    "Run a repeatable Python workflow script to fan out or pipeline multiple agents",
    "用可复用 Python 工作流脚本并行或分阶段编排多代理",
  ),
  command(
    "browser",
    "Invoke a browser agent to open pages, interact with UI, and verify results",
    "调用浏览器代理打开网页、操作交互与截图验证",
  ),
  command(
    "learn",
    "Turn session corrections into reusable rules or skills after your approval",
    "从本轮纠偏中提炼可复用规则或 Skill（确认后保存）",
  ),
  command(
    "automation",
    "Map scheduled automation requests to TaroBird /cron schedules or Antigravity /schedule",
    "将定时自动化需求映射到 TaroBird 原生 /cron 定时任务或 /schedule",
  ),
  command(
    "schedule",
    "Run an instruction on an in-session recurring schedule or one-time timer",
    "在当前会话内设置单次或周期定时提醒与执行",
  ),
  command(
    "boost",
    "Invoke the Boost multi-agent orchestrator for complex tasks",
    "调用 Boost 多代理编排器处理复杂任务",
  ),
];

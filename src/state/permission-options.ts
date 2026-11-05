import { resolveApprovalModeForEngine } from "./approval-mode.js";

// Pure data shared by the host and clients. IDs describe saved behavior, not a
// universal CLI flag: notably Claude Auto and Kimi Auto have opposite meanings.
export const PERMISSION_CHOICES = ["bypass", "full-auto", "normal", "claude-auto", "claude-accept-edits"] as const;
export type PermissionChoice = typeof PERMISSION_CHOICES[number];
export type PermissionEngine = "codex" | "claude" | "kimi" | "deepseek" | "antigravity";
export type PermissionOption = { id: PermissionChoice; label: string; description: string };
export function defaultPermission(engine: PermissionEngine): PermissionChoice { return engine === "kimi" ? "full-auto" : "bypass"; }
export function permissionOptions(engine: PermissionEngine, codexRuntime?: unknown): PermissionOption[] {
  switch (engine) {
    case "claude": return [
      { id: "bypass", label: "完全访问 · Bypass", description: "跳过工具权限确认；不提供系统沙箱。" },
      { id: "claude-auto", label: "自动审批 · Claude Auto", description: "由 Claude CLI 自动评估操作；仍需人工确认的请求显示在对话中。不等于沙箱。" },
      { id: "claude-accept-edits", label: "自动批准编辑 · Accept edits", description: "自动批准文件编辑；其他需要权限的操作在对话中请求批准。不等于沙箱。" },
      { id: "normal", label: "普通审批 · Manual", description: "由 Claude CLI 的权限规则决定哪些操作需批准，并在对话中确认。不等于沙箱。" },
    ];
    case "kimi": return [
      { id: "full-auto", label: "YOLO · 按需询问", description: "普通工具自动批准；敏感操作仍可能询问。没有系统沙箱。" },
      { id: "bypass", label: "完全访问 · Kimi Auto", description: "Never Ask：高危和无法分析的命令也会自动执行，没有系统沙箱。" },
      { id: "normal", label: "普通审批 · Default", description: "使用 Kimi 的普通审批模式；需要批准的操作显示在对话中。没有系统沙箱。" },
    ];
    case "antigravity": return [
      { id: "bypass", label: "完全访问 · Bypass", description: "跳过工具权限确认，不启用终端沙箱。" },
      { id: "full-auto", label: "沙箱自动执行", description: "自动批准工具操作，并启用 Antigravity 的终端沙箱。" },
      { id: "normal", label: "每轮批准 · 终端沙箱", description: "每轮开始前在对话中批准整轮任务；批准后在终端沙箱内自动执行，并非逐条命令审批。" },
    ];
    default: return [
      { id: "bypass", label: "完全访问 · Bypass", description: "跳过工具权限确认，并允许工作区以外的访问。" },
      { id: "full-auto", label: "工作区自动执行", description: "在工作区沙箱内自动执行，不请求工具批准；超出沙箱的操作可能失败。" },
      { id: "normal", label: codexRuntime === "process" ? "每轮批准 · 工作区沙箱" : "普通审批 · 工作区沙箱", description: codexRuntime === "process" ? "旧版进程运行时先批准整轮任务，再在工作区沙箱内执行，并非逐条命令审批。" : "启用工作区沙箱，需要额外权限时在对话中请求批准。" },
    ];
  }
}
export function currentPermission(engine: PermissionEngine, config: Record<string, unknown>): PermissionChoice {
  const mode = resolveApprovalModeForEngine(engine, config.approvalMode, config.kimiAutoNeverAskAcknowledged);
  if (engine === "claude") {
    if (mode !== "normal") return "bypass"; // Legacy full-auto also meant bypassPermissions.
    if (config.claudePermissionMode === "auto") return "claude-auto";
    if (config.claudePermissionMode === "acceptEdits") return "claude-accept-edits";
  }
  return mode;
}
export function applyPermission(config: Record<string, unknown>, engine: PermissionEngine, choice: PermissionChoice): void {
  if (!permissionOptions(engine).some(option => option.id === choice)) throw new Error("permissions_incompatible");
  config.approvalMode = choice.startsWith("claude-") ? "normal" : choice;
  delete config.claudePermissionMode;
  delete config.kimiAutoNeverAskAcknowledged;
  if (engine === "claude") config.claudePermissionMode = choice === "claude-auto" ? "auto" : choice === "claude-accept-edits" ? "acceptEdits" : "manual";
  if (engine === "kimi" && choice === "bypass") config.kimiAutoNeverAskAcknowledged = true;
}

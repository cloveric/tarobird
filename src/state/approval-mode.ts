import { hostT } from "../locales/index.js";
import type { Locale } from "../runtime/locale.js";

export type ApprovalMode = "normal" | "full-auto" | "bypass";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "bypass";

export function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  return value === "normal" || value === "full-auto" || value === "bypass" ? value : undefined;
}

export function resolveApprovalMode(value: unknown): ApprovalMode {
  return normalizeApprovalMode(value) ?? DEFAULT_APPROVAL_MODE;
}

export function resolveApprovalModeForEngine(
  engine: string,
  value: unknown,
  kimiAutoNeverAskAcknowledged: unknown = false,
): ApprovalMode {
  const mode = normalizeApprovalMode(value);
  // Pi and omp have no workspace sandbox. A legacy "full-auto" selection must not
  // silently turn into unattended unrestricted execution.
  if (engine === "pi" || engine === "omp") return mode === "full-auto" ? "normal" : mode ?? DEFAULT_APPROVAL_MODE;
  if (engine === "kimi") {
    if (mode === "bypass" && kimiAutoNeverAskAcknowledged !== true) {
      return "full-auto";
    }
    return mode ?? "full-auto";
  }
  return mode ?? DEFAULT_APPROVAL_MODE;
}

export function renderApprovalModeStatus(
  engine: string,
  value: unknown,
  locale: Locale,
  kimiAutoNeverAskAcknowledged: unknown = false,
): string {
  const mode = resolveApprovalModeForEngine(engine, value, kimiAutoNeverAskAcknowledged);
  if (engine === "pi") {
    return hostT(locale, mode === "normal" ? "Pi：主机工具审批；无 OS 沙箱" : "Pi 原生访问；无 OS 沙箱");
  }
  if (engine === "omp") {
    return hostT(locale, mode === "normal" ? "omp：主机工具审批；无 OS 沙箱" : "omp 原生访问；无 OS 沙箱");
  }
  if (engine === "kimi") {
    if (mode === "full-auto") {
      return hostT(locale, "Kimi YOLO（普通工具自动批准；敏感命令仍可能询问；无 OS 沙箱）");
    }
    if (mode === "bypass") {
      return hostT(locale, "Kimi Auto（完全无人值守；高危及无法分析的命令也会直接执行；无 OS 沙箱）");
    }
  }
  if (mode === "bypass") {
    return "YOLO unsafe/bypass";
  }
  if (mode === "full-auto") {
    return "YOLO/full-auto";
  }
  return hostT(locale, "普通审批");
}

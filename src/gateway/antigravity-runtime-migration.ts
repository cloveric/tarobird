import { readFile } from "node:fs/promises";
import path from "node:path";
import { createBotSchema } from "../client-protocol/bots.js";
import { probeAntigravityAcpResume } from "../codex/antigravity-acp-adapter.js";
import { probeAntigravityAcpVersion, resolveAntigravityExecutable } from "../codex/antigravity-acp-support.js";
import { normalizeApprovalMode, resolveApprovalModeForEngine, type ApprovalMode } from "../state/approval-mode.js";
import { readValidatedConfigFile, updateInstanceConfig } from "../state/instance-config.js";

const configChanged = Symbol("antigravity_runtime_config_changed");

function eligibleApproval(config: Record<string, unknown>): ApprovalMode | undefined {
  if (config.engine !== "antigravity" || config.role !== undefined || config.antigravityRuntime !== undefined) return undefined;
  if (config.approvalMode !== undefined && !normalizeApprovalMode(config.approvalMode)) return undefined;
  return resolveApprovalModeForEngine("antigravity", config.approvalMode);
}

/** Caller owns the Gateway instance lock and has not started taking work. */
export async function migrateManagedLegacyAntigravityRuntime(stateDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const config = await readValidatedConfigFile(path.join(stateDir, "config.json"), { forExecution: true }).catch(() => null);
  const approval = config && eligibleApproval(config);
  if (!approval) return;

  // Worker roles exist in the immutable managed specification and may be
  // absent from config.json. Only a positively identified ordinary Bot moves.
  const spec = await readFile(path.join(stateDir, "managed-bot-spec.json"), "utf8").then(
    raw => createBotSchema.safeParse(JSON.parse(raw)),
  ).catch(() => null);
  if (!spec?.success || spec.data.role !== undefined) return;
  const executable = resolveAntigravityExecutable(env);
  const version = await probeAntigravityAcpVersion(executable, env);
  if (version !== "supported") {
    console.warn(`antigravity_runtime_migration_deferred version_${version}`);
    return;
  }
  const resume = await probeAntigravityAcpResume(executable, env, approval === "normal" ? "full-auto" : approval);
  if (resume !== "supported") {
    console.warn(`antigravity_runtime_migration_deferred acp_${resume}`);
    return;
  }

  try {
    await updateInstanceConfig(stateDir, current => {
      // Keep an operator's explicit runtime or permission change made while
      // probing. Throw before updateInstanceConfig writes any bytes.
      if (eligibleApproval(current) !== approval) throw configChanged;
      current.antigravityRuntime = "acp";
      if (approval === "normal") current.antigravityAcpLegacyTurnApproval = true;
    });
  } catch (error) {
    if (error !== configChanged) throw error;
  }
}

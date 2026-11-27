import path from "node:path";

import { failedTurnUsage, type AdapterUsage } from "../codex/adapter.js";
import { hostT } from "../locales/index.js";
import type { Locale } from "./locale.js";
import { loadInstanceConfig } from "../state/instance-config.js";
import { UsageStore, type UsageRecord } from "../state/usage-store.js";

export interface ExhaustedBudgetState {
  budgetUsd: number;
  usage: UsageRecord;
  message: string;
}

export interface RecordedTurnUsage {
  usage: UsageRecord;
  reachedBudget: boolean;
}

export async function loadBudgetUsd(stateDir: string): Promise<number | undefined> {
  try {
    return (await loadInstanceConfig(stateDir)).budgetUsd;
  } catch (error) {
    const configPath = path.join(stateDir, "config.json");
    console.error(
      `Failed to load ${configPath}, falling back to no budget enforcement:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

export async function checkBudgetAvailability(
  stateDir: string,
  budgetUsd: number | undefined,
  locale: Locale,
): Promise<ExhaustedBudgetState | null> {
  if (budgetUsd === undefined) {
    return null;
  }

  const usage = await new UsageStore(stateDir).load();
  if (usage.totalCostUsd < budgetUsd) {
    return null;
  }

  const message = hostT(locale, "预算已用尽：${0} / ${1}。请在主机上调整此 Bot 的预算配置后重试。", usage.totalCostUsd.toFixed(4), budgetUsd.toFixed(2));

  return { budgetUsd, usage, message };
}

/**
 * Record the usage an engine attached to a failed turn (`withFailedTurnUsage`). Best effort: a ledger
 * write that fails must not replace the turn's own error. Returns whether anything was recorded.
 */
export async function recordFailedTurnUsage(stateDir: string, error: unknown, budgetUsd?: number): Promise<boolean> {
  const usage = failedTurnUsage(error);
  if (!usage) return false;
  try { await recordBridgeTurnUsage(stateDir, usage, budgetUsd); return true; }
  catch (recordError) {
    console.error("Failed to record the usage of a failed turn:", recordError instanceof Error ? recordError.message : recordError);
    return false;
  }
}

export async function recordBridgeTurnUsage(
  stateDir: string,
  usage: AdapterUsage | undefined,
  budgetUsd: number | undefined,
): Promise<RecordedTurnUsage | null> {
  const usageStore = new UsageStore(stateDir);
  if (!usage) {
    await usageStore.recordUnmetered();
    const totals = await usageStore.load();
    return {
      usage: totals,
      reachedBudget: false,
    };
  }

  await usageStore.record({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    costUsd: usage.costUsd,
  });

  const totals = await usageStore.load();
  return {
    usage: totals,
    reachedBudget: budgetUsd !== undefined && totals.totalCostUsd >= budgetUsd,
  };
}

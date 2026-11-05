import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createBridgeDependencies } from "../src/core/engine-factory.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { EngineRetryableError } from "../src/codex/turn-retry.js";
import { EngineRecoveryBudgetError } from "../src/runtime/engine-recovery.js";
import { UsageStore } from "../src/state/usage-store.js";
import { readValidatedConfigFile } from "../src/state/instance-config.js";
import { renderCoreUserFacingError } from "../src/core/errors.js";

it("the production Bridge factory records failed native usage and stops recovery when the Bot budget is reached", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-engine-recovery-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", budgetUsd: 1, approvalMode: "normal" }));
  const send = vi.spyOn(CodexAppServerAdapter.prototype, "sendUserMessage").mockRejectedValue(new EngineRetryableError("Selected model is at capacity", {
    sessionId: "native-budget", mode: "continue", reason: "capacity", usage: { inputTokens: 100, outputTokens: 50, costUsd: 1 },
  }));
  const { bridge } = await createBridgeDependencies({ HOME: root, TAROCUB_INSTANCE: "recovery", CODEX_TELEGRAM_STATE_DIR: stateDir });
  vi.useFakeTimers();
  let waiting!: () => void; const ready = new Promise<void>(r => { waiting = r; });
  try {
    const result = bridge.createAuthenticatedSurface().handleAuthorizedMessage({ chatId: 84, userId: 42, chatType: "private", locale: "zh", conversationKey: `budget-${root}`, text: "finish", files: [],
      onEngineEvent: event => { if (event.type === "engine_retry" && event.status === "waiting") waiting(); } });
    const rejected = expect(result).rejects.toBeInstanceOf(EngineRecoveryBudgetError);
    await ready;
    expect(await new UsageStore(stateDir).load()).toMatchObject({ totalCostUsd: 1, totalInputTokens: 100, totalOutputTokens: 50 });
    await vi.advanceTimersByTimeAsync(3_000); await rejected;
    expect(send).toHaveBeenCalledTimes(1);
    expect(await new UsageStore(stateDir).load()).toMatchObject({ totalCostUsd: 1 });
  } finally { vi.useRealTimers(); send.mockRestore(); await bridge.destroy(); await rm(root, { recursive: true, force: true }); }
});

it("does not silently remove an invalid budget before automatic recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recovery-budget-config-"));
  try {
    const file = path.join(root, "config.json");
    await writeFile(file, JSON.stringify({ engine: "codex", approvalMode: "normal", budgetUsd: "10" }));
    await expect(readValidatedConfigFile(file, { forExecution: true, requireValidBudget: true })).rejects.toMatchObject({ name: "EngineConfigError" });
    const error = await readValidatedConfigFile(file, { forExecution: true, requireValidBudget: true }).catch(error => error);
    expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("预算配置");
  } finally { await rm(root, { recursive: true, force: true }); }
});

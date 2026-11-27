import type { BotCatalog, CreateBotInput } from "../../src/client-protocol/bots.js";

export const NEW_BOT_ENGINE_LABELS: Record<CreateBotInput["engine"], string> = {
  codex: "Codex",
  claude: "Claude Code",
  antigravity: "Antigravity",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  pi: "Pi",
  omp: "oh-my-pi (omp)",
};

export interface UnavailableEnginesSummary {
  allUnavailable: boolean;
  partialUnavailable: boolean;
  unavailableIds: CreateBotInput["engine"][];
  unavailableLabels: string[];
}

export function unavailableEngines(catalog: BotCatalog | undefined): UnavailableEnginesSummary {
  if (!catalog || catalog.engines.length === 0) {
    return { allUnavailable: false, partialUnavailable: false, unavailableIds: [], unavailableLabels: [] };
  }
  const unavailableIds = catalog.engines.filter(engine => !engine.available).map(engine => engine.id);
  const availableCount = catalog.engines.length - unavailableIds.length;
  return {
    allUnavailable: availableCount === 0,
    partialUnavailable: availableCount > 0 && unavailableIds.length > 0,
    unavailableIds,
    unavailableLabels: unavailableIds.map(id => NEW_BOT_ENGINE_LABELS[id] ?? id),
  };
}

export function formatUnavailableEngineList(labels: readonly string[], separator: string): string {
  return labels.join(separator);
}

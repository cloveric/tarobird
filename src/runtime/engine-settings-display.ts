import {
  renderCodexEffortSetting,
  renderCodexModelSetting,
  type CodexUserDefaults,
} from "../codex/user-defaults.js";
import { hostT } from "../locales/index.js";
import type { InstanceEngine } from "../state/instance-config.js";
import type { Locale } from "./locale.js";

export function renderEngineModelSetting(
  engine: InstanceEngine,
  explicitModel: string | undefined,
  codexDefaults: CodexUserDefaults | undefined,
  locale: Locale,
): string {
  if (engine === "codex") {
    return renderCodexModelSetting(explicitModel, codexDefaults, locale);
  }
  if (explicitModel) {
    return explicitModel;
  }
  if (engine === "claude") {
    return hostT(locale, "默认（Claude CLI 默认；未设置 --model 覆盖）");
  }
  return hostT(locale, "默认");
}

export function renderEngineEffortSetting(
  engine: InstanceEngine,
  explicitEffort: string | undefined,
  codexDefaults: CodexUserDefaults | undefined,
  locale: Locale,
): string {
  if (engine === "codex") {
    return renderCodexEffortSetting(explicitEffort, codexDefaults, locale);
  }
  if (explicitEffort) {
    return explicitEffort;
  }
  if (engine === "claude") {
    return hostT(locale, "默认（Claude CLI 默认；未设置 --effort 覆盖）");
  }
  return hostT(locale, "默认");
}

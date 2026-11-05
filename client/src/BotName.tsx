import type { CSSProperties } from "react";
import { useBotDirectory } from "./BotReferences.js";
import { modelBrandNames, resolveModelBrand, type ModelIdentity } from "./model-brand.js";
import { t, useLocale } from "./i18n.js";
import openai from "./assets/model-brands/openai.svg";
import claude from "./assets/model-brands/claude.svg";
import gemini from "./assets/model-brands/gemini.svg";
import deepseek from "./assets/model-brands/deepseek.svg";
import kimi from "./assets/model-brands/kimi.svg";
const icons = { openai, claude, gemini, deepseek, kimi };

/** Current Bot configuration, not attribution of a past message to a model. */
export function BotName({ id, name, bot, compact = false }: { id: string; name: string; bot?: ModelIdentity; compact?: boolean }) {
  const locale = useLocale();
  const directory = useBotDirectory(), identity = bot ?? directory.find(value => value.id === id);
  const match = resolveModelBrand(identity);
  const description = match && (match.source === "model" ? t("当前配置模型：{0}", identity?.model) : t("引擎默认品牌：{0}，具体模型未指定", modelBrandNames[match.brand]));
  return <span className={`bot-name${compact ? " bot-name-compact" : ""}`} data-bot-name={id} data-model-brand={match?.brand} data-brand-source={match?.source} title={description} aria-label={description ? `${name}${locale === "en" ? ", " : "，"}${description}` : undefined}>
    <span className="bot-name-label">{name}</span>
    {match && <span className="bot-brand-icon" aria-hidden="true" style={{ "--brand-icon": `url("${icons[match.brand]}")` } as CSSProperties}/>}
  </span>;
}

export type ModelBrand = "openai" | "claude" | "gemini" | "deepseek" | "kimi";
export type ModelIdentity = { engine?: string; model?: string };
export const modelBrandNames: Record<ModelBrand, string> = { openai: "OpenAI", claude: "Claude", gemini: "Gemini", deepseek: "DeepSeek", kimi: "Kimi" };

/** Identify the configured model, never the Bot's name or a historical reply.
 * Explicit unknown models must not inherit a misleading engine brand. */
export function resolveModelBrand(bot?: ModelIdentity): { brand: ModelBrand; source: "model" | "engine" } | undefined {
  if (!bot) return;
  const model = (bot.model ?? "").trim().toLowerCase();
  const leaf = model.replace(/:\d+$/, "").split(/[/:]/).at(-1)!.replace(/^(?:(?:us|eu|global)\.)?anthropic\./, "");
  let brand: ModelBrand | undefined;
  if (/^(?:gpt|chatgpt|codex)(?:[-_.\s\[]|$)|^o[134](?:[-_.\s\[]|$)|^(?:astra|sol|terra|luna)$/.test(leaf)) brand = "openai";
  else if (/^(?:claude|opus|sonnet|haiku|fable\d*)(?:[-_.\s\[]|$)/.test(leaf)) brand = "claude";
  else if (/^gemini(?:[-_.\s\[]|$)/.test(leaf)) brand = "gemini";
  else if (/^deepseek(?:[-_.\s\[]|$)/.test(leaf)) brand = "deepseek";
  else if (/^(?:kimi|moonshot)(?:[-_.\s\[]|$)/.test(leaf) || /^kimi(?:-code)?\//.test(model)) brand = "kimi";
  if (brand) return { brand, source: "model" };
  if (model && !["default", "auto"].includes(model)) return;
  const engine = (bot.engine ?? "").trim().toLowerCase();
  const engines: Record<string, ModelBrand> = { codex: "openai", claude: "claude", antigravity: "gemini", agy: "gemini", deepseek: "deepseek", kimi: "kimi" };
  brand = Object.hasOwn(engines, engine) ? engines[engine] : undefined;
  if (brand) return { brand, source: "engine" };
}

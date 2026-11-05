import type { ModelSettings } from "../../src/client-protocol/model.js";

type Choice = ModelSettings["choices"][number];
type Effort = ModelSettings["effort"];
type CatalogChoice = Omit<Choice, "efforts"> & { efforts: readonly string[] };
type Selection = { model: string; effort: Effort };
export type ModelOption = Choice & { variants?: { id: string; effort: Effort }[] };
export function modelOptionLabel(choice: Pick<Choice, "id" | "label">, defaultLabel: string): string {
  return choice.id ? choice.label || choice.id : choice.label ? `${defaultLabel} · ${choice.label}` : defaultLabel;
}
const order: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const suffix = /^(.*)-(low|medium|high|xhigh|max|ultra)$/;

/** Group only host-advertised variants with matching IDs AND display labels.
 * Option values remain real catalog IDs; a family name is never sent to a Hub. */
export function modelOptions(engine: string, input: readonly CatalogChoice[]): ModelOption[] {
  const choices: Choice[] = input.map(choice => ({ ...choice, efforts: choice.efforts.filter((level): level is Effort => level === "" || order.includes(level as Effort)) }));
  if (engine !== "antigravity") return choices.map(choice => ({ ...choice }));
  const groups = new Map<string, { label: string; rows: { choice: Choice; effort: Effort }[] }>();
  for (const choice of choices) {
    const match = choice.id.match(suffix), label = choice.label?.match(/^(.*?)\s+\((low|medium|high|xhigh|max|ultra)\)$/i);
    if (!match || !label || label[2]!.toLowerCase() !== match[2] || !choice.efforts.includes(match[2] as Effort)) continue;
    const family = match[1]!, group = groups.get(family) ?? { label: label[1]!, rows: [] };
    group.rows.push({ choice, effort: match[2] as Effort }); groups.set(family, group);
  }
  const replacements = new Map<string, ModelOption>(), hidden = new Set<string>();
  for (const group of groups.values()) {
    // Conflicting labels or an incompletely understood family stay ungrouped.
    const base = group.rows[0]!.choice.id.replace(suffix, "$1");
    const familyRows = choices.filter(choice => choice.id === base || choice.id.replace(suffix, "$1") === base);
    if (familyRows.length !== group.rows.length || group.rows.some(row => row.choice.label?.replace(/\s+\((low|medium|high|xhigh|max|ultra)\)$/i, "") !== group.label)) continue;
    const first = group.rows[0]!.choice;
    replacements.set(first.id, { id: first.id, label: group.label,
      efforts: order.filter(level => group.rows.some(row => row.effort === level)),
      variants: group.rows.map(row => ({ id: row.choice.id, effort: row.effort })),
    });
    for (const row of group.rows.slice(1)) hidden.add(row.choice.id);
  }
  return choices.filter(choice => !hidden.has(choice.id)).map(choice => replacements.get(choice.id) ?? { ...choice });
}

export function selectedModelOption(options: readonly ModelOption[], model: string): ModelOption | undefined {
  return options.find(option => option.id === model || option.variants?.some(variant => variant.id === model));
}
export function selectedModelEffort(option: ModelOption | undefined, selection: Selection): Effort {
  return selection.effort || option?.variants?.find(variant => variant.id === selection.model)?.effort || "";
}
export function selectModel(options: readonly ModelOption[], model: string, previous: Selection, customEfforts: Effort[] = [""]): Selection {
  const option = selectedModelOption(options, model);
  const previousEffort = selectedModelEffort(selectedModelOption(options, previous.model), previous);
  if (option?.variants) {
    const variant = option.variants.find(value => value.effort === previousEffort) ?? option.variants[0]!;
    return { model: variant.id, effort: variant.effort };
  }
  const levels = option?.efforts ?? customEfforts;
  return { model, effort: levels.includes(previous.effort) ? previous.effort : "" };
}
/** Unsupported selections are refused, never rewritten to an invented variant. */
export function selectModelEffort(option: ModelOption | undefined, model: string, effort: Effort): Selection | undefined {
  if (option?.variants) {
    const variant = option.variants.find(value => value.effort === effort);
    return variant && { model: variant.id, effort };
  }
  return !option || option.efforts.includes(effort) ? { model, effort } : undefined;
}

/** Effort-only controls keep the native override contract; explain its preset. */
export function modelEffortPreset(engine: string, model: string, levels: readonly Effort[]): Selection | undefined {
  const match = engine === "antigravity" && /^(?:gemini|claude|gpt)-/.test(model) && model.match(suffix);
  return match && levels.includes(match[2] as Effort) ? { model: match[1]!, effort: match[2] as Effort } : undefined;
}

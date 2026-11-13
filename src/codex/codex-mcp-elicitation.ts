import { z } from "zod";
import type { EngineApprovalDecision } from "./adapter.js";

// Standard MCP form mode from the installed Codex 0.159.3 generated schema.
// URL/auth and OpenAI-specific forms have separate contracts and are declined.
const text = z.string().max(16_000);
const base = { title: text.nullish(), description: text.nullish() };
const option = z.object({ const: text, title: text }).strict();
const property = z.discriminatedUnion("type", [
  z.object({ type: z.literal("string"), ...base, default: text.nullish(), enum: z.array(text).max(100).optional(), enumNames: z.array(text).max(100).nullish(), oneOf: z.array(option).max(100).optional(), format: z.enum(["email", "uri", "date", "date-time"]).nullish(), minLength: z.number().int().nonnegative().nullish(), maxLength: z.number().int().nonnegative().nullish() }).strict(),
  z.object({ type: z.literal("boolean"), ...base, default: z.boolean().nullish() }).strict(),
  z.object({ type: z.literal("number"), ...base, default: z.number().nullish(), minimum: z.number().nullish(), maximum: z.number().nullish() }).strict(),
  z.object({ type: z.literal("integer"), ...base, default: z.number().int().nullish(), minimum: z.number().nullish(), maximum: z.number().nullish() }).strict(),
  z.object({ type: z.literal("array"), ...base, default: z.array(text).nullish(), minItems: z.number().int().nonnegative().nullish(), maxItems: z.number().int().nonnegative().nullish(), items: z.union([
    z.object({ type: z.literal("string"), enum: z.array(text).max(100) }).strict(),
    z.object({ anyOf: z.array(option).max(100) }).strict(),
  ]) }).strict(),
]);
const schema = z.object({
  threadId: z.string().min(1), turnId: z.string().min(1).nullish(), serverName: z.string().min(1).max(256),
  mode: z.literal("form"), message: text, _meta: z.unknown().optional(),
  requestedSchema: z.object({ type: z.literal("object"), $schema: text.nullish(), properties: z.record(z.string().min(1).max(256), property), required: z.array(z.string()).nullish() }).strict(),
});
type Property = z.infer<typeof property>;
type Choice = { label: string; value: string };

// Codex 0.167.2 Computer Use emits an empty standard MCP form with these
// consent options in metadata. The response's _meta.persist belongs to Codex;
// it must come from an explicit choice, never the Bot's command approval mode.
const consentMetadata = z.object({
  codex_approval_kind: z.literal("mcp_tool_call"),
  persist: z.array(z.enum(["session", "always"])).max(2).refine((values) => new Set(values).size === values.length).default([]),
  connector_name: z.string().max(256).optional(), subtitle: text.optional(),
  tool_name: z.string().max(256).optional(), riskLevel: z.string().max(100).optional(),
  tool_params_display: z.array(z.object({ display_name: z.string().max(256), value: z.unknown() })).max(20).optional(),
});
type ElicitationResponse = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown>; _meta?: { persist: "session" | "always" } };

function choices(field: Property): Choice[] | undefined {
  if (field.type === "boolean") return [{ label: "true", value: "true" }, { label: "false", value: "false" }];
  const source = field.type === "array"
    ? ("anyOf" in field.items ? field.items.anyOf.map((o) => ({ label: o.title || o.const, value: o.const })) : field.items.enum.map((value) => ({ label: value, value })))
    : field.type === "string" ? field.oneOf?.map((o) => ({ label: o.title || o.const, value: o.const })) ?? field.enum?.map((value, i) => ({ label: field.enumNames?.[i] || value, value })) : undefined;
  if (!source) return undefined;
  if (!source.length || source.some((o) => !o.label.trim() || o.label.trim().length > 1000) || new Set(source.map((o) => o.value)).size !== source.length) throw new Error("Invalid MCP choices");
  const normalized = source.map((o) => ({ ...o, label: o.label.trim() }));
  const labels = new Set<string>();
  return normalized.map((o) => {
    let label = o.label;
    if (normalized.filter((other) => other.label === label).length > 1) label += ` (${o.value})`;
    while (labels.has(label)) label += ` (${o.value})`;
    labels.add(label); return { ...o, label };
  });
}

// The shared card currently returns selected labels joined with ", ". Recover
// only an unambiguous segmentation; a comma inside a label is not a delimiter.
function selectedChoices(answer: string, options: Choice[]): Choice[] | undefined {
  const memo = new Map<number, Choice[][]>([[answer.length, [[]]]]);
  for (let offset = answer.length - 1; offset >= 0; offset--) {
    const results: Choice[][] = [];
    for (const o of options) {
      if (!answer.startsWith(o.label, offset)) continue;
      const end = offset + o.label.length;
      if (end < answer.length && (!answer.startsWith(", ", end) || end + 2 >= answer.length)) continue;
      for (const tail of memo.get(end < answer.length ? end + 2 : end) ?? []) {
        if (tail.length >= options.length) continue;
        results.push([o, ...tail]); if (results.length > 1) break;
      }
      if (results.length > 1) break;
    }
    if (results.length) memo.set(offset, results);
  }
  const matches = memo.get(0) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function scalar(answer: string, field: Property): string | number | undefined {
  if (field.type === "number" || field.type === "integer") {
    // JSON number grammar: do not interpret empty, hex or whitespace as zero.
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(answer)) return undefined;
    const value = Number(answer);
    if (!Number.isFinite(value) || field.type === "integer" && !Number.isSafeInteger(value) || field.minimum != null && value < field.minimum || field.maximum != null && value > field.maximum) return undefined;
    return value;
  }
  if (field.type !== "string") return undefined;
  const length = [...answer].length;
  if (field.minLength != null && length < field.minLength || field.maxLength != null && length > field.maxLength) return undefined;
  const format = field.format === "email" ? z.email() : field.format === "uri" ? z.url() : field.format === "date" ? z.iso.date() : field.format === "date-time" ? z.iso.datetime({ offset: true }) : undefined;
  return !format || format.safeParse(answer).success ? answer : undefined;
}

export function normalizeCodexMcpElicitation(value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return undefined;
  const request = parsed.data, entries = Object.entries(request.requestedSchema.properties);
  if (entries.length > 20) return undefined;
  const required = new Set(request.requestedSchema.required ?? []);
  if ([...required].some((key) => !Object.hasOwn(request.requestedSchema.properties, key))) return undefined;
  // Codex also uses an empty standard form for an MCP tool-call confirmation.
  // Empty fields do not constitute consent. Preserve only native persistence
  // choices, with the requested target and warning visible before submission.
  if (!entries.length) {
    const meta = request._meta;
    const isConsent = meta != null && typeof meta === "object" && "codex_approval_kind" in meta && meta.codex_approval_kind === "mcp_tool_call";
    const consent = isConsent ? consentMetadata.safeParse(meta) : undefined;
    if (consent && !consent.success) return undefined;
    const native = consent?.data;
    const options: { label: string; persist?: "session" | "always" }[] = [{ label: "允许本次" }];
    if (native?.persist.includes("session")) options.push({ label: "本会话允许", persist: "session" });
    if (native?.persist.includes("always")) options.push({ label: "始终允许", persist: "always" });
    const details = (native?.tool_params_display ?? []).map((item) => `${item.display_name}: ${typeof item.value === "string" ? item.value : JSON.stringify(item.value)}`);
    const question = [request.message.trim() || `${request.serverName} 请求确认`, native && `MCP 服务: ${request.serverName}`, native?.subtitle,
      native?.tool_name && `工具: ${native.tool_name}`, ...details,
      native?.riskLevel && `工具声明的风险级别: ${native.riskLevel}`,
      native?.persist.includes("always") && "选择“始终允许”会将持续授权选择交给 Codex 保存和管理。",
    ].filter(Boolean).join("\n\n").trim();
    if (question.length > 16_000) return undefined;
    return {
      threadId: request.threadId, turnId: request.turnId, itemId: undefined,
      toolInput: { questions: [{ question, header: `${native?.connector_name || request.serverName} · 确认`, options: [...options.map(({ label }) => ({ label })), { label: "拒绝" }], allowFreeText: false, required: true, multiSelect: false }] },
      response(decision: EngineApprovalDecision): ElicitationResponse {
        if (decision.behavior !== "allow") return { action: "cancel" };
        const input = z.object({ answers: z.record(z.string(), z.string()) }).safeParse(decision.updatedInput);
        const selected = input.success && Object.hasOwn(input.data.answers, question)
          ? options.find((option) => option.label === input.data.answers[question]) : undefined;
        return selected ? { action: "accept", content: {}, ...(selected.persist ? { _meta: { persist: selected.persist } } : {}) } : { action: "decline" };
      },
    };
  }
  const usedKeys = new Set<string>();
  let fields;
  try {
    fields = entries.map(([key, field]) => {
      const options = choices(field);
      if (field.type === "string" && field.enum && field.oneOf) throw new Error("Ambiguous MCP choices");
      let answerKey = `${request.message}\n${field.description || field.title || key}`.trim();
      while (usedKeys.has(answerKey)) answerKey += ` (${key})`;
      usedKeys.add(answerKey);
      return { key, field, options, answerKey };
    });
  } catch { return undefined; }
  return {
    threadId: request.threadId, turnId: request.turnId, itemId: undefined,
    toolInput: { questions: fields.map(({ key, field, options, answerKey }) => ({
      question: answerKey, header: `${request.serverName} · ${field.title || key}`,
      options: options?.map((o) => ({ label: o.label })) ?? [], allowFreeText: !options,
      required: required.has(key), multiSelect: field.type === "array",
      ...(field.type === "array" ? { minSelections: field.minItems ?? undefined, maxSelections: field.maxItems ?? undefined } : {}),
    })) },
    response(decision: EngineApprovalDecision): { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } {
      if (decision.behavior !== "allow") return { action: "cancel" };
      const input = z.object({ answers: z.record(z.string(), z.string().max(16_000)) }).safeParse(decision.updatedInput);
      if (!input.success) return { action: "decline" };
      const content: Record<string, unknown> = {};
      for (const { key, answerKey, field, options } of fields) {
        const answer = Object.hasOwn(input.data.answers, answerKey) ? input.data.answers[answerKey]!.trim() : "";
        if (!answer) { if (required.has(key)) return { action: "decline" }; else continue; }
        let result: unknown;
        if (field.type === "array") {
          const picks = selectedChoices(answer, options!);
          if (!picks || new Set(picks.map((p) => p.value)).size !== picks.length || field.minItems != null && picks.length < field.minItems || field.maxItems != null && picks.length > field.maxItems) return { action: "decline" };
          result = picks.map((p) => p.value);
        } else if (options) {
          const choice = options.find((o) => o.label === answer);
          if (!choice) return { action: "decline" };
          result = field.type === "boolean" ? choice.value === "true" : scalar(choice.value, field);
        } else result = scalar(answer, field);
        if (result === undefined) return { action: "decline" };
        Object.defineProperty(content, key, { value: result, enumerable: true });
      }
      return { action: "accept", content };
    },
  };
}

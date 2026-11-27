import { decodePiModel } from "../codex/pi-models.js";
import { PI_THINKING_LEVELS } from "../codex/pi-models.js";
import { effortValueSchema } from "../client-protocol/effort.js";
import type { ModelSettings } from "../client-protocol/model.js";
import type { PiSessionResult } from "../client-protocol/pi-session.js";
import { HostCliError } from "./client.js";

const piLevels = () => PI_THINKING_LEVELS.join(", ");

/** `--thinking` for a conversation, or `--effort` for a Pi/omp Bot: native levels, or `default`. */
export function piLevelArgumentError(flag: "--thinking" | "--effort", value: string, engine: "pi" | "omp" = "pi"): Error {
  const name = engine === "omp" ? "omp" : "Pi";
  return new Error(`${flag} ${value} 不是 ${name} 的思考强度。可选：${piLevels()}，或 default（${flag === "--thinking" ? "交还给 Bot 默认" : "跟随模型默认"}）。 / ${flag} ${value} is not ${engine === "omp" ? "an omp" : "a Pi"} thinking level. Use ${piLevels()}, or default.`);
}

/** `--effort` for a Bot of another engine: the values the settings API accepts. */
export function effortArgumentError(value: string): Error {
  const values = effortValueSchema.options.filter(option => option).join(", ");
  return new Error(`--effort ${value} 不是有效的思考强度。可选：${values}，或 default。 / --effort ${value} is not a valid effort. Use ${values}, or default.`);
}

/** One line for the owner when a conversation change came back `invalid` with its reason. */
export function piSessionRejectionNote(result: PiSessionResult, value: string | null): string | undefined {
  if (result.outcome !== "rejected" || !result.detail) return undefined;
  const { kind, allowed } = result.detail, levels = allowed?.length ? allowed.join(", ") : "";
  const provider = value ? decodePiModel(value)?.provider : undefined;
  switch (kind) {
    case "model_invalid": return `模型要写成 provider/model。 / A Pi model is written as provider/model.`;
    case "model_not_found": return `提供商 ${provider} 已登录，但没有 ${value} 这个模型。 / Provider ${provider} is signed in but has no model ${value}.`;
    case "provider_unavailable": return `提供商 ${provider} 没有可用凭据（或不存在）。在主机终端执行 pi auth login ${provider} 后再试。 / Provider ${provider} has no usable sign-in (or does not exist). Run pi auth login ${provider} on the host, then retry.`;
    case "model_unavailable": return `Pi 不能使用 ${value}，原因未能确认。 / Pi cannot use ${value}; the reason could not be confirmed.`;
    case "default_unavailable": return `Bot 默认模型或 Pi 默认模型当前不可用。 / The Bot's default model or Pi's default model is not available.`;
    case "thinking_invalid": return `思考强度可选：${piLevels()}。 / Thinking levels: ${piLevels()}.`;
    case "thinking_unsupported": return levels ? `当前模型不支持这个思考强度，可选：${levels}。 / The current model does not offer this level; it offers ${levels}.` : `当前模型不支持这个思考强度。 / The current model does not offer this level.`;
  }
}

/**
 * The settings API answers a refused Pi model with a code only. Say which part
 * was the problem from the catalog the CLI already read. The code stays first,
 * so scripts that look for it still find it.
 */
export function explainPiModelRejection(error: unknown, settings: ModelSettings, model: string, effort: string | undefined): unknown {
  if (!(error instanceof HostCliError) || (settings.engine !== "pi" && settings.engine !== "omp")) return error;
  const isOmp = settings.engine === "omp";
  const engineName = isOmp ? "omp" : "Pi";
  let text: string | undefined;
  if (error.code === "model_unavailable") {
    const provider = decodePiModel(model)?.provider ?? model;
    const signedIn = settings.choices.some(choice => choice.id && (choice.provider ?? decodePiModel(choice.id)?.provider) === provider);
    if (isOmp) {
      text = signedIn
        ? `omp 的模型目录里没有 ${model}：提供商 ${provider} 已登录，但没有这个模型。用 bots model 查看可选模型。 / omp's catalog has no ${model}: provider ${provider} is signed in but has no such model. Run bots model to list the choices.`
        : `omp 的模型目录里没有 ${model}：提供商 ${provider} 没有可用凭据（或不存在）。在运行 Bot 的主机终端运行 omp 并执行 /login 后再试。 / omp's catalog has no ${model}: provider ${provider} has no usable sign-in (or does not exist). Run omp and /login on the host, then retry.`;
    } else {
      text = signedIn
        ? `${engineName} 的模型目录里没有 ${model}：提供商 ${provider} 已登录，但没有这个模型。用 bots model 查看可选模型。 / ${engineName}'s catalog has no ${model}: provider ${provider} is signed in but has no such model. Run bots model to list the choices.`
        : `${engineName} 的模型目录里没有 ${model}：提供商 ${provider} 没有可用凭据（或不存在）。在运行 Bot 的主机终端执行 pi auth login ${provider} 后再试。 / ${engineName}'s catalog has no ${model}: provider ${provider} has no usable sign-in (or does not exist). Run pi auth login ${provider} on the host, then retry.`;
    }
  } else if (error.code === "model_effort_incompatible") {
    const levels = (settings.choices.find(choice => choice.id === model)?.efforts ?? []).filter(level => level);
    const asked = effort || settings.effort || "default";
    text = levels.length
      ? `${model} 不支持思考强度 ${asked}。可选：${levels.join(", ")}，或 default（跟随模型默认）。 / ${model} does not offer ${asked}. It offers ${levels.join(", ")}, or default.`
      : `${model} 不提供可选的思考强度，请用 --effort default。 / ${model} offers no thinking levels; use --effort default.`;
  }
  if (!text) return error;
  error.message = `${error.code}: ${text}`;
  return error;
}

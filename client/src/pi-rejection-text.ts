import { decodePiModel } from "../../src/codex/pi-models.js";
import type { PiSessionResult } from "../../src/client-protocol/pi-session.js";
import { formatList, t } from "./i18n.js";

/**
 * Why Pi refused a model or thinking choice, in the owner's words. Each
 * function returns undefined when the Host gave no reason it can name (an
 * older Host, another engine), so the caller keeps its existing sentence.
 */

const levelList = (levels: readonly string[]) => formatList(levels.filter(level => level));
const providerOf = (model: string) => decodePiModel(model)?.provider;

/** A refused conversation change, from the reason a current Host attaches to `invalid`. */
export function piSessionRejectionText(result: PiSessionResult, command: { action: "model" | "thinking"; value: string | null }): string | undefined {
  const detail = result.outcome === "rejected" && result.reason === "invalid" ? result.detail : undefined;
  if (!detail) return undefined;
  const provider = command.value ? providerOf(command.value) : undefined;
  switch (detail.kind) {
    case "model_invalid": return t("Pi 模型要写成 provider/model，请从列表选择。");
    case "model_not_found": return provider ? t("提供商 {0} 已登录，但没有 {1} 这个模型。请重新读取后选择。", provider, command.value!) : undefined;
    case "provider_unavailable": return provider ? t("提供商 {0} 当前没有可用凭据（或不存在）。请在运行 Bot 的主机终端执行 pi auth login {0}，然后重新读取。", provider) : undefined;
    case "model_unavailable": return t("Pi 当前不能使用这个模型，原因未能确认。请重新读取后选择。");
    case "default_unavailable": return undefined;
    case "thinking_invalid": return detail.allowed?.length ? t("这不是 Pi 的思考强度。可选：{0}。", levelList(detail.allowed)) : undefined;
    case "thinking_unsupported":
      if (!detail.allowed?.length) return undefined;
      return command.value === null
        ? t("Bot 默认思考强度不适用于当前对话模型。这个模型可选：{0}。请选择其中一档，或调整 Bot 默认设置。", levelList(detail.allowed))
        : t("当前模型不支持这个思考强度。可选：{0}。", levelList(detail.allowed));
  }
}

type Choice = { id: string; provider?: string; efforts: readonly string[] };

/**
 * A refused Bot default model for a Pi Bot, read against the catalog the dialog
 * already has: the settings API answers with a code only. Pi lists only signed-in
 * providers, so a provider absent from the catalog is the sign-in case.
 */
export function piModelSettingsRejectionText(code: string, context: { engine?: string; model: string; effort: string; choices: readonly Choice[] }): string | undefined {
  if ((context.engine !== "pi" && context.engine !== "omp") || !context.model) return undefined;
  if (code === "model_unavailable") {
    const provider = providerOf(context.model);
    if (!provider) return undefined;
    const signedIn = context.choices.some(choice => choice.id && (choice.provider ?? providerOf(choice.id)) === provider);
    if (context.engine === "omp") {
      return signedIn
        ? t("提供商 {0} 已登录，但 omp 的模型目录里没有 {1}。请从列表选择，或检查模型 ID。", provider, context.model)
        : t("提供商 {0} 当前没有可用凭据（或不存在）。请在运行 Bot 的主机终端运行 omp 并执行 /login，然后重新读取。", provider);
    }
    return signedIn
      ? t("提供商 {0} 已登录，但 Pi 的模型目录里没有 {1}。请从列表选择，或检查模型 ID。", provider, context.model)
      : t("提供商 {0} 当前没有可用凭据（或不存在）。请在运行 Bot 的主机终端执行 pi auth login {0}，然后重新读取。", provider);
  }
  if (code === "model_effort_incompatible") {
    // Only for a model the catalog lists: an older Host also used this code for an unknown model.
    const choice = context.choices.find(item => item.id === context.model);
    // The refused level is not offered back: the dialog's catalog listed it, the Host's did not.
    const levels = choice?.efforts.filter(level => level && level !== context.effort) ?? [];
    if (!choice || !context.effort) return undefined;
    return levels.length
      ? t("{0} 不支持思考强度 {1}。可选：{2}，或跟随默认。", context.model, context.effort, levelList(levels))
      : t("{0} 不提供可选的思考强度，请选择跟随默认。", context.model);
  }
  return undefined;
}

/** A refused Bot default thinking level for a Pi Bot, with the levels its current model offers. */
export function piEffortSettingsRejectionText(code: string, context: { engine?: string; effort: string; choices: readonly string[] }): string | undefined {
  if ((context.engine !== "pi" && context.engine !== "omp") || code !== "effort_incompatible" || !context.effort) return undefined;
  const levels = context.choices.filter(level => level && level !== context.effort);
  return levels.length ? t("当前模型不支持思考强度 {0}。可选：{1}，或跟随默认。", context.effort, levelList(levels)) : undefined;
}

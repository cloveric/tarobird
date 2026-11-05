/** CLI-generated API failures can use an assistant envelope. They are not
 * model output: publishing them makes an entirely failed turn look partial. */
export function claudeAssistantError(frame: {
  type?: string; error?: unknown; isApiErrorMessage?: boolean; is_error?: boolean;
  message?: { content?: Array<{ type?: string; text?: string }> };
}): string | undefined {
  if (frame.type !== "assistant" || !(frame.error || frame.isApiErrorMessage === true || frame.is_error === true)) return undefined;
  return frame.message?.content?.filter(item => item.type === "text" && typeof item.text === "string")
    .map(item => item.text).join("").trim()
    || (frame.error === "authentication_failed" || frame.error === "authentication_error"
      ? "Claude authentication failed" : "Claude reported an API error");
}

/** Preserve engine provenance for actionable, transport-neutral errors. */
export function claudeError(message: string): Error {
  const error = new Error(message);
  error.name = "ClaudeError";
  return error;
}

export function claudeResultRepeatsError(error: string | undefined, result: string | undefined): boolean {
  if (!error) return false;
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  return !result?.trim() || normalize(result) === normalize(error);
}

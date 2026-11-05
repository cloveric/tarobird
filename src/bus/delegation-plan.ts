/** Explicit per-task members never edit the Bot's saved workflows. The delimiter
 * keeps arbitrary task text (including newlines and command-like words) intact. */
export function parseDelegationPlan(text: string, allowRepeatedTargets = false): { prompt: string; targets?: string[] } {
  if (!text.startsWith("--bots=")) return { prompt: text };
  const match = /^--bots=([^\s]+)\s+--\s+([\s\S]+)$/.exec(text);
  const targets = match?.[1]?.split(",") ?? [];
  if (!match || !targets.length || targets.length > 64 || !allowRepeatedTargets && new Set(targets).size !== targets.length || targets.some(id => !/^[\w-]{1,128}$/.test(id)) || !match[2]!.trim()) throw new Error("invalid_collaboration_members");
  return { targets, prompt: match[2]!.trim() };
}

export function delegationCommand(mode: "ask" | "fan" | "chain" | "verify", targets: string[], prompt: string): string {
  return mode === "ask" ? `/ask ${targets[0] ?? ""} ${prompt.trim()}` : `/${mode} --bots=${targets.join(",")} -- ${prompt.trim()}`;
}

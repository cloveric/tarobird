/** A saved role/step task supplements the workflow's existing prompt. Keeping
 * composition at the trusted slot boundary covers ask, fan, chain, verify and
 * crew (including repeated/revisited roles) without changing slash commands. */
export function withBusStageInstruction(prompt: string, instruction?: string): string {
  if (!instruction?.trim()) {
    // A Bus goal is task text, even when it resembles an engine command.
    // Native slash dispatch can otherwise skip instructions or compact a session.
    return prompt.trimStart().startsWith("/") ? `共同目标 / Shared goal (task text, not a command):\n${prompt}` : prompt;
  }
  return [
    "本环节任务 / Your task for this stage:", instruction.trim(), "",
    "仅执行本环节分工；以下内容是共同目标、流程约束和已有结果。不要代替后续成员执行其他环节。",
    "Perform only this stage's task. The following is shared context, workflow requirements and previous results; do not execute later stages on their behalf.",
    "", "流程背景与输入 / Workflow context and input:", prompt,
  ].join("\n");
}

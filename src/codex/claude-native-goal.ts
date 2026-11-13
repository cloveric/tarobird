/** Claude Code's native `/goal` as seen over stream-json stdio.
 *
 * `/goal <condition>` registers a session-scoped Stop hook whose evaluator
 * model decides, after every turn, whether Claude may stop. Everything here is
 * verified with isolated Claude Code 2.1.323 probes (real CLI, local fake
 * provider, no real model); docs: https://code.claude.com/docs/en/goal.
 *
 * - The CLI reads a slash command from character 0 of the LAST text block of a
 *   user message; earlier blocks of the same message reach the model with it.
 *   Text after the command is part of the condition.
 * - `/goal` alone answers the current state and `/goal clear` (or
 *   stop/off/reset/none/cancel) removes it; both are local, with no model call.
 *   There is no `status` verb: `/goal status` sets the condition "status".
 * - The stream carries the command's own reply (`local_command_run`), every
 *   "not met" verdict (a synthetic `Stop hook feedback` user message) and the
 *   consecutive-block cap. It carries nothing when the evaluator ends the goal,
 *   whether as met or as impossible, and `active_goal` exists only under
 *   CLAUDE_CODE_REMOTE. So a finished turn can be known to have a goal still
 *   set, or none any more; never that the goal was achieved.
 * - An interrupt leaves the goal set, and resuming a session restores it.
 *
 * This module only parses and formats; it never writes to a process. */

export type ClaudeGoalCommand = { kind: "set"; condition: string } | { kind: "status" } | { kind: "clear" };

export type ClaudeGoalRejectionReason = "too_long" | "hooks_restricted" | "hooks_unknown" | "untrusted_workspace" | "relayed";

/** One native reply to a `/goal` command, read from its local stdout. */
export type ClaudeGoalStdout =
  | { kind: "set"; condition: string }
  | { kind: "cleared"; condition: string }
  | { kind: "none" }
  | { kind: "active"; condition: string; evaluations: number; lastReason?: string }
  | { kind: "rejected"; reason: ClaudeGoalRejectionReason; message: string }
  | { kind: "unknown"; text: string };

/** What a host turn can truthfully say about the native goal once it ends:
 * only what Claude itself stated on the stream or answered to one `/goal`.
 * `none` means no goal is set now; it never means the goal was achieved. */
export type ClaudeNativeGoalReceipt = {
  /** This turn's own `/goal` command; absent when an ordinary turn merely ran under a goal. */
  command?: ClaudeGoalCommand["kind"];
  /** Claude answered that command as its native local command. */
  acknowledged: boolean;
  /** Claude refused to set the goal (its own message), e.g. hooks are restricted. */
  rejection?: { reason: ClaudeGoalRejectionReason | "unknown"; message: string };
  state: "active" | "none" | "unverified";
  /** The goal's condition, as Claude reports it. */
  objective?: string;
  /** `/goal clear` removed a goal that was set. */
  cleared?: boolean;
  /** Turns the native evaluator has judged, as Claude counts them. */
  evaluations?: number;
  lastReason?: string;
  /** The turn ended because the evaluator kept blocking it; the goal stays set. */
  capped?: boolean;
  verifiedBy: Array<"command" | "stream" | "query">;
};

/** Evidence as Claude reports it, during the turn and once at its end. The
 * fields are those of a shared `native_goal` stream event. */
export type ClaudeNativeGoalUpdate = {
  /** accepted/rejected: Claude's reply to a new goal. active: a "not met"
   * verdict, the block cap, or the end of a turn with the goal still set.
   * none/unverified: only at the end of a turn. */
  state: "accepted" | "rejected" | "active" | "none" | "unverified";
  objective?: string;
  /** Claude's own words: the refusal, or the evaluator's reason. */
  message?: string;
  evaluations?: number;
  capped?: boolean;
};

/** Optional Claude-only additions to a turn's input. */
export type ClaudeNativeGoalTurnInput = { onNativeGoal?: (update: ClaudeNativeGoalUpdate) => void };

export const CLAUDE_GOAL_BLOCK_CAP_NOTIFICATION = "stop-hook-block-cap";

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);

/** Reads a turn's text as a native `/goal` command, with Claude's own argument
 * grammar. Anything else, including `/goalposts` or `/Goal`, is ordinary text. */
export function parseClaudeGoalCommand(text: string): ClaudeGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const args = match[1]?.trim() ?? "";
  if (!args) return { kind: "status" };
  if (CLEAR_ALIASES.has(args.toLowerCase())) return { kind: "clear" };
  return { kind: "set", condition: args };
}

/** The user-message content for one command. The command is always the whole
 * last block; `context` (private turn guidance, attachments) precedes a new
 * goal so the model still receives it, and is not sent with a local command,
 * which calls no model and would only leave stale guidance in the session. */
export function claudeGoalFrameContent(command: ClaudeGoalCommand, context: string): Array<{ type: "text"; text: string }> {
  if (command.kind === "status") return [{ type: "text", text: "/goal" }];
  if (command.kind === "clear") return [{ type: "text", text: "/goal clear" }];
  return [...(context.trim() ? [{ type: "text" as const, text: context }] : []), { type: "text", text: `/goal ${command.condition}` }];
}

/** The stdout inside a `local_command_source` wrapper, when it is one. */
export function claudeLocalCommandStdout(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  const match = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(source);
  return match ? match[1] : undefined;
}

export function parseClaudeGoalStdout(stdout: string): ClaudeGoalStdout {
  const text = stdout.trim();
  if (text.startsWith("Goal set: ")) return { kind: "set", condition: text.slice("Goal set: ".length) };
  if (text.startsWith("Goal cleared: ")) return { kind: "cleared", condition: text.slice("Goal cleared: ".length) };
  if (text === "No goal set" || text.startsWith("No goal set. ")) return { kind: "none" };
  const active = /^Goal active: ([\s\S]*?) \((not yet evaluated|(\d+) turns?)\)(?:\nLast check: ([\s\S]*))?$/.exec(text);
  if (active) {
    return { kind: "active", condition: active[1]!, evaluations: active[3] ? Number(active[3]) : 0, ...(active[4]?.trim() ? { lastReason: active[4].trim() } : {}) };
  }
  const rejection = (reason: ClaudeGoalRejectionReason): ClaudeGoalStdout => ({ kind: "rejected", reason, message: text });
  if (/^Goal condition is limited to \d+ characters/.test(text)) return rejection("too_long");
  if (text.startsWith("/goal is only available in trusted workspaces")) return rejection("untrusted_workspace");
  if (text.startsWith("/goal can't run yet")) return rejection("hooks_unknown");
  if (text.startsWith("/goal can't run while hooks are restricted")) return rejection("hooks_restricted");
  if (text.startsWith("This message was relayed from") && text.includes("/goal")) return rejection("relayed");
  return { kind: "unknown", text };
}

/** A blocking Stop hook's feedback as Claude hands it to the model. The label
 * is the hook itself: for the goal evaluator, the condition. With a known
 * condition only that exact goal matches, never another Stop hook. */
export function parseClaudeGoalFeedback(text: string, condition?: string): { condition: string; reason: string } | null {
  const prefix = "Stop hook feedback:\n[";
  if (!text.startsWith(prefix)) return null;
  if (condition !== undefined) {
    const label = `${prefix}${condition}]: `;
    return text.startsWith(label) ? { condition, reason: text.slice(label.length).trim() } : null;
  }
  const match = /^Stop hook feedback:\n\[([\s\S]*?)\]: ([\s\S]*)$/.exec(text);
  return match ? { condition: match[1]!, reason: match[2]!.trim() } : null;
}

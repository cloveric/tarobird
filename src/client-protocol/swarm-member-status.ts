import type { SwarmMemberState } from "./engine-tasks.js";

const labels = {
  working: { en: "Working", zh: "工作中" },
  waiting: { en: "Waiting", zh: "等待中" },
  killed: { en: "Killed", zh: "已终止" },
  done: { en: "Completed", zh: "已完成" },
  failed: { en: "Failed", zh: "失败" },
  paused: { en: "Paused", zh: "受配额暂停" },
  unknown: { en: "Status unconfirmed", zh: "状态待确认" },
} satisfies Record<SwarmMemberState, { en: string; zh: string }>;

export function isTerminalSwarmMemberState(state: SwarmMemberState): boolean {
  return state === "killed" || state === "done" || state === "failed";
}

export function swarmMemberStatusCopy(state: SwarmMemberState, active = true): { en: string; zh: string } {
  if (!active && !isTerminalSwarmMemberState(state)) {
    return { en: "Swarm ended, member outcome unconfirmed", zh: "Swarm 已结束，成员结果未确认" };
  }
  return labels[state];
}

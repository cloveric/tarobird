import type { CronJobRecord } from "../state/cron-store-schema.js";

export function createFreshCronSessionId(job: CronJobRecord): string {
  // Every engine adapter recognizes `tarobot-` as the shared logical-session
  // marker for "start fresh" rather than attempting to resume this synthetic id.
  return `tarobot-cron-${job.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

import type { CronStore } from "../state/cron-store.js";
import type { CronScheduler } from "./cron-scheduler.js";

/** Host-owned schedule ports; lifecycle belongs to Gateway. */
export interface CronRuntime { store: CronStore; scheduler: CronScheduler; }

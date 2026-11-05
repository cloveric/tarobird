import type { ScheduleSettings } from "../../src/client-protocol/schedules.js";
import { t } from "./i18n.js";

/** Describe only schedules whose cadence is exact; other cron syntax stays custom. */
export function scheduleCadence(timing: ScheduleSettings["timing"]): string {
  if (timing.kind === "once") return t("只执行一次");
  const expression = timing.expression.trim().replace(/\s+/g, " ");
  if (expression === "* * * * *") return t("每分钟");
  if (expression === "0 * * * *") return t("每小时");
  const interval = /^\*\/(\d+) \* \* \* \*$/.exec(expression);
  const minutes = Number(interval?.[1]);
  // */45 restarts at each hour: it is not a uniform 45-minute interval.
  if (minutes > 0 && minutes < 60 && 60 % minutes === 0) return minutes === 1 ? t("每分钟") : t("每 {0} 分钟", minutes);
  const clock = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(expression);
  if (!clock || Number(clock[1]) > 59 || Number(clock[2]) > 23) return t("自定义 Cron");
  const time = `${clock[2]!.padStart(2, "0")}:${clock[1]!.padStart(2, "0")}`;
  if (clock[3] === "*") return t("每天 {0}", time);
  if (clock[3] === "1-5") return t("工作日 {0}", time);
  const day = [t("周日"), t("周一"), t("周二"), t("周三"), t("周四"), t("周五"), t("周六")][Number(clock[3])];
  return t("每{0} {1}", day, time);
}

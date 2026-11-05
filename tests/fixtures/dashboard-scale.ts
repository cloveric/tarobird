/** Synthetic state only; no model sessions, real chat IDs or user files. */
export function dashboardScaleJobs(count = 5000) {
  const at = "2026-10-03T00:00:00.000Z";
  return Array.from({ length: count }, (_, index) => ({
    id: index.toString(16).padStart(8, "0"), channel: "lark" as const, chatId: 1, userId: 1,
    conversationKey: "lark:gw_scale", cronExpr: `${index % 60} ${index % 24} * * *`,
    timezone: index % 2 ? "Asia/Shanghai" : "UTC", enabled: index % 2 === 0,
    prompt: `Synthetic reminder ${index}`, description: `定时任务 ${String(index).padStart(5, "0")}`,
    createdAt: at, updatedAt: at,
    runHistory: Array.from({ length: 10 }, () => ({ ranAt: at, success: true })),
  }));
}

import { inspectHubService, type DrainedStopGuard } from "../hub/service.js";
import { randomUUID } from "node:crypto";
import type { DrainBlocker } from "../gateway/control.js";
import { liveHostWork, type HostUpdateUnfinishedRun } from "./update.js";

function drainOwnedError(expiresAt?: number): Error {
  const expiry = expiresAt && Number.isFinite(expiresAt) ? `（租约到期：${new Date(expiresAt).toISOString()}）` : "";
  return Object.assign(new Error(`主机正在为另一项操作收尾${expiry}。请等待租约到期后重试，或执行 tarobot drain-cancel 取消原收尾操作。`), { code: "host_drain_owned" });
}
function drainWaitDetail(blockers?: DrainBlocker[]): string {
  if (!blockers?.length) return "";
  const names: Record<DrainBlocker["type"], string> = { run: "运行中的任务", approval: "待审批操作", async_question: "待回答的异步问题", native_choice: "待回答的原生选择", batch: "待合并消息", queue: "排队任务", cron: "定时任务", bus: "协作任务", transport: "消息交付", worker: "工作进程未确认空闲" };
  const details = blockers.slice(0, 8).map(item => `Bot ${item.botId}${item.conversationKey ? ` / 会话 ${item.conversationKey}` : ""}：${names[item.type]} ${item.count} 项`).join("；");
  const interactive = blockers.some(item => ["approval", "async_question", "native_choice"].includes(item.type));
  return ` 等待原因：${details}${blockers.length > 8 ? `；另有 ${blockers.length - 8} 项等待原因` : ""}。可用 tarobot bots list 核对 Bot 名称。${interactive ? "请在 App 打开对应 Bot 和会话处理待回答的问题或审批，再重试；原生问题尚不能在重启后恢复。" : "请在对应 Bot 的会话中检查任务进度，再重试。"}`;
}
function legacyWorkDetail(version: string | undefined, work: HostUpdateUnfinishedRun[]): string {
  const kind = (item: HostUpdateUnfinishedRun) => item.status === "dispatched" ? "已开始处理的消息" : ["pending", "streaming"].includes(item.status) ? `前台回复${item.phase ? `（${item.phase}）` : ""}` : `后台任务（${item.phase ?? item.status}）`;
  const details = work.slice(0, 8).map(item => `Bot ${item.botId} / 对话 ${item.conversationId}：${kind(item)}`).join("；");
  return ` 等待原因：旧版主机（${version ?? "未报告版本"}）收尾时不会等待原生后台任务，前台结束即退出，因此在已知任务结算前未发起收尾。${details}${work.length > 8 ? `；另有 ${work.length - 8} 项` : ""}。请在对应对话核对这些任务，结束后重试。若确认已不在运行（残留卡片）或决定中断，可执行 tarobot restart --force 明确中断该主机的全部任务并重启（重新接入的 worker 会把遗留的活动卡片结算为已中断），然后重试。`;
}
/** Hosts before 0.1.454 report idle while Claude native background work runs,
 * and their supervisor then commits worker shutdown. Unknown versions are old. */
function drainCountsNativeBackground(version?: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "")?.slice(1).map(Number);
  if (!parts) return false;
  const different = parts.findIndex((part, index) => part !== [0, 1, 454][index]);
  return different < 0 || parts[different]! > [0, 1, 454][different]!;
}

/** Keep ownership alive across post-drain configuration and graceful stop.
 * If this CLI dies, the Hub lease expires independently and restores workers. */
export function keepHostDrainLease(directory: string, drainId: string): { stop(): void; check(): void } {
  let stopped = false, running = false, failure: Error | undefined;
  const timer = setInterval(() => {
    if (stopped || running || failure) return;
    running = true;
    void inspectHubService(directory, "drain-renew", { drainId }).then(status => {
      if (!status.running) { stopped = true; clearInterval(timer); return; }
      if (status.controlError || !status.draining || status.drainId !== drainId) throw new Error(status.controlError ?? "host_drain_lease_lost");
    }).catch(error => { failure = error instanceof Error ? error : new Error(String(error)); }).finally(() => { running = false; });
  }, 5000); timer.unref();
  return { stop() { stopped = true; clearInterval(timer); }, check() { if (failure) throw failure; } };
}
export async function captureDrainedStopGuard(directory: string, drainId?: string): Promise<DrainedStopGuard | undefined> {
  const status = await inspectHubService(directory);
  if (!status.running) return;
  if (!drainId || status.drainId !== drainId) throw drainOwnedError(status.drainLeaseExpiresAt);
  if (!status.drained || !status.controlCapabilities?.includes("drained-stop")) throw new Error("host_drain_stop_unsupported_or_unfinished");
  return { drainId, pid: status.pid, publicKey: status.publicKey };
}

export async function waitForHostIdle(directory: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) throw new Error("等待已取消，未强制停止或更新。");
  const initial = await inspectHubService(directory);
  if (!initial.running) return;
  if (signal?.aborted) throw new Error("等待已取消，未强制停止或更新。");
  if (initial.drained === undefined || !initial.controlCapabilities?.includes("drain-renew")) throw new Error("当前主机不支持带租约的安全等待。请在任务结束后手动停止旧版主机，再启动新版。");
  if (initial.draining) throw drainOwnedError(initial.drainLeaseExpiresAt);
  const waitStarted = Date.now();
  if (!drainCountsNativeBackground(initial.version)) {
    // Its drain cannot see native background work, and foreground work it waits
    // for may launch some; request drain only once known work has settled. The
    // host keeps accepting work throughout and nothing is stopped on timeout.
    for (;;) {
      const work = await liveHostWork(directory);
      // A cancellation during the read must not be followed by a drain request.
      if (signal?.aborted) throw new Error("等待已取消，未强制停止或更新。");
      if (!work.length) break;
      const remaining = waitStarted + timeoutMs - Date.now();
      if (remaining <= 0) throw Object.assign(new Error(`任务仍未收尾，未强制停止或更新。${legacyWorkDetail(initial.version, work)}`), { code: "host_drain_busy" });
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
      if (signal?.aborted) throw new Error("等待已取消，未强制停止或更新。");
    }
  }
  const budget = Math.max(0, timeoutMs - (Date.now() - waitStarted));
  const drainId = `wait_${randomUUID()}`;
  try {
    const requested = drainId ? await inspectHubService(directory, "drain", { drainId }) : initial;
    if (requested.running && requested.controlError) throw requested.controlError === "host_drain_owned" ? drainOwnedError(requested.drainLeaseExpiresAt) : new Error(requested.controlError);
    const deadline = Date.now() + budget; let renewAt = Date.now() + 5000;
    for (;;) {
      if (signal?.aborted) throw new Error("等待已取消，未强制停止或更新。");
      if (drainId && Date.now() >= renewAt) {
        const renewed = await inspectHubService(directory, "drain-renew", { drainId });
        if (renewed.running && renewed.controlError) throw new Error(renewed.controlError);
        renewAt = Date.now() + 5000;
      }
      const status = await inspectHubService(directory);
      if (!status.running) return drainId;
      if (!status.draining || (drainId && status.drainId !== drainId)) throw new Error("收尾操作已被其他请求改变，未强制停止或更新。");
      if (status.drained) return drainId;
      if (Date.now() >= deadline) throw Object.assign(new Error(`任务仍未收尾，未强制停止或更新。${drainWaitDetail(status.drainBlockers)}`), { code: "host_drain_busy" });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    // A timed-out CLI invocation must not leave its host silently refusing work.
    // An earlier explicit drain belongs to its caller and must remain untouched.
    if (drainId) {
      const resumed = await inspectHubService(directory, "drain-cancel", { drainId });
      if (resumed.running && resumed.controlError === "host_drain_owned") throw new Error(`${String(error)} 其他请求的收尾操作保持不变。`);
      if (resumed.running && (resumed.controlError || resumed.draining)) throw new Error(`${String(error)} 恢复接收任务失败；请执行 host drain-cancel。`);
      const wrapped = new Error(`${error instanceof Error ? error.message : String(error)} 已恢复接收任务。`);
      if (error && typeof error === "object" && "code" in error && error.code === "host_drain_busy") Object.assign(wrapped, { code: error.code });
      throw wrapped;
    }
    throw error;
  }
}

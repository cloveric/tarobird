import { BusProtocolError } from "./bus-protocol.js";

/** Durable logs keep the code and original diagnostic, apart from UI copy. */
export function busFailureDetail(error: unknown): string {
  return `${error instanceof BusProtocolError ? `[${error.code}] ` : ""}${error instanceof Error ? error.message : String(error)}`;
}

/** Known transport failures only. Unknown engine errors retain their detail. */
export function describeBusFailure(error: unknown, locale: "zh" | "en"): string {
  const detail = error instanceof Error ? error.message : String(error);
  const code = error instanceof BusProtocolError ? error.code : detail.match(/^\[([a-z_]+)\]/)?.[1] ?? (/^agent_bus_[a-z_]+$/.test(detail) ? detail : undefined);
  if (locale !== "zh") return detail;
  const messages: Record<string, string> = {
    agent_bus_interrupted: "主机恢复后未能确认该环节的结果，未自动重发。请检查成员记录。",
    agent_bus_stage_unfinished: "协作已结束，此环节没有完成记录，未自动重发。",
    agent_bus_not_executed: "此环节未执行，未自动重发。",
    timeout: "成员未在设定时限内返回，已请求停止，未自动重发。请检查已有结果。",
    cancelled: "本次协作已停止，未自动重发。",
    connection_lost: "等待成员结果时连接中断，执行结果尚未确认，未自动重发。请先检查成员记录。",
    response_too_large: "成员返回的结果超过传输大小上限，未自动重发。请检查成员记录或减小交付内容。",
    request_too_large: "本环节任务、共同背景和上一步结果合计超过传递上限，本环节未发送。请缩短输入内容。",
    invalid_response: "成员返回的结果无法解析，执行结果尚未确认，未自动重发。请先检查成员记录。",
    server_busy: "成员当前繁忙，协作未完成。请查看已有记录，稍后再启动。",
    instance_unavailable: "成员服务未运行或无法连接，本次任务未发送给该成员。",
  };
  return code && messages[code] || detail;
}

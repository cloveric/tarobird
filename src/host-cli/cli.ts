import { screenCommand } from "./screens.js";
import { runWorkbenchCommand } from "./workbench.js";
import { runConversationsCommand } from './conversations.js';
import { runBackupsCommand } from "./backups.js";
import { runFoldersCommand } from './folders.js';
import { engineSettingsCommand } from "./engine-settings.js";
import { widgetSettingsCommand } from "./widget-settings.js";
import { runWidgetsCommand, WIDGET_PUBLISH_USAGE } from "./widgets.js";
import { voiceCommand } from "./voice.js";
import { QwenAsrSetup } from "../runtime/qwen-asr-setup.js";
import { assertWindowsRuntimeAdmission } from "./windows-state-admission.js";
import { planDirectoryRecovery, verifyDirectoryRecovery } from "./directory-recovery.js";
import { runBotMessagesCommand } from "./bot-messages.js";
import { allowedEnginesOption, runTicketsCommand } from "./tickets.js";
import { runAttachmentsCommand } from "./attachments.js";
import { runMessagesCommand } from "./messages.js";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lstat, open, unlink, writeFile } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { exists, resolveHostDirectory } from "./paths.js";
import { initializeHost, requireInitialized, readHostProfile } from "./setup.js";
import { inspectHost, inspectEngines } from "./doctor.js";
import { desktopHost } from "../hub/desktop.js";
import { hubServiceCommand, inspectHubService } from "../hub/service.js";
import { assertHostSupervisor, assertWindowsHostLauncher, enableManagedServiceOnLogin, installManagedService, managedServiceStatus, reassertManagedServiceIntent, refreshManagedServiceRuntime, uninstallManagedService } from "./service-manager.js";
import { LocalHostClient, resetCliController } from "./client.js";
import { withHostManagement } from "./management.js";
import { runQueueCommand } from "./queue.js";
import { runTasksCommand } from "./tasks.js";
import { runSteeringCommand, steeringReceiptHint, steeringCommandFailure, steeringCommandNotice } from "./steering.js";
import { runSideCommand } from "./side.js";
import { runChangesCommand } from "./changes.js";
import { runAgentBusCommand } from "./agent-bus.js";
import { runGroupsCommand } from "./groups.js";
import { executeNetworkTransfer, exportNetworkTransfer } from "./network-transfer.js";
import { HostNetwork, verifyCliNetworkMembership, verifyCliNetworkProposal } from "./network-cli.js";
import { formatLocalRoutes } from "./network-local.js";
import { tailscaleDiagnostic } from "./tailscale-status.js";
import { isTailscaleAddress } from "../hub/network.js";
import { networkCanonical, sharedRoutesSchema, type NetworkCommand } from "../client-protocol/private-network.js";
import { routesSchema, type Route } from "../client-protocol/routes.js";
import { createBotSchema } from "../client-protocol/bots.js";
import { hashSecret } from "../hub/auth.js";
import { waitForHostIdle, keepHostDrainLease, captureDrainedStopGuard } from "./lifecycle.js";
import { captureUpdateRecovery, recoverUnchangedAutostart, recoverUnchangedRuntime } from "./update-recovery.js";
import { runHostRuntime, isCurrentHostRuntime } from "./foreground.js";
import { hostPairingLink, terminalPairingQr } from "./pairing.js";
import { assertHostRuntimeCompatible } from "./schema-guard.js";
import { stageHostUpdate, preflightHostUpdate, hostUpdateStatus, resolveHostRuntime, activateHostUpdate, rollbackHostUpdate, markHostUpdateHealthy, inspectHostUpdateRecovery, pruneHostUpdates } from "./update.js";

export const HOST_CLI_HELP = `TaroBird — 同一台主机，桌面与命令行共用

首次使用
  tarobot init --name "Mac mini"        设置主机名，不会启动或加入网络
  tarobot service install               安装当前用户的后台服务
  tarobot start                         启动主机，登记本机 CLI 控制器
  tarobot pair --lan                    开启局域网 HTTPS 并显示连接二维码（供手机或电脑扫描）
  tarobot devices pending               查看等待批准的设备
  tarobot devices approve 12345678      核对新设备显示的 8 位码后批准

日常管理（也可写为 tarobot host <命令>）
  run | start | stop | restart | status | logs | doctor | enroll [--reset --yes]
  name <名称>                           修改本机在网络内的名称
  stop | restart [--wait SECONDS] [--force]
  drain | drain-cancel                  收尾等待 / 恢复接收新工作（租约 30 秒）
  service install | uninstall | status
  bots list | catalog | create --name N --engine E [--model M --effort E]
    [--workspace DIRECTORY] [--permission CHOICE] [--request-id ID]
    权限选项以 bots catalog 为准；Claude 还支持 claude-auto / claude-accept-edits。
    [--role dispatcher [--dispatch-mode ask|auto] [--max-concurrent N] [--allow ENGINE,ENGINE|all]]
    --role dispatcher 创建幕僚长（Chancellor）：只有一个对话，把任务拆成工单，直接交给本机已装的 CLI 执行；只能在创建时选择。
  bots status ID | restart ID | rename ID --name N --expected-name OLD
  bots chrome ID                        读取 Claude 浏览器联动开关和 revision
  bots chrome ID --enabled on|off --revision REV
  bots model ID                         读取当前模型、可选模型和 revision
  bots model ID --model M --revision REV [--effort E]
    --model default 恢复默认；--effort default 恢复默认思考强度
  bots persona ID                       读取 Bot 人设小节和 revision
  bots persona ID --from PATCH.json     保存 {revision,text}；text 为空字符串时清空人设
  bots delete ID --expected-name N --yes（保留历史与工作区）
  screens status                       查看桌面服务、授权设备和当前屏幕会话
  screens enable|disable --yes           启用/禁用；配对设备不会自动获得查看权
  screens allow DEVICE --permission view|control --yes
  screens revoke DEVICE --yes           撤销屏幕授权并立即结束相关连接
  screens stop [SESSION] --yes           停止指定/全部屏幕会话
  screens configure --from FILE --yes    提交含 expectedRevision 的完整授权命令
  folders list                         读取当前用户的分组、置顶和 revision
  folders pin ID --enabled on|off --revision N
  folders pin --unfiled --enabled on|off --revision N
    取消置顶恢复普通分组位置；旧置顶未保存原位置时回到普通分组末尾
  conversations list --host HOST --bot BOT [--source-bot LOCAL_BOT_ID]
  conversations local                 当前本地主机的全部可见对话（含已归档）
  conversations archive --ids ID,ID --yes [--request-id ID]
  conversations restore --ids ID,ID --yes [--request-id ID]
  conversations move --ids ID,ID (--folder ID|--unfiled|--new-folder NAME) --revision N [--request-id ID]
    同一主机一次最多 100 项，整批成功或失败；归档可恢复；当前回复继续，自动讨论在当前发言后暂停。
    话题随所属群分组，不能单独移动；revision 从 folders list 取得。
    同编号、同参数重试：未执行过则执行，已执行过不会重复。
  integrations asr status | install --yes [--request-id ID] [--json]
    安装模型与当前用户后台服务；复用统一安装器，不启动 Hub。Windows 暂不支持自动安装。
  integrations voice status [--request-id ID] [--json]
  integrations voice set --mode local|cloud|auto --adapter ID --threshold-seconds N --revision REV --yes [--request-id ID] [--json]
    管理当前主机转写方式；云端需确认上传与费用。旧 --enabled on/off 对应 auto/local。
  messages grants [--cross-host] [--json]
    查看本机 Bot 的直接消息授权，与 App 的「Bot 消息授权」使用同一份记录
    --cross-host 改为查看其他主机 Bot → 本机 Bot 的单向授权（含已离网来源的残留授权），与 App「跨主机」标签同一份快照
  messages send --to HOST/BOT[/CONVERSATION] --text-file FILE [--file FILE]... [--new-conversation NAME] [--request-id ID] [--context-message ID] [--source-bot LOCAL_BOT_ID]
  messages wait --to HOST_ID/BOT_ID/CONVERSATION_ID --message ID [--timeout SECONDS] [--out DIRECTORY] [--source-bot LOCAL_BOT_ID]
    默认等待 120 秒；timeout/pending 只结束本次查询，不会中断任务或自动恢复。用同一消息 ID 继续查询，勿重复发送。
    首次立即查询，后续间隔 1.5、3、6 秒，最长 6 秒；完成状态可能有最多一个轮询间隔的延迟。
  messages allow|revoke --from SOURCE_HOST/SOURCE_BOT_ID --bot TARGET_BOT
  attachments list [--conversation ID [--sort size|time] [--offset N]]
    主人专用：不带 --conversation 时按对话汇总附件占用；带上则列出该对话的附件，每页 100 项
  attachments delete (--ids ID,ID | --conversation ID) --yes
    删除主机上的附件文件并立即释放空间；消息保留原文，附件处显示「附件已删除」。Bot 尚未处理完的消息里的附件会被拒绝
  tickets list [--bot DISPATCHER] [--open] | show TICKET | targets | engines
  tickets capabilities --engine ENGINE [--match TEXT] [--offset N] [--bot DISPATCHER]
    按需读取用户级技能/MCP元数据，每页40项；不创建执行者、不验证运行权限或质量。
  tickets create --title T (--text T | --text-file F) [--context-message ID]
  tickets dispatch TICKET --engine codex|claude|kimi|deepseek|antigravity [--model M] [--effort E] [--assist 0..2] [--text T | --text-file F] [--force] [--context-message ID]
    --assist 为本次派工链的协助次数；auto 默认 1，ask 默认 0。ask 模式需在计划中取得主人同意；限定单一模型时请设 0。
  tickets update TICKET [--status queued|needs_answer|needs_review|blocked|done|cancelled] [--note N] [--context-message ID]
  tickets assist --engine ENGINE [--model M] [--effort E] --text-file FILE --note REASON --request-id ID --context-message MESSAGE
    工单执行者请求一个协助任务；主机绑定当前工单与轮次。成功仅表示已记录，保存进度并结束本轮，等待结果回传后继续。
  tickets assist-status --context-message MESSAGE   执行者查看当前协助状态与剩余次数
  tickets assists TICKET                            主人/幕僚长查看该工单的协助记录
    幕僚长写工单须显式携带本轮指引中的 --context-message ID；不要依赖持久会话的环境变量或沿用旧 ID。本机主人操作不需要此参数。
    dispatch_context_not_active 表示轮次上下文缺失或失效，不是接口未启用；不可绕过工单直接启动引擎 CLI。
  tickets pause|resume|cancel|accept TICKET   主人控制工单（暂停、继续、取消、验收）
  tickets remove TICKET                     移除已结束工单，保留执行对话和文件
  tickets engine-reset ENGINE                 清除某个引擎的冷却或“需要登录”标记
  tickets settings [--bot DISPATCHER] [--dispatch-mode ask|auto] [--max-concurrent N] [--allow ENGINE,ENGINE|all]
  messages list CONVERSATION [--before ID]  查看自己的消息，每页 50 条
  messages delete CONVERSATION --ids ID,ID --yes  删除自己的记录并同步自己的设备
  messages clear CONVERSATION [--through ID --yes | --yes]   清理自己的 App 记录，保留模型会话；不加 --yes 仅预览
  workbench targets CONVERSATION [--context-message ID] [--json]
  workbench guide widgets|browser [--json]  离线读取同一操作合同（设计、白板、Markdown 笔记、图表、浏览器），不授予权限
  workbench context CONVERSATION --context-message ID [--json]  读取此消息冻结的完整上下文，不读取当前选区
  workbench publish CONVERSATION --from WIDGET.json --request-id ID [--context-message ID] [--json]
    发布 {title,summary,html} 并返回真实图表 source；仅在用户明确要求时使用 report。Bot 仅使用自己当前用户轮次的授权。
  workbench run CONVERSATION --from REQUEST.json --request-id ID [--context-message ID] [--file IMAGE] [--json]
    通过同一主机授权接口控制在线 App；返回真实回执。unknown 不代表成功，勿换编号自动重试。
    Markdown 笔记是 App 工作台对象，不是本机文件；导入导出只由用户在 App 中进行。
  engines status [--request-id ID] [--json]
  engines set --engine ENGINE --path ABSOLUTE_PATH --revision REV [--request-id ID]
  engines reset --engine ENGINE --revision REV [--request-id ID]
    路径属于运行主机；保存前只检查文件。新启动的 Bot 生效，已运行的 Bot 请空闲后重启。
  widgets status [--request-id ID] [--json]
  widgets set --enabled on|off --revision REV [--request-id ID] [--json]
  ${WIDGET_PUBLISH_USAGE}
  queue list CONVERSATION --bot BOT
  steer status CONVERSATION --bot BOT    查看当前可补充的任务编号
    targetKind=background-review：Claude 正在处理已完成后台任务的结果；--mode message 补充作为新一轮交给 Claude 原生排队，可能在该处理的下一步被读入并由新一轮回复；不能立即发送
  steer send CONVERSATION --bot BOT --target ID --text TEXT [--mode message] [--request-id ID]
  steer send-now|cancel CONVERSATION --message ID [--request-id ID]
                                        Claude 原生待处理消息：立即发送或原子撤回
    只补充指定当前任务；结果未确认时用原编号和原内容核对，不会排成下一轮。
    拒绝、未采纳或结果未确认时退出码为 1，原回执仍输出为 JSON；Bot 常规协作补充请用 messages send。
  tasks list CONVERSATION --bot BOT    查看原生子代理与后台任务
  tasks stop CONVERSATION --bot BOT --task ID [--request-id ID]
    仅停止指定任务；子步骤可能被所属代理重试，要结束整项工作请停止父代理。
  tasks recover CONVERSATION --bot BOT --token TOKEN --yes [--request-id ID]
    仅用于停止未确认的会话；强制结束该 Claude 进程及其全部后台任务。
    断线后用原编号核对；确认仍在运行后，可明确使用新编号重新请求停止。
  side status CONVERSATION --bot BOT
  side ask CONVERSATION --bot BOT --text TEXT | --text-file FILE [--file FILE]... [--timeout SECONDS]
    支持的 Codex 侧边可直接返回图片或文件；JSON 的 deliveries 返回附件 ID 与显示信息，不写入主对话。
    自动使用引擎支持的侧边工具；Codex 侧边可联网并执行命令，文件访问范围跟随 Bot，不单独请求审批
    --file 先上传到该对话，再作为侧边附件（最多 8 个）；带附件时可不写问题
  changes list CONVERSATION --bot BOT [--message MESSAGE] [--json]
  changes show CONVERSATION --bot BOT --path FILE [--message MESSAGE --operation SEQ-INDEX] [--preview] [--json]
    只读查看当前 Bot 工作区相对 HEAD 的变更；不是某轮执行的历史归属
  queue move CONVERSATION --bot BOT --message ID --before ID | --last
  queue edit CONVERSATION --bot BOT --message ID --text TEXT | --text-file FILE
  queue pause|resume CONVERSATION --bot BOT --message ID
    暂停保留原位置，后续消息继续；resume 按原位置恢复，不中断当前任务
  queue cancel CONVERSATION --bot BOT --message ID
    修改队列时必填 --revision REV；可用 --request-id ID 核对同一操作
    仅管理主机尚未下发的消息；不改变正在执行的任务或对话历史顺序
  groups show GROUP                      查看群设置：模式、发言顺序、最多轮数与 revision
  groups update GROUP --from FILE         用完整设置 JSON 保存（title、botIds、expectedTitle、expectedBotIds，
    可选 policy {mode: mentions|parallel|sequential|independent, botOrder, maxRounds} 与 expectedRevision）
    parallel 为并行回复：不 @ 时全员各自回复用户，@ 时仅点名 Bot；保存后直接发消息即可
  groups status CONVERSATION              查看群或话题当前/最近一次讨论（只读）
  groups start CONVERSATION --text-file FILE --revision REV [--file FILE]... [--request-id ID]
    [--participants BOT,BOT] [--supersedes RUN_ID]
    按已保存的轮流讨论 / 独立评议设置开始一次讨论；REV 来自 groups show，设置变化时拒绝
    --participants 只让所选 Bot（2–8 个）发言，顺序仍按群设置；--supersedes 结束该已暂停讨论并改用新课题
  groups note CONVERSATION --run RUN_ID [--text-file FILE] [--file FILE]... [--request-id ID]
    [--then resume|retry --revision REV] [--if-running]
    补充到指定讨论；CONVERSATION 用 groups status 的 run.conversationId（实际话题 ID）
    start / note 均可用 --reply-to MESSAGE 引用消息
    --then 补充并继续/重试（同一操作，失败时补充也不保存）；--if-running 讨论已暂停时拒绝而不保存
  groups pause|resume|end|retry CONVERSATION --run RUN_ID --revision REV [--request-id ID]
    暂停在当前发言结束后生效；结束会请求停止并等待终态；继续不会重跑失败的发言，retry 才会
    独立评议首轮 retry 会重试全部未完成回答；首轮无有效回答时不能继续，只能 retry 或 end
    新版主机上 pause / end 可省略 --revision（按讨论 ID 精确匹配）
    讨论进行中不能 @ Bot；轮流 / 独立评议群 @ 多个 Bot 需用 groups start --participants
    普通群只投递被 @ 的 Bot；不 @ 时仅保存发言。断线或超时不会自动重发，请保留请求编号核对
  bus list | show ID
  bus create --from FILE [--request-id ID]
  bus update ID --from FILE --revision REV
  bus run ID --text-file FILE --revision REV [--request-id ID]
    配置的 members[].instruction 为各步骤分工；text-file 为本次共同目标。
  bus stop ID --run RUN_ID [--request-id ID] [--abandon]
    --abandon 仅结束离线运行的等待；先请求停止，原执行可能仍在进行。
  bus delete ID --revision REV --yes     删除协作工作区，保留关联对话
  bus permissions BOT_ID                查看协作权限与服务状态
  bus prepare --coordinator BOT_ID --members ID,ID --yes [--request-id ID]
    Bot 可重复参与；每个步骤绑定不同 conversationId，省略则分配专用对话
    仅添加所选 Bot 的双向权限；离线服务安排空闲重启，不发送任务
    只连接已运行的本机 Hub；结果为 JSON，断线或超时不会自动重发
  devices list | pending | approve CODE | revoke ID --yes
  devices invites | revoke-invite ID   查看或撤销本 CLI 签发的连接码
  devices rename ID --name N           修改此主机上的设备名称
                                      本机桌面端共用主机名称，请用 name <名称>
                                      撤销已入网设备会同步全网，不会让主机退出组网
  pair [--lan | --tailscale | --routes FILE] [--address IP] [--out FILE] [--wait SECONDS]
    需运行新版主机并登记 CLI 控制器（tarobot enroll）；生成 5 分钟有效、仅限一台新设备的邀请。
  network status | create --name N | routes --from FILE --yes
  network local [--tailscale] [--json] 只读查看本机局域网/Tailscale 线路与共享线路
  network offer --out FILE
  network propose --from OFFER --out PROPOSAL --yes
  network admit --from PROPOSAL --out ADMISSION --yes
  network join --from ADMISSION --yes
  network inspect --from FILE
  network recover --from RECEIPT --out NEW_FILE
  network leave --yes | remove PUBLIC_KEY --yes
  update stage --from PACKAGE_DIRECTORY | status
  update apply REVISION --yes [--wait SECONDS] | rollback --yes
  update apply REVISION --dry-run | rollback --dry-run
  update prune --revision ID | --receipt ID [--yes]（默认仅预览）
  directory plan [--state-dir PATH] --json  只读检查 Windows 目录与隔离副本
  directory verify --from SOURCE --state-dir DESTINATION --json
    离线逐文件校验恢复副本；不复制、不覆盖、不合并，不用于运行中的主机
  backups status [--request-id ID] | configure --days N [--revision R] [--request-id ID]
    自动数据库快照默认保留 1 天；0 关闭并清理自动快照，手动备份不受影响
  backup NEW_DIRECTORY | restore BACKUP --state-dir ORIGINAL_DIRECTORY

Google 文档工具：tarobot gdocs --help（导入 OAuth 配置、授权、查看状态及创建/更新文档）
通用选项：--state-dir PATH（显式选择独立主机） --json --help
默认与桌面版共用数据目录；不会自动合并旧 ~/.cctb/hub。
引擎：codex、claude、antigravity、kimi、deepseek；须在此主机同一用户下安装并登录。
跨网络使用现有 VPS 中转或 Tailscale；pair --routes 只分享已配置线路，不部署中转。
手机配对不等于主机加入组网；network 命令保留签名审批与独立手机归属。
多网卡配对需用 --address 选择地址；Tailscale 双栈默认使用唯一 IPv4，可显式选择 IPv6。
配对不会修改组网共享线路。
stop/restart/update 默认等待任务收尾，--force 仅用于明确中断 stop/restart。
Windows --force 只终止已确认所属的后台任务；最初控制管道已失联时不会猜测并强杀。
`;

async function readJson(file: string) {
  if (!(await lstat(file)).isFile()) throw new Error("输入必须是普通 JSON 文件。");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 16 * 1024 * 1024) throw new Error("输入文件类型无效或超过 16 MiB。");
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("读取期间输入文件发生变化，请重新导出。");
    return JSON.parse(bytes.subarray(0, length).toString());
  } finally { await handle.close(); }
}
async function output(value: unknown, file?: string) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (file) await writeFile(path.resolve(file), text + "\n", { mode: 0o600, flag: "wx" });
  else console.log(text);
}
function required(value: string | undefined, message: string): string { if (!value) throw new Error(message); return value; }
const entrypoint = fileURLToPath(new URL("../index.js", import.meta.url));
async function packageDirectory(entry: string): Promise<string> {
  let current = path.dirname(entry);
  while (!await exists(path.join(current, "package.json"))) { const parent = path.dirname(current); if (parent === current) throw new Error("找不到完整主机安装包。"); current = parent; }
  return current;
}
export async function runHostCli(argv: string[]): Promise<void> {
  const { values: v, positionals: p, tokens } = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options: {
    "state-dir": { type: "string" }, name: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    days: { type: "string" }, mode: { type: "string" }, adapter: { type: "string" }, "threshold-seconds": { type: "string" }, enabled: { type: "string" }, engine: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, workspace: { type: "string" }, permission: { type: "string" },
    "request-id": { type: "string" }, "expected-name": { type: "string" }, yes: { type: "boolean" }, force: { type: "boolean" }, abandon: { type: "boolean" },
    wait: { type: "string" }, from: { type: "string" }, out: { type: "string" }, routes: { type: "string" },
    lan: { type: "boolean" }, tailscale: { type: "boolean" }, address: { type: "string" }, reset: { type: "boolean" },
    role: { type: "string" }, "dispatch-mode": { type: "string" }, "max-concurrent": { type: "string" }, allow: { type: "string" }, assist: { type: "string" }, status: { type: "string" }, note: { type: "string" }, open: { type: "boolean" }, match: { type: "string" }, offset: { type: "string" },
    folder: { type: "string" }, "new-folder": { type: "string" }, unfiled: { type: "boolean" }, "dry-run": { type: "boolean" }, revision: { type: "string" }, receipt: { type: "string" },
    "html-file": { type: "string" }, "report-file": { type: "string" }, title: { type: "string" }, summary: { type: "string" },
    token: { type: "string" }, target: { type: "string" }, task: { type: "string" }, bot: { type: "string" }, message: { type: "string" }, before: { type: "string" }, through: { type: "string" }, last: { type: "boolean" },
    path: { type: "string" }, operation: { type: "string" }, preview: { type: "boolean" },
    host: { type: "string" }, to: { type: "string" }, "source-bot": { type: "string" }, "cross-host": { type: "boolean" }, "context-message": { type: "string" }, file: { type: "string", multiple: true }, "new-conversation": { type: "string" }, timeout: { type: "string" },
    "reply-to": { type: "string" }, ids: { type: "string" }, conversation: { type: "string" }, sort: { type: "string" }, text: { type: "string" }, "text-file": { type: "string" }, run: { type: "string" },
    coordinator: { type: "string" }, members: { type: "string" },
    participants: { type: "string" }, supersedes: { type: "string" }, then: { type: "string" }, "if-running": { type: "boolean" },
  } });
  const [command, sub, argument, ...extra] = p;
  const seenOptions = new Set<string>();
  for (const token of tokens) if (token.kind === "option") {
    const repeatable = token.name === "file" && ((command === "groups" && (sub === "start" || sub === "note")) || (command === "side" && sub === "ask") || (command === "messages" && sub === "send"));
    if (seenOptions.has(token.name) && !repeatable) throw new Error(`${command} 命令不能重复 --${token.name}。`);
    seenOptions.add(token.name);
  }
  if (command === "network" && !v.help && !["local", "status", "inspect", "recover", "create", "offer", "routes", "propose", "admit", "join", "leave", "remove"].includes(sub ?? "")) throw new Error("未知 network 命令。请执行 tarobot network --help。");
  if (v.help || !command || command === "help") { console.log(HOST_CLI_HELP); return; }
  if (extra.length) throw new Error("多余的位置参数。请执行 tarobot --help。");
  const commands = ["attachments", "screens", "workbench", "init", "run", "start", "stop", "restart", "status", "logs", "doctor", "enroll", "name", "drain", "drain-cancel", "service", "bots", "queue", "side", "tasks", "steer", "changes", "bus", "groups", "messages", "tickets", "widgets", "engines", "folders", "conversations", "devices", "pair", "network", "update", "backups", "backup", "restore", "directory", "integrations"];
  if (!commands.includes(command)) throw new Error(`未知命令：${command}。请执行 tarobot --help。`);
  const allowed: Record<string, string[]> = {
    screens: ["from", "yes", "permission", "request-id"],
    workbench: ["from", "request-id", "context-message", "file"],
    engines: ["engine", "path", "revision", "request-id"],
    backups: ["days", "revision", "request-id"],
    integrations: ["yes", "request-id", "mode", "enabled", "adapter", "threshold-seconds", "revision"], directory: ["from"], init: ["name"], stop: ["wait", "force"], restart: ["wait", "force"], enroll: ["reset", "yes"], name: ["name"], drain: ["wait"],
    service: ["yes"], bots: ["name", "engine", "model", "effort", "workspace", "permission", "request-id", "expected-name", "yes", "revision", "enabled", "role", "dispatch-mode", "max-concurrent", "allow", "from"],
    tickets: ["bot", "match", "offset", "assist", "engine", "title", "text", "text-file", "model", "effort", "force", "status", "note", "open", "request-id", "context-message", "dispatch-mode", "max-concurrent", "allow", "revision"],
    devices: ["yes", "name"], pair: ["lan", "tailscale", "address", "routes", "out", "wait"], network: ["name", "from", "out", "yes", "tailscale"], update: ["from", "yes", "wait", "dry-run", "revision", "receipt"],
    folders: ["enabled", "revision", "unfiled"],
    conversations: ["host", "bot", "source-bot", "ids", "yes", "folder", "new-folder", "unfiled", "revision", "request-id"],
    widgets: ["html-file", "report-file", "title", "summary", "request-id", "enabled", "revision"],
    messages: ["ids", "before", "through", "yes", "to", "source-bot", "text-file", "file", "new-conversation", "message", "timeout", "out", "request-id", "from", "bot", "context-message", "cross-host"],
    queue: ["bot", "message", "before", "last", "text", "text-file", "revision", "request-id"],
    tasks: ["bot", "task", "token", "yes", "request-id"],
    attachments: ["conversation", "ids", "sort", "offset", "yes"],
    steer: ["bot", "target", "text", "request-id", "mode", "message"],
    side: ["bot", "text", "text-file", "file", "timeout", "request-id"],
    changes: ["bot", "path", "preview", "message", "operation"],
    bus: ["from", "revision", "text-file", "request-id", "run", "yes", "coordinator", "members", "abandon"],
    groups: ["from", "revision", "text-file", "file", "run", "request-id", "reply-to", "participants", "supersedes", "then", "if-running"],
  };
  for (const key of Object.keys(v)) if (!["state-dir", "json", "help", ...(allowed[command] ?? [])].includes(key)) throw new Error(`此命令不支持 --${key}。请执行 tarobot --help。`);
  const positionalLimit: Record<string, number> = { screens: 3, workbench: 3, engines: 2, backups: 2, integrations: 3, directory: 2, name: 2, bots: 3, queue: 3, tasks: 3, steer: 3, side: 3, changes: 3, bus: 3, groups: 3, messages: 3, tickets: 3, widgets: 3, folders: 3, conversations: 2, devices: 3, service: 2, network: 3, update: 3, backup: 2, restore: 2 };
  if (command === "bus" && ["list", "create", "prepare"].includes(sub ?? "")) positionalLimit.bus = 2;
  if (command === "bots" && ["list", "catalog", "create"].includes(sub ?? "") || command === "devices" && ["list", "pending", "invites"].includes(sub ?? "") || command === "network" && sub !== "remove" || command === "update" && sub !== "apply") positionalLimit[command] = 2;
  if (p.length > (positionalLimit[command] ?? 1)) throw new Error("此命令不接受额外的位置参数。请执行 tarobot --help。");
  if (v.force && !["stop", "restart", "tickets"].includes(command)) throw new Error("--force 仅支持 stop、restart 或 tickets dispatch。");
  if (v.reset && command !== "enroll") throw new Error("--reset 仅支持本机 CLI 控制器重新登记。");
  if (v["cross-host"] && !(command === "messages" && sub === "grants")) throw new Error("--cross-host 仅支持 messages grants。");
  if (command === "network" && v.tailscale && sub !== "local") throw new Error("--tailscale 仅支持 network local。");
  if (command === "network" && sub === "local" && (v.name || v.from || v.out || v.yes)) throw new Error("network local 只读，不接受 --name/--from/--out/--yes。");
  if (command === "update") {
    if (v["dry-run"] && !["apply", "rollback"].includes(sub ?? "")) throw new Error("--dry-run 仅支持 update apply/rollback；prune 默认只预览。");
    if (v["dry-run"] && v.yes) throw new Error("--dry-run 与 --yes 不能同时使用。");
    if ((v.revision || v.receipt) && sub !== "prune") throw new Error("--revision/--receipt 仅支持 update prune。");
  }
  if (command === "integrations" && sub === "asr") {
    if ([v.mode, v.enabled, v.adapter, v["threshold-seconds"], v.revision].some(value => value !== undefined)) throw new Error("ASR 安装不接受云端设置参数。");
    if (v["state-dir"]) throw new Error("ASR 集成属于当前操作系统用户，不按 Host 数据目录复制安装。");
    if (sub !== "asr" || !["status", "install"].includes(argument ?? "")) throw new Error("请使用 integrations asr status 或 integrations asr install --yes。");
    if (argument === "status" && (v.yes || v["request-id"])) throw new Error("status 不接受安装参数。");
    const setup = new QwenAsrSetup();
    if (argument === "status") { await output(await setup.status()); return; }
    if (!v.yes) throw new Error("安装将下载依赖和模型并启用当前用户后台服务；确认后请加 --yes。");
    const stop = () => { void setup.close(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const requestId = v["request-id"] ?? randomUUID();
      const admitted = await setup.start({ requestId, model: true, service: true });
      if (admitted.requestId !== requestId) { await output({ ...await setup.status(admitted.requestId), requestAccepted: false, error: "installation_busy" }); process.exitCode = 1; return; }
      await setup.wait(); const state = await setup.status(requestId); await output(state);
      if (state.job && ["failed", "interrupted"].includes(state.job.status)) process.exitCode = 1;
    } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); await setup.close(); }
    return;
  }
  if (command === "directory") {
    if (sub === "plan" && !v.from) { await output(await planDirectoryRecovery(v["state-dir"])); return; }
    if (sub === "verify") { const result = await verifyDirectoryRecovery(required(v.from, "缺少 --from 原目录。"), required(v["state-dir"], "缺少 --state-dir 恢复目录。")); await output(result); if (!result.verified) process.exitCode = 1; return; }
    throw new Error("请使用 directory plan 或 directory verify；不会自动迁移数据。");
  }
  if (command === "network" && sub === "inspect") {
    const raw = await readJson(required(v.from, "缺少 --from 签名文件。"));
    await output(raw?.proposal ? verifyCliNetworkProposal(raw) : verifyCliNetworkMembership(raw?.membership ?? raw)); return;
  }
  if (command === "network" && sub === "recover") {
    await output(await exportNetworkTransfer(required(v.from, "缺少 --from 操作记录。"), required(v.out, "缺少新的 --out 文件。"))); return;
  }
  if (command === "workbench" && sub === "guide") {
    await output(await runWorkbenchCommand("", sub, argument, { from: v.from, requestId: v["request-id"], contextMessageId: v["context-message"], file: v.file })); return;
  }
  const abort = new AbortController();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map(signals.map(signal => [signal, () => {
    if (!abort.signal.aborted) { abort.abort(); return; }
    for (const [name, handler] of handlers) process.off(name, handler);
    process.kill(process.pid, signal);
  }]));
  const handleSignals = ["stop", "restart", "update", "pair", "drain", "service"].includes(command);
  if (handleSignals) for (const [signal, handler] of handlers) process.on(signal, handler);
  const checkCancelled = () => { if (abort.signal.aborted) throw Object.assign(new Error("操作已取消，未继续切换主机。"), { exitCode: 130 }); };
  try {
  const inspection = ["stop", "status", "doctor", "logs"].includes(command) || command === "service" && ["status", "uninstall"].includes(sub ?? "");
  const directory = await resolveHostDirectory(v["state-dir"], { inspection });
  checkCancelled();
  if (command === "backups") {
    const client = await LocalHostClient.connect(directory);
    try { await output(await runBackupsCommand(client, sub, { days: v.days, revision: v.revision, requestId: v["request-id"] }, id => console.error(`备份设置操作编号：${id}。结果未确认时用 backups status --request-id 核对。`))); }
    finally { client.close(); }
    return;
  }
  if (command === "engines") {
    if (argument) throw new Error("请使用 engines status|set|reset --help。");
    const client = await LocalHostClient.connect(directory);
    try { await output(await engineSettingsCommand(client, sub ?? "", { engine: v.engine, path: v.path, revision: v.revision, requestId: v["request-id"] }, id => console.error(`引擎路径操作编号：${id}。结果未确认时用 engines status --request-id 核对。`))); }
    finally { client.close(); }
    return;
  }
  if (command === "widgets" && (sub === "status" || sub === "set")) {
    if (argument || v["html-file"] !== undefined || v["report-file"] !== undefined || v.title !== undefined || v.summary !== undefined) throw new Error("widgets status/set 不接受发布参数。");
    const client = await LocalHostClient.connect(directory);
    try { await output(await widgetSettingsCommand(client, sub, { enabled: v.enabled, revision: v.revision, requestId: v["request-id"] }, id => console.error(`图形设置操作编号：${id}。结果未确认时用 status --request-id 核对。`))); }
    finally { client.close(); }
    return;
  }
  if (command === "integrations") {
    if (sub !== "voice") throw new Error("请使用 integrations asr 或 integrations voice。");
    const client = await LocalHostClient.connect(directory);
    try { await output(await voiceCommand(client, argument, { mode: v.mode, enabled: v.enabled, adapter: v.adapter, revision: v.revision, thresholdSeconds: v["threshold-seconds"], requestId: v["request-id"], yes: v.yes }, id => console.error(`语音设置操作编号：${id}。结果未确认时，请保留原参数并用相同 --request-id 重试。`))); }
    finally { client.close(); }
    return;
  }
  const waitMs = v.wait === undefined ? 300_000 : z.coerce.number().int().min(1).max(86400).parse(v.wait) * 1000;
  const yes = () => { if (!v.yes) throw new Error("请先核对目标；确认后加 --yes 执行。" + (command === "network" && v.from ? "network inspect --from FILE 可以查看签名内容。" : "")); };
  const enroll = async () => { const client = await LocalHostClient.connect(directory, { enroll: true }); const identity = { deviceId: client.deviceId, hostPublicKey: client.publicKey }; client.close(); return identity; };
  const wait = async () => {
    checkCancelled();
    if (!v.json) console.error(command === "drain" ? "正在等待任务收尾；租约到期后将自动恢复接收，或用 tarobot drain-cancel 提前恢复。" : "正在等待任务收尾；未开始的消息会保留到主机重新启动。");
    try { return await waitForHostIdle(directory, waitMs, abort.signal); }
    catch (error) { if (abort.signal.aborted && error instanceof Error) Object.assign(error, { exitCode: 130 }); throw error; }
  };
  const startCompatible = async () => {
    const selected = await resolveHostRuntime(directory, entrypoint);
    await assertWindowsRuntimeAdmission(selected.entrypoint);
    // Only an explicitly selected, snapshotted update may migrate state.
    await assertHostRuntimeCompatible(directory, selected.entrypoint, { allowMigration: !!selected.revisionId });
    return selected;
  };
  const start = async () => {
    // An already running host needs no runtime/schema change. In particular an
    // older CLI must not disrupt a healthy host started by a newer desktop.
    let result = await desktopHost("status", directory, entrypoint);
    if (result.running && ("draining" in result && result.draining || "drainId" in result && result.drainId)) throw new Error("主机正在收尾或退出，请稍后执行 status 检查；未启动第二个主机。");
    if (!result.running) { await startCompatible(); result = await desktopHost("start", directory, entrypoint); }
    try { return { ...result, cliController: { ready: true, ...await enroll() } }; }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!v.json) console.error(`主机已启动，但本机 CLI 控制器尚未就绪：${reason}。请执行 tarobot enroll 检查登记；已有设备仍可连接。`);
      return { ...result, cliController: { ready: false, error: reason, recovery: "tarobot enroll" } };
    }
  };
  const stop = async () => {
    const drainId = v.force ? undefined : await wait();
    const lease = drainId ? keepHostDrainLease(directory, drainId) : undefined;
    try { checkCancelled(); lease?.check(); const drainedStop = v.force ? undefined : await captureDrainedStopGuard(directory, drainId); checkCancelled(); return await desktopHost("stop", directory, entrypoint, { drainedStop, requireDrained: !v.force, ...(v.force ? { force: true } : {}) }); }
    finally {
      lease?.stop();
      if (drainId) await inspectHubService(directory, "drain-cancel", { drainId }).catch(() => undefined);
    }
  };

  if (command === "init") {
    let name = v.name;
    if (!name && process.stdin.isTTY && !v.json) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { name = await rl.question("给这台运行 Bot 的主机起个名字："); } finally { rl.close(); }
    }
    await output({ ...await initializeHost(directory, required(name, "请通过 --name 设置主机名称。")), engines: inspectEngines() }); return;
  }
  if (command === "status" || command === "doctor") {
    const report = await inspectHost(directory, process.env, command === "doctor");
    if (v.json) await output(report);
    else {
      console.log(`主机：${report.profile?.name ?? "尚未初始化"}\n目录：${directory}\n状态：${report.service.running ? report.service.draining ? "正在收尾" : "运行中" : "未运行"}\n后台服务：${report.manager.error ? "状态未知" : report.manager.configured ? `${report.manager.manager ?? "未知管理器"} / ${report.manager.enabled ? "已启用" : "已停用"}` : "未安装"}`);
      if (report.service.running) console.log(`版本：${report.service.version ?? "旧版未报告"}\n本地入口：${report.service.url}\n中转：${report.service.relay?.configured ? report.service.relay.online ? "已连接" : "未连接" : "未配置"}`);
      if (report.database) console.log(`Bot：${report.database.bots}\n网络：${report.database.network?.name ?? "独立主机"}`);
      if (report.manager.error) console.log(`后台服务需检查：${report.manager.error}`);
      if (command === "doctor") {
        for (const engine of report.engines) { const live = report.liveEngines?.find(item => item.id === engine.engine); console.log(`${engine.engine}: ${engine.installed ? engine.executable : "当前终端未找到"}；后台服务：${live ? live.available ? "可找到" : "未找到" : "未验证"}；登录状态待验证`); }
        if (report.liveCheck) console.log(`后台引擎检查未完成：${report.liveCheck}`);
        if (report.serviceEnvironmentDifferences.length) console.log(`终端与后台服务的配置不同：${report.serviceEnvironmentDifferences.join("、")}。如需更新，停止主机后重新 service install。`);
        if (report.serviceEnvironmentCheck) console.log(`后台环境检查未完成：${report.serviceEnvironmentCheck}`);
        if (report.environmentCheck?.hint) console.log(report.environmentCheck.hint);
        if (report.environmentCheck) console.log(`当前终端环境需检查：${report.environmentCheck.error}${report.environmentCheck.variables.length ? `（${report.environmentCheck.variables.join("、")}）` : ""}`);
        for (const note of report.notes) console.log(note);
      }
    }
    return;
  }
  if (command === "logs") { await output(await hubServiceCommand("logs", directory, entrypoint)); return; }
  if (command === "restore") {
    required(v["state-dir"], "恢复必须明确指定原 --state-dir，不会覆盖已有目录。");
    await (await import("../hub/cli.js")).runHubCli(["restore", required(sub, "缺少备份目录。"), "--state-dir", directory]); return;
  }
  if (command === "service" && sub === "uninstall") {
    yes();
    const manager = await managedServiceStatus(directory);
    if (manager.configured && (await inspectHubService(directory)).running) await stop();
    // The manager can remove a stale OS registration when its manifest is
    // missing, but refuses to take over a live foreground Hub in that case.
    checkCancelled(); await output(await uninstallManagedService(directory, { requireDrained: true })); return;
  }
  if (command === "run") await assertHostSupervisor(directory);
  await requireInitialized(directory);
  checkCancelled();
  if (command === "start") { await output(await start()); return; }
  if (command === "enroll") { if (v.reset) { yes(); await resetCliController(directory); } await output(await enroll()); return; }
  if (command === "stop") { await output(await stop()); return; }
  if (command === "restart") { await startCompatible(); await stop(); checkCancelled(); await output(await start()); return; }
  if (command === "run") {
    if ((await inspectHubService(directory)).running) throw new Error("同一主机已经运行；不会启动第二个 Hub。");
    const selected = await startCompatible();
    if (!await isCurrentHostRuntime(selected, entrypoint)) { await runHostRuntime(selected.executable, selected.entrypoint, ["host", "run", "--state-dir", directory], directory); return; }
    const runner = await import(pathToFileURL(path.join(path.dirname(selected.entrypoint), "hub", "cli.js")).href);
    await runner.runHubCli(["run", "--state-dir", directory]); return;
  }
  if (command === "drain") {
    await wait(); const status = await inspectHubService(directory);
    if (!v.json && status.running && status.drainLeaseExpiresAt) console.error(`收尾租约到期：${new Date(status.drainLeaseExpiresAt).toISOString()}；到期后自动恢复接收。`);
    await output(status); return;
  }
  if (command === "drain-cancel") { const result = await inspectHubService(directory, "drain-cancel"); if (result.running && result.controlError) throw new Error(result.controlError); await output(result); return; }
  if (command === "service") {
    if (sub === "status") await output(await managedServiceStatus(directory));
    else if (sub === "install") {
      if ((await inspectHubService(directory)).running) throw new Error("先执行 tarobot stop 等待当前任务收尾，再安装后台服务；不会直接接管运行中的主机。");
      let selected = await resolveHostRuntime(directory, entrypoint);
      await assertWindowsRuntimeAdmission(selected.entrypoint);
      checkCancelled();
      if (process.platform === "win32") await assertWindowsHostLauncher(selected.entrypoint);
      if (!selected.revisionId) {
        await inspectHostUpdateRecovery(directory);
        const source = await packageDirectory(entrypoint);
        checkCancelled();
        const revision = await stageHostUpdate(directory, source);
        checkCancelled();
        await activateHostUpdate(directory, revision.id, { currentEntrypoint: entrypoint });
        selected = await resolveHostRuntime(directory, entrypoint);
      }
      checkCancelled();
      await output(await installManagedService(directory, selected.entrypoint, { executable: selected.executable }));
    }
    else throw new Error("service 支持 install、uninstall、status。");
    return;
  }
  if (command === "backup") {
    await (await import("../hub/cli.js")).runHubCli(["backup", required(sub, "缺少新的备份目录。"), "--full", "--state-dir", directory]); return;
  }
  if (command === "update") {
    if (sub === "status") { await output(await hostUpdateStatus(directory)); return; }
    if (sub === "stage") { checkCancelled(); const revision = await stageHostUpdate(directory, path.resolve(required(v.from, "缺少 --from 已安装依赖的完整独立包目录。"))); checkCancelled(); await output(revision); return; }
    if (sub === "prune") { await output(await pruneHostUpdates(directory, { revisionId: v.revision, transactionId: v.receipt, yes: v.yes })); return; }
    if (sub !== "apply" && sub !== "rollback") throw new Error("update 支持 stage、status、apply、rollback、prune。");
    if (!v["dry-run"]) yes();
    if (sub === "apply") required(argument, "缺少已暂存的版本标识。");
    const target = await preflightHostUpdate(directory, sub === "apply" ? argument : undefined);
    if (v["dry-run"]) { await output({ dryRun: true, target, recovery: await inspectHostUpdateRecovery(directory) }); return; }
    const before = await inspectHubService(directory);
    const managerBefore = await managedServiceStatus(directory);
    const recovery = await captureUpdateRecovery(directory, entrypoint, before);
    // Selection/backup will independently acquire Hub + worker locks. This wait
    // is user-friendly preparation, never the sole concurrency guarantee.
    let receipt;
    try { await stop(); checkCancelled(); receipt = sub === "apply" ? await activateHostUpdate(directory, argument!, { currentEntrypoint: entrypoint }) : await rollbackHostUpdate(directory, { currentEntrypoint: entrypoint }); }
    catch (error) {
      let recovered = false, recoveryError = "", loginRecovery = "";
      try { recovered = await recoverUnchangedRuntime(directory, entrypoint, recovery, start); }
      catch (failure) { recoveryError = ` ${failure instanceof Error ? failure.message : String(failure)}`; }
      if (managerBefore.configured && managerBefore.enabled) {
        try {
          const restored = (!before.running || recovered) && await recoverUnchangedAutostart(directory, entrypoint, recovery, () => before.running ? reassertManagedServiceIntent(directory) : enableManagedServiceOnLogin(directory));
          loginRecovery = restored ? "原登录自启设置已恢复。" : "登录自启未自动恢复，请执行 service status 检查。";
        } catch (failure) { loginRecovery = `恢复登录自启失败，请执行 service status 检查：${failure instanceof Error ? failure.message : String(failure)}。`; }
      }
      const actual = await inspectHubService(directory).catch(() => undefined);
      const state = recovered ? "运行时选择未改变，原主机已恢复运行。" : actual?.running ? actual.draining || actual.drainId ? "主机仍在收尾或退出，尚未确认恢复；请执行 status 和 update status 检查。" : "原主机仍在运行；未确认完成更新，请执行 status 和 update status 检查。" : actual ? "主机当前未运行；执行 update status 查看记录，确认后 start。" : "未能确认主机当前状态；请执行 status 和 update status 检查。";
      throw Object.assign(new Error(`更新选择未完成：${error instanceof Error ? error.message : String(error)}。${state}${loginRecovery}原数据保留。${recoveryError}`, { cause: error }),
        error instanceof Error && "exitCode" in error && error.exitCode === 130 ? { exitCode: 130 } : {});
    }
    let recoveryPhase = "刷新后台服务";
    try {
      if ((await managedServiceStatus(directory)).configured) await refreshManagedServiceRuntime(directory, { entrypoint: receipt.after.entrypoint, executable: receipt.after.executable });
      if (before.running) {
        recoveryPhase = "启动并验证新版";
        await start(); const current = await inspectHubService(directory);
        if (!current.running || current.draining || current.drainId || current.publicKey !== before.publicKey || current.version !== receipt.after.version || current.runtimeId !== receipt.after.runtimeId) throw new Error("新版身份或运行时摘要验收不匹配。");
        await markHostUpdateHealthy(directory, receipt.id);
      } else if (managerBefore.configured && managerBefore.enabled) {
        recoveryPhase = "恢复登录自启";
        await enableManagedServiceOnLogin(directory);
      }
    } catch (error) {
      const actual = await inspectHubService(directory).catch(() => undefined);
      const state = actual ? actual.running ? "主机正在运行，版本尚需核对。" : "主机当前未运行。" : "主机运行状态未知。";
      throw Object.assign(new Error(`更新已保留记录和原数据，但${recoveryPhase}失败。${state}执行 status、service status 和 update status 查看；确认后 start。不会自动降级数据库。${error instanceof Error ? error.message : String(error)}`, { cause: error }),
        error instanceof Error && "exitCode" in error && error.exitCode === 130 ? { exitCode: 130 } : {});
    }
    await output(await hostUpdateStatus(directory)); return;
  }
  if (command === "pair") {
    if (Number(!!v.lan) + Number(!!v.tailscale) + Number(!!v.routes) > 1) throw new Error("请选择一种配对线路来源。");
    if (v.address && !v.lan && !v.tailscale) throw new Error("--address 需与 --lan 或 --tailscale 一起使用。");
    const outputFile = v.out ? await open(path.resolve(v.out), "wx", 0o600) : undefined;
    let reserved: Stats | undefined, exported = false;
    try {
    reserved = await outputFile?.stat();
    let routes: Route[];
    if (v.lan || v.tailscale) {
      await startCompatible();
      let drainId: string | undefined, lease: ReturnType<typeof keepHostDrainLease> | undefined;
      let configured;
      try {
        checkCancelled();
        configured = await desktopHost(v.tailscale ? "tailscale" : "network", directory, entrypoint, undefined, {
          selectAddress: addresses => {
            if (v.address && !addresses.includes(v.address)) throw new Error(`指定地址不在可用线路中：${addresses.join("、")}。请用 --address IP 选择。`);
            if (v.address) return v.address;
            const ipv4 = v.tailscale ? addresses.filter(isIPv4) : [];
            const candidates = ipv4.length ? ipv4 : addresses;
            if (candidates.length > 1) throw new Error(`发现多个可用地址：${candidates.join("、")}。请用 --address IP 选择手机可达的地址。`);
            return candidates[0]!;
          },
          beforeRestart: async () => {
            drainId = await wait();
            lease = drainId ? keepHostDrainLease(directory, drainId) : undefined;
            checkCancelled(); lease?.check();
            const guard = await captureDrainedStopGuard(directory, drainId);
            checkCancelled(); return guard;
          },
        });
      } finally {
        lease?.stop();
        if (drainId) {
          const resumed = await inspectHubService(directory, "drain-cancel", { drainId });
          if (resumed.running && resumed.controlError) throw new Error(resumed.controlError);
        }
      }
      if (!("routes" in configured)) throw new Error("配对线路尚未准备好。");
      routes = routesSchema.parse([configured.routes[0]]);
    } else if (v.routes) routes = routesSchema.parse(await readJson(v.routes));
    else {
      const client = await LocalHostClient.connect(directory);
      try { routes = (await new HostNetwork(client).view()).host.routes; } finally { client.close(); }
    }
    if (!routes.length) throw new Error("尚无可分享线路。局域网用 pair --lan；已有 VPS / HTTPS 线路用 --routes FILE。");
    const service = await inspectHubService(directory); if (!service.running) throw new Error("请先启动主机。");
    const invitation = await withHostManagement(directory, management => management.issuePairingInvite()).catch((error: unknown) => {
      if (error instanceof Error && error.message === "pairing_invites_full") throw new Error("有效邀请或待确认设备过多。请用 tarobot devices invites 查看，再用 tarobot devices revoke-invite ID 撤销未使用的邀请，或等待 5 分钟后重试。");
      throw error;
    });
    const link = hostPairingLink(service.publicKey, routes, invitation.invite);
    if (outputFile) { await outputFile.writeFile(link + "\n"); await outputFile.sync(); exported = true; }
    if (v.json) await output({ host: await readHostProfile(directory), publicKey: service.publicKey, routes, link, inviteId: invitation.id, expiresAt: invitation.expiresAt, serverTime: invitation.serverTime });
    else { console.log(`限时连接码有效期 5 分钟，仅限一台新设备；过期后重新运行 tarobot pair。邀请 ID：${invitation.id}。
在新手机或电脑扫描连接二维码，再用已授权设备确认新设备上的 8 位配对码；也可在此运行 tarobot devices approve <配对码>。\n${link}`); try { console.log(await terminalPairingQr(link)); } catch { console.error("连接信息超出终端二维码容量；请在新设备选择「粘贴连接信息」并粘贴上面的链接。"); } }
    return;
    } finally {
      await outputFile?.close();
      if (v.out && reserved && !exported) { const current = await lstat(path.resolve(v.out)).catch(() => undefined); if (current?.dev === reserved.dev && current.ino === reserved.ino) await unlink(path.resolve(v.out)).catch(() => undefined); }
    }
  }

  if (command === "conversations" && sub === "list" || command === "messages" && ["send", "wait", "allow", "revoke", "grants"].includes(sub ?? "")) {
    if (argument || command === "conversations" && sub !== "list") throw new Error("请使用 conversations list 或 messages send|wait|allow|revoke|grants。");
    if (command === "conversations" && [v.ids, v.yes, v.folder, v["new-folder"], v.unfiled, v.revision, v["request-id"]].some(value => value !== undefined)) throw new Error("conversations list 不接受批量修改参数。");
    await output(await runBotMessagesCommand(directory, sub!, {
      host: v.host, bot: v.bot, to: v.to, "source-bot": v["source-bot"], "context-message": v["context-message"], "text-file": v["text-file"], file: v.file,
      "new-conversation": v["new-conversation"], message: v.message, timeout: v.timeout, out: v.out, "request-id": v["request-id"], from: v.from, "cross-host": v["cross-host"],
    }, abort.signal)); return;
  }
  if (command === "attachments") { await output(await runAttachmentsCommand(directory, sub, { conversation: v.conversation, ids: v.ids, sort: v.sort, offset: v.offset, yes: v.yes })); return; }
  if (command === "tickets") {
    await output(await runTicketsCommand(directory, sub, argument, {
      bot: v.bot, match: v.match, offset: v.offset, assist: v.assist, engine: v.engine, title: v.title, text: v.text, "text-file": v["text-file"], model: v.model, effort: v.effort, force: v.force, status: v.status, note: v.note, open: v.open,
      "request-id": v["request-id"], "context-message": v["context-message"], "dispatch-mode": v["dispatch-mode"], "max-concurrent": v["max-concurrent"], allow: v.allow, revision: v.revision,
    }, id => console.error(`工单操作编号：${id}。结果未确认时保留原参数并用 --request-id ${id} 核对，不会自动重发。`))); return;
  }
  if (command === "workbench") { await output(await runWorkbenchCommand(directory, sub, argument, { from: v.from, requestId: v["request-id"], contextMessageId: v["context-message"], file: v.file })); return; }
  await withHostManagement(directory, async management => {
    if (command === "changes") { await output(await runChangesCommand(management.client, sub, argument, { bot: v.bot, path: v.path, preview: v.preview, message: v.message, operation: v.operation })); return; }
    if (command === "bus") {
      await output(await runAgentBusCommand(management.client, sub, argument, {
        from: v.from, revision: v.revision, "text-file": v["text-file"], "request-id": v["request-id"], run: v.run, yes: v.yes, abandon: v.abandon,
        coordinator: v.coordinator, members: v.members,
      }, id => console.error(`Agent Bus 请求编号：${id}。断线或超时不会自动重发；请保留此编号和原参数核对结果。`)));
      return;
    }
    if (command === "groups") {
      await output(await runGroupsCommand(management.client, sub, argument, {
        from: v.from, revision: v.revision, "text-file": v["text-file"], file: v.file, run: v.run, "request-id": v["request-id"], "reply-to": v["reply-to"],
        participants: v.participants, supersedes: v.supersedes, then: v.then, "if-running": v["if-running"],
      }, id => console.error(`群讨论请求编号：${id}。断线或超时不会自动重发；请保留此编号和原参数核对结果。`)));
      return;
    }
    if (command === "widgets") { if (v.enabled !== undefined || v.revision !== undefined) throw new Error("widgets publish 不接受设置参数。"); await output(await runWidgetsCommand(management.client, sub, argument, { htmlFile: v["html-file"], reportFile: v["report-file"], title: v.title, summary: v.summary, requestId: v["request-id"] })); return; }
    if (command === "conversations") {
      if (argument || [v.host, v.bot, v["source-bot"]].some(value => value !== undefined)) throw new Error("批量整理使用当前本地主机；不接受跨 Bot 路由参数。");
      await output(await runConversationsCommand(management.client, sub, { ids: v.ids, yes: v.yes, folder: v.folder, unfiled: v.unfiled, newFolder: v["new-folder"], revision: v.revision, requestId: v["request-id"] }, id => console.error(`批量操作编号：${id}。结果不确定时保留原编号和参数核对，勿换编号重复提交。`))); return;
    }
    if (command === "folders") { await output(await runFoldersCommand(management.client, sub, argument, { enabled: v.enabled, revision: v.revision, unfiled: v.unfiled })); return; }
    if (command === "messages") { await output(await runMessagesCommand(management.client, sub, argument, { ids: v.ids, before: v.before, through: v.through, yes: v.yes }, id => console.error(`清理范围编号：${id}。未确认完成时用同一 --through ${id} --yes 继续。`))); return; }
    if (command === "steer") {
      const result = await runSteeringCommand(management.client, sub, argument, { mode: v.mode, message: v.message, bot: v.bot, target: v.target, text: v.text, "request-id": v["request-id"] }, id => console.error(steeringReceiptHint(sub, id)));
      await output(result);
      const failure = steeringCommandFailure(sub, result);
      if (failure) { console.error(failure); process.exitCode = 1; }
      else { const notice = steeringCommandNotice(sub, result); if (notice) console.error(notice); }
      return;
    }
    if (command === "tasks") { await output(await runTasksCommand(management.client, sub, argument, { bot: v.bot, task: v.task, token: v.token, yes: v.yes, "request-id": v["request-id"] }, id => console.error(`任务操作编号：${id}。结果未确认时使用原编号核对，不会自动重发。`))); return; }
    if (command === "side") {
      const abort = new AbortController(), stop = () => abort.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try { await output(await runSideCommand(management.client, sub, argument, { bot: v.bot, text: v.text, "text-file": v["text-file"], file: v.file, timeout: v.timeout, "request-id": v["request-id"] }, abort.signal)); }
      finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      return;
    }
    if (command === "queue") {
      await output(await runQueueCommand(management.client, sub, argument, {
        bot: v.bot, message: v.message, before: v.before, last: v.last, text: v.text,
        "text-file": v["text-file"], revision: v.revision, "request-id": v["request-id"],
      }, id => console.error(`队列操作编号：${id}。若结果未确认，请保留原参数并用 --request-id ${id} 核对。`)));
      return;
    }
    if (command === "name") { const profile = await management.profile(); await output(await management.renameHost(required(sub ?? v.name, "缺少主机名称。"), profile.revision)); return; }
    if (command === "bots") {
      if (v.from !== undefined && sub !== "persona") throw new Error("bots --from 仅支持 persona。");
      if (sub === "list") await output(management.bots());
      else if (sub === "catalog") await output(await management.catalog());
      else if (sub === "create") {
        const input = createBotSchema.parse({ requestId: v["request-id"] ?? randomUUID(), name: required(v.name, "缺少 --name。"), engine: required(v.engine, "缺少 --engine。"), model: v.model ?? "", effort: v.effort ?? "", workspace: v.workspace ? path.resolve(v.workspace) : "", ...(v.permission ? { permission: v.permission } : {}),
          ...(v.role ? { role: v.role } : {}), ...(v.role && (v["dispatch-mode"] !== undefined || v["max-concurrent"] !== undefined || v.allow !== undefined) ? { dispatcher: {
            ...(v["dispatch-mode"] !== undefined ? { mode: v["dispatch-mode"] } : {}), ...(v["max-concurrent"] !== undefined ? { maxConcurrent: Number(v["max-concurrent"]) } : {}),
            ...(Array.isArray(allowedEnginesOption(v.allow)) ? { allowedEngines: allowedEnginesOption(v.allow) } : {}) } } : {}) });
        console.error(`创建 Bot 操作编号：${input.requestId}。结果未确认时保留原参数并用 --request-id ${input.requestId} 重试，避免重复创建。`);
        await output(await management.createBot(input));
      }
      else if (sub === "delete") { yes(); await output(await management.deleteBot(required(argument, "缺少 Bot ID。"), { expectedName: required(v["expected-name"], "删除需填写 --expected-name，核对 Bot 名称。"), confirm: true })); }
      else if (sub === "rename") await output(await management.renameBot(required(argument, "缺少 Bot ID。"), { name: required(v.name, "缺少 --name。"), expectedName: required(v["expected-name"], "缺少 --expected-name。") }));
      else if (sub === "restart") await output(await management.restartBot(required(argument, "缺少 Bot ID。"), v["request-id"]));
      else if (sub === "status") await output(await management.botStatus(required(argument, "缺少 Bot ID。")));
      else if (sub === "chrome") {
        const id = required(argument, "缺少 Bot ID。");
        if (v.enabled === undefined) {
          if (v.revision !== undefined) throw new Error("修改浏览器联动需填写 --enabled on|off 和 --revision。");
          await output(await management.botChrome(id));
        } else {
          if (!["on", "off"].includes(v.enabled)) throw new Error("--enabled 只接受 on 或 off。");
          await output(await management.botChrome(id, { enabled: v.enabled === "on", revision: required(v.revision, "先用 bots chrome ID 读取 revision，再用 --revision 提交。") }));
        }
      }
      else if (sub === "persona") {
        if (v.revision !== undefined) throw new Error("请把 revision 和 text 一起写入 --from 指定的 JSON 文件。");
        await output(await management.botPersona(required(argument, "缺少 Bot ID。"), v.from === undefined ? undefined : await readJson(v.from)));
      }
      else if (sub === "model") {
        const id = required(argument, "缺少 Bot ID。");
        if (v.model === undefined) {
          if (v.effort !== undefined || v.revision !== undefined) throw new Error("修改模型需填写 --model 和 --revision。");
          await output(await management.botModel(id));
        } else {
          await output(await management.botModel(id, {
            revision: required(v.revision, "先用 bots model ID 读取 revision，再用 --revision 提交，避免覆盖其他设备的修改。"),
            model: ["default", "off"].includes(v.model) ? "" : v.model,
            ...(v.effort === undefined ? {} : { effort: (["default", "off"].includes(v.effort) ? "" : v.effort) as import("../client-protocol/model.js").ModelPatch["effort"] }),
          }));
        }
      }
      else throw new Error("未知 bots 命令。请执行 tarobot --help。");
      return;
    }
    if (command === "screens") {
      if (["status", "enable", "disable", "configure"].includes(sub ?? "") && argument) throw new Error("此 screens 命令不接受额外 ID。");
      if (v.from && sub !== "configure" || v.permission && sub !== "allow") throw new Error("--from 仅支持 configure；--permission 仅支持 allow。");
      await output(await screenCommand(management.client, required(sub, "缺少 screens 子命令。"), argument, {
        yes: v.yes, permission: v.permission, requestId: v["request-id"], command: sub === "configure" ? await readJson(required(v.from, "缺少 --from 命令文件。")) : undefined,
      })); return;
    }
    if (command === "devices") {
      if (sub === "list") await output(await management.devices());
      else if (sub === "pending") await output(await management.pendingDevices());
      else if (sub === "invites") await output(await management.pairingInvites());
      else if (sub === "revoke-invite") await output(await management.revokePairingInvite(required(argument, "缺少邀请 ID。")));
      else if (sub === "rename") await output(await management.renameDevice(required(argument, "缺少设备 ID。"), required(v.name, "缺少 --name。")));
      else if (sub === "approve") await output(await management.approveDevice(required(argument, "缺少新设备显示的 8 位配对码。")));
      else if (sub === "revoke") { yes(); await output(await management.revokeDevice(required(argument, "缺少设备 ID。"))); }
      else throw new Error("未知 devices 命令。");
      return;
    }
    if (command === "network" && sub === "local") {
      const local = await new HostNetwork(management.client).localRoutes();
      const addresses = local.routes.map(entry => new URL(entry.route.url).hostname.replace(/^\[|\]$/g, "")).filter(address => isTailscaleAddress(address));
      const tailscale = v.tailscale ? await tailscaleDiagnostic([...new Set(addresses)]) : undefined;
      if (v.json) { await output({ ...local, ...(tailscale ? { tailscale } : {}) }); return; }
      console.log(formatLocalRoutes(local, tailscale)); return;
    }
    if (command === "network") {
      const network = new HostNetwork(management.client), view = await network.view();
      if (sub === "status") { await output(view); return; }
      if (sub === "offer") { if (!view.membership) throw new Error("请先 network create 建立网络。"); await output(view.membership, v.out); return; }
      if (sub === "create") { const action = { operation: "create" as const, name: required(v.name, "缺少网络 --name。") }; const transfer = await executeNetworkTransfer(directory, action, v.out, () => network.command(action)); await output(transfer.document); return; }
      const raw = v.from ? await readJson(v.from) : undefined;
      if (sub === "inspect") {
        if (raw?.proposal) await output(verifyCliNetworkProposal(raw));
        else await output(verifyCliNetworkMembership(raw?.membership ?? raw));
        return;
      }
      yes();
      let action: NetworkCommand;
      if (sub === "routes") action = { operation: "routes", networkId: view.membership?.manifest.id ?? "", routes: sharedRoutesSchema.parse(raw) };
      else if (sub === "propose") {
        const offer = verifyCliNetworkMembership(raw);
        action = { operation: "propose", networkId: offer.manifest.id, authorityKey: offer.manifest.authorityKey, seenManifestHash: hashSecret(networkCanonical(offer.manifest)) };
      } else if (sub === "admit") action = { operation: "admit", proposal: verifyCliNetworkProposal(raw) };
      else if (sub === "join") {
        const admission = z.object({ membership: z.unknown(), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(raw);
        action = { operation: "join", membership: verifyCliNetworkMembership(admission.membership, management.client.publicKey), nonce: admission.nonce };
      } else if (sub === "leave") action = { operation: "leave", networkId: view.membership?.manifest.id ?? "", expectedState: view.membership ? view.host.state : "standalone" };
      else if (sub === "remove") {
        const target = view.membership?.manifest.hosts.find(host => host.publicKey === argument && !host.revoked);
        if (!target) throw new Error("没有找到此网络中的目标主机公钥。");
        action = { operation: "remove", networkId: view.membership!.manifest.id, publicKey: target.publicKey, expectedState: target.state };
      } else throw new Error("未知 network 命令。");
      const transfer = await executeNetworkTransfer(directory, action, v.out, () => network.command(action));
      await output(transfer.document);
      return;
    }
  });
  } finally { if (handleSignals) for (const [signal, handler] of handlers) process.off(signal, handler); }
}

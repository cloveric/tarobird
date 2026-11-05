# Agent Bus Crew 成员授权预检 · 2026-11-01

Issue #103 独立审计 F-02。基线 `bbcced125b65513de3a8ea54c31868e9e81ec52c`。本页只记录这一项修复。

## 问题

Agent Bus 的 Fan、Chain、Verify 在做任何本地或委派工作之前，会先校验运行快照里的显式成员（`core/shared/delegation-commands.ts`）。Crew 没有这一步：成员未获授权时（本 Bot 的 Bus 未启用，或远程角色不在 peer 列表中），仍先执行一轮发起者的拆解模型调用；随后每个研究子问题都以 `bus_disabled` 或 `peer_not_allowed` 失败，发起者对话里只能看到泛化的“所有 research specialist 子任务都失败了”。

App 启动前做过准备度预检，但 CLI `tarobot bus run` 没有；另外，App 预检之后、开始执行之前，权限也可能被另一台设备改掉。这两种情况都会走到上述路径。

## 修复

`handleCrewCoreWorkflow` 只在 Agent Bus 运行（`agentBus: true`，且没有自定义角色委派）时，在发起者模型调用、Crew 运行记录、活动运行锁和任何委派之前，执行与 Fan/Chain/Verify 相同的成员规则：

- 角色先去重。发起者自己担任的角色由 Gateway 在本地执行，不需要自授权；
- 其余每个远程角色，都要求本 Bot 的 Bus 已启用，且该角色通过 `isPeerAllowed`；
- 不满足时，发送与其他模式相同的“协作成员无效或尚未获准……任务未启动”，并结束处理。Hub 中的运行以 `agent_bus_not_executed` 结束，App 显示既有的“协作未开始”说明。

保持不变：
- 同一个 Bot 担任多个角色（每个角色绑定不同的记录对话）、发起者担任角色，这两种合法配置照常运行；
- bus-client 和目标 Bus 服务端在每次实际委派时的双侧授权检查；
- 普通 `/crew`（Bot 保存的 `bus.crew`）和 Mini crew（`crewConfig` 加自有 `delegateRole`）的行为；
- 成员离线、超时、研究失败等业务失败，不会被归类为权限错误；
- Hub schema、Agent Bus 协议、worker capability 和 CLI 命令。

预检在 worker 侧执行，所以由 App 和由 CLI 启动的运行都按同一规则处理。不需要新增 CLI 命令。

## 验证

证据使用真实的共享工作流和真实的 `bus-client.delegateToInstance`，模型为脚本替身。这不是付费真实模型的验收。

- 红绿回归：在 `tests/shared-crew-workflow.test.ts` 新增“Agent Bus crew member preflight”4 例。
  - “Bus 未启用”和“某个远程角色不是 peer”两例：修复前都失败（发起者模型被调用 1 次），修复后通过，结果为 0 次发起者调用、0 次委派、不创建 Crew 运行记录，并发出统一的未启动提示。
  - “同一个 Bot 担任多个角色，加上发起者本地角色”一例：通过真实 Bus 服务端和 bus-client 委派远程角色，修复前后都通过。
  - “普通保存的 `/crew` 不受影响”一例：修复前后都通过。
  - 整个文件 11 例通过。
- 相邻回归：`gateway-agent-bus`、`agent-bus-audit-boundaries`、`shared-mini-bus-commands`、`mini-bus-store`、`core-bus-transport`、`shared-delegation-commands`、`collaboration-task`、`gateway-bus`、`bus`、`agent-bus-instructions` 共 10 个文件，213 例中 212 例通过。唯一失败的是 `bus.test.ts` 的多进程并发注册用例，在并发负载下超过 5 秒；它与本修改无关，单独重跑通过，没有放宽任何超时。
- TypeScript：`tsc --noEmit -p tsconfig.app.json` 无错误。完整的 `tsconfig.json` 报 154 个既有错误，与只读基线在同一命令下的输出一致（只是绝对路径不同），改动文件里没有错误。

没有构建或发布 App/CLI，没有重启生产 Host，也没有改动真实 Bot 配置。

Root independent desired-behavior probe: original Crew case failed while Fan control passed; after the fix, both passed (`root-crew-green.log`). Root source review confirmed no grants are added and ordinary/custom Crew entry paths remain unchanged. The integrated standalone build is included in the final audit index.

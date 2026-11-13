import { EngineSettingsReadError, hostEngineEnvironment } from "../runtime/host-engine-settings.js";
import { assignNewBotAvatar } from "./bot-avatar-default.js";
import { publishExclusive } from "../state/publish-exclusive.js";
import { resolveEngineExecutable } from "../runtime/engine-process.js";
import { killProcessTree } from "../codex/process-tree.js";
import { applyPermission, currentPermission, defaultPermission, permissionOptions } from "../state/permission-options.js";
import { isRunActive, runSummarySchema } from "../client-protocol/run.js";
import { antigravityEffortChoices, discoverAntigravityModels, preferredAntigravityModel } from "../codex/antigravity-models.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { RedactedLogTail } from "../runtime/redacted-log-tail.js";
import { idSchema } from "../client-protocol/index.js";
import { createBotSchema, type CreateBotInput, type BotCatalog } from "../client-protocol/bots.js";
import { defaultDispatcherSettings } from "../client-protocol/dispatch.js";
import { saveDispatcherSettingsInTransaction } from "./dispatch.js";
import { CODEX_MODEL_CHOICES } from "../codex/model-capabilities.js";
import { modelCatalog } from "../runtime/model-catalog.js";
import { readEngineCapabilities } from "../runtime/bot-capabilities.js";
import { applyEngineSelection, getEngineEffortValidationError, loadInstanceConfig, readValidatedConfigFile, resolveInstanceWorkspacePath, updateInstanceConfig, type InstanceEngine } from "../state/instance-config.js";
import { hashSecret } from "./auth.js";
import { HubError, type HubStore, type TransactionGuard } from "./store.js";
import { DEFAULT_UNCLEAN_BOOT_WINDOW_MS } from "../runtime/restart-loop-guard.js";
import { appendServiceLifecycleEventSync } from "../runtime/service-lifecycle-log.js";
import { GatewayReceipts } from "../gateway/receipts.js";
import { drainCancelledSchema, drainStatusReceiptSchema, restartQueuedSchema, type DrainBlocker } from "../gateway/control.js";

export { createBotSchema, type CreateBotInput, type BotCatalog } from "../client-protocol/bots.js";
type Managed = { bot_id: string; owner_id: string; request_id: string; specification_json: string };
export interface BotManagerOptions { entrypoint: string; env?: NodeJS.ProcessEnv }
const restartResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.object({ text: z.string() }) }),
  z.object({ ok: z.literal(false), error: z.enum(["hub_stopping", "bot_worker_stopping", "restart_send_failed", "restart_confirmation_unavailable", "operation_failed", "operation_interrupted", "engine_settings_unavailable"]) }),
]);
type RestartResult = z.infer<typeof restartResultSchema>;
/** Each Bot owns a normal TaroCub config, workspace, session store and process.
 * Only newly created instances under this Hub's directory are managed here. */
export class BotManager {
  private children = new Map<string, ChildProcess>();
  private failures = new Map<string, number[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private tail: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private draining = false;
  private drainTail: Promise<void> = Promise.resolve();
  private drainOperations = 0;
  private drainId?: string;
  private drainTimer?: ReturnType<typeof setTimeout>;
  private drainCancelling = false;
  private drainBlockers = new Map<ChildProcess, DrainBlocker[]>();
  private deleted = new Set<string>();
  private logs = new Map<string, RedactedLogTail>();
  private restartReceipts = new Map<string, GatewayReceipts>();
  private restartPending = new Map<string, Promise<RestartResult>>();
  private restartQueued = new WeakSet<ChildProcess>();
  private restartTasks = new Set<Promise<RestartResult>>();
  /** Bots whose last launch was refused because the engine path settings were unreadable. */
  private settingsBlocked = new Set<string>();
  constructor(readonly store: HubStore, readonly directory: string, readonly options: BotManagerOptions, readonly instanceUrl: () => string, readonly changed: (id: string) => Promise<void>) {}
  private get env(): NodeJS.ProcessEnv {
    try { return hostEngineEnvironment(this.directory, this.options.env ?? process.env); }
    catch (error) { if (error instanceof EngineSettingsReadError) throw new HubError(error.message, 503); throw error; }
  }
  capabilities(engine: InstanceEngine) { return readEngineCapabilities(engine, { env: this.env }); }
  private engineBinaries(env = this.env): Record<InstanceEngine, string> {
    return { codex: env.CODEX_EXECUTABLE || "codex", claude: env.CLAUDE_EXECUTABLE || "claude", kimi: env.KIMI_EXECUTABLE || "kimi", deepseek: env.DSH_EXECUTABLE || "dsh", antigravity: env.ANTIGRAVITY_EXECUTABLE || "agy" };
  }
  engineAvailable(engine: InstanceEngine): boolean { const env = this.env; return !!resolveEngineExecutable(this.engineBinaries(env)[engine], env); }
  async catalog(): Promise<BotCatalog> {
    const env = this.env, bins = this.engineBinaries(env);
    return { engines: await Promise.all((Object.keys(bins) as InstanceEngine[]).map(async (id) => {
      const available = !!resolveEngineExecutable(bins[id], env);
      const models = id === "antigravity" && !available ? [{ id: "", efforts: [""] }] : await modelCatalog(id, env);
      const defaults: Record<string, unknown> = {}; applyEngineSelection(defaults, id);
      if (id === "antigravity") defaults.model = preferredAntigravityModel(models);
      return { id, available, models, permissions: { defaultChoice: defaultPermission(id), choices: permissionOptions(id) }, defaultModel: String(defaults.model ?? (id === "codex" ? CODEX_MODEL_CHOICES[0] : "")), defaultEffort: String(defaults.effort ?? "") };
    })) };
  }
  async restore(): Promise<void> {
    const rows = await this.store.db.serial(() => this.store.db.all<Managed>("SELECT m.* FROM managed_bots m JOIN bots b ON b.id=m.bot_id WHERE b.deleted_at IS NULL"));
    for (const row of rows) { try { await this.prepare(row); this.launch(row.bot_id); } catch { await this.store.audit("bot.start_failed", null, { botId: row.bot_id }); } }
  }
  create(userId: string, input: CreateBotInput, validate?: TransactionGuard, options: { internal?: true; dispatcherId?: string } = {}) {
    const authorize = async () => { await validate?.(); await this.store.requireOwner(userId); };
    const work = this.tail.then(async () => {
      if (this.stopping || this.draining) throw new HubError("hub_draining", 503);
      await this.store.db.serial(authorize);
      const spec = createBotSchema.parse(input);
      if (spec.role === "worker" && !options.internal) throw new HubError("bot_role_forbidden", 403);
      if (spec.permission && !permissionOptions(spec.engine).some(option => option.id === spec.permission)) throw new HubError("permissions_incompatible");
      const incompatible = getEngineEffortValidationError(spec.engine, spec.effort || undefined, spec.model || undefined);
      if (incompatible) throw new HubError("bot_effort_incompatible");
      const botId = `client_${createHash("sha256").update(`${userId}:${spec.requestId}`).digest("hex").slice(0, 24)}`;
      if (await this.store.db.serial(() => this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NOT NULL", [botId]))) throw new HubError("bot_deleted", 410);
      let row = await this.store.db.serial(() => this.store.db.get<Managed>("SELECT * FROM managed_bots WHERE bot_id=?", [botId]));
      if (row && row.specification_json !== JSON.stringify(spec)) throw new HubError("idempotency_conflict", 409);
      const creating = !row;
      if (!row) {
        const engine = (await this.catalog()).engines.find((e) => e.id === spec.engine);
        if (!engine?.available) throw new HubError("bot_engine_unavailable", 409);
        if (spec.engine === "kimi" && spec.effort && engine.models.find(model => model.id === spec.model)?.efforts.includes(spec.effort) === false) throw new HubError("bot_effort_incompatible");
        if (spec.engine === "antigravity" && spec.effort && !antigravityEffortChoices(await discoverAntigravityModels(this.env), spec.model).includes(spec.effort)) throw new HubError("bot_effort_incompatible");
        if (spec.workspace && (!path.isAbsolute(spec.workspace) || !await stat(spec.workspace).then((s) => s.isDirectory(), () => false))) throw new HubError("bot_workspace_unavailable");
        await this.store.db.serial(authorize);
        row = { bot_id: botId, owner_id: userId, request_id: spec.requestId, specification_json: JSON.stringify(spec) };
        const secret = await this.prepare(row);
        await this.store.db.transaction(async () => {
          await authorize();
          await this.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES(?,?,?,?,?,?,?)", [botId, spec.name, hashSecret(secret), spec.engine, spec.model, spec.effort, spec.role ?? ""]);
          if (spec.role === "dispatcher") await saveDispatcherSettingsInTransaction(this.store.db, botId, spec.dispatcher ?? defaultDispatcherSettings());
          await this.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [botId, userId, spec.requestId, row!.specification_json]);
          if (options.internal && options.dispatcherId && spec.role === "worker") await this.store.db.run("INSERT INTO dispatch_workers VALUES(?,?,?) ON CONFLICT(dispatcher_bot_id,engine) DO UPDATE SET bot_id=excluded.bot_id", [options.dispatcherId, spec.engine, botId]);
          await assignNewBotAvatar(this.store.db, botId);
        });
        await this.store.audit("bot.created", userId, { botId, engine: spec.engine, ...(spec.role ? { role: spec.role } : {}) }); await this.changed(botId);
      }
      if (!this.children.has(botId) && !this.timers.has(botId)) {
        if (creating) {
          // Registration admitted this durable worker. Complete its launch even
          // if the original device disconnects; restore() uses the same record.
          this.failures.delete(botId); this.launch(botId);
        } else {
          await this.prepare(row);
          await this.store.db.serial(async () => { await authorize(); this.failures.delete(botId); this.launch(botId); });
        }
      }
      return (await this.store.bots(userId)).find((b) => b.id === botId)!;
    });
    this.tail = work.catch(() => undefined); return work;
  }
  /** A dispatcher's hidden worker for one engine CLI: created on first use with
   * the CLI's own defaults and the dispatcher's workspace. Tickets choose their
   * model and effort per conversation, so this Bot's settings never change. */
  async dispatchWorker(dispatcherId: string, engine: InstanceEngine, validate?: TransactionGuard): Promise<string> {
    const existing = await this.store.db.serial(async () => {
      await validate?.();
      return this.store.db.get<{ bot_id: string; name: string; deleted_at: number | null }>("SELECT w.bot_id,b.name,b.deleted_at FROM dispatch_workers w JOIN bots b ON b.id=w.bot_id WHERE w.dispatcher_bot_id=? AND w.engine=?", [dispatcherId, engine]);
    });
    const dispatcher = await this.store.db.serial(() => this.store.db.get<{ name: string; owner_id: string }>("SELECT b.name,m.owner_id FROM bots b JOIN managed_bots m ON m.bot_id=b.id WHERE b.id=? AND b.role='dispatcher' AND b.deleted_at IS NULL", [dispatcherId]));
    if (!dispatcher) throw new HubError("dispatcher_required", 409);
    const config = await readValidatedConfigFile(path.join(this.directory, "bots", dispatcherId, "config.json"), { forExecution: true });
    const selected = currentPermission(config.engine ?? "codex", config);
    // Engine-specific auto modes are not equivalent. Across engines preserve
    // explicit bypass/manual; otherwise fall back to manual rather than widen.
    const permission = config.engine === engine || selected === "bypass" || selected === "normal" ? selected : "normal";
    const workspace = resolveInstanceWorkspacePath({ workspacePath: config.workspacePath, resume: config.resume }) ?? "";
    const label = { codex: "Codex", claude: "Claude", kimi: "Kimi", deepseek: "DeepSeek", antigravity: "Antigravity" }[engine];
    const guard = async () => {
      await validate?.();
      if (!await this.store.db.get("SELECT 1 FROM bots WHERE id=? AND role='dispatcher' AND deleted_at IS NULL", [dispatcherId])) throw new HubError("dispatcher_required", 409);
    };
    if (existing && existing.deleted_at === null) {
      const previous = await readValidatedConfigFile(path.join(this.directory, "bots", existing.bot_id, "config.json"), { forExecution: true });
      if (currentPermission(engine, previous) === permission) return existing.bot_id;
      // Never rewrite settings under an in-flight turn. An idle replacement
      // starts a fresh CLI session; the deleted generation retains its history.
      const phases = runSummarySchema.shape.phase.options.filter(isRunActive), params = phases.map(() => "?").join(",");
      await this.delete(dispatcher.owner_id, existing.bot_id, existing.name, async () => {
        await guard();
        const pending = await this.store.db.get("SELECT 1 FROM deliveries WHERE bot_id=? AND status='pending' UNION ALL SELECT 1 FROM action_deliveries WHERE bot_id=? AND status='pending' LIMIT 1", [existing.bot_id, existing.bot_id]);
        const running = await this.store.db.get(`SELECT 1 FROM messages WHERE author_id=? AND author_type='bot' AND status!='deleted' AND
          (status IN ('pending','streaming') OR EXISTS (SELECT 1 FROM json_each(blocks_json) b WHERE json_extract(b.value,'$.extra.nativeRun.phase') IN (${params}) OR json_extract(b.value,'$.extra.scopedRun.phase') IN (${params}) OR json_extract(b.value,'$.extra.answerFollowup.phase') IN ('queued','processing'))) LIMIT 1`, [existing.bot_id, ...phases, ...phases]);
        if (pending || running) throw new HubError("dispatch_worker_permissions_busy", 409);
      });
    }
    // A deleted worker keeps its history. Its ID names the next generation so
    // concurrent retries agree on one replacement instead of resurrecting it.
    const requestId = `dw_${dispatcherId}_${engine}${existing ? `_${existing.bot_id}` : ""}`;
    const bot = await this.create(dispatcher.owner_id, { requestId, name: `${dispatcher.name.slice(0, 80)} · ${label}`, engine, model: "", effort: "", workspace, role: "worker", permission }, guard, { internal: true, dispatcherId });
    return this.store.db.transaction(async () => {
      await guard();
      const live = await this.store.db.get<{ bot_id: string }>("SELECT w.bot_id FROM dispatch_workers w JOIN bots b ON b.id=w.bot_id WHERE w.dispatcher_bot_id=? AND w.engine=? AND b.deleted_at IS NULL", [dispatcherId, engine]);
      if (live) return live.bot_id;
      if (!await this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [bot.id])) throw new HubError("dispatch_worker_unavailable", 409);
      await this.store.db.run("INSERT INTO dispatch_workers VALUES(?,?,?) ON CONFLICT(dispatcher_bot_id,engine) DO UPDATE SET bot_id=excluded.bot_id", [dispatcherId, engine, bot.id]);
      return bot.id;
    });
  }
  async ticketWorkspace(dispatcherId: string, ticketId: string): Promise<string> {
    const root = resolveInstanceWorkspacePath(await loadInstanceConfig(path.join(this.directory, "bots", idSchema.parse(dispatcherId)))) ?? path.join(this.directory, "bots", dispatcherId, "workspace");
    const directory = path.join(root, "tickets", idSchema.parse(ticketId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
  private async prepare(row: Managed): Promise<string> {
    const spec = createBotSchema.parse(JSON.parse(row.specification_json));
    const stateDir = path.join(this.directory, "bots", row.bot_id); await mkdir(stateDir, { recursive: true, mode: 0o700 });
    // A rejected/crashed creation can leave inert preparation files. Bind them
    // to the original request so a retry cannot silently run an older config
    // under a different specification. Never delete a pre-existing workspace.
    const specification = path.join(stateDir, "managed-bot-spec.json");
    try { await publishExclusive(specification, row.specification_json); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(specification, "utf8") !== row.specification_json) throw new HubError("idempotency_conflict", 409);
    }
    const key = path.join(stateDir, "gateway.key");
    try { await publishExclusive(key, randomBytes(32).toString("base64url")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const workspace = spec.workspace || path.join(stateDir, "workspace"); await mkdir(workspace, { recursive: true, mode: 0o700 });
    // Only initialize a new config. /model and /effort changes survive Hub restarts.
    if (!await stat(path.join(stateDir, "config.json")).then(() => true, () => false)) await updateInstanceConfig(stateDir, (config) => {
      applyEngineSelection(config, spec.engine); config.model = spec.model || undefined; config.effort = spec.effort || undefined; config.workspacePath = workspace; config.locale = "zh";
      if (spec.permission) applyPermission(config, spec.engine, spec.permission);
      // The Gateway reads the role to add the host-owned dispatcher contract.
      if (spec.role === "dispatcher") config.role = spec.role;
    });
    const secret = (await readFile(key, "utf8")).trim();
    const existing = await this.store.db.serial(() => this.store.db.get<{ secret_hash: string }>("SELECT secret_hash FROM bots WHERE id=?", [row.bot_id]));
    if (existing && existing.secret_hash !== hashSecret(secret)) throw new HubError("bot_key_mismatch", 409);
    return secret;
  }
  private launch(botId: string): ChildProcess | undefined {
    if (this.stopping || this.draining || this.deleted.has(botId) || this.children.has(botId)) return;
    let env: NodeJS.ProcessEnv;
    try { env = this.env; this.settingsBlocked.delete(botId); }
    catch (error) {
      if (error instanceof HubError && error.code === "engine_settings_unavailable") this.settingsBlocked.add(botId);
      // A damaged operator setting must not crash the Host from a retry timer
      // or silently launch a different executable. Existing workers keep running.
      const previous = this.logs.get(botId)?.text() ?? "", notice = "Engine path settings are unavailable. Check the host settings file before restarting this Bot.\n";
      const log = new RedactedLogTail(previous); if (!previous.endsWith(notice)) log.write(notice); this.logs.set(botId, log);
      const timer = setTimeout(() => { this.timers.delete(botId); this.launch(botId); }, 60_000); timer.unref(); this.timers.set(botId, timer);
      return;
    }
    const stateDir = path.join(this.directory, "bots", botId);
    const child = fork(this.options.entrypoint, ["gateway", "run", "--state-dir", stateDir, "--bot-id", botId, "--hub-url", this.instanceUrl().replace(/^http/, "ws") + "/instance"], { env: { ...env, TAROBOT_CLI_ENTRYPOINT: this.options.entrypoint, TAROBOT_NODE_EXECUTABLE: process.execPath, TAROBOT_HOST_DIR: this.directory, TAROBOT_INSTANCE: botId, TAROBOT_STATE_DIR: stateDir }, execArgv: [], ...{ windowsHide: true }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    this.children.set(botId, child);
    const log = new RedactedLogTail(this.logs.get(botId)?.text()); this.logs.set(botId, log);
    child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
    child.stderr?.once("close", () => log.end());
    let finished = false;
    const exit = (code: number | null) => {
      if (finished) return; finished = true; this.children.delete(botId);
      if (this.stopping || this.draining || this.deleted.has(botId)) return;
      const now = Date.now();
      const failures = code === 75 ? [] : [...(this.failures.get(botId) ?? []).filter((at) => at >= now - DEFAULT_UNCLEAN_BOOT_WINDOW_MS && at <= now), now];
      this.failures.set(botId, failures); const attempts = failures.length;
      // A transient lock/disk/startup failure must not strand a Bot forever.
      // Keep the crash-loop guard, but probe slowly after the fast retry budget.
      const retryAfterMs = attempts > 3 ? Math.min(300_000, 60_000 * 2 ** Math.min(attempts - 4, 3)) : Math.min(10_000, 500 * 2 ** attempts);
      const detail = { botId, exitCode: code ?? -1, recentFailures: attempts, restartPaused: false, retryAfterMs };
      void this.store.audit("bot.worker_stopped", null, detail).catch(() => undefined);
      appendServiceLifecycleEventSync(path.join(this.directory, "bots", botId), { type: "process.exit", instanceName: botId, outcome: code === 75 ? "success" : "error", detail: log.text().slice(-2048), metadata: detail });
      const timer = setTimeout(() => { this.timers.delete(botId); this.launch(botId); }, retryAfterMs); timer.unref(); this.timers.set(botId, timer);
    };
    child.on("error", error => {
      // IPC send/kill errors can occur while the process is still alive. Keep
      // ownership until exit; only a failed spawn (no PID) is already terminal.
      if (!child.pid) { log.write(`${error.message}\n`); exit(null); }
      else void this.store.audit("bot.worker_error", null, { botId, pid: child.pid }).catch(() => undefined);
    });
    child.once("exit", (code) => exit(code));
    return child;
  }
  async owns(botId: string): Promise<boolean> { return !!await this.store.db.serial(() => this.store.db.get("SELECT 1 FROM managed_bots m JOIN bots b ON b.id=m.bot_id WHERE bot_id=? AND b.deleted_at IS NULL", [botId])); }
  serviceStatus(botId: string): { text: string } {
    const child = this.children.get(botId);
    const status = child?.pid ? `PID: ${child.pid}${child.connected ? "" : "\n进程通信已断开，正在等待退出。"}` : this.timers.has(botId) ? (this.failures.get(botId)?.length ?? 0) > 3 ? "近期连续异常退出，正在慢速重试（间隔 1–5 分钟）。也可查看日志后点击空闲后重启。" : "正在等待自动重启。" : "进程尚未运行，可点击空闲后重启。";
    return { text: [`TaroBird Hub 管理的独立 Bot`, status, this.logs.get(botId)?.text() ?? ""].filter(Boolean).join("\n") };
  }
  restart(botId: string, receiptId = `restart_${randomUUID()}`, authorize?: () => Promise<void>): Promise<RestartResult> {
    if (this.stopping || this.draining) return Promise.resolve({ ok: false, error: "hub_stopping" });
    const task = this.restartOnce(botId, receiptId, authorize); this.restartTasks.add(task);
    void task.finally(() => this.restartTasks.delete(task)).catch(() => undefined);
    return task;
  }
  private async restartOnce(botId: string, receiptId: string, authorize?: () => Promise<void>): Promise<RestartResult> {
    idSchema.parse(botId); idSchema.parse(receiptId);
    if (!await this.owns(botId)) throw new HubError("bot_forbidden", 403);
    let receipts = this.restartReceipts.get(botId);
    if (!receipts) { receipts = new GatewayReceipts(path.join(this.directory, "bot-operations", botId)); this.restartReceipts.set(botId, receipts); }
    const receipt = await receipts.run(`restart:${receiptId}`, async () => {
      let task = this.restartPending.get(botId);
      if (!task) {
        task = this.performRestart(botId); this.restartPending.set(botId, task);
        void task.finally(() => this.restartPending.delete(botId)).catch(() => undefined);
      }
      return task;
    }, 0, authorize);
    return restartResultSchema.parse(receipt.ok ? receipt.result : receipt);
  }
  private async performRestart(botId: string, drain: false | string = false): Promise<RestartResult> {
    if (this.deleted.has(botId) || !await this.owns(botId)) throw new HubError("bot_deleted", 410);
    if (this.stopping) return { ok: false, error: "hub_stopping" };
    const child = this.children.get(botId);
    if (child) {
      if (!drain && this.restartQueued.has(child)) return { ok: true, result: { text: "已安排空闲后重启" } };
      if (!child.connected) return { ok: false, error: "bot_worker_stopping" };
      const requestId = drain || `ipc_${randomUUID()}`;
      return new Promise<RestartResult>((resolve) => {
        let settled = false;
        const finish = (result: RestartResult) => { if (settled) return; settled = true; clearTimeout(timer); child.off("message", message); child.off("exit", exit); resolve(result); };
        const exit = () => finish({ ok: false, error: "restart_confirmation_unavailable" });
        const message = (value: unknown) => {
          const receipt = restartQueuedSchema.safeParse(value);
          if (receipt.success && receipt.data.requestId === requestId && receipt.data.pid === child.pid) {
            if (!drain) this.restartQueued.add(child); finish({ ok: true, result: { text: "已安排空闲后重启" } });
          }
        };
        const timer = setTimeout(exit, 3000); timer.unref(); child.on("message", message); child.once("exit", exit);
        try { child.send({ type: drain ? "drain.whenIdle" : "restart.whenIdle", requestId }, (error) => { if (error) finish({ ok: false, error: "restart_send_failed" }); }); }
        catch { finish({ ok: false, error: "restart_send_failed" }); }
      });
    }
    const timer = this.timers.get(botId); if (timer) clearTimeout(timer); this.timers.delete(botId); this.failures.delete(botId);
    const launched = this.launch(botId);
    // launch() already logged the reason and re-armed its retry. A damaged
    // settings file is the owner's to repair; it is not a stopping Hub.
    if (!launched) return { ok: false, error: !this.stopping && !this.draining && this.settingsBlocked.has(botId) ? "engine_settings_unavailable" : "hub_stopping" };
    return new Promise((resolve) => {
      const spawned = () => { launched.off("error", failed); resolve({ ok: true, result: { text: "已启动 Bot，正在连接。" } }); };
      const failed = () => { launched.off("spawn", spawned); resolve({ ok: false, error: "operation_failed" }); };
      launched.once("spawn", spawned); launched.once("error", failed);
    });
  }
  delete(userId: string, botId: string, expectedName: string, validate?: TransactionGuard) {
    idSchema.parse(botId);
    const work = this.tail.then(async () => {
      if (this.stopping) throw new HubError("hub_stopping", 503);
      const conversations = await this.store.deleteBot(userId, botId, expectedName, validate);
      this.deleted.add(botId); this.settingsBlocked.delete(botId);
      const timer = this.timers.get(botId); if (timer) clearTimeout(timer); this.timers.delete(botId);
      this.failures.delete(botId);
      // Publish revocation before stopping: new inputs cannot reach this worker.
      await this.changed(botId).catch(() => undefined);
      const child = this.children.get(botId);
      if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(escalate); clearTimeout(deadline); resolve(); };
        const escalate = setTimeout(() => killProcessTree(child.pid, { graceMs: 500 }), 8000);
        const deadline = setTimeout(() => { clearTimeout(escalate); child.off("exit", done); reject(new HubError("bot_stop_unconfirmed", 503)); }, 12_000);
        child.once("exit", done);
        if (child.connected) { try { child.send({ type: "shutdown.now" }, () => {}); } catch { /* escalation remains armed */ } }
        else if (process.platform !== "win32") child.kill("SIGTERM");
      });
      this.logs.delete(botId);
      return conversations;
    });
    this.tail = work.catch(() => undefined); return work;
  }
  beginShutdown(): void {
    clearTimeout(this.drainTimer); this.drainId = undefined;
    this.stopping = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
  }
  get shutdownComplete(): boolean { return this.stopping && this.children.size === 0; }
  async close(): Promise<void> {
    this.beginShutdown(); await this.tail; await this.drainTail;
    await Promise.all([...this.children.values()].map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => {
        // A wedged worker cannot finish its own engine cleanup; take its tree.
        // The owned handle is SIGKILLed on its own timer, so a missing or hung
        // `pgrep`/`ps` can never delay it.
        try {
          if (process.platform === "win32") killProcessTree(child.pid);
          else {
            void killProcessTree(child.pid, { graceMs: 500 });
            const hard = setTimeout(() => { try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* exit is still awaited */ } }, 1_000);
            child.once("exit", () => clearTimeout(hard));
          }
        }
        catch { /* Keep ownership and wait for actual exit; never claim closed. */ }
      }, 8000); timer.unref(); child.once("exit", () => { clearTimeout(timer); resolve(); });
      // Windows SIGTERM is an immediate TerminateProcess; IPC lets engines,
      // pending deliveries and SQLite finish their normal shutdown first.
      if (child.connected) { try { child.send({ type: "shutdown.now" }, () => {}); } catch { /* watchdog owns escalation */ } }
      else if (process.platform !== "win32") { try { child.kill("SIGTERM"); } catch { /* watchdog owns escalation */ } }
    })));
    await Promise.allSettled([...this.restartTasks]);
  }

  /** Wait for the workers' existing idle boundary; never terminate an active run.
   * New persisted inputs stay queued until the same host starts again. */
  drainStatus() {
    const blockers = this.draining ? [...this.children.values()].flatMap(child => this.drainBlockers.get(child) ?? []).slice(0, 128) : [];
    return { draining: this.draining, drained: this.draining && !this.drainOperations && this.children.size === 0, ...(this.drainId ? { drainId: this.drainId } : {}), ...(blockers.length ? { drainBlockers: blockers } : {}) };
  }
  private transitionDrain(work: () => Promise<void>): Promise<void> {
    this.drainOperations++;
    const task = this.drainTail.then(work).finally(() => { this.drainOperations--; });
    this.drainTail = task.catch(() => undefined); return task;
  }
  drain(requestedId?: string): Promise<void> {
    return this.transitionDrain(async () => {
      if (requestedId) idSchema.parse(requestedId);
      if (this.draining) { if (requestedId && requestedId !== this.drainId) throw new Error("host_drain_owned"); return; }
      this.draining = true;
      this.drainBlockers.clear();
      this.drainCancelling = false;
      const drainId = this.drainId = requestedId ?? `drain_${randomUUID()}`;
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear(); await this.tail;
      await Promise.all([...this.children.entries()].map(async ([botId, child]) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const result = await this.performRestart(botId, drainId);
        if (!result.ok) throw new Error(`host_drain_unconfirmed:${botId}:${result.error}`);
      }));
      this.pollDrain(drainId);
    });
  }
  cancelDrain(requestedId?: string): Promise<void> {
    return this.transitionDrain(async () => {
      if (!this.draining) return;
      if (requestedId && requestedId !== this.drainId) throw new Error("host_drain_owned");
      clearTimeout(this.drainTimer); this.drainCancelling = true;
      // Complete the pending drain receipts before cancel can overtake them.
      // IPC messages to each child remain ordered even across separate calls.
      await Promise.all([...this.children.values()].map(child => this.cancelWorkerDrain(child)));
      this.draining = false;
      this.drainBlockers.clear();
      this.drainId = undefined;
      await this.restore();
    });
  }
  /** Keep idle peers alive until the whole fleet is quiet: a running turn may
   * still delegate to them. Only after this barrier may workers exit. */
  private pollDrain(drainId: string): void {
    this.drainTimer = setTimeout(() => {
      void (async () => {
        if (this.stopping || this.drainCancelling || this.drainId !== drainId) return;
        const children = [...this.children.entries()];
        const idle = await Promise.all(children.map(([botId, child]) => this.workerIdle(botId, child, drainId)));
        if (this.stopping || this.drainCancelling || this.drainId !== drainId) return;
        if (idle.every(Boolean)) for (const [, child] of children) if (child.connected) {
          try { child.send({ type: "drain.commit", drainId }, () => {}); } catch { /* retain until confirmed exit */ }
        }
        if (this.children.size) this.pollDrain(drainId);
      })().catch(() => { if (!this.stopping && !this.drainCancelling && this.drainId === drainId) this.pollDrain(drainId); });
    }, 250); this.drainTimer.unref();
  }
  private workerIdle(botId: string, child: ChildProcess, drainId: string): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    if (!child.connected) return Promise.resolve(false);
    const requestId = `ipc_${randomUUID()}`;
    return new Promise(resolve => {
      let finished = false;
      const finish = (idle: boolean, blockers?: DrainBlocker[]) => {
        if (finished) return; finished = true;
        clearTimeout(timer); child.off("message", receive); child.off("exit", exited);
        if (this.drainId === drainId && !this.drainCancelling && this.children.get(botId) === child) {
          if (idle) this.drainBlockers.delete(child);
          else this.drainBlockers.set(child, blockers?.length ? blockers.map(reason => ({ ...reason, botId })) : [{ botId, type: "worker", count: 1 }]);
        }
        resolve(idle);
      };
      const exited = () => finish(true);
      const receive = (value: unknown) => { const receipt = drainStatusReceiptSchema.safeParse(value); if (receipt.success && receipt.data.requestId === requestId && receipt.data.drainId === drainId && receipt.data.pid === child.pid) finish(receipt.data.idle, receipt.data.blockers); };
      const timer = setTimeout(() => finish(false), 3000); timer.unref(); child.on("message", receive); child.once("exit", exited);
      try { child.send({ type: "drain.status", requestId, drainId }, error => { if (error) finish(false); }); } catch { finish(false); }
    });
  }
  private cancelWorkerDrain(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    if (!child.connected) return Promise.reject(new Error("host_drain_cancel_unconfirmed"));
    const requestId = `ipc_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); child.off("message", receive); child.off("exit", exited); error ? reject(error) : resolve(); };
      const exited = () => finish(); // restore() will launch this already-drained worker.
      const receive = (value: unknown) => { const receipt = drainCancelledSchema.safeParse(value); if (receipt.success && receipt.data.requestId === requestId && receipt.data.pid === child.pid) finish(receipt.data.ok ? undefined : new Error("host_drain_cancel_failed")); };
      const timer = setTimeout(() => finish(new Error("host_drain_cancel_unconfirmed")), 3000); timer.unref();
      child.on("message", receive); child.once("exit", exited);
      try { child.send({ type: "drain.cancel", requestId }, error => { if (error) finish(new Error("host_drain_cancel_send_failed")); }); }
      catch { finish(new Error("host_drain_cancel_send_failed")); }
    });
  }
}

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JsonStore } from "../state/json-store.js";
import { withFileMutex } from "../state/file-mutex.js";
import { readProcessEpoch, type ProcessEpoch } from "../state/process-epoch.js";
import { asrInstallSchema, asrJobSchema, asrPhaseSchema, asrStateSchema, type AsrInstall, type AsrJob, type AsrState } from "../client-protocol/asr-setup.js";

const active = new Map<string, { controller: AbortController; work: Promise<void>; owner: QwenAsrSetup }>();
const storedJobSchema = asrJobSchema.extend({ processEpoch: z.object({ bootId: z.string().max(100).optional(), processBirth: z.string().max(100).optional(), machineId: z.string().max(100).optional() }).optional() });
type StoredJob = z.infer<typeof storedJobSchema>;
const jobAlive = async (job: StoredJob | undefined) => {
  if (!job || job.status !== 'running' || Date.now() - job.startedAt > 3_660_000) return false;
  try { process.kill(job.pid, 0); } catch { return false; }
  if (job.processEpoch) {
    const current: ProcessEpoch = await readProcessEpoch(job.pid).catch(() => ({}));
    for (const key of ['bootId', 'processBirth', 'machineId'] as const) {
      if (job.processEpoch[key] && current[key] && job.processEpoch[key] !== current[key]) return false;
    }
  }
  return true;
};
const safeError = (value: string) => /^[a-z0-9_]{1,100}$/.test(value) ? value : "installation_failed";
const packageRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), import.meta.url.includes('/dist/src/') ? '../../..' : '../..');
export class AsrSetupError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export type AsrExecutor = (args: string[], signal: AbortSignal, phase?: (phase: AsrJob['phase']) => void, authorize?: () => Promise<void>, spawned?: (pid: number) => void) => Promise<string>;

/** Shared account-level integration. Hub and CLI run the same packaged installer.
 * The Python installer also holds an OS file lock, including direct Bash callers. */
export class QwenAsrSetup {
  private readonly file: string;
  private readonly records: JsonStore<{ jobs: StoredJob[] }>;
  private readonly execute: AsrExecutor;
  private cached?: { at: number; value: AsrState };
  private reading?: Promise<AsrState>;
  constructor(readonly home = os.homedir(), execute?: AsrExecutor) {
    this.file = path.join(home, '.tarobot', 'asr-setup.json');
    this.records = new JsonStore(this.file, value => z.object({ jobs: z.array(storedJobSchema).max(64) }).parse(value));
    this.execute = execute ?? ((args, signal, phase, authorize, spawned) => this.run(args, signal, phase, authorize, spawned));
  }
  private async run(args: string[], signal: AbortSignal, onPhase?: (phase: AsrJob['phase']) => void, authorize?: () => Promise<void>, spawned?: (pid: number) => void): Promise<string> {
    const script = path.join(packageRoot(), 'scripts/install-qwen-asr.sh');
    const status = args.includes('--status');
    const logDir = path.join(this.home, '.tarobot');
    if (!status) await mkdir(logDir, { recursive: true, mode: 0o700 });
    // Bounded public output; verbose package-manager output stays in a private local log.
    const log = status ? undefined : await open(path.join(logDir, 'asr-install.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    let logWrites = Promise.resolve(), logBytes = 0;
    try {
      await authorize?.();
      signal.throwIfAborted();
      return await new Promise<string>((resolve, reject) => {
        let output = '', failure = '', settled = false;
        const pending: Record<string, string> = { stdout: '', stderr: '' };
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const executable = process.platform === 'win32' ? (process.env.PYTHON_BIN || 'python') : 'bash';
        const argv = process.platform === 'win32' ? [path.join(packageRoot(), 'scripts/qwen-asr-install.py'), ...args] : [script, ...args];
        const child = spawn(executable, argv, { env: { ...process.env, HOME: this.home }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        if (child.pid) spawned?.(child.pid);
        const kill = () => {
          try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch {}
          escalation ??= setTimeout(() => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 10_000);
          escalation.unref();
        };
        const timer = setTimeout(kill, status ? 10_000 : 3_600_000); timer.unref();
        const abort = () => kill(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        const consume = (stream: string, chunk: Buffer) => {
          if (log && logBytes < 16 * 1024 * 1024) { const bytes = chunk.subarray(0, 16 * 1024 * 1024 - logBytes); logBytes += bytes.length; logWrites = logWrites.then(async () => { await log.write(bytes); }).catch(() => undefined); }
          if (status) { output += chunk.toString(); if (output.length > 64 * 1024) { output = output.slice(0, 65536); failure = 'status_too_large'; kill(); } }
          pending[stream] = (pending[stream] + chunk.toString()).slice(-32768);
          const lines = pending[stream]!.split(/\r?\n/); pending[stream] = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('TAROBOT_ASR_PHASE=')) { const phase = asrPhaseSchema.safeParse(line.slice(18)); if (phase.success) onPhase?.(phase.data); }
            if (line.startsWith('TAROBOT_ASR_ERROR=')) failure = safeError(line.slice(18));
          }
        };
        child.stdout.on('data', chunk => consume('stdout', chunk)); if (!status) child.stderr.on('data', chunk => consume('stderr', chunk)); else child.stderr.resume();
        const finish = (code: number | null, error?: Error) => {
          if (settled) return; settled = true; clearTimeout(timer); clearTimeout(escalation); signal.removeEventListener('abort', abort);
          if (signal.aborted) reject(new Error('installation_interrupted'));
          else if (error || code !== 0) reject(new Error(failure || 'installation_failed'));
          else resolve(output);
        };
        child.once('error', error => finish(null, error)); child.once('close', code => finish(code));
      });
    } finally { await logWrites; await log?.close(); }
  }
  async status(requestId?: string): Promise<AsrState> {
    let state: AsrState;
    try {
      if (this.cached && Date.now() - this.cached.at < 3000) state = this.cached.value;
      else {
        this.reading ??= this.execute(['--status'], AbortSignal.timeout(10_000)).then(value => asrStateSchema.parse(JSON.parse(value))).finally(() => { this.reading = undefined; });
        state = await this.reading; this.cached = { at: Date.now(), value: state };
      }
    }
    catch { state = { platform: process.platform, supported: process.platform === 'darwin' || process.platform === 'linux', installed: false,
      pythonPresent: false, modelPresent: false, running: false, managed: false, legacyService: false, activeRequests: null, watchdog: null,
      autostart: 'disabled', error: 'status_unavailable' }; }
    const jobs = (await this.records.read({ jobs: [] })).jobs; let job = requestId ? jobs.find(value => value.requestId === requestId) : jobs.at(-1);
    if (job?.status === 'running' && !active.has(this.file)) {
      if (!await jobAlive(job)) job = { ...job, status: 'interrupted', error: 'installation_interrupted' };
    }
    return { ...state, job: job ? asrJobSchema.parse(job) : null };
  }
  async start(raw: AsrInstall, admitted: () => Promise<void> = async () => {}, authorize?: () => Promise<void>): Promise<AsrJob> {
    const command = asrInstallSchema.parse(raw);
    if (!['darwin', 'linux'].includes(process.platform)) throw new AsrSetupError('platform_unsupported', 400);
    return withFileMutex(this.file, async () => {
      const jobs = (await this.records.read({ jobs: [] })).jobs;
      const previous = jobs.find(job => job.requestId === command.requestId);
      if (previous) { if (previous.model !== command.model || previous.service !== command.service) throw new AsrSetupError('installation_request_conflict', 409); return asrJobSchema.parse(previous); }
      if (active.has(this.file) || await jobAlive(jobs.at(-1))) return asrJobSchema.parse(jobs.at(-1)!);
      await admitted();
      const job: StoredJob = { ...command, status: 'running', phase: 'checking', startedAt: Date.now(), pid: process.pid, processEpoch: await readProcessEpoch(process.pid).catch(() => ({})) };
      await this.records.write({ jobs: [...jobs, job].slice(-64) });
      const controller = new AbortController();
      const save = async (change: Partial<StoredJob>) => withFileMutex(this.file, async () => {
        const current = (await this.records.read({ jobs: [] })).jobs;
        await this.records.write({ jobs: current.map(value => value.requestId === job.requestId ? { ...value, ...change } : value) });
      });
      // Start outside this admission lock; never hold a Hub DB queue during pip/model downloads.
      const work = Promise.resolve().then(async () => {
        let phases = Promise.resolve();
        try {
          await this.execute([...(command.model ? ['--with-model'] : []), ...(command.service ? ['--as-service'] : [])], controller.signal,
            phase => { phases = phases.then(() => save({ phase })); }, authorize,
            pid => { phases = phases.then(async () => save({ pid, processEpoch: await readProcessEpoch(pid).catch(() => ({})) })); });
          await phases; await save({ status: 'completed', phase: 'completed', finishedAt: Date.now() });
        } catch (error) {
          await phases.catch(() => undefined);
          await save({ status: controller.signal.aborted ? 'interrupted' : 'failed', error: safeError(error instanceof Error ? error.message : ''), finishedAt: Date.now() });
        } finally { this.cached = undefined; active.delete(this.file); }
      });
      active.set(this.file, { controller, work, owner: this }); void work.catch(() => undefined);
      return asrJobSchema.parse(job);
    });
  }
  async close(): Promise<void> { const job = active.get(this.file); if (job?.owner === this) { job.controller.abort(); await job.work; } }
  async wait(): Promise<void> { await active.get(this.file)?.work; }
}

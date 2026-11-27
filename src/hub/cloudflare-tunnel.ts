import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  cloudflareCommands,
  cloudflareConfigSchema,
  cloudflareOriginSchema,
  cloudflareUpdateSchema,
  cloudflareViewSchema,
  type CloudflareConfig,
  type CloudflareProtocol,
  type CloudflareView,
} from "../client-protocol/cloudflare.js";
import { HubError, type HubStore } from "./store.js";

const execFileAsync = promisify(execFile);
export const CLOUDFLARE_META_KEY = "cloudflare-tunnel:v1";
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const STREAM_BUFFER_LIMIT = 4096;

export type CloudflaredBinary = { installed: boolean; path?: string; version?: string };

function candidatePaths(): string[] {
  if (process.platform === "win32") {
    const candidates: string[] = [];
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (base) candidates.push(path.join(base, "cloudflared", "cloudflared.exe"));
    }
    candidates.push("cloudflared.exe", "cloudflared");
    return candidates;
  }
  return [
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    "cloudflared",
  ];
}

function findCloudflaredPath(): string | undefined {
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  for (const candidate of candidatePaths()) {
    if (candidate === "cloudflared" || candidate === "cloudflared.exe") return candidate;
    try { accessSync(candidate, mode); return candidate; } catch { /* continue */ }
  }
  return undefined;
}

export async function detectCloudflared(): Promise<CloudflaredBinary> {
  const bin = findCloudflaredPath() ?? "cloudflared";
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["--version"], { timeout: 3000, windowsHide: true });
    const line = (stdout || stderr).trim().split(/\r?\n/)[0]?.slice(0, 120);
    return { installed: true, path: bin, ...(line ? { version: line } : {}) };
  } catch {
    return { installed: false };
  }
}

export function defaultCloudflareConfig(): CloudflareConfig {
  return { v: 1, mode: "named", protocol: "http2", origins: [] };
}

function envAllowedOrigins(): string[] {
  const raw = process.env.TAROBOT_CLOUDFLARE_ORIGINS ?? "";
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const parsed = cloudflareOriginSchema.safeParse(part.trim());
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

export interface HubCloudflareOptions {
  store: HubStore;
  loopbackTarget: () => string;
  /** Reason the dedicated edge-proxy listener is unavailable for this run, if any. */
  listenerUnavailable?: () => string | undefined;
  detect?: () => Promise<CloudflaredBinary>;
  spawnProcess?: typeof spawn;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Host-side DIY Cloudflare Tunnel configuration, origin allowlist for
 * `/api/edge-identity`, diagnostics and optional Quick Tunnel helper. */
export class HubCloudflareTunnel {
  private config: CloudflareConfig = defaultCloudflareConfig();
  private loaded = false;
  private cachedBinary?: { value: CloudflaredBinary; until: number };
  private child?: ChildProcess;
  private runningProtocol?: CloudflareProtocol;
  private activeUrl?: string;
  private lastError?: string;
  private lifecycleTail: Promise<unknown> = Promise.resolve();
  private abortStarting?: () => void;
  private closed = false;
  private readonly detect: () => Promise<CloudflaredBinary>;
  private readonly spawnProcess: typeof spawn;
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;

  constructor(private readonly options: HubCloudflareOptions) {
    this.detect = options.detect ?? detectCloudflared;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.startTimeoutMs = options.startTimeoutMs ?? 20_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3000;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycleTail.then(operation);
    this.lifecycleTail = next.catch(() => undefined);
    return next;
  }

  private childAlive(child: ChildProcess | undefined): child is ChildProcess {
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  private async terminateChild(child: ChildProcess | undefined): Promise<void> {
    if (!this.childAlive(child)) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (forceTimer) clearTimeout(forceTimer);
        child.off("exit", done);
        child.off("close", done);
        resolve();
      };
      child.once("exit", done);
      child.once("close", done);
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { done(); return; }
        forceTimer = setTimeout(done, 1000);
        forceTimer.unref();
      }, this.stopTimeoutMs);
      killTimer.unref();
      try { child.kill("SIGTERM"); } catch { done(); }
    });
  }

  private async stopChildLocked(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.runningProtocol = undefined;
    this.activeUrl = undefined;
    await this.terminateChild(child);
  }

  async load(): Promise<CloudflareConfig> {
    if (this.loaded) return this.config;
    const row = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [CLOUDFLARE_META_KEY]);
    if (row) {
      try { this.config = cloudflareConfigSchema.parse(JSON.parse(row.value)); }
      catch { this.config = defaultCloudflareConfig(); }
    }
    this.loaded = true;
    return this.config;
  }

  private async persistInTransaction(next: CloudflareConfig): Promise<CloudflareConfig> {
    const parsed = cloudflareConfigSchema.parse(next);
    await this.options.store.db.run(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [CLOUDFLARE_META_KEY, JSON.stringify(parsed)],
    );
    return parsed;
  }

  private async persist(next: CloudflareConfig): Promise<void> {
    const parsed = await this.options.store.db.serial(() => this.persistInTransaction(next));
    this.config = parsed;
    this.loaded = true;
  }

  /** Strictly checks whether `origin` is authorized on this Host for edge-terminated
   * TLS identity proofs. Never authorizes arbitrary origins. */
  isOriginAllowed(origin: string): boolean {
    const parsed = cloudflareOriginSchema.safeParse(origin);
    if (!parsed.success) return false;
    const canonical = parsed.data;
    if (this.activeUrl === canonical) return true;
    if (this.config.origins.includes(canonical)) return true;
    return envAllowedOrigins().includes(canonical);
  }

  private async binary(): Promise<CloudflaredBinary> {
    const now = Date.now();
    if (this.cachedBinary && this.cachedBinary.until > now) return this.cachedBinary.value;
    const value = await this.detect();
    this.cachedBinary = { value, until: now + 30_000 };
    return value;
  }

  async view(): Promise<CloudflareView> {
    const [config, bin] = await Promise.all([this.load(), this.binary()]);
    const loopbackTarget = this.options.loopbackTarget();
    // Reported through the existing `lastError` field; no protocol change.
    const lastError = this.options.listenerUnavailable?.() ?? this.lastError;
    return cloudflareViewSchema.parse({
      v: 1,
      installed: bin.installed,
      ...(bin.version ? { version: bin.version } : {}),
      running: this.childAlive(this.child) && !this.child.killed,
      ...(this.activeUrl ? { activeUrl: this.activeUrl } : {}),
      ...(lastError ? { lastError: lastError.slice(0, 240) } : {}),
      mode: config.mode,
      protocol: config.protocol,
      origins: config.origins,
      loopbackTarget,
      commands: cloudflareCommands(loopbackTarget),
    });
  }

  async update(raw: unknown, authorizeInTransaction?: () => Promise<void>): Promise<CloudflareView> {
    const patch = cloudflareUpdateSchema.parse(raw);
    const committed = await this.options.store.db.transaction(async () => {
      await authorizeInTransaction?.();
      const row = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [CLOUDFLARE_META_KEY]);
      let current = defaultCloudflareConfig();
      if (row) {
        try { current = cloudflareConfigSchema.parse(JSON.parse(row.value)); }
        catch { current = defaultCloudflareConfig(); }
      }
      return this.persistInTransaction({
        v: 1,
        mode: patch.mode ?? current.mode,
        protocol: patch.protocol ?? current.protocol,
        origins: patch.origins ?? current.origins,
      });
    });
    this.config = committed;
    this.loaded = true;
    return this.view();
  }

  startQuickTunnel(protocol?: CloudflareProtocol, validate?: () => Promise<unknown>): Promise<CloudflareView> {
    if (this.closed) return Promise.reject(new HubError("hub_stopping", 503));
    return this.serialize(async () => {
      if (this.closed) throw new HubError("hub_stopping", 503);
      await validate?.();
      if (this.options.listenerUnavailable?.()) throw new HubError("edge_listener_unavailable", 503);
      const config = await this.load();
      const chosen = protocol ?? config.protocol;
      if (chosen !== config.protocol || config.mode !== "quick") {
        await this.persist({ ...config, mode: "quick", protocol: chosen });
      }
      if (this.childAlive(this.child) && !this.child.killed && this.activeUrl && this.runningProtocol === chosen) {
        return this.view();
      }
      await this.stopChildLocked();
      if (this.closed) throw new HubError("hub_stopping", 503);
      await validate?.();

      const bin = await this.detect();
      this.cachedBinary = { value: bin, until: Date.now() + 30_000 };
      if (!bin.installed || !bin.path) throw new HubError("cloudflared_not_installed", 409);
      if (this.closed) throw new HubError("hub_stopping", 503);

      const target = new URL(this.options.loopbackTarget()).origin;
      const args = ["tunnel", "--no-autoupdate", "--protocol", chosen];
      if (target.startsWith("https://")) args.push("--no-tls-verify");
      args.push("--url", target);

      this.lastError = undefined;
      const child = this.spawnProcess(bin.path, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      this.runningProtocol = chosen;
      this.activeUrl = undefined;

      let url: string;
      try {
        url = await new Promise<string>((resolve, reject) => {
          let settled = false;
          let stdoutBuf = "";
          let stderrBuf = "";
          let timer: ReturnType<typeof setTimeout> | undefined;

          const onStdout = (chunk: Buffer | string) => inspect("stdout", chunk);
          const onStderr = (chunk: Buffer | string) => inspect("stderr", chunk);
          const onError = (err: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            this.lastError = err.message.slice(0, 200);
            if (this.child === child) {
              this.child = undefined;
              this.runningProtocol = undefined;
              this.activeUrl = undefined;
            }
            reject(new HubError("cloudflared_start_failed", 502));
          };
          const onExit = (code: number | null) => {
            if (this.child === child) {
              this.child = undefined;
              this.runningProtocol = undefined;
              this.activeUrl = undefined;
            }
            if (!settled) {
              settled = true;
              cleanup();
              this.lastError = `cloudflared exited with code ${code ?? "unknown"}`;
              reject(new HubError("cloudflared_start_failed", 502));
            }
          };

          const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new HubError(this.closed ? "hub_stopping" : "cloudflared_stopped", this.closed ? 503 : 409));
          };

          const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (this.abortStarting === abort) this.abortStarting = undefined;
            child.stdout?.off("data", onStdout);
            child.stderr?.off("data", onStderr);
            // Drain pipes after detaching so a running cloudflared never blocks on full stdout/stderr.
            child.stdout?.resume();
            child.stderr?.resume();
            child.off("error", onError);
          };

          const inspect = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            const next = ((stream === "stdout" ? stdoutBuf : stderrBuf) + text).slice(-STREAM_BUFFER_LIMIT);
            if (stream === "stdout") stdoutBuf = next;
            else stderrBuf = next;
            const match = next.match(TRYCLOUDFLARE_RE);
            if (match && !settled) {
              const parsed = cloudflareOriginSchema.safeParse(match[0]);
              if (parsed.success) {
                settled = true;
                cleanup();
                resolve(parsed.data);
              }
            }
          };

          this.abortStarting = abort;
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            this.lastError = "Timed out waiting for trycloudflare.com URL";
            reject(new HubError("cloudflared_start_timeout", 504));
          }, this.startTimeoutMs);
          timer.unref();

          child.stdout?.on("data", onStdout);
          child.stderr?.on("data", onStderr);
          child.once("error", onError);
          child.once("exit", onExit);
        });
      } catch (error) {
        if (this.child === child) {
          this.child = undefined;
          this.runningProtocol = undefined;
          this.activeUrl = undefined;
        }
        await this.terminateChild(child);
        throw error;
      }

      if (this.closed || this.child !== child || !this.childAlive(child) || child.killed) {
        if (this.child === child) {
          this.child = undefined;
          this.runningProtocol = undefined;
          this.activeUrl = undefined;
        }
        await this.terminateChild(child);
        throw new HubError(this.closed ? "hub_stopping" : "cloudflared_stopped", this.closed ? 503 : 409);
      }

      this.activeUrl = url;
      return this.view();
    });
  }

  stopQuickTunnel(): Promise<CloudflareView> {
    this.abortStarting?.();
    return this.serialize(async () => {
      await this.stopChildLocked();
      return this.view();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortStarting?.();
    await this.serialize(() => this.stopChildLocked());
  }
}

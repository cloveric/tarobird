import { createHmac, randomBytes } from "node:crypto";
import { openSync, readSync, readdirSync, fstatSync, statSync, closeSync, constants, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { QuotaAuthMode, QuotaEngine, QuotaSnapshot } from "../client-protocol/engine-quota.js";
import type { QuotaAccountProof } from "../runtime/engine-quota-scope.js";
import { QUOTA_TTL_MS, unavailableQuota } from "./account-quota.js";

const ANTIGRAVITY_SIGN_IN_RETRY_MS = 30 * 60_000;
export type EngineQuotaReadOptions = { refresh: boolean; expectedRevision?: string; signal?: AbortSignal; timeoutMs?: number; accountProofKey?: Uint8Array };
export type EngineQuotaReadResult = { revision: string; snapshot: QuotaSnapshot; proof?: QuotaAccountProof };
/** `credentialRevision` changes with any byte of the credential material (token refreshes included) and keys the cache.
 * `accountIdentity` changes only when the signed-in account or its credential source changes; a live worker's
 * spawn-time guard compares this one, so a token refresh or an unrelated config rewrite does not disown it. */
export type AdapterQuotaScope = { revision: string; credentialRevision: string; accountIdentity: string; verifiable: boolean; authMode: QuotaAuthMode };

function readBounded(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("scope_unverifiable");
    const buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, 1024 * 1024 + 1));
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, used);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used > 1024 * 1024 || used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("scope_unverifiable");
    return buffer.toString("utf8", 0, used);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw new Error("scope_unverifiable");
  } finally { if (fd !== undefined) closeSync(fd); }
}
function jsonRecord(text: string): Record<string, unknown> {
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("scope_unverifiable");
  return parsed;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function readPlatformEnv(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (Object.hasOwn(env, key) && env[key] !== undefined) return env[key];
  if (platform !== "win32") return undefined;
  const upper = key.toUpperCase();
  let matchedKey: string | undefined;
  let matchedValue: string | undefined;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.toUpperCase() !== upper) continue;
    if (matchedKey === undefined || compareCodeUnits(name, matchedKey) < 0) {
      matchedKey = name;
      matchedValue = value;
    }
  }
  return matchedValue;
}

export function resolvePlatformHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const userProfile = readPlatformEnv(env, "USERPROFILE", platform)?.trim();
  const homeVar = readPlatformEnv(env, "HOME", platform)?.trim();
  // On Windows, Claude Code / Node `os.homedir()` resolve USERPROFILE rather than
  // HOME (which Git for Windows / MSYS may set to another directory).
  return (platform === "win32" ? userProfile || homeVar : homeVar || userProfile) || homedir();
}

function envMaterial(env: NodeJS.ProcessEnv, prefix: RegExp, platform: NodeJS.Platform): ReadonlyArray<readonly [string, string] | readonly [string, string, string]> {
  if (platform === "win32") {
    return Object.entries(env)
      .filter(([key, value]) => value !== undefined && prefix.test(key.toUpperCase()))
      .map(([key, value]) => [key.toUpperCase(), key, value!] as const)
      .sort((a, b) => compareCodeUnits(a[0], b[0]) || compareCodeUnits(a[1], b[1]));
  }
  return Object.entries(env)
    .filter(([key, value]) => value !== undefined && prefix.test(key))
    .map(([key, value]) => [key, value!] as const)
    .sort((a, b) => compareCodeUnits(a[0], b[0]));
}

const KIMI_MAX_DIR_ENTRIES = 256;
const KIMI_MAX_DIR_DEPTH = 2;

function formatStat(st: BigIntStats): string {
  const kind = st.isDirectory() ? "d" : st.isFile() ? "f" : "o";
  return `${kind}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

function statMetadata(file: string): string {
  try {
    return formatStat(statSync(file, { bigint: true }));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing";
    throw new Error("scope_unverifiable");
  }
}

function fingerprintKimiDir(dir: string, depth = 0): { meta: string; entries: unknown[]; fileCount: number } {
  let st: BigIntStats;
  try {
    st = statSync(dir, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { meta: "missing", entries: [], fileCount: 0 };
    }
    throw new Error("scope_unverifiable");
  }
  const meta = formatStat(st);
  if (st.isFile()) return { meta, entries: [], fileCount: 1 };
  if (!st.isDirectory()) throw new Error("scope_unverifiable");
  if (depth >= KIMI_MAX_DIR_DEPTH) throw new Error("scope_unverifiable");

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { meta: "missing", entries: [], fileCount: 0 };
    }
    throw new Error("scope_unverifiable");
  }
  if (names.length > KIMI_MAX_DIR_ENTRIES) throw new Error("scope_unverifiable");
  names.sort();

  const entries: unknown[] = [];
  let fileCount = 0;
  for (const name of names) {
    const entryPath = path.join(dir, name);
    let entryStat: BigIntStats;
    try {
      entryStat = statSync(entryPath, { bigint: true });
    } catch {
      throw new Error("scope_unverifiable");
    }
    if (entryStat.isDirectory()) {
      const nested = fingerprintKimiDir(entryPath, depth + 1);
      entries.push([name, nested.meta, nested.entries]);
      fileCount += nested.fileCount;
    } else if (entryStat.isFile()) {
      entries.push([name, formatStat(entryStat)]);
      if (name !== ".DS_Store") fileCount++;
    } else {
      throw new Error("scope_unverifiable");
    }
  }
  return { meta, entries, fileCount };
}

/** A workspace account ID can be shared by multiple signed-in users. Use the
 * local ID-token subject only as a change detector, never as authentication. */
function codexTokenSubject(token: unknown): [string, string] | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]!)) return undefined;
  try {
    const claims = jsonRecord(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (typeof claims.iss === "string" && claims.iss && typeof claims.sub === "string" && claims.sub) {
      return [claims.iss, claims.sub];
    }
  } catch { /* Unrecognized token formats retain the full credential fence. */ }
  return undefined;
}

/** Codex config keys that choose which account or credential source a process signs in with. */
const CODEX_CREDENTIAL_CONFIG = /^\s*["']?(?:cli_auth_credentials_store|auth_command|credential_helper|include|model_provider|model_providers|chatgpt_base_url|forced_login_method|forced_chatgpt_workspace_id|preferred_auth_method|base_url|env_key|experimental_bearer_token|requires_openai_auth)["']?\s*=/;

function codexCredentialConfig(text: string): unknown {
  // Keep the path of each key in the fingerprint: provider tables can be
  // reordered, renamed, or written as dotted keys or inline TOML tables.
  const entries: Array<[string[], unknown]> = [];
  const visit = (table: Record<string, unknown>, scope: string[]) => {
    for (const key of Object.keys(table).sort()) {
      const value = table[key];
      const keyPath = [...scope, key];
      if (key === "model_providers" && value && typeof value === "object") {
        visit(value as Record<string, unknown>, keyPath);
      } else if (CODEX_CREDENTIAL_CONFIG.test(`${key}=`)) {
        entries.push([keyPath, value]);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, keyPath);
      }
    }
  };
  try {
    visit(parseToml(text), []);
    return entries;
  } catch {
    // An unreadable config is only equivalent to the same exact input.
    return text;
  }
}

/** Private in-memory scope guard. No credential values, hashes or file paths are emitted to logs/public DTOs. */
export class AdapterQuotaCache {
  readonly proofKey = randomBytes(32);
  private cached?: { revision: string; snapshot: QuotaSnapshot; proof?: QuotaAccountProof; proofKeyHex?: string };
  constructor(private readonly engine: "codex" | "claude" | "antigravity" | "kimi", private readonly executable: string, private readonly env: NodeJS.ProcessEnv, private readonly cwd?: string, private readonly configPath?: string, private readonly platform: NodeJS.Platform = process.platform) {}

  capture(workerGeneration: string): AdapterQuotaScope {
    const digest = (value: unknown) => createHmac("sha256", this.proofKey).update(JSON.stringify(value)).digest("hex");
    const home = resolvePlatformHome(this.env, this.platform);
    const engineHome = this.engine === "codex"
      ? readPlatformEnv(this.env, "CODEX_HOME", this.platform)?.trim() || path.join(home, ".codex")
      : this.engine === "claude"
        ? readPlatformEnv(this.env, "CLAUDE_CONFIG_DIR", this.platform)?.trim() || path.join(home, ".claude")
        : this.engine === "kimi"
          ? readPlatformEnv(this.env, "KIMI_CODE_HOME", this.platform) || path.join(home, ".kimi-code")
          : path.join(home, ".gemini", "antigravity-cli");
    let authMode: QuotaAuthMode = "unknown", verifiable = false;
    let material: unknown, identity: unknown;
    try {
      const configured = this.configPath ? readBounded(this.configPath) : "";
      if (this.engine === "codex") {
        const authText = readBounded(path.join(engineHome, "auth.json"));
        const config = readBounded(path.join(engineHome, "config.toml"));
        const project = this.cwd ? readBounded(path.join(this.cwd, ".codex", "config.toml")) : "";
        const account = jsonRecord(authText);
        const tokens = account.tokens && typeof account.tokens === "object" ? account.tokens as Record<string, unknown> : {};
        const env = envMaterial(this.env, /^(OPENAI_|CODEX_|CHATGPT_)/, this.platform);
        const openAiKey = readPlatformEnv(this.env, "OPENAI_API_KEY", this.platform);
        authMode = typeof tokens.access_token === "string" && tokens.access_token ? "subscription" : openAiKey || account.OPENAI_API_KEY ? "api_key" : "unknown";
        // Keyring/auto, includes and external auth helpers are not proven by an auth.json file next to them.
        const opaque = /cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']|(?:auth_command|credential_helper|include)\s*=/.test(`${configured}\n${config}\n${project}`);
        verifiable = !opaque && authMode !== "unknown";
        material = [this.executable, engineHome, configured, config, project, authText, env];
        // The account, not the bytes: Codex rewrites auth.json on every token refresh, and other tools rewrite
        // config.toml. Keep the full credential fence when a login or its source cannot be identified.
        const accountId = typeof tokens.account_id === "string" && tokens.account_id ? tokens.account_id : undefined;
        const credentialLines = (text: string) => text.split(/\r?\n/).filter(line => CODEX_CREDENTIAL_CONFIG.test(line)).map(line => line.trim());
        const subject = codexTokenSubject(tokens.id_token);
        identity = verifiable && authMode === "subscription" && accountId && subject
          ? [this.executable, engineHome, authMode, accountId, subject, credentialLines(configured), codexCredentialConfig(config), codexCredentialConfig(project), env]
          : material;
      } else if (this.engine === "claude") {
        const authText = readBounded(path.join(engineHome, ".credentials.json"));
        const settings = readBounded(path.join(engineHome, "settings.json"));
        const project = this.cwd ? readBounded(path.join(this.cwd, ".claude", "settings.json")) + readBounded(path.join(this.cwd, ".claude", "settings.local.json")) : "";
        const account = jsonRecord(authText);
        const oauth = account.claudeAiOauth && typeof account.claudeAiOauth === "object" ? account.claudeAiOauth as Record<string, unknown> : {};
        const env = envMaterial(this.env, /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|AZURE_)/, this.platform);
        const cloud = readPlatformEnv(this.env, "CLAUDE_CODE_USE_BEDROCK", this.platform) === "1"
          || readPlatformEnv(this.env, "CLAUDE_CODE_USE_VERTEX", this.platform) === "1"
          || readPlatformEnv(this.env, "CLAUDE_CODE_USE_FOUNDRY", this.platform) === "1";
        const apiKey = readPlatformEnv(this.env, "ANTHROPIC_API_KEY", this.platform) || readPlatformEnv(this.env, "ANTHROPIC_AUTH_TOKEN", this.platform);
        const oauthEnv = readPlatformEnv(this.env, "CLAUDE_CODE_OAUTH_TOKEN", this.platform);
        authMode = cloud ? "other" : apiKey ? "api_key" : oauthEnv || (typeof oauth.accessToken === "string" && oauth.accessToken) ? "subscription" : "unknown";
        const opaque = /"apiKeyHelper"\s*:|"ANTHROPIC_|"CLAUDE_CODE_OAUTH_TOKEN"\s*:/.test(`${settings}\n${project}`);
        // The macOS CLI may prefer Keychain over the plaintext file. Only an explicit env token proves that source here.
        verifiable = !opaque && authMode !== "unknown" && (this.platform !== "darwin" || Boolean(oauthEnv || apiKey) || cloud);
        material = [this.executable, engineHome, configured, settings, project, authText, env];
      } else if (this.engine === "kimi") {
        // Never read or copy Kimi's credential bytes; track login/config changes via filesystem metadata only.
        // Any non-ENOENT error throws `scope_unverifiable`, failing closed instead of reusing stale quotas.
        const legacyHome = path.join(home, ".kimi");
        const credDirs = [
          fingerprintKimiDir(path.join(engineHome, "credentials")),
          fingerprintKimiDir(path.join(engineHome, "oauth")),
          fingerprintKimiDir(path.join(legacyHome, "credentials")),
          fingerprintKimiDir(path.join(legacyHome, "oauth")),
        ];
        const metaFiles = [
          statMetadata(path.join(engineHome, "config.toml")),
          statMetadata(path.join(engineHome, "region")),
          statMetadata(path.join(engineHome, "credentials.json")),
          statMetadata(path.join(engineHome, "oauth.json")),
          statMetadata(path.join(legacyHome, "config.toml")),
          statMetadata(path.join(legacyHome, "region")),
          statMetadata(path.join(legacyHome, "credentials.json")),
          statMetadata(path.join(legacyHome, "oauth.json")),
        ];
        const hasCredentialFiles = credDirs.some(dir => dir.fileCount > 0)
          || metaFiles[2] !== "missing"
          || metaFiles[3] !== "missing"
          || metaFiles[6] !== "missing"
          || metaFiles[7] !== "missing";
        // Windows environment names are case-insensitive; the same lookup as the other engines (#168).
        const kimiEnv = (key: string) => readPlatformEnv(this.env, key, this.platform);
        const hasApiKeyOnly = Boolean(kimiEnv("KIMI_API_KEY")) && !hasCredentialFiles;
        const envFlags = [
          Boolean(kimiEnv("KIMI_API_KEY")),
          kimiEnv("KIMI_CODE_HOME") ?? "",
          kimiEnv("KIMI_BASE_URL") ?? "",
          kimiEnv("KIMI_CODE_BASE_URL") ?? "",
          kimiEnv("KIMI_CODE_OAUTH_HOST") ?? "",
          kimiEnv("KIMI_OAUTH_HOST") ?? "",
          kimiEnv("KIMI_CODE_REGION") ?? "",
          kimiEnv("KIMI_REGION") ?? "",
        ];
        authMode = hasApiKeyOnly ? "api_key" : "subscription";
        verifiable = true;
        material = [this.executable, engineHome, configured, credDirs, metaFiles, envFlags];
      } else {
        const geminiHome = path.join(home, ".gemini");
        const settings = readBounded(path.join(engineHome, "settings.json"));
        const onboardingText = readBounded(path.join(engineHome, "cache", "onboarding.json"));
        const onboarding = jsonRecord(onboardingText);
        const oauthCreds = readBounded(path.join(geminiHome, "oauth_creds.json"));
        const googleAccounts = readBounded(path.join(geminiHome, "google_accounts.json"));
        const env = envMaterial(this.env, /^(GEMINI_|GOOGLE_|ANTIGRAVITY_|AGY_|CLOUDSDK_)/, this.platform);
        const onboarded = onboarding.onboardingComplete === true
          || onboarding.consumerOnboardingComplete === true
          || onboarding.enterpriseOnboardingComplete === true;
        const geminiApiKey = readPlatformEnv(this.env, "GEMINI_API_KEY", this.platform);
        const googleAdc = readPlatformEnv(this.env, "GOOGLE_APPLICATION_CREDENTIALS", this.platform);
        authMode = onboarded || oauthCreds.trim().length > 0 ? "subscription"
          : geminiApiKey ? "api_key"
          : googleAdc ? "adc"
          : "unknown";
        verifiable = true;
        material = [this.executable, engineHome, configured, settings, onboardingText, oauthCreds, googleAccounts, env];
      }
    } catch {
      // A failed identity read invalidates the cache; it is never equivalent to an empty/default identity.
      material = [this.executable, engineHome, "unverifiable"];
      verifiable = false;
    }
    const credentialRevision = digest(material);
    return { credentialRevision, accountIdentity: identity === undefined ? credentialRevision : digest(identity), revision: digest([credentialRevision, workerGeneration]), verifiable, authMode };
  }
  response(scope: AdapterQuotaScope, options: EngineQuotaReadOptions): EngineQuotaReadResult | undefined {
    if (options.signal?.aborted) return this.failure(scope, "cancelled");
    if (options.expectedRevision && options.expectedRevision !== scope.revision) { this.cached = undefined; return this.failure(scope, "auth_changed"); }
    if (!scope.verifiable) {
      this.cached = undefined;
      // Codex's public account/read can still answer one explicit read: it reports "not signed in"
      // natively, and the before/after identity check binds that single reading to one account.
      // Antigravity is intentionally excluded here because `agy -p /usage` opens a browser OAuth
      // tab when unauthenticated; missing local login state must never spawn `agy`.
      // store() never retains it, because later reads cannot prove the opaque source is unchanged.
      if (this.engine === "codex" && options.refresh) return undefined;
      return this.failure(scope, "scope_unverifiable");
    }
    if (this.engine === "antigravity" && scope.authMode === "unknown") {
      this.cached = undefined;
      return { revision: scope.revision, snapshot: unavailableQuota(this.engine, "login_required", Date.now(), scope.authMode) };
    }
    if (scope.authMode !== "subscription") { this.cached = undefined; return { revision: scope.revision, snapshot: unavailableQuota(this.engine, "mode_not_supported", Date.now(), scope.authMode) }; }
    if (this.cached?.revision !== scope.revision) this.cached = undefined;
    if (options.refresh && (this.engine === "codex" || this.engine === "antigravity" || this.engine === "kimi")) {
      // `agy` may open a browser sign-in each time it is asked while signed out. Once it has said so, it is
      // not started again for the same login state until this long has passed.
      if (this.engine === "antigravity" && this.cached?.snapshot.state === "login_required" && this.cached.snapshot.lastAttemptAt
        && Date.now() - Date.parse(this.cached.snapshot.lastAttemptAt) < ANTIGRAVITY_SIGN_IN_RETRY_MS) return structuredClone(this.cached);
      return undefined;
    }
    if (!this.cached) return this.failure(scope, this.engine === "claude" ? "no_passive_event" : "not_loaded");
    const value = structuredClone(this.cached);
    if (value.snapshot.observedAt && Date.now() - Date.parse(value.snapshot.observedAt) >= QUOTA_TTL_MS) value.snapshot.state = "stale";
    const { proofKeyHex, ...result } = value;
    if (options.accountProofKey && result.proof && proofKeyHex !== Buffer.from(options.accountProofKey).toString("hex")) {
      delete result.proof;
    }
    return result;
  }
  store(scope: AdapterQuotaScope, value: { snapshot: QuotaSnapshot; proof?: QuotaAccountProof }, proofKey?: Uint8Array): EngineQuotaReadResult {
    // One-shot only: no cache and no account proof for a credential source this Host cannot verify.
    // The native reply must then identify the account itself: a stable user id and the billed account id
    // (both optional upstream). Type, plan or email alone cannot separate two accounts. Native
    // "not signed in", API-key and error answers carry no account values and pass unchanged.
    if (!scope.verifiable) {
      this.cached = undefined;
      const snapshot = value.snapshot;
      const carriesValues = snapshot.observedAt !== undefined || snapshot.pools.length > 0 || snapshot.constraints.length > 0 || snapshot.availability !== "unknown";
      if (carriesValues && !value.proof) return this.failure(scope, "scope_unverifiable");
      return { revision: scope.revision, snapshot: structuredClone(snapshot) };
    }
    const proofKeyHex = value.proof && proofKey ? Buffer.from(proofKey).toString("hex") : undefined;
    const same = this.cached?.revision === scope.revision ? this.cached : undefined;
    if (same && same.snapshot.observedAt && ["unavailable", "offline"].includes(value.snapshot.state)) {
      this.cached = { ...same, snapshot: { ...same.snapshot, state: "stale", reason: value.snapshot.reason, lastAttemptAt: value.snapshot.lastAttemptAt } };
    } else this.cached = { revision: scope.revision, snapshot: structuredClone(value.snapshot), ...(value.proof ? { proof: structuredClone(value.proof), ...(proofKeyHex ? { proofKeyHex } : {}) } : {}) };
    const { proofKeyHex: _ignored, ...stored } = structuredClone(this.cached);
    return stored;
  }
  failure(scope: AdapterQuotaScope, reason: Parameters<typeof unavailableQuota>[1]): EngineQuotaReadResult {
    return { revision: scope.revision, snapshot: unavailableQuota(this.engine, reason, Date.now(), scope.authMode) };
  }
  invalidate(): void { this.cached = undefined; }
}

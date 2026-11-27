import { quotaSnapshotSchema, type QuotaBalance, type QuotaSnapshot } from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError, unavailableQuota } from "./account-quota.js";

export type DeepSeekWallet = {
  currency: string;
  balance: string;
};

export type DeepSeekBalanceOutcome =
  | { status: "ready"; value: readonly DeepSeekWallet[]; bonusWallets?: readonly DeepSeekWallet[] }
  | { status: "failed" };

const UNSIGNED_DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_BALANCE_CHARS = 80;
const MAX_WALLETS_PER_LIST = 8;

/** Normalize Platform unsigned decimal / scientific balance strings (e.g. "0E-16",
 * "5.000000", "12.5", "0.00001", "1e21") into a clean unsigned decimal string
 * accepted by `quotaBalanceSchema`. Rejects non-decimal literals (hex/octal/binary),
 * negative values, and values that cannot be represented without turning a non-zero
 * balance into zero. */
export function normalizeBalanceDecimal(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_BALANCE_CHARS || !UNSIGNED_DECIMAL_RE.test(trimmed)) return null;
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (!match) return null;
  const intPart = match[1] ?? "";
  const fracPart = match[2] ?? "";
  const exp = match[3] !== undefined ? Number.parseInt(match[3], 10) : 0;
  if (!Number.isSafeInteger(exp)) return null;

  const digits = intPart + fracPart;
  const firstNonZero = digits.search(/[1-9]/);
  if (firstNonZero < 0) return "0.00";

  const sig = digits.slice(firstNonZero).replace(/0+$/, "");
  const pos = intPart.length - firstNonZero + exp;

  let whole: string;
  let frac: string;
  if (pos >= sig.length) {
    if (pos + 3 > MAX_BALANCE_CHARS) return null;
    whole = sig + "0".repeat(pos - sig.length);
    frac = "00";
  } else if (pos > 0) {
    whole = sig.slice(0, pos);
    frac = sig.slice(pos);
    if (frac.length < 2) frac = frac.padEnd(2, "0");
  } else {
    const leadingZeros = -pos;
    if (2 + leadingZeros >= MAX_BALANCE_CHARS) return null;
    whole = "0";
    frac = "0".repeat(leadingZeros) + sig;
    if (frac.length < 2) frac = frac.padEnd(2, "0");
  }

  let formatted = `${whole}.${frac}`;
  if (formatted.length > MAX_BALANCE_CHARS) {
    const maxFrac = MAX_BALANCE_CHARS - whole.length - 1;
    if (maxFrac < 2) return null;
    const truncated = frac.slice(0, maxFrac).replace(/0+$/, "");
    // Never round a tiny non-zero balance down to zero.
    if (whole === "0" && !/[1-9]/.test(truncated)) return null;
    formatted = `${whole}.${truncated.length < 2 ? truncated.padEnd(2, "0") : truncated}`;
  }
  return /^\d+(?:\.\d+)?$/.test(formatted) && formatted.length <= MAX_BALANCE_CHARS ? formatted : null;
}

function mapWallets(
  wallets: readonly unknown[],
  prefix: "recharge" | "bonus",
  observedAt: string,
  expiresAt: string,
): QuotaBalance[] {
  if (wallets.length > MAX_WALLETS_PER_LIST) {
    throw new QuotaReadError("invalid_response");
  }
  const out: QuotaBalance[] = [];
  const seen = new Set<string>();
  for (const item of wallets) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new QuotaReadError("invalid_response");
    }
    const row = item as Record<string, unknown>;
    if (typeof row.currency !== "string") {
      throw new QuotaReadError("invalid_response");
    }
    const currencyRaw = row.currency.trim().toUpperCase();
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(currencyRaw)) {
      throw new QuotaReadError("invalid_response");
    }
    let balanceRaw: string;
    if (typeof row.balance === "string") {
      balanceRaw = row.balance;
    } else if (typeof row.balance === "number" && Number.isFinite(row.balance)) {
      balanceRaw = String(row.balance);
    } else {
      throw new QuotaReadError("invalid_response");
    }
    const amount = normalizeBalanceDecimal(balanceRaw);
    if (amount === null) {
      throw new QuotaReadError("invalid_response");
    }
    const id = `${prefix}_${currencyRaw.toLowerCase()}`;
    if (seen.has(id)) {
      throw new QuotaReadError("invalid_response");
    }
    seen.add(id);
    out.push({
      id,
      kind: "currency",
      amount,
      unit: currencyRaw,
      observedAt,
      expiresAt,
    });
  }
  return out;
}

/** Parse DeepSeek Harness `account.getBalance` outcome into a TaroBird `QuotaSnapshot`. */
export function parseDeepSeekAccountBalance(
  outcome: unknown,
  options: { now?: number; hasApiKey?: boolean } = {},
): QuotaSnapshot {
  const now = options.now ?? Date.now();
  if (outcome === null || outcome === undefined) {
    if (options.hasApiKey) {
      return unavailableQuota("deepseek", "mode_not_supported", now, "api_key");
    }
    return unavailableQuota("deepseek", "login_required", now, "unknown");
  }
  if (typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new QuotaReadError("invalid_response");
  }
  const obj = outcome as Record<string, unknown>;
  if (obj.status === "failed") {
    return unavailableQuota("deepseek", "native_error", now, "subscription");
  }
  if (obj.status !== "ready" || !Array.isArray(obj.value)) {
    throw new QuotaReadError("invalid_response");
  }
  if (obj.bonusWallets !== undefined && obj.bonusWallets !== null && !Array.isArray(obj.bonusWallets)) {
    throw new QuotaReadError("invalid_response");
  }

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const recharge = mapWallets(obj.value, "recharge", observedAt, expiresAt);
  const bonus = Array.isArray(obj.bonusWallets) ? mapWallets(obj.bonusWallets, "bonus", observedAt, expiresAt) : [];
  const balances = [...recharge, ...bonus];

  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: balances.length ? "ready" : "unknown",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools: balances.length ? [{
      id: "deepseek_wallet",
      label: "DeepSeek",
      sharing: "shared",
      availability: "unknown",
      windows: [],
      balances,
      constraints: [],
    }] : [],
    constraints: [],
    help: "deepseek_balance",
  };

  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}

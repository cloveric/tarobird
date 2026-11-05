import { redactSecrets, redactSecretsInErrorDetail } from "../runtime/secret-redaction.js";

// Lark-facing aliases for the shared, channel-agnostic redactor. Kept as named
// exports so existing Lark call sites stay stable; the patterns now live in
// runtime/secret-redaction so the audit/timeline log writers can reuse them.
export function redactCoreSensitiveText(value: string): string {
  return redactSecrets(value);
}

export function redactCoreErrorDetail(error: unknown): string {
  return redactSecretsInErrorDetail(error);
}

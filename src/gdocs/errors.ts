import { GoogleDocumentWriteError } from "./client.js";

export class GoogleDocsError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Public codes only; provider payloads, local paths and credential bytes stay local. */
export function googleDocsErrorCode(error: unknown): string {
  if (error instanceof GoogleDocsError) return error.code;
  if (error instanceof GoogleDocumentWriteError) return "google_docs_partial_write";
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("google_authorization_required")) return "google_docs_authorization_required";
  if (message === "google_stored_authorization_invalid") return "google_docs_authorization_invalid";
  if (/^google_oauth_http_\d+$/.test(message)) return "google_docs_authorization_failed";
  if (/^system_keychain_/.test(message)) return "google_docs_keychain_unavailable";
  if (message === "Google Docs authorization requires a macOS Keychain or Linux Secret Service on the Hub") return "google_docs_platform_unsupported";
  if (/^google_docs_http_\d+$/.test(message)) return "google_docs_service_failed";
  return "google_docs_export_failed";
}

import path from "node:path";
import { stat } from "node:fs/promises";
import { readHubConfig } from "../hub/config.js";
import { JsonStore } from "../state/json-store.js";
import { withFileMutex } from "../state/file-mutex.js";
import { readOAuthClient, type OAuthClient } from "./auth.js";
import { GoogleDocsError, googleDocsErrorCode } from "./errors.js";
import type { GoogleDocs } from "./client.js";
import type { GoogleDocsStatus } from "../client-protocol/google-docs.js";

const managedFile = (directory: string) => path.join(directory, "gdocs", "google-oauth-client.json");
async function readClient(file: string): Promise<OAuthClient> {
  try { return await readOAuthClient(file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GoogleDocsError(code === "ENOENT" ? "google_docs_not_configured" : code ? "google_docs_config_unreadable" : "google_docs_config_invalid");
  }
}
export async function googleDocsClient(directory: string, explicit?: string): Promise<OAuthClient> {
  if (explicit) return readClient(path.resolve(explicit));
  // Dedicated managed import avoids rewriting unrelated live Hub settings.
  const file = managedFile(directory);
  const managed = await stat(file).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw new GoogleDocsError("google_docs_config_unreadable");
  });
  if (managed) return readClient(file);
  const config = await readHubConfig(directory);
  return readClient(config.gdocs?.clientFile ?? path.join(directory, "google-oauth-client.json"));
}
export async function configureGoogleDocs(directory: string, file: string): Promise<void> {
  const client = await readClient(path.resolve(file));
  await withFileMutex(path.join(directory, "gdocs-config"), () => new JsonStore(managedFile(directory)).write({ installed: client }));
}
export async function googleDocsStatus(open: () => Promise<GoogleDocs>): Promise<GoogleDocsStatus> {
  let docs: GoogleDocs;
  try { docs = await open(); }
  catch (error) { return { configured: false, authorized: false, error: googleDocsErrorCode(error) }; }
  try { return { configured: true, authorized: await docs.authorization.authorized() }; }
  catch (error) { return { configured: true, authorized: false, error: googleDocsErrorCode(error) }; }
}

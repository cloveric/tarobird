import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { GoogleAuthorization } from "../src/gdocs/auth.js";
import { GoogleDocs } from "../src/gdocs/client.js";
import type { SecretVault } from "../src/gdocs/keychain.js";
import { exportGoogleDocument } from "../src/hub/google-export.js";
import { HubStore } from "../src/hub/store.js";

class MemoryVault implements SecretVault { value: string | null = null; async read() { return this.value; } async write(value: string) { this.value = value; } async remove() { this.value = null; } }
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function callbackUrl(url: string): URL {
  const link = new URL(url), callback = new URL(link.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", link.searchParams.get("state")!); callback.searchParams.set("code", "fixture-code");
  return callback;
}
it.each(["cancel", "timeout"] as const)("fences a late OAuth token after %s, even if fetch ignores abort", async (stop) => {
  const vault = new MemoryVault(), entered = deferred<AbortSignal>(), response = deferred<Response>();
  const auth = new GoogleAuthorization({ client_id: "test" }, vault, async (_url, init) => { entered.resolve(init!.signal!); return response.promise; });
  const flow = await auth.begin(stop === "timeout" ? 150 : 5_000);
  const terminal = flow.completed.catch((error: Error) => error.message);
  const callback = fetch(callbackUrl(flow.url)).then((r) => r.text()).catch(() => undefined);
  try {
    const signal = await entered.promise;
    if (stop === "cancel") flow.cancel();
    expect(await terminal).toBe(`google_authorization_${stop === "cancel" ? "cancelled" : "timeout"}`);
    expect(signal.aborted).toBe(true);
    response.resolve(Response.json({ access_token: "late-access", refresh_token: "late-refresh", expires_in: 3600 }));
    await new Promise((resolve) => setTimeout(resolve, 20)); await callback;
    expect(vault.value).toBeNull();
    await expect(auth.token()).rejects.toThrow("google_authorization_required");
    await expect(fetch(callbackUrl(flow.url))).rejects.toThrow();
  } finally { flow.cancel(); response.reject(new Error("fixture cleanup")); await callback; }
});
it("keeps cancellation terminal when the token request later rejects", async () => {
  const vault = new MemoryVault(), entered = deferred<void>(), response = deferred<Response>();
  const auth = new GoogleAuthorization({ client_id: "test" }, vault, async () => { entered.resolve(); return response.promise; });
  const flow = await auth.begin(); const terminal = flow.completed.catch((error: Error) => error.message);
  const callback = fetch(callbackUrl(flow.url)).then((r) => r.text()).catch(() => undefined);
  try {
    await entered.promise; flow.cancel(); response.reject(new Error("provider-details-must-not-leak"));
    expect(await terminal).toBe("google_authorization_cancelled"); await callback; expect(vault.value).toBeNull();
  } finally { flow.cancel(); response.reject(new Error("fixture cleanup")); await callback; }
});
it.each([true, false])("reports the actual vault commit result when cancelled during persistence (success=%s)", async (success) => {
  const vault = new MemoryVault(), entered = deferred<void>(), write = deferred<void>();
  vault.write = async (value: string) => { entered.resolve(); await write.promise; vault.value = value; };
  const auth = new GoogleAuthorization({ client_id: "test" }, vault, async () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
  const flow = await auth.begin(); const terminal = flow.completed.then(() => "success", (error: Error) => error.message);
  const callback = fetch(callbackUrl(flow.url)).then(async (r) => { await r.text(); return r.status; }).catch(() => undefined);
  try {
    await entered.promise; flow.cancel();
    if (success) write.resolve(); else write.reject(new Error("fixture write failed"));
    expect(await terminal).toBe(success ? "success" : "google_authorization_failed");
    expect(await callback).toBe(success ? 200 : 500);
    expect(vault.value).toBe(success ? JSON.stringify({ refreshToken: "refresh" }) : null);
    flow.cancel(); expect(await terminal).toBe(success ? "success" : "google_authorization_failed");
    expect(vault.value).toBe(success ? JSON.stringify({ refreshToken: "refresh" }) : null);
  } finally { write.reject(new Error("fixture cleanup")); flow.cancel(); await callback; }
});
it("cancelling before the callback preserves an existing Google credential without removing it", async () => {
  const vault = new MemoryVault(); vault.value = JSON.stringify({ refreshToken: "existing" });
  let exchanges = 0, removals = 0;
  vault.remove = async () => { removals++; vault.value = null; };
  const auth = new GoogleAuthorization({ client_id: "test" }, vault, async () => { exchanges++; throw new Error("No token request expected"); });
  const flow = await auth.begin(); flow.cancel();
  await expect(flow.completed).rejects.toThrow("google_authorization_cancelled");
  expect(exchanges).toBe(0); expect(removals).toBe(0); expect(vault.value).toBe(JSON.stringify({ refreshToken: "existing" }));
});
it("finishes a successful vault commit even if the callback browser has closed", async () => {
  const vault = new MemoryVault(), entered = deferred<void>(), write = deferred<void>();
  vault.write = async (value: string) => { entered.resolve(); await write.promise; vault.value = value; };
  const auth = new GoogleAuthorization({ client_id: "test" }, vault, async () => Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
  const flow = await auth.begin(), abort = new AbortController();
  const callback = fetch(callbackUrl(flow.url), { signal: abort.signal }).then((r) => r.text()).catch(() => undefined);
  try {
    await entered.promise; abort.abort(); await callback;
    await new Promise((resolve) => setTimeout(resolve, 20)); write.resolve();
    await flow.completed; expect(vault.value).toBe(JSON.stringify({ refreshToken: "refresh" }));
  } finally { write.resolve(); flow.cancel(); await callback; }
});
it("binds a one-time loopback OAuth callback to state and PKCE, stores only refresh credentials", async () => {
  const vault = new MemoryVault(); let verifier = ""; let exchanges = 0;
  const fetcher: typeof fetch = async (url, init) => { expect(String(url)).toBe("https://oauth2.googleapis.com/token"); expect(init?.redirect).toBe("error"); const body = new URLSearchParams(String(init?.body)); verifier = body.get("code_verifier") ?? ""; exchanges++; return Response.json({ access_token: "ephemeral", refresh_token: "persistent", expires_in: 3600 }); };
  const auth = new GoogleAuthorization({ client_id: "test-client" }, vault, fetcher); const flow = await auth.begin();
  try {
    const link = new URL(flow.url); expect(link.hostname).toBe("accounts.google.com"); const callback = new URL(link.searchParams.get("redirect_uri")!); callback.searchParams.set("code", "one-time-code"); callback.searchParams.set("state", "wrong");
    expect((await fetch(callback)).status).toBe(400); expect(exchanges).toBe(0);
    callback.searchParams.set("state", "界".repeat(43)); expect((await fetch(callback)).status).toBe(400);
    callback.searchParams.set("state", link.searchParams.get("state")!); const response = await fetch(callback); expect(response.status).toBe(200); await response.text(); await flow.completed;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(link.searchParams.get("code_challenge"));
    expect(vault.value).toBe(JSON.stringify({ refreshToken: "persistent" })); expect(await auth.token()).toBe("ephemeral"); expect(exchanges).toBe(1);
  } finally { flow.cancel(); }
});
it("coalesces access token refreshes and never exposes malformed stored credentials", async () => {
  const vault = new MemoryVault(); vault.value = JSON.stringify({ refreshToken: "refresh" }); let count = 0;
  const auth = new GoogleAuthorization({ client_id: "test" }, vault, async () => { count++; await new Promise((r) => setTimeout(r, 5)); return Response.json({ access_token: "short-lived", expires_in: 3600 }); });
  expect(await Promise.all(Array.from({ length: 10 }, () => auth.token()))).toEqual(Array(10).fill("short-lived")); expect(count).toBe(1);
  vault.value = "TOP-SECRET-BROKEN-JSON";
  await expect(new GoogleAuthorization({ client_id: "test" }, vault).token()).rejects.toThrow(/^google_stored_authorization_invalid$/);
});
function mockDocs() {
  const vault = new MemoryVault(); vault.value = JSON.stringify({ refreshToken: "refresh" });
  const authorization = new GoogleAuthorization({ client_id: "test" }, vault, async () => Response.json({ access_token: "access", expires_in: 3600 }));
  let content = ""; let creates = 0; let corrupt = false;
  const docs = new GoogleDocs(authorization, async (url, init) => {
    expect(init?.headers).toMatchObject({ Authorization: "Bearer access" }); expect(init?.redirect).toBe("error");
    if (init?.method === "POST" && String(url).endsWith("/documents")) { creates++; return Response.json({ documentId: "doc_1" }); }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { writeControl: { requiredRevisionId: string }; requests: { insertText?: { text: string }; deleteContentRange?: { range: { endIndex: number } } }[] };
      expect(body.writeControl.requiredRevisionId).toBe("rev_1"); if (content) expect(body.requests[0]?.deleteContentRange?.range.endIndex).toBe(content.length + 1);
      content = body.requests.find((r) => r.insertText)?.insertText?.text ?? ""; return Response.json({ documentId: "doc_1" });
    }
    return Response.json({ documentId: "doc_1", revisionId: "rev_1", tabs: [{ documentTab: { body: { content: [{ endIndex: content.length + 2, paragraph: { elements: [{ textRun: { content: (corrupt ? "wrong" : content) + "\n" } }] } }] } } }] });
  });
  return { docs, created: () => creates, corrupt: () => { corrupt = true; } };
}
it("guards updates with the current revision and returns a link only after content read-back", async () => {
  const mock = mockDocs(); expect(await mock.docs.create("Test", "Hello 🌱\n你好")).toEqual({ documentId: "doc_1", url: "https://docs.google.com/document/d/doc_1/edit" });
  expect((await mock.docs.update("doc_1", "Next version")).documentId).toBe("doc_1"); mock.corrupt();
  await expect(mock.docs.update("doc_1", "Changed")).rejects.toThrow("could not be verified");
  await expect(mock.docs.update("../malicious", "x")).rejects.toThrow();
});
it("exports each message version once and reuses the durable document receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdocs-export-")); const store = await HubStore.open(root);
  try {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','test')");
    const c = await store.createConversation("owner", ["alpha"], "Export", "create"); const message = await store.publishBotMessage("alpha", { conversationId: c.id, blocks: [{ type: "text", text: "Document content" }] }); const mock = mockDocs();
    const first = await exportGoogleDocument(store, root, "owner", message, mock.docs); const second = await exportGoogleDocument(store, root, "owner", message, mock.docs);
    expect(first).toEqual(second); expect(mock.created()).toBe(1);
    expect(await store.db.get("SELECT 1 FROM audit_log WHERE kind='gdocs.exported'")).toBeDefined();
  } finally { await store.db.close(); await rm(root, { recursive: true, force: true }); }
});

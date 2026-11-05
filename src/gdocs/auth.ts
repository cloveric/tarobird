import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { z } from "zod";
import type { SecretVault } from "./keychain.js";

export const oauthClientSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().optional() });
export type OAuthClient = z.infer<typeof oauthClientSchema>;
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive() });
const storedSchema = z.object({ refreshToken: z.string().min(1) });
function savedToken(raw: string): z.infer<typeof storedSchema> { try { return storedSchema.parse(JSON.parse(raw)); } catch { throw new Error("google_stored_authorization_invalid"); } }
export async function readOAuthClient(file: string): Promise<OAuthClient> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  return z.object({ installed: oauthClientSchema }).parse(raw).installed;
}
export class GoogleAuthorization {
  private access?: { token: string; until: number }; private refreshing?: Promise<string>;
  constructor(readonly client: OAuthClient, readonly vault: SecretVault, readonly fetcher: typeof fetch = fetch) {}
  private async exchange(values: Record<string, string>, signal?: AbortSignal): Promise<z.infer<typeof tokenSchema>> {
    const deadline = AbortSignal.timeout(20_000);
    const response = await this.fetcher("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.client.client_id, ...(this.client.client_secret ? { client_secret: this.client.client_secret } : {}), ...values }), signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "error" });
    if (!response.ok) throw new Error(`google_oauth_http_${response.status}`);
    return tokenSchema.parse(await response.json());
  }
  async token(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 30_000) return this.access.token;
    if (this.refreshing) return this.refreshing;
    const work = (async () => {
      const raw = await this.vault.read(); if (!raw) throw new Error("google_authorization_required: run tarobot gdocs auth");
      const saved = savedToken(raw); const token = await this.exchange({ grant_type: "refresh_token", refresh_token: saved.refreshToken });
      if (token.refresh_token && token.refresh_token !== saved.refreshToken) await this.vault.write(JSON.stringify({ refreshToken: token.refresh_token }));
      this.access = { token: token.access_token, until: Date.now() + token.expires_in * 1000 }; return token.access_token;
    })(); this.refreshing = work;
    try { return await work; } finally { this.refreshing = undefined; }
  }
  async authorized(): Promise<boolean> { const raw = await this.vault.read(); if (!raw) return false; savedToken(raw); return true; }
  async logout(): Promise<void> {
    const raw = await this.vault.read();
    if (raw) { const saved = savedToken(raw); const response = await this.fetcher("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: saved.refreshToken }), redirect: "error", signal: AbortSignal.timeout(20_000) }); if (!response.ok && response.status !== 400) throw new Error("google_token_revocation_failed"); }
    await this.vault.remove(); this.access = undefined;
  }
  async begin(timeoutMs = 5 * 60_000): Promise<{ url: string; completed: Promise<void>; cancel: () => void }> {
    const state = randomBytes(32).toString("base64url"); const verifier = randomBytes(48).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
    let finish: (() => void) | undefined; let fail: ((e: Error) => void) | undefined; let consumed = false;
    let phase: "waiting" | "exchanging" | "committing" | "finished" = "waiting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exchangeAbort = new AbortController();
    const cancel = (reason: string) => {
      // A vault write cannot be atomically undone. Once it starts, report its
      // actual result rather than claiming cancellation and then saving a token.
      if (phase === "committing" || phase === "finished") return;
      phase = "finished"; consumed = true; exchangeAbort.abort(); fail?.(new Error(reason));
    };
    const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }); void completed.catch(() => undefined);
    let redirect = "";
    const server = createServer((req, res) => {
      const callback = new URL(req.url ?? "/", "http://127.0.0.1"); const returnedState = callback.searchParams.get("state") ?? "";
      res.setHeader("Content-Type", "text/plain; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const respond = (status: number, text: string, settle: () => void) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; res.off("close", done); settle(); } };
        // Closing the browser must not strand a completed vault commit. Prefer
        // flushing the response, but the OAuth outcome does not depend on it.
        if (res.destroyed) { done(); return; }
        res.once("close", done); res.writeHead(status); res.end(text, done);
      };
      if (consumed || req.method !== "GET" || callback.pathname !== "/oauth/callback" || Buffer.byteLength(returnedState) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))) { res.writeHead(400); res.end("Invalid authorization callback."); return; }
      const code = callback.searchParams.get("code");
      if (!code || code.length > 4096) { phase = "finished"; respond(400, "Google authorization was not granted.", () => fail?.(new Error("google_authorization_denied"))); consumed = true; return; }
      consumed = true; phase = "exchanging";
      void this.exchange({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect }, exchangeAbort.signal).then(async (token) => {
        // The fetcher may complete despite abort; cancellation must still fence
        // both credential persistence and the in-memory access token.
        if (phase !== "exchanging") return;
        if (!token.refresh_token) throw new Error("google_refresh_token_missing");
        phase = "committing"; clearTimeout(timer);
        await this.vault.write(JSON.stringify({ refreshToken: token.refresh_token })); this.access = { token: token.access_token, until: Date.now() + token.expires_in * 1000 };
        phase = "finished";
        respond(200, "TaroBird 已完成 Google 文档授权，可以关闭此窗口。", () => finish?.());
      }).catch(() => {
        if (phase === "finished") return;
        phase = "finished"; respond(500, "Authorization failed. Return to TaroBird and retry.", () => fail?.(new Error("google_authorization_failed")));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("oauth_listener_failed");
    redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth"); url.search = new URLSearchParams({ client_id: this.client.client_id, redirect_uri: redirect, response_type: "code", scope: "https://www.googleapis.com/auth/documents", code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" }).toString();
    timer = setTimeout(() => cancel("google_authorization_timeout"), timeoutMs);
    const cleanup = () => { clearTimeout(timer); server.close(); server.closeAllConnections(); };
    void completed.finally(cleanup).catch(() => undefined);
    return { url: url.toString(), completed, cancel: () => cancel("google_authorization_cancelled") };
  }
}

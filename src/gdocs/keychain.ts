import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export interface SecretVault { read(): Promise<string | null>; write(value: string): Promise<void>; remove(): Promise<void> }
function command(file: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] }); let stdout = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("system_keychain_timeout")); }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 65_536) child.kill(); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("system_keychain_unavailable")); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: stdout.trim() }); });
    child.stdin.on("error", () => undefined); child.stdin.end(input);
  });
}
/** Dedicated TaroCub item only. Secrets go through stdin, never argv or logs. */
export class SystemSecretVault implements SecretVault {
  private account: string;
  constructor(clientId: string, private readonly platform = process.platform) { this.account = createHash("sha256").update(clientId).digest("hex"); }
  async read(): Promise<string | null> {
    const result = this.platform === "darwin"
      ? await command("/usr/bin/security", ["find-generic-password", "-s", "com.tarocub.gdocs", "-a", this.account, "-w"])
      : this.platform === "linux" ? await command("secret-tool", ["lookup", "application", "tarocub-gdocs", "account", this.account]) : this.unsupported();
    if (result.code === 44 || this.platform === "linux" && result.code === 1 && !result.stdout) return null;
    if (result.code !== 0) throw new Error("system_keychain_read_failed");
    return Buffer.from(result.stdout, "base64").toString("utf8");
  }
  async write(value: string): Promise<void> {
    const encoded = Buffer.from(value).toString("base64");
    const result = this.platform === "darwin"
      ? await command("/usr/bin/security", ["-i"], `add-generic-password -U -s com.tarocub.gdocs -a ${this.account} -w ${encoded}\n`)
      : this.platform === "linux" ? await command("secret-tool", ["store", "--label=TaroBird Google Docs", "application", "tarocub-gdocs", "account", this.account], encoded) : this.unsupported();
    // security -i may exit successfully after an individual command fails.
    if (result.code !== 0 || await this.read() !== value) throw new Error("system_keychain_write_failed");
  }
  async remove(): Promise<void> {
    const result = this.platform === "darwin"
      ? await command("/usr/bin/security", ["delete-generic-password", "-s", "com.tarocub.gdocs", "-a", this.account])
      : this.platform === "linux" ? await command("secret-tool", ["clear", "application", "tarocub-gdocs", "account", this.account]) : this.unsupported();
    if (![0, 44].includes(result.code)) throw new Error("system_keychain_delete_failed");
  }
  private unsupported(): never { throw new Error("Google Docs authorization requires a macOS Keychain or Linux Secret Service on the Hub"); }
}

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { isCredentialStylePath } from "../src/runtime/credential-files.js";
import { preflightCoreDeliveryPath } from "../src/core/delivery-preflight.js";

test.each([
  "/home/example/.codex/auth.json", "C:\\Users\\example\\.codex\\auth.json",
  "/home/example/.claude/.credentials.json", "/home/example/.aws/credentials",
  "/home/example/.kimi-code/credentials/kimi-code.json", "C:\\Users\\example\\.kimi-code\\credentials\\kimi-code.json",
  "/home/example/.kimi-code/config.toml", "/private/bot/dsh-home/.credentials.yaml", "/private/shared/.credentials.yml",
  "/home/example/.config/gh/hosts.yml", "/home/example/.config/gcloud/application_default_credentials.json",
  "/home/example/.netrc", "/home/example/.npmrc", "/home/example/.git-credentials",
  "/tmp/signing.p12", "/tmp/KEYSTORE.JKS", "/tmp/signing.pfx", "/tmp/id_ecdsa",
  "/home/example/Library/Application Support/Google/Chrome/Default/Network/Cookies",
  "/home/example/Library/Application Support/Google/Chrome/Default/Login Data-wal",
  "C:\\Users\\example\\AppData\\Local\\Microsoft\\Edge\\User Data\\Profile 1\\Network\\Cookies",
  "/home/example/.mozilla/firefox/example.default/cookies.sqlite",
  "/home/example/Library/Keychains/login.keychain-db",
])("blocks known credential location %s", file => expect(isCredentialStylePath(file)).toBe(true));

test.each([
  "/workspace/auth.json", "/workspace/hosts.yml", "/workspace/credentials-report.md",
  "/home/example/.codex/generated_images/figure.png", "/workspace/browser/Cookies.md",
  "/workspace/app/package.json", "/home/example/.config/gh/report.md", "/workspace/id_ed25519.pub",
  "/home/example/.kimi-code/generated_images/figure.png", "/home/example/.kimi-code/credentials/report.md",
  "/workspace/config.toml", "/workspace/credentials.yaml",
])("keeps ordinary outputs deliverable %s", file => expect(isCredentialStylePath(file)).toBe(false));

test.each([".codex/auth.json", ".kimi-code/config.toml", ".kimi-code/credentials/kimi-code.json", "dsh-home/.credentials.yaml"])("full access still rejects credential targets hidden behind a harmless symlink: %s", async relative => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "credential-delivery-"));
  try {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "synthetic fixture only");
    const link = path.join(dir, "report.json"); await symlink(target, link);
    expect(await preflightCoreDeliveryPath(link, { allowedRoots: [dir], allowAnyAbsolutePath: true }))
      .toMatchObject({ ok: false, reason: "credentials-file" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

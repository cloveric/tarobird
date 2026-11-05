import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Standalone release tooling intentionally has no TypeScript declaration.
import { createWindowsUpdateBundle, verifyWindowsUpdateArtifact } from "../client/scripts/windows-update-manifest.mjs";
// @ts-expect-error Standalone release tooling intentionally has no TypeScript declaration.
import { createDesktopUpdateBundle, verifyDesktopUpdateArtifact } from "../client/scripts/desktop-update-manifest.mjs";

const execute = promisify(execFile);
const signer = path.resolve("client/node_modules/@tauri-apps/cli/tauri.js");
const version = "1.2.3";
const basename = "TaroBot 1.2.3_x64-setup.exe";
const repository = "cloveric/tarobot";
const assetUrl = `https://api.github.com/repos/${repository}/releases/assets/123456789`;
let directory: string;
let signedInstaller: string;
let publicKey: string;
let installer: string;
let outputDir: string;

function options(overrides: Record<string, unknown> = {}) {
  return { installer, publicKey, repository, assetUrl, version, outputDir, ...overrides };
}

async function editSignature(edit: (lines: string[]) => void) {
  const lines = Buffer.from(await readFile(`${installer}.sig`, "utf8"), "base64").toString("utf8").trimEnd().split("\n");
  edit(lines);
  await writeFile(`${installer}.sig`, Buffer.from(`${lines.join("\n")}\n`).toString("base64"));
}

async function tauri(args: string[]) {
  // The generator prints the disposable private key. Capture it and never emit it.
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: "true" };
    for (const name of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PATH", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) delete env[name];
    await execute(process.execPath, [signer, "signer", ...args], {
      env,
    });
  } catch {
    throw new Error("The disposable Tauri signer fixture could not be created");
  }
}

beforeAll(async () => {
  // Keep temporary signing keys outside the checkout; the suite removes them.
  const fixtureRoot = path.join(path.dirname(process.cwd()), "desktop-update-tests.noindex");
  await mkdir(fixtureRoot, { recursive: true });
  directory = await mkdtemp(path.join(fixtureRoot, "windows-update-manifest-test-"));
  const key = path.join(directory, "disposable.key");
  await tauri(["generate", "--ci", "--password", "", "--write-keys", key]);
  publicKey = await readFile(`${key}.pub`, "utf8");
  signedInstaller = path.join(directory, basename);
  await writeFile(signedInstaller, "MZ synthetic installer; never execute this fixture\n");
  await tauri(["sign", "--private-key-path", key, "--password", "", "--app-version", version, signedInstaller]);
}, 30_000);

beforeEach(async () => {
  const fixture = await mkdtemp(path.join(directory, "case-"));
  installer = path.join(fixture, basename);
  await copyFile(signedInstaller, installer);
  await copyFile(`${signedInstaller}.sig`, `${installer}.sig`);
  outputDir = path.join(fixture, "bundle");
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("Windows updater bundle", () => {
  it("signs a Mac archive and isolates its manifest, target, version and archive type", async () => {
    const app = path.join(path.dirname(installer), "TaroBot.app");
    await mkdir(app); await writeFile(path.join(app, "fixture"), "disposable non-executable test bundle");
    const archive = app + ".tar.gz";
    await execute("tar", ["-czf", archive, "-C", path.dirname(app), path.basename(app)]);
    await tauri(["sign", "--private-key-path", path.join(directory, "disposable.key"), "--password", "", "--app-version", version, archive]);
    const input = options({ installer: archive, platform: "macos" });
    const result = await createDesktopUpdateBundle(input);
    expect(result.tag).toBe("macos-tarobot-v1.2.3");
    expect(path.basename(result.manifestFile)).toBe("macos-tarobot-latest.json");
    const manifest = JSON.parse(await readFile(result.manifestFile, "utf8"));
    expect(Object.keys(manifest.platforms)).toEqual(["darwin-aarch64"]);
    expect(manifest.platforms["darwin-aarch64"].url).toBe(assetUrl);
    await expect(verifyDesktopUpdateArtifact({ ...input, version: "1.2.4" })).rejects.toThrow(/signed version/i);
    await expect(verifyDesktopUpdateArtifact({ ...input, installer })).rejects.toThrow(/app.tar.gz/);
    await writeFile(archive, "changed");
    await expect(verifyDesktopUpdateArtifact(input)).rejects.toThrow(/signature verification/i);
  });
  it("verifies a real Tauri signature and writes an immutable GitHub manifest and checksums", async () => {
    const result = await createWindowsUpdateBundle(options({ notes: "Windows update test" }));
    expect(result).toEqual({
      manifestFile: path.join(outputDir, "windows-tarobot-latest.json"),
      installerFile: path.join(outputDir, basename),
      signatureFile: path.join(outputDir, `${basename}.sig`),
      checksumFile: path.join(outputDir, "SHA256SUMS"),
      version,
      tag: "windows-tarobot-v1.2.3",
      repository: "cloveric/tarobot",
    });
    const signature = await readFile(`${installer}.sig`, "utf8");
    const manifestBytes = await readFile(result.manifestFile);
    expect(JSON.parse(manifestBytes.toString())).toEqual({
      version,
      notes: "Windows update test",
      pub_date: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      platforms: { "windows-x86_64": { url: assetUrl, signature } },
    });
    expect(await readFile(result.installerFile)).toEqual(await readFile(installer));
    expect(await readFile(result.signatureFile, "utf8")).toBe(signature);
    const sums = await readFile(result.checksumFile, "utf8");
    for (const file of [result.installerFile, result.signatureFile, result.manifestFile]) {
      expect(sums).toContain(`${createHash("sha256").update(await readFile(file)).digest("hex")}  ${path.basename(file)}\n`);
    }
  });

  it("verifies a real signed artifact before a GitHub asset exists without creating a bundle", async () => {
    await expect(verifyWindowsUpdateArtifact({ installer, publicKey, version })).resolves.toEqual({ installerFile: path.resolve(installer), signatureFile: path.resolve(`${installer}.sig`), version });
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects tampered bytes during artifact-only verification", async () => {
    await writeFile(installer, "tampered before upload");
    await expect(verifyWindowsUpdateArtifact({ installer, publicKey, version })).rejects.toThrow(/signature verification/i);
  });

  it("rejects a changed version during artifact-only verification", async () => {
    await expect(verifyWindowsUpdateArtifact({ installer, publicKey, version: "1.2.4" })).rejects.toThrow(/signed version/i);
  });

  it("verifies both the legacy Ed format and the ED prehashed format with trusted comments", async () => {
    const { publicKey: key, privateKey } = generateKeyPairSync("ed25519");
    const keyBytes = key.export({ type: "spki", format: "der" }).subarray(-32);
    const keyId = Buffer.from("12345678");
    const encodedPublicKey = Buffer.from(`untrusted comment: disposable test key\n${Buffer.concat([Buffer.from("Ed"), keyId, keyBytes]).toString("base64")}\n`).toString("base64");
    for (const algorithm of ["Ed", "ED"]) {
      const data = await readFile(installer);
      const rawSignature = sign(null, algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data, privateKey);
      const trustedComment = `timestamp:1700000000\tfile:${basename}\tversion:${version}`;
      const globalSignature = sign(null, Buffer.concat([rawSignature, Buffer.from(trustedComment)]), privateKey);
      const text = `untrusted comment: disposable test signature\n${Buffer.concat([Buffer.from(algorithm), keyId, rawSignature]).toString("base64")}\ntrusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`;
      await writeFile(`${installer}.sig`, Buffer.from(text).toString("base64"));
      await expect(createWindowsUpdateBundle(options({ publicKey: encodedPublicKey, outputDir: `${outputDir}-${algorithm === "Ed" ? "legacy" : "prehashed"}` }))).resolves.toMatchObject({ version });
    }
  });

  it("rejects modified installer bytes before creating output", async () => {
    await writeFile(installer, "MZ changed bytes");
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/signature verification/i);
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects another public key even when its key ID is unchanged", async () => {
    const lines = Buffer.from(publicKey, "base64").toString("utf8").trim().split("\n");
    const bytes = Buffer.from(lines[1], "base64");
    bytes[41] ^= 1;
    lines[1] = bytes.toString("base64");
    const changedKey = Buffer.from(`${lines.join("\n")}\n`).toString("base64");
    await expect(createWindowsUpdateBundle(options({ publicKey: changedKey }))).rejects.toThrow(/signature verification/i);
  });

  it.each(["key ID", "artifact signature", "global signature", "trusted comment", "algorithm"])("rejects a changed %s", async (part) => {
    await editSignature((lines) => {
      if (part === "trusted comment") lines[2] = lines[2].replace("version:1.2.3", "version:9.9.9");
      else if (part === "global signature") {
        const bytes = Buffer.from(lines[3], "base64"); bytes[0] ^= 1; lines[3] = bytes.toString("base64");
      } else {
        const bytes = Buffer.from(lines[1], "base64");
        bytes[part === "key ID" ? 2 : part === "algorithm" ? 0 : 10] ^= 1;
        lines[1] = bytes.toString("base64");
      }
    });
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/signature|key id|algorithm/i);
  });

  it.each(["leading", "trailing"])("rejects %s whitespace added to a real Tauri trusted comment", async (position) => {
    await editSignature((lines) => {
      lines[2] = position === "leading" ? lines[2].replace("trusted comment: ", "trusted comment:  ") : `${lines[2]} `;
    });
    await expect(verifyWindowsUpdateArtifact({ installer, publicKey, version })).rejects.toThrow(/trusted comment signature verification/i);
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/trusted comment signature verification/i);
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a manifest version different from the cryptographically signed version", async () => {
    await expect(createWindowsUpdateBundle(options({ version: "1.2.4" }))).rejects.toThrow(/signed version.*1\.2\.3.*1\.2\.4/i);
  });

  it("requires a version in the signed trusted comment", async () => {
    await tauri(["sign", "--private-key-path", path.join(directory, "disposable.key"), "--password", "", installer]);
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/signed version/i);
  });

  it.each(["1.2", "v1.2.3", "01.2.3", "1.2.3-rc.1", "1.2.3+build", "1.2.3\n", "18446744073709551616.0.0"])("rejects non-stable or invalid version %j", async (invalidVersion) => {
    await expect(createWindowsUpdateBundle(options({ version: invalidVersion }))).rejects.toThrow(/stable.*version|stable.*semver/i);
  });

  it.each(["latest", "windows-latest", "windows-tarobot-v1.2.4", "../windows-tarobot-v1.2.3"])("rejects a tag that is not tied to this Windows version: %s", async (tag) => {
    await expect(createWindowsUpdateBundle(options({ tag }))).rejects.toThrow(/tag/i);
  });

  it.each(["", "owner", "owner/repo/extra", "https://github.com/owner/repo", "owner/repo?token=secret", "../repo", "owner/%2e%2e", "owner/repo\n", " owner/repo", "-owner/repo", "owner/.."])("rejects unsafe repository slug %j", async (unsafeRepository) => {
    await expect(createWindowsUpdateBundle(options({ repository: unsafeRepository }))).rejects.toThrow(/repository/i);
  });

  it.each([
    undefined,
    "https://github.com/cloveric/tarobot/releases/download/windows-tarobot-v1.2.3/installer.exe",
    "https://api.github.com/repos/someone/else/releases/assets/123",
    "http://api.github.com/repos/cloveric/tarobot/releases/assets/123",
    "https://api.github.com/repos/cloveric/tarobot/releases/assets/0",
    "https://api.github.com/repos/cloveric/tarobot/releases/assets/123?token=secret",
    "https://api.github.com/repos/cloveric/tarobot/releases/assets/123#fragment",
    "https://token@api.github.com/repos/cloveric/tarobot/releases/assets/123",
    "https://api.github.com/repos/cloveric/tarobot/releases/assets/123/",
  ])("rejects an asset URL outside the repository's authenticated GitHub asset API: %s", async (unsafeUrl) => {
    await expect(createWindowsUpdateBundle(options({ assetUrl: unsafeUrl }))).rejects.toThrow(/asset.*url/i);
  });

  it.each(["", "not base64!", Buffer.from("untrusted comment: key\nRWQ=\n").toString("base64")])("rejects a malformed public key", async (malformedKey) => {
    await expect(createWindowsUpdateBundle(options({ publicKey: malformedKey }))).rejects.toThrow(/public key|pubkey|base64/i);
  });

  it.each(["not base64!", Buffer.from("untrusted comment: truncated\nRWQ=\n").toString("base64")])("rejects a malformed signature", async (signature) => {
    await writeFile(`${installer}.sig`, signature);
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/signature/i);
  });

  it("refuses to overwrite an existing output directory and preserves its files", async () => {
    await mkdir(outputDir);
    const marker = path.join(outputDir, "keep.txt");
    await writeFile(marker, "preserve me");
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/output.*exist|exist.*output/i);
    expect(await readFile(marker, "utf8")).toBe("preserve me");
  });

  it.each(["installer", "signature"])("rejects a directory as the %s input", async (part) => {
    const file = part === "installer" ? installer : `${installer}.sig`;
    await rm(file);
    await mkdir(file);
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/regular file/i);
  });

  it.each(["installer", "signature"])("rejects a symlink as the %s input", async (part) => {
    const file = part === "installer" ? installer : `${installer}.sig`;
    const target = part === "installer" ? signedInstaller : `${signedInstaller}.sig`;
    await rm(file);
    // Junctions do not require Windows Developer Mode or administrator rights.
    await symlink(process.platform === "win32" ? path.dirname(target) : target, file, process.platform === "win32" ? "junction" : "file");
    await expect(createWindowsUpdateBundle(options())).rejects.toThrow(/regular file|symlink/i);
  });

  it("requires an NSIS executable installer", async () => {
    const msi = installer.replace(/\.exe$/, ".msi");
    await copyFile(installer, msi);
    await copyFile(`${installer}.sig`, `${msi}.sig`);
    await expect(createWindowsUpdateBundle(options({ installer: msi }))).rejects.toThrow(/\.exe|NSIS/i);
  });

  it("exposes a CLI with explicit artifact, repository, version, asset URL and notes file", async () => {
    const notes = path.join(path.dirname(installer), "notes.txt");
    await writeFile(notes, "Private Windows release\n");
    const { stdout } = await execute(process.execPath, [path.resolve("client/scripts/windows-update-manifest.mjs"), "--installer", installer, "--repository", repository, "--version", version, "--asset-url", assetUrl, "--output", outputDir, "--notes-file", notes], {
      env: { ...process.env, TAROBOT_UPDATE_PUBLIC_KEY: publicKey, TAROCUB_UPDATE_PUBLIC_KEY: "invalid legacy value" },
    });
    const result = JSON.parse(stdout);
    expect(JSON.parse(await readFile(result.manifestFile, "utf8"))).toMatchObject({ notes: "Private Windows release\n", platforms: { "windows-x86_64": { url: assetUrl } } });
  });

  it("keeps legacy public-key environment compatibility", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TAROCUB_UPDATE_PUBLIC_KEY: publicKey };
    delete env.TAROBOT_UPDATE_PUBLIC_KEY;
    await execute(process.execPath, [path.resolve("client/scripts/windows-update-manifest.mjs"), "--installer", installer, "--repository", repository, "--version", version, "--asset-url", assetUrl, "--output", outputDir], { env });
    expect(JSON.parse(await readFile(path.join(outputDir, "windows-tarobot-latest.json"), "utf8"))).toMatchObject({ version, notes: "" });
  });

  it("supports --verify-only before a release or asset URL exists", async () => {
    const { stdout } = await execute(process.execPath, [path.resolve("client/scripts/windows-update-manifest.mjs"), "--verify-only", "--installer", installer, "--version", version], {
      env: { ...process.env, TAROBOT_UPDATE_PUBLIC_KEY: publicKey },
    });
    expect(JSON.parse(stdout)).toEqual({ installerFile: path.resolve(installer), signatureFile: path.resolve(`${installer}.sig`), version });
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails --verify-only for an invalid signature", async () => {
    await writeFile(installer, "tampered before upload");
    await expect(execute(process.execPath, [path.resolve("client/scripts/windows-update-manifest.mjs"), "--verify-only", "--installer", installer, "--version", version], {
      env: { ...process.env, TAROBOT_UPDATE_PUBLIC_KEY: publicKey },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/signature verification/i) });
  });
});

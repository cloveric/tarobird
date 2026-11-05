import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { desktopUpdatePlatform } from "./desktop-update-platform.mjs";
import { releaseConfig } from "./desktop-release.mjs";

export function validateGithubRepository(repository) {
  if (typeof repository !== "string" || repository !== repository.trim()) throw new Error("Expected a GitHub repository as owner/repo");
  const parts = repository.split("/");
  if (parts.length !== 2 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(parts[0]) || parts[0].includes("--") || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || [".", ".."].includes(parts[1])) {
    throw new Error("Expected a GitHub repository as owner/repo");
  }
  return repository;
}

export function validateGithubAssetUrl(assetUrl, repository) {
  validateGithubRepository(repository);
  const prefix = `https://api.github.com/repos/${repository}/releases/assets/`;
  if (typeof assetUrl !== "string" || !assetUrl.startsWith(prefix) || !/^[1-9][0-9]*$/.test(assetUrl.slice(prefix.length))) {
    throw new Error("Asset URL must be the authenticated GitHub release asset API URL for this repository");
  }
  return assetUrl;
}

function stableVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) || version.split(".").some((part) => BigInt(part) > 18446744073709551615n)) {
    throw new Error("Expected a stable semantic version such as 1.2.3");
  }
  return version;
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`Invalid ${label} base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`Invalid ${label} base64`);
  return bytes;
}

function decodeText(bytes, label) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`Invalid ${label} UTF-8`); }
}

function verifyInstaller(data, encodedSignature, publicKey, version) {
  const keyLines = decodeText(decodeBase64(publicKey, "public key"), "public key").trim().split(/\r?\n/);
  const keyBytes = decodeBase64(keyLines[1], "public key");
  if (keyLines.length !== 2 || !keyLines[0].startsWith("untrusted comment:") || keyBytes.length !== 42 || keyBytes.subarray(0, 2).toString() !== "Ed") throw new Error("Invalid Tauri public key");
  const lines = decodeText(decodeBase64(encodedSignature, "signature"), "signature").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment: ")) throw new Error("Invalid Tauri signature format");
  const signatureBytes = decodeBase64(lines[1], "signature");
  const globalSignature = decodeBase64(lines[3], "global signature");
  const algorithm = signatureBytes.subarray(0, 2).toString();
  if (signatureBytes.length !== 74 || globalSignature.length !== 64 || !["Ed", "ED"].includes(algorithm)) throw new Error("Invalid Tauri signature algorithm or length");
  if (!signatureBytes.subarray(2, 10).equals(keyBytes.subarray(2, 10))) throw new Error("Signature key ID does not match the public key");
  const rawSignature = signatureBytes.subarray(10);
  // The installed updater's minisign-verify preserves every comment byte.
  const trustedComment = lines[2].slice("trusted comment: ".length);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes.subarray(10)]), format: "der", type: "spki" });
  // Minisign ED signs a BLAKE2b-512 digest. Its global signature binds the
  // 64-byte artifact signature and trusted comment, without the packet header.
  // https://github.com/jedisct1/rust-minisign/blob/master/src/lib.rs
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, rawSignature)) throw new Error("Installer signature verification failed");
  if (!verify(null, Buffer.concat([rawSignature, Buffer.from(trustedComment)]), key, globalSignature)) throw new Error("Trusted comment signature verification failed");
  // Read version metadata only after its global signature has been verified.
  const signedVersions = trustedComment.split("\t").filter((field) => field.startsWith("version:")).map((field) => field.slice("version:".length));
  if (signedVersions.length !== 1) throw new Error("Signature must contain exactly one signed version");
  if (signedVersions[0] !== version) throw new Error(`Signed version ${signedVersions[0]} does not match manifest version ${version}`);
}

async function readRegularFile(file, label) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a symlink`);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error(`${label} must be the same regular file that was inspected`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function readVerifiedDesktopArtifact({ installer, publicKey, version, platform = "windows" }) {
  const channel = desktopUpdatePlatform(platform);
  stableVersion(version);
  // Keep this key validation aligned with the updater configuration used to build the App.
  releaseConfig("https://api.github.com/", publicKey);
  if (typeof installer !== "string" || !installer || !installer.endsWith(channel.extension)) throw new Error(`Expected a ${channel.extension} desktop update artifact`);
  const basename = path.basename(installer);
  if (/[<>:"/\\|?*\x00-\x1f\x7f]/.test(basename) || /[. ]$/.test(basename)) throw new Error("Installer filename is not safe for a release asset or checksum file");
  const data = await readRegularFile(installer, "Installer");
  const signature = await readRegularFile(`${installer}.sig`, "Signature");
  const signatureText = decodeText(signature, "signature");
  verifyInstaller(data, signatureText, publicKey, version);
  return { data, signature, signatureText, basename };
}

/** Verify the exact local installer/signature pair before any upload occurs. */
export async function verifyDesktopUpdateArtifact({ installer, publicKey, version, platform = "windows" }) {
  await readVerifiedDesktopArtifact({ installer, publicKey, version, platform });
  return { installerFile: path.resolve(installer), signatureFile: path.resolve(`${installer}.sig`), version };
}

/** Build a verified local bundle after the private release's installer is uploaded. */
export async function createDesktopUpdateBundle({ installer, publicKey, repository, assetUrl, version, platform = "windows", tag = `${desktopUpdatePlatform(platform).prefix}${version}`, outputDir, notes = "" }) {
  const channel = desktopUpdatePlatform(platform);
  validateGithubRepository(repository);
  validateGithubAssetUrl(assetUrl, repository);
  stableVersion(version);
  if (tag !== `${channel.prefix}${version}`) throw new Error("Desktop release tag must match the selected platform and version");
  if (typeof outputDir !== "string" || !outputDir) throw new Error("Output directory is required");
  if (typeof notes !== "string") throw new Error("Release notes must be a string");
  const { data, signature, signatureText, basename } = await readVerifiedDesktopArtifact({ installer, publicKey, version, platform });
  const directory = path.resolve(outputDir);
  const result = {
    manifestFile: path.join(directory, channel.manifest),
    installerFile: path.join(directory, basename),
    signatureFile: path.join(directory, `${basename}.sig`),
    checksumFile: path.join(directory, "SHA256SUMS"),
    version, tag, repository,
  };
  const manifest = Buffer.from(`${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms: { [channel.target]: { url: assetUrl, signature: signatureText } } }, null, 2)}\n`);
  const files = [[result.installerFile, data], [result.signatureFile, signature], [result.manifestFile, manifest]];
  const checksums = files.map(([file, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${path.basename(file)}\n`).join("");
  await mkdir(path.dirname(directory), { recursive: true });
  try { await mkdir(directory); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Output directory already exists; choose a new directory");
    throw error;
  }
  try {
    // Write the exact verified bytes; do not reopen mutable source paths to copy them.
    for (const [file, bytes] of files) await writeFile(file, bytes, { flag: "wx" });
    await writeFile(result.checksumFile, checksums, { flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return result;
}

export async function readUpdateNotes(file) { return decodeText(await readRegularFile(file, "Notes"), "notes"); }

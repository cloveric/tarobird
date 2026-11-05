import "reflect-metadata";
import { randomBytes, webcrypto, X509Certificate, createPrivateKey } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { BasicConstraintsExtension, ExtendedKeyUsageExtension, KeyUsagesExtension, KeyUsageFlags, SubjectAlternativeNameExtension, X509CertificateGenerator } from "@peculiar/x509";
import { z } from "zod";
import { isTailscaleAddress } from "./network.js";

const crypto = webcrypto as unknown as Crypto;
const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const authoritySchema = z.object({ certificate: z.string(), privateKey: z.string() }).strict();
const pem = (type: string, bytes: ArrayBuffer) => `-----BEGIN ${type}-----\n${Buffer.from(bytes).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${type}-----\n`;
export function desktopLanAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flat().filter((v) => v && !v.internal && v.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v.address)).map((v) => v!.address))].slice(0, 4);
}
export function desktopTailscaleAddresses(interfaces = networkInterfaces()): string[] {
  // CGNAT IPv4 alone can belong to an ISP or another VPN. macOS uses utun names,
  // so recognize its Tailscale interface by the accompanying private IPv6 prefix.
  const candidates = Object.entries(interfaces).filter(([name, addresses]) => /tailscale/i.test(name) || addresses?.some(v => !v.internal && v.family === "IPv6" && isTailscaleAddress(v.address))).flatMap(([, addresses]) => addresses ?? []);
  return [...new Set(candidates.filter(v => !v.internal && isTailscaleAddress(v.address)).map(v => v.address))]
    .sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")) || a.localeCompare(b)).slice(0, 4);
}
/** Private CA stays in the host directory. Only its public DER is shared by QR;
 * clients trust it for this route and still verify the signed Hub identity. */
export async function desktopTls(directory: string, addresses: string[]) {
  const root = path.join(directory, "desktop-tls"); await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "authority.json");
  let authority = await readFile(file, "utf8").then((v) => authoritySchema.parse(JSON.parse(v)), (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
  const now = Date.now();
  if (!authority) {
    const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
    const certificate = await X509CertificateGenerator.createSelfSigned({ name: "CN=TaroBot private host CA", serialNumber: randomBytes(16).toString("hex"), notBefore: new Date(now - 300_000), notAfter: new Date(now + 10 * 365 * 86400_000), keys, signingAlgorithm: algorithm, extensions: [new BasicConstraintsExtension(true, 0, true), new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true)] }, crypto);
    authority = { certificate: certificate.toString("pem"), privateKey: Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64") };
    await writeFile(file, JSON.stringify(authority), { mode: 0o600, flag: "wx" });
  }
  const cert = path.join(root, "server.pem"), key = path.join(root, "server-key.pem");
  const certificateAuthority = new X509Certificate(authority.certificate).raw.toString("base64");
  try {
    const existing = new X509Certificate(await readFile(cert));
    if (Date.parse(existing.validTo) > now + 7 * 86400_000 && addresses.every((ip) => existing.checkIP(ip) === ip)
      && existing.verify(new X509Certificate(authority.certificate).publicKey)
      && existing.checkPrivateKey(createPrivateKey(await readFile(key)))) {
      return { cert, key, certificateAuthority, renewed: false };
    }
  } catch { /* Missing, expired or mismatched leaves are renewed under the host mutex. */ }
  const signingKey = await crypto.subtle.importKey("pkcs8", Uint8Array.from(Buffer.from(authority.privateKey, "base64")), algorithm, false, ["sign"]);
  const keys = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
  const certificate = await X509CertificateGenerator.create({ subject: "CN=TaroBot host", issuer: "CN=TaroBot private host CA", publicKey: keys.publicKey, signingKey, signingAlgorithm: algorithm, serialNumber: randomBytes(16).toString("hex"), notBefore: new Date(now - 300_000), notAfter: new Date(now + 90 * 86400_000), extensions: [new BasicConstraintsExtension(false, undefined, true), new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]), new SubjectAlternativeNameExtension([...new Set(addresses)].map((value) => ({ type: "ip" as const, value })))] }, crypto);
  await writeFile(cert, certificate.toString("pem") + "\n" + authority.certificate, { mode: 0o600 });
  await writeFile(key, pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)), { mode: 0o600 });
  return { cert, key, certificateAuthority, renewed: true };
}

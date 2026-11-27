import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { createServer, request as httpsRequest } from "node:https";
import { connect as tcpConnect, createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desktopTls } from "../src/hub/desktop-tls.js";
import {
  connectionDiagnosticCode,
  connectionErrorMessage,
  connectionVerificationFailure,
  connectionVerificationLabel,
  connectionVerificationMessage,
  preferredVerificationDiagnostic,
  preferredVerificationFailure,
} from "../client/src/connection-verification.js";
import { connectionTiming } from "../client/src/connection-timing.js";
import { setLocale } from "../client/src/i18n.js";

const prevDocument = (globalThis as { document?: unknown }).document;
let tempRoot: string;
beforeAll(async () => {
  if (!prevDocument) (globalThis as { document?: unknown }).document = { documentElement: { lang: "zh-CN" } };
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tarobird-ios-tls-"));
});
afterAll(async () => {
  setLocale("zh");
  if (!prevDocument) delete (globalThis as { document?: unknown }).document;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("desktopTls X.509 iOS strictness & IP/DNS SAN support (#98)", () => {
  it("emits SKI/AKI extensions and supports both IP and DNS SAN entries over a transparent TCP forwarder", async () => {
    const dir = path.join(tempRoot, "mixed-san");
    const first = await desktopTls(dir, ["127.0.0.1", "hub.example.test"]);
    expect(first.renewed).toBe(true);

    const certPem = await readFile(first.cert, "utf8");
    const keyPem = await readFile(first.key, "utf8");
    const pemBlocks = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    expect(pemBlocks.length).toBe(2);

    const leaf = new X509Certificate(pemBlocks[0]!);
    const ca = new X509Certificate(pemBlocks[1]!);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(leaf.checkHost("hub.example.test")).toBe("hub.example.test");
    expect(leaf.keyUsage).toContain(["1", "3", "6", "1", "5", "5", "7", "3", "1"].join("."));
    expect(leaf.ca).toBe(false);
    expect(ca.ca).toBe(true);
    // Standard RFC 5280 / Apple iOS SKI and AKI extension OIDs present in DER
    const leafHex = leaf.raw.toString("hex");
    const caHex = ca.raw.toString("hex");
    expect(caHex).toContain("551d0e"); // SubjectKeyIdentifier on CA
    expect(leafHex).toContain("551d0e"); // SubjectKeyIdentifier on leaf
    expect(leafHex).toContain("551d23"); // AuthorityKeyIdentifier on leaf

    // Calling desktopTls again with the same IP + DNS list reuses the valid cert without renewing
    const second = await desktopTls(dir, ["127.0.0.1", "hub.example.test"]);
    expect(second.renewed).toBe(false);

    // Adding a new DNS SAN triggers clean renewal under the same CA
    const third = await desktopTls(dir, ["127.0.0.1", "hub.example.test", "relay.example.test"]);
    expect(third.renewed).toBe(true);
    expect(third.certificateAuthority).toBe(first.certificateAuthority);
    const renewedLeaf = new X509Certificate(await readFile(third.cert));
    expect(renewedLeaf.checkHost("relay.example.test")).toBe("relay.example.test");

    // Verify TLS passthrough via transparent TCP forwarder (matching issue #98 setup)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const leafSha = createHash("sha256").update(renewedLeaf.raw).digest("hex");
    const server = createServer({ cert: await readFile(third.cert), key: await readFile(third.key) }, (req, res) => {
      const u = new URL(req.url ?? "/", "https://hub.example.test");
      const nonce = u.searchParams.get("nonce") ?? "";
      const sig = sign(null, Buffer.from(JSON.stringify(["tarocub/tls-identity/v1", pubB64, nonce, leafSha])), privateKey).toString("base64");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, type: "tls.identity", publicKey: pubB64, nonce, certificateSha256: leafSha, signature: sig }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tlsPort = (server.address() as { port: number }).port;

    const forwarder = createTcpServer((client) => {
      const upstream = tcpConnect(tlsPort, "127.0.0.1");
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    await new Promise<void>((resolve) => forwarder.listen(0, "127.0.0.1", resolve));
    const fwdPort = (forwarder.address() as { port: number }).port;

    try {
      const res = await new Promise<{ status: number; sha: string }>((resolve, reject) => {
        const req = httpsRequest({
          hostname: "127.0.0.1",
          port: fwdPort,
          servername: "hub.example.test",
          ca: ca.toString(),
          rejectUnauthorized: true,
          agent: false,
          path: "/api/tls-identity?nonce=testnonce123",
        }, (response) => {
          const sha = createHash("sha256").update((response.socket as TLSSocket).getPeerCertificate().raw).digest("hex");
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode ?? 0, sha }));
        });
        req.on("error", reject);
        req.end();
      });
      expect(res.status).toBe(200);
      expect(res.sha).toBe(leafSha);
    } finally {
      forwarder.close();
      server.close();
    }
  });
});

describe("iOS pairing TLS & transport failure diagnostics (#98)", () => {
  it("classifies the specific native TLS causes distinctly instead of collapsing into a generic error", () => {
    expect(connectionVerificationFailure(new Error("native_tls_hostname_mismatch"))).toBe("hostname-mismatch");
    expect(connectionVerificationFailure(new Error("native_tls_cert_expired"))).toBe("certificate-expired");
    expect(connectionVerificationFailure(new Error("native_tls_cert_policy_rejected"))).toBe("certificate-policy");
    expect(connectionVerificationFailure(new Error("native_ats_blocked"))).toBe("certificate-policy");
    expect(connectionVerificationFailure(new Error("native_tls_handshake_failed"))).toBe("tls-handshake");
    expect(connectionVerificationFailure(new Error("native_tls_identity_unavailable"))).toBe("verification-unavailable");
    // Untrusted certificates and timeouts stay with the route diagnostics (tls-untrusted / timeout).
    expect(connectionVerificationFailure(new Error("native_tls_untrusted"))).toBeUndefined();
    expect(connectionVerificationFailure(new Error("native_request_timeout"))).toBeUndefined();
    expect(connectionVerificationFailure(new DOMException("aborted", "AbortError"))).toBeUndefined();

    // Priority keeps identity causes first, then the specific certificate causes
    expect(preferredVerificationFailure([undefined, "hostname-mismatch"])).toBe("hostname-mismatch");
    expect(preferredVerificationFailure(["verification-unavailable", "certificate-expired"])).toBe("certificate-expired");
    expect(preferredVerificationFailure(["tls-handshake", "identity-mismatch"])).toBe("identity-mismatch");
    expect(preferredVerificationFailure(["identity-mismatch", "invalid-key"])).toBe("invalid-key");
  });

  it("extracts only whitelisted safe diagnostic codes and never leaks raw snake_case codes into user messages", () => {
    const codes = [
      "native_tls_hostname_mismatch",
      "native_tls_cert_expired",
      "native_tls_cert_policy_rejected",
      "native_ats_blocked",
      "native_tls_untrusted",
      "native_tls_handshake_failed",
      "native_request_timeout",
      "native_dns_failed",
      "native_host_unreachable",
      "native_connection_refused",
      "native_connection_reset",
      "native_network_offline",
      "local_network_permission_denied",
      "native_transport_failed",
      "tls_identity_mismatch",
    ];
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      for (const code of codes) {
        expect(connectionDiagnosticCode(new Error(code))).toBe(code);
        const failure = connectionVerificationFailure(new Error(code));
        if (failure) {
          const msg = connectionVerificationMessage(failure)!;
          const label = connectionVerificationLabel(failure)!;
          expect(msg.length).toBeGreaterThan(8);
          expect(label.length).toBeGreaterThan(2);
          expect(msg).not.toMatch(/[a-z]+_[a-z_]+/);
          expect(label).not.toMatch(/[a-z]+_[a-z_]+/);
        }
        const errMsg = connectionErrorMessage(new Error(code));
        expect(errMsg).not.toMatch(/[a-z]+_[a-z_]+/);
      }
    }
    expect(connectionDiagnosticCode(new DOMException("aborted", "AbortError"))).toBe("pairing_probe_timeout");
    expect(connectionDiagnosticCode(new Error("arbitrary user secret https://host.local"))).toBeUndefined();
  });

  it("keeps timeouts on auto-retry copy and gives unreachable hosts their own retry copy", () => {
    setLocale("zh");
    for (const code of ["native_socket_timeout", "native_request_timeout", "connection_handshake_timeout"]) {
      expect(connectionErrorMessage(new Error(code))).toBe("主机响应超时，正在自动重试。请确认主机仍在运行。");
    }
    for (const code of ["native_dns_failed", "native_host_unreachable", "native_connection_refused", "native_connection_reset"]) {
      expect(connectionErrorMessage(new Error(code))).toBe("暂时无法连接到主机地址，正在自动重试。请检查网络、代理或端口转发状态。");
    }

    setLocale("en");
    for (const code of ["native_socket_timeout", "native_request_timeout", "connection_handshake_timeout"]) {
      expect(connectionErrorMessage(new Error(code))).toBe("The host timed out. Retrying automatically; make sure the host is still running.");
    }
    expect(connectionErrorMessage(new Error("native_host_unreachable"))).toBe("Can't reach the host; retrying. Check network, proxy or port forwarding.");
    // Concrete TLS causes keep their own message in the paired context.
    expect(connectionErrorMessage(new Error("native_tls_hostname_mismatch"))).toBe("The host certificate doesn't cover this address. Update it and retry.");
    setLocale("zh");
  });

  it("aligns multi-route pairing diagnostic codes with the preferred failure route", () => {
    expect(preferredVerificationDiagnostic([
      new Error("native_host_unreachable"),
      new Error("native_tls_hostname_mismatch"),
    ])).toEqual({ failure: "hostname-mismatch", code: "native_tls_hostname_mismatch" });

    expect(preferredVerificationDiagnostic([
      new DOMException("timed out", "TimeoutError"),
      new Error("tls_identity_mismatch"),
    ])).toEqual({ failure: "identity-mismatch", code: "tls_identity_mismatch" });

    expect(preferredVerificationDiagnostic([
      new Error("native_host_unreachable"),
      new Error("native_dns_failed"),
    ])).toEqual({ failure: undefined, code: "native_host_unreachable" });

    expect(preferredVerificationDiagnostic([
      new Error("unclassified_error"),
      new Error("native_dns_failed"),
    ])).toEqual({ failure: undefined, code: "native_dns_failed" });
  });

  it("gives native pinned reconnect probes a budget above HubTLS's 12 s identity deadline", () => {
    const nativeTiming = connectionTiming({ name: "VPS", url: "https://relay.example.test" }, true);
    expect(nativeTiming.probeMs).toBeGreaterThan(12_000);
    expect(nativeTiming.handshakeMs).toBe(7000);

    const webRemoteTiming = connectionTiming({ name: "VPS", url: "https://relay.example.test" }, false);
    expect(webRemoteTiming.probeMs).toBe(6000);

    const webLocalTiming = connectionTiming({ name: "Direct", url: "http://127.0.0.1:8788" }, false);
    expect(webLocalTiming.probeMs).toBe(650);
  });
});

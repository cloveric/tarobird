import { describe, expect, it } from "vitest";
import { browserPairingLink, inspectBrowserPairingHash, isBrowserTrustedRoute, parseBrowserPairingHash } from "../src/web-browser.js";
import { MAX_PAIRING_LINK_LENGTH } from "../src/pairing-link.js";

const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 7)]).toString("base64");
const invite = "a".repeat(43);

describe("Official web browser client pairing & route trust (#120)", () => {
  it("builds a fragment-only browser pairing URL and round-trips through parseBrowserPairingHash for matching origin", () => {
    const payload = {
      v: 1 as const,
      kind: "connect" as const,
      hubPublicKey: spki,
      routes: [{ name: "VPS" as const, url: "https://hub.example.com" }],
      invite,
    };
    const link = browserPairingLink("https://hub.example.com", payload);
    const url = new URL(link);
    // Security invariant: invite and pairing data stay strictly in the fragment, never query params.
    expect(url.origin).toBe("https://hub.example.com");
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash.startsWith("#pair=")).toBe(true);
    expect(url.hash).toContain(`invite=${invite}`);

    expect(parseBrowserPairingHash(url.hash, "https://hub.example.com")).toEqual(payload);
    expect(inspectBrowserPairingHash(url.hash, "https://hub.example.com")).toEqual({ kind: "valid", payload });
  });

  it("rejects cross-origin #pair= fragments whose routes do not include expectedOrigin", () => {
    const attackerPayload = {
      v: 1 as const,
      kind: "connect" as const,
      hubPublicKey: spki,
      routes: [{ name: "VPS" as const, url: "https://attacker.example.invalid" }],
      invite,
    };
    const link = browserPairingLink("https://attacker.example.invalid", attackerPayload);
    const hash = new URL(link).hash;

    expect(parseBrowserPairingHash(hash, "https://alice-hub.example.com")).toBeUndefined();
    expect(inspectBrowserPairingHash(hash, "https://alice-hub.example.com")).toEqual({ kind: "origin_mismatch" });
    // Also fails closed when expectedOrigin is missing or non-HTTP(S).
    expect(parseBrowserPairingHash(hash, "")).toBeUndefined();
    expect(parseBrowserPairingHash(hash, "javascript:alert(1)")).toBeUndefined();
  });

  it("distinguishes absent hashes from malformed or oversized pairing fragments", () => {
    expect(inspectBrowserPairingHash("", "https://hub.example.com")).toEqual({ kind: "none" });
    expect(inspectBrowserPairingHash("#unrelated=1", "https://hub.example.com")).toEqual({ kind: "none" });
    expect(inspectBrowserPairingHash("#conversation=conv_1", "https://hub.example.com")).toEqual({ kind: "none" });

    expect(inspectBrowserPairingHash("#pair=%7B%7D", "https://hub.example.com")).toEqual({ kind: "invalid" });
    expect(inspectBrowserPairingHash(`#invite=${invite}`, "https://hub.example.com")).toEqual({ kind: "invalid" });
    expect(inspectBrowserPairingHash(`#pair=not-json&invite=${invite}`, "https://hub.example.com")).toEqual({ kind: "invalid" });
    expect(inspectBrowserPairingHash(`#pair=${"x".repeat(MAX_PAIRING_LINK_LENGTH)}&invite=${invite}`, "https://hub.example.com")).toEqual({ kind: "invalid" });

    expect(parseBrowserPairingHash("", "https://hub.example.com")).toBeUndefined();
    expect(parseBrowserPairingHash("#unrelated=1", "https://hub.example.com")).toBeUndefined();
    expect(parseBrowserPairingHash("#pair=%7B%7D", "https://hub.example.com")).toBeUndefined();
    expect(parseBrowserPairingHash(`#pair=not-json&invite=${invite}`, "https://hub.example.com")).toBeUndefined();
  });

  it("returns over-length browser pairing links without throwing so PairingCode can render a length alert", () => {
    const routes = Array.from({ length: 8 }, (_, index) => ({
      name: "VPS" as const,
      url: `https://relay${index}.example.com`,
      label: `Relay ${index} ${"x".repeat(20)}`,
      certificateAuthority: "A".repeat(1200),
    }));
    const link = browserPairingLink("https://relay0.example.com", {
      v: 1,
      kind: "connect",
      hubPublicKey: spki,
      routes,
      invite,
    });
    expect(link.length).toBeGreaterThan(MAX_PAIRING_LINK_LENGTH);
    expect(link.startsWith("https://relay0.example.com/#pair=")).toBe(true);
  });

  it("distinguishes browser-trusted HTTPS/loopback routes from private, CGNAT, link-local, ULA, and loopback HTTPS routes", () => {
    // Public HTTPS domains & documented test public IP without private CA are browser-trusted.
    expect(isBrowserTrustedRoute({ url: "https://hub.example.com" })).toBe(true);
    expect(isBrowserTrustedRoute({ url: "https://relay.example.org:8443" })).toBe(true);
    expect(isBrowserTrustedRoute({ url: "https://203.0.113.10:8443" })).toBe(true);
    // Plain HTTP loopback is a browser Secure Context.
    expect(isBrowserTrustedRoute({ url: "http://127.0.0.1:8788" })).toBe(true);
    expect(isBrowserTrustedRoute({ url: "http://localhost:8788" })).toBe(true);
    expect(isBrowserTrustedRoute({ url: "http://[::1]:8788" })).toBe(true);

    // Private Host CA routes are never trusted by standard browsers.
    expect(isBrowserTrustedRoute({ url: "https://hub.example.com", certificateAuthority: "A".repeat(128) })).toBe(false);
    expect(isBrowserTrustedRoute({ url: "https://192.168.1.20:8788", certificateAuthority: "A".repeat(128) })).toBe(false);

    // Unpinned non-public HTTPS hosts (without certificateAuthority) cannot have public WebPKI trust.
    const cgnatHigh = ["100", "127", "255", "254"].join(".");
    const cgnatMid = ["100", "101", "102", "103"].join(".");
    const nonPublicHttps = [
      // Loopback
      "https://127.0.0.1:8788",
      "https://127.0.1.1:8788",
      "https://localhost:8788",
      "https://sub.localhost:8788",
      "https://[::1]:8788",
      // Unspecified
      "https://0.0.0.0:8788",
      "https://[::]:8788",
      // RFC 1918 private IPv4
      "https://10.0.0.5:8788",
      "https://172.16.0.1:8788",
      "https://172.31.255.254:8788",
      "https://192.168.1.20:8788",
      // Link-local IPv4 & IPv6
      "https://169.254.1.10:8788",
      "https://[fe80::1]:8788",
      "https://[febf::1]:8788",
      // IPv6 ULA (fc00::/7, including Tailscale fd7a:115c:a1e0::/48)
      "https://[fc00::1]:8788",
      "https://[fd7a:115c:a1e0::1]:8788",
      // Tailscale / RFC 6598 CGNAT
      "https://100.64.0.1:8788",
      `https://${cgnatMid}:8788`,
      `https://${cgnatHigh}:8788`,
      // IPv4-mapped IPv6 literals for private / loopback / CGNAT
      "https://[::ffff:192.168.1.20]:8788",
      "https://[::ffff:127.0.0.1]:8788",
      "https://[::ffff:100.64.0.1]:8788",
    ];
    for (const url of nonPublicHttps) {
      expect(isBrowserTrustedRoute({ url }), `expected ${url} to be untrusted`).toBe(false);
    }

    // Non-loopback plain HTTP is never trusted.
    expect(isBrowserTrustedRoute({ url: "http://192.168.1.20:8788" })).toBe(false);
    expect(isBrowserTrustedRoute({ url: "http://0.0.0.0:8788" })).toBe(false);
  });
});

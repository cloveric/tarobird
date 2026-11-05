import { isIP } from "node:net";

// Origins identify the bundled WebViews, not authentication. Every protected
// endpoint still requires a device signature or short-lived session token.
export const NATIVE_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "capacitor://localhost", "https://localhost"];

export function isLoopback(host: string): boolean { return host === "::1" || host === "::ffff:127.0.0.1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host); }
export type ListenerExposure = "private" | "public";
export function isTailscaleAddress(host: string): boolean {
  const family = isIP(host), octets = host.split(".").map(Number);
  return (family === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) || (family === 6 && /^fd7a:115c:a1e0:/i.test(host));
}
export function assertSafeBind(host: string, tls: boolean, exposure: ListenerExposure = "private"): void {
  if (!isIP(host)) throw new Error("Hub bind address must be an explicit IP address");
  // Public listening is opt-in per listener. It never enables the instance API.
  if (exposure === "public") {
    if (!tls) throw new Error("Public Hub listeners require TLS; plaintext public access is forbidden");
    return;
  }
  if (isLoopback(host)) return;
  if (!isTailscaleAddress(host) || !tls) throw new Error("Private Hub listeners require loopback or TLS on a Tailscale address; public HTTPS requires explicit exposure: public");
}

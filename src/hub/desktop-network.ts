import net from "node:net";
import https from "node:https";
import { randomInt, X509Certificate } from "node:crypto";
import { isLoopback } from "./network.js";

/** Bind failures meaning that one address is not usable right now. The Host
 * tolerates the same failures on an optional listener and retries it later;
 * `EADDRINUSE` is different and selects another candidate port below. */
const ADDRESS_UNAVAILABLE = new Set(["EADDRNOTAVAIL", "ENODEV", "ENETUNREACH", "EAFNOSUPPORT"]);
export async function freeDesktopPort(addresses = ["127.0.0.1"]): Promise<number> {
  const randomCandidate = addresses.some(address => !isLoopback(address));
  // A port free on loopback may be occupied on Wi-Fi or a VPN. Hold every
  // probe until the same candidate has been checked on all intended addresses.
  for (let attempt = 0; attempt < 16; attempt++) {
    const sockets: net.Server[] = [];
    try {
      // A port selected by listen(0) on a LAN interface can immediately be
      // reused by another app's outgoing connection before the child Host
      // binds it. Choose a candidate below the usual ephemeral ranges, then
      // still check every intended interface. Saved ports are never changed.
      let port = randomCandidate ? randomInt(20_000, 32_768) : 0;
      // An interface can disappear between discovery and this probe. Skip only
      // that address: its listener stays optional and is reported ready only by
      // its own health check. The port must still be held on a real address.
      let unavailable: unknown;
      for (const address of addresses) {
        const socket = net.createServer(); sockets.push(socket);
        try { await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(port, address, resolve); }); }
        catch (error) {
          if (!ADDRESS_UNAVAILABLE.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
          unavailable ??= error; continue;
        }
        port = (socket.address() as net.AddressInfo).port;
      }
      if (unavailable && !sockets.some(socket => socket.listening)) throw unavailable;
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows excluded port ranges reject explicit candidates with EACCES.
      if (!(code === "EADDRINUSE" || (randomCandidate && code === "EACCES")) || attempt === 15) throw error;
    } finally {
      await Promise.all(sockets.filter(socket => socket.listening).map(socket => new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))));
    }
  }
  throw new Error("desktop_host_no_free_network_port");
}
export async function verifyNetworkRoute(url: string, certificateAuthority: string, publicKey: string): Promise<void> {
  const ca = new X509Certificate(Buffer.from(certificateAuthority, "base64")).toString();
  await new Promise<void>((resolve, reject) => {
    const request = https.get(url + "/health", { ca, agent: false, signal: AbortSignal.timeout(3000) }, response => {
      let body = "";
      response.on("error", reject);
      response.on("data", chunk => { body += chunk; if (body.length > 16384) request.destroy(new Error("desktop_host_invalid_health")); });
      response.on("end", () => {
        try {
          const health = JSON.parse(body);
          if (response.statusCode !== 200 || health.ok !== true || health.publicKey !== publicKey) throw new Error("desktop_host_invalid_health");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
  });
}

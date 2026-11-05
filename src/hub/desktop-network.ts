import net from "node:net";
import https from "node:https";
import { randomInt, X509Certificate } from "node:crypto";
import { isLoopback } from "./network.js";

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
      for (const address of addresses) {
        const socket = net.createServer(); sockets.push(socket);
        await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(port, address, resolve); });
        port = (socket.address() as net.AddressInfo).port;
      }
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

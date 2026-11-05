import net from "node:net";
import { createServer, request as forward } from "node:http";

/** A real network boundary also covers WebKit service-worker-owned requests. */
export async function downloadProxy(target: string, allowFile: (range: string) => Promise<boolean>) {
  const sockets = new Set<net.Socket>();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/attachments/")) {
      if (!await allowFile(request.headers.range ?? "")) { response.destroy(); return; }
    }
    if (response.destroyed) return;
    const upstream = forward(new URL(request.url!, target), { method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode!, result.headers); result.pipe(response); result.on("error", () => response.destroy());
    });
    upstream.on("error", () => response.destroy()); request.on("aborted", () => upstream.destroy());
    response.on("close", () => { if (!response.writableEnded) upstream.destroy(); }); request.pipe(upstream);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, client, head) => {
    const remote = net.connect(Number(new URL(target).port), "127.0.0.1"); sockets.add(remote);
    client.on("error", () => remote.destroy()); remote.on("error", () => client.destroy());
    client.on("close", () => remote.destroy()); remote.on("close", () => { sockets.delete(remote); client.destroy(); });
    remote.on("connect", () => {
      const headers = request.rawHeaders.reduce((text, value, i) => text + value + (i % 2 ? "\r\n" : ": "), "");
      remote.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`);
      if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: async () => {
    for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

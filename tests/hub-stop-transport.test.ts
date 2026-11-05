import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { controlPath, hubServiceCommand } from "../src/hub/service.js";

it.each(["status", "stop"])("requires a stop acknowledgment and retries only a lost %s response after it", async lost => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stop-race-"));
  await writeFile(path.join(root, "hub-control.key"), "a".repeat(64), { mode: 0o600 });
  const status = { running: true, pid: 2147483647, publicKey: "fixture", url: "http://127.0.0.1:8788" };
  let stopping = false, droppedResponse = false;
  let closing: Promise<void> | undefined;
  const server = net.createServer(socket => {
    socket.on("error", () => undefined);
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString(); if (!data.includes("\n")) return;
      const { command } = JSON.parse(data.trim());
      if (command === lost && (stopping || lost === "stop")) {
        // The real shutdown closes connected control sockets as it retires
        // the listener. This status request must not masquerade as stop failure.
        droppedResponse = true; socket.destroy();
        closing = new Promise(resolve => server.close(() => resolve()));
      } else {
        if (command === "stop") stopping = true;
        socket.end(JSON.stringify(status) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(controlPath(root), resolve); });
  try {
    const result = hubServiceCommand("stop", root, path.join(root, "unused.js"));
    if (lost === "status") await expect(result).resolves.toEqual({ running: false });
    else await expect(result).rejects.toThrow("hub_control_closed");
    expect(droppedResponse).toBe(true);
  } finally {
    if (closing) await closing;
    else await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

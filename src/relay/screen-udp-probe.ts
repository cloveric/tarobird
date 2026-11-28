import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { decodeStun, decodeStunAddress, encodeStun, STUN } from "./screen-stun.js";

/** Validates a correlated reply on a connected UDP socket. Reachability
 * alone says nothing about screen grants, allocations or media flow. */
export async function probeScreenUdp(address: string, port: number): Promise<boolean> {
  const socket = createSocket("udp4");
  const tx = randomBytes(12);
  return new Promise(resolve => {
    let finished = false;
    const finish = (ok: boolean) => { if (finished) return; finished = true; clearTimeout(timer); socket.close(); resolve(ok); };
    const timer = setTimeout(() => finish(false), 3000);
    socket.once("error", () => finish(false));
    socket.on("message", packet => {
      const response = decodeStun(packet);
      if (response?.type === 0x0101 && response.transaction.equals(tx) && decodeStunAddress(response.attributes.get(STUN.mapped))) finish(true);
    });
    socket.connect(port, address, () => { if (!finished) socket.send(encodeStun(STUN.binding, tx, []), error => { if (error) finish(false); }); });
  });
}

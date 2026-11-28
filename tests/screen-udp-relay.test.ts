import { createHash, randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { afterEach, expect, test } from "vitest";
import { createScreenRelayGrant, ScreenUdpRelay } from "../src/relay/screen-udp.js";
import { decodeStun, encodeStun, encodeStunAddress, STUN } from "../src/relay/screen-stun.js";

let relay: ScreenUdpRelay | undefined;
const clients: Socket[] = [];
afterEach(() => { relay?.close(); for (const client of clients.splice(0)) client.close(); });

function client() {
  const socket = createSocket("udp4");
  clients.push(socket);
  return socket;
}

async function receive(socket: Socket, send: () => void, timeout = 400): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const done = (packet?: Buffer) => { clearTimeout(timer); socket.off("message", done); resolve(packet); };
    const timer = setTimeout(done, timeout);
    socket.once("message", done);
    send();
  });
}

test("admits only the authorised allocation pair on one real UDP port", async () => {
  relay = await ScreenUdpRelay.listen("127.0.0.1", 0, "127.0.0.1");
  const port = relay.port;
  const grant = relay.authorize("fixture-host", createScreenRelayGrant());
  const [sender, viewer, outsider] = [client(), client(), client()];
  const send = (socket: Socket, packet: Buffer) => socket.send(packet, port, "127.0.0.1");
  async function allocate(socket: Socket, user: typeof grant.sender, password = user.credential) {
    const transport = [STUN.transport, Buffer.from([17, 0, 0, 0])] as const;
    const probe = decodeStun((await receive(socket, () => send(socket, encodeStun(STUN.allocate, randomBytes(12), [transport]))))!)!;
    expect(probe.type).toBe(0x0113);
    const realm = probe.attributes.get(STUN.realm)!;
    const key = createHash("md5").update(`${user.username}:${realm}:${password}`).digest();
    const attrs = [[STUN.username, Buffer.from(user.username)], [STUN.realm, realm], [STUN.nonce, probe.attributes.get(STUN.nonce)!], transport] as const;
    const reply = decodeStun((await receive(socket, () => send(socket, encodeStun(STUN.allocate, randomBytes(12), attrs, key))))!)!;
    if (reply.type === 0x0103) {
      const addr = encodeStunAddress({address: "127.0.0.1", port});
      const permission = decodeStun((await receive(socket, () => send(socket, encodeStun(STUN.permission, randomBytes(12), [...attrs.slice(0, 3), [STUN.peer, addr]], key))))!)!;
      expect(permission.type).toBe(0x0108);
    }
    return reply;
  }
  expect((await allocate(outsider, grant.sender, "invalid")).type).toBe(0x0113);
  expect((await allocate(sender, grant.sender)).type).toBe(0x0103);
  expect((await allocate(viewer, grant.viewer)).type).toBe(0x0103);
  const address = encodeStunAddress({ address: "127.0.0.1", port });
  const payload = Buffer.from("opaque payload");
  const indicate = () => encodeStun(STUN.send, randomBytes(12), [[STUN.peer, address], [STUN.data, payload]]);
  expect(await receive(viewer, () => send(outsider, indicate()), 100)).toBeUndefined();
  const forwarded = decodeStun((await receive(viewer, () => send(sender, indicate())))!);
  expect(forwarded?.type).toBe(STUN.dataIndication);
  expect(forwarded?.attributes.get(STUN.data)).toEqual(payload);
  expect(relay.usage("fixture-host")?.bytesForwarded).toBe(payload.length);
  relay.revoke("fixture-host", grant.id);
  expect(await receive(viewer, () => send(sender, indicate()), 100)).toBeUndefined();
});

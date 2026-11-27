import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NativeAppPipe } from "./native-app-pipe.js";
import {
  OMP_BRIDGE_ENDPOINT_ENV, OMP_BRIDGE_PROTOCOL, OMP_BRIDGE_TOKEN_ENV, type OmpBridgeToolOrigin,
} from "./omp-bridge-extension.js";

export { OMP_BRIDGE_ENDPOINT_ENV, OMP_BRIDGE_TOKEN_ENV, type OmpBridgeToolOrigin } from "./omp-bridge-extension.js";

export interface OmpBridgeApproveRequest {
  toolName: string;
  toolCallId: string;
  origin: OmpBridgeToolOrigin;
  input: unknown;
  inputTruncated?: boolean;
}

export interface OmpBridgeHandler {
  approve(input: OmpBridgeApproveRequest, signal: AbortSignal): Promise<{ allow: boolean; reason?: string }>;
}

export interface OmpBridgeConnection {
  setPolicy(gate: boolean, hostTools?: string[]): Promise<void>;
  readonly closed: Promise<void>;
  readonly isOpen: boolean;
  close(): void;
}

export interface OmpBridgeEndpoint {
  env: Record<string, string>;
  connection: Promise<OmpBridgeConnection>;
  dispose(): void;
}

export function resolveOmpBridgeExtensionPath(): string {
  const compiled = fileURLToPath(new URL("./omp-bridge-extension.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = fileURLToPath(new URL("./omp-bridge-extension.ts", import.meta.url));
  return existsSync(source) ? source : compiled;
}

const OMP_BRIDGE_UNIX_PATH_LIMIT = 100;
const HELLO_MAX_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const helloSchema = z.object({
  v: z.literal(1),
  type: z.literal("request"),
  id: z.string().uuid(),
  method: z.literal("hello"),
  payload: z.object({ token: z.string().min(1).max(256), protocol: z.literal(OMP_BRIDGE_PROTOCOL) }).strict(),
}).strict();

const originSchema = z.enum(["builtin", "other"]);

const approveSchema = z.object({
  toolName: z.string().max(256),
  toolCallId: z.string().max(512),
  origin: originSchema,
  input: z.unknown(),
  inputTruncated: z.literal(true).optional(),
}).strict();

function ownedDirectory(directory: string): boolean {
  try {
    const info = lstatSync(directory);
    return info.isDirectory() && !info.isSymbolicLink() && (typeof process.getuid !== "function" || info.uid === process.getuid());
  } catch { return false; }
}

function ensureOwnedDirectory(directory: string): void {
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!ownedDirectory(directory)) throw new Error("omp bridge directory is not a private directory");
}

function createUnixEndpoint(stateDir: string, tmpDir: string): { directory: string; endpoint: string } {
  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomBytes(16).toString("hex");
    const directory = path.join(stateDir, "omp", "bridge", id.slice(0, 8));
    const endpoint = path.join(directory, "s");
    if (Buffer.byteLength(endpoint) > OMP_BRIDGE_UNIX_PATH_LIMIT) break;
    if (!statSync(stateDir).isDirectory()) throw new Error("omp bridge state directory is missing");
    ensureOwnedDirectory(path.join(stateDir, "omp"));
    ensureOwnedDirectory(path.join(stateDir, "omp", "bridge"));
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    if (!ownedDirectory(directory)) throw new Error("omp bridge directory is not a private directory");
    return { directory, endpoint };
  }
  const directory = mkdtempSync(path.join(tmpDir, "tb-omp-"));
  const endpoint = path.join(directory, "s");
  if (!ownedDirectory(directory) || Buffer.byteLength(endpoint) > OMP_BRIDGE_UNIX_PATH_LIMIT) {
    try { rmdirSync(directory); } catch { /* ignore */ }
    throw new Error("No directory short enough for the omp bridge socket");
  }
  return { directory, endpoint };
}

function createConnection(socket: Socket, handler: OmpBridgeHandler): OmpBridgeConnection {
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const serve = async (method: string, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    if (method !== "approve") return null;
    const req = approveSchema.safeParse(payload);
    if (!req.success) return { allow: false, reason: "The approval request was malformed, so the tool was not run." };
    try {
      const decision = await handler.approve(req.data, signal);
      return decision?.allow === true
        ? { allow: true }
        : { allow: false, ...(typeof decision?.reason === "string" && decision.reason ? { reason: decision.reason.slice(0, 2000) } : {}) };
    } catch {
      return { allow: false, reason: "TaroBird could not decide this approval, so the tool was not run." };
    }
  };
  const pipe = new NativeAppPipe(socket, socket, serve, () => resolveClosed());
  return {
    closed,
    get isOpen() { return pipe.available; },
    close: () => pipe.close(),
    async setPolicy(gate, hostTools) {
      const result = await pipe.request("policy", { gate, ...(hostTools ? { hostTools } : {}) }, undefined, REQUEST_TIMEOUT_MS);
      z.object({ gate: z.literal(gate) }).strict().parse(result);
    },
  };
}

export async function openOmpBridgeEndpoint(input: {
  stateDir: string;
  handler: OmpBridgeHandler;
  handshakeTimeoutMs?: number;
  platform?: NodeJS.Platform;
  initial?: { gate?: boolean; hostTools?: string[] };
  tmpDir?: string;
}): Promise<OmpBridgeEndpoint> {
  const platform = input.platform ?? process.platform;
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token, "utf8");
  const place = platform === "win32"
    ? { directory: undefined, endpoint: `\\\\.\\pipe\\tarobird-omp-${randomBytes(16).toString("hex")}` }
    : createUnixEndpoint(input.stateDir, input.tmpDir ?? os.tmpdir());

  let server: Server | undefined = createServer();
  let accepted: Socket | undefined;
  let connection: OmpBridgeConnection | undefined;
  let settled = false;
  let disposed = false;
  let resolveConnection!: (conn: OmpBridgeConnection) => void;
  let rejectConnection!: (err: Error) => void;
  const connectionPromise = new Promise<OmpBridgeConnection>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
  connectionPromise.catch(() => {});

  const removeFiles = () => {
    if (!place.directory) return;
    try { if (lstatSync(place.endpoint).isSocket()) unlinkSync(place.endpoint); } catch { /* ignore */ }
    try { if (ownedDirectory(place.directory)) rmdirSync(place.directory); } catch { /* ignore */ }
  };
  const closeListener = () => {
    const listener = server;
    server = undefined;
    if (listener) { try { listener.close(); } catch { /* ignore */ } }
    removeFiles();
  };
  const fail = (reason: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    closeListener();
    accepted?.destroy();
    rejectConnection(new Error(`omp bridge handshake failed: ${reason}`));
  };
  const timer = setTimeout(() => fail("timeout"), input.handshakeTimeoutMs ?? 15_000);
  timer.unref?.();

  const handshake = (socket: Socket) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(0x0a);
      if (end < 0) { if (received.length > HELLO_MAX_BYTES) fail("malformed"); return; }
      socket.off("data", onData);
      socket.pause();
      let hello: z.infer<typeof helloSchema>;
      try { hello = helloSchema.parse(JSON.parse(received.subarray(0, end).toString("utf8"))); }
      catch { fail("malformed"); return; }
      const given = Buffer.from(hello.payload.token, "utf8");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { fail("token"); return; }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", onClose);
      const rest = received.subarray(end + 1);
      if (rest.length) socket.unshift(rest);
      socket.write(`${JSON.stringify({
        v: 1,
        type: "response",
        id: hello.id,
        result: {
          protocol: OMP_BRIDGE_PROTOCOL,
          gate: input.initial?.gate !== false,
          hostTools: input.initial?.hostTools ?? [],
        },
      })}\n`);
      connection = createConnection(socket, input.handler);
      socket.resume();
      resolveConnection(connection);
    };
    const onClose = () => fail("closed");
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.on("error", () => {});
  };

  server.on("connection", socket => {
    if (accepted) {
      socket.destroy();
      if (!settled) fail("extra-connection");
      return;
    }
    accepted = socket;
    closeListener();
    if (settled) { socket.destroy(); return; }
    handshake(socket);
  });
  server.on("error", () => fail("closed"));

  try {
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(place.endpoint, () => { server?.off("error", reject); resolve(); });
    });
  } catch (error) {
    fail("closed");
    throw error;
  }

  return {
    env: { [OMP_BRIDGE_ENDPOINT_ENV]: place.endpoint, [OMP_BRIDGE_TOKEN_ENV]: token },
    connection: connectionPromise,
    dispose() {
      if (disposed) return;
      disposed = true;
      fail("disposed");
      closeListener();
      connection?.close();
      accepted?.destroy();
    },
  };
}

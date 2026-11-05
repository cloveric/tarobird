import { setTimeout as delay } from "node:timers/promises";
import { isPeerAllowed, loadBusConfig } from "./bus-config.js";
import { lookupInstance, resolveChannelRoot } from "./bus-registry.js";
import {
  BusProtocolError,
  createBusTalkRequestEnvelope,
  parseBusTalkResponse,
} from "./bus-protocol.js";
import { MAX_BODY_BYTES, type BusTalkResponse } from "./bus-server.js";
import { postBusTurn } from "./bus-http.js";

export interface BusDelegateInput {
  fromInstance: string;
  targetInstance: string;
  prompt: string;
  depth: number;
  stateDir: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Internal Hub workflow slot; never sent to the peer or accepted from prompts. */
  agentBusMemberIndex?: number;
}

// A delegated turn runs a full engine turn on the remote instance, which routinely
// exceeds 60s. The old 60s default silently aborted long /ask /chain /verify /board
// runs (and, being retryable, risked re-running them remotely). Default to 30min,
// overridable via CCTB_DELEGATION_TIMEOUT_MS for operators who want a tighter cap.
export const DEFAULT_DELEGATION_TIMEOUT_MS = 30 * 60_000;

export function resolveDefaultDelegationTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CCTB_DELEGATION_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_DELEGATION_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DELEGATION_TIMEOUT_MS;
}

export async function delegateToInstance(input: BusDelegateInput): Promise<BusTalkResponse> {
  const cancelled = () => new BusProtocolError({ message: `Delegation to "${input.targetInstance}" was cancelled`, code: "cancelled", retryable: false, fromInstance: input.targetInstance });
  if (input.abortSignal?.aborted) throw cancelled();
  const checkPermission = async () => {
    const busConfig = await loadBusConfig(input.stateDir);
    if (input.abortSignal?.aborted) throw cancelled();
    if (!busConfig) {
      throw new BusProtocolError({
        message: "Bus is not enabled on this instance",
        code: "bus_disabled",
        retryable: false,
      });
    }

    if (!isPeerAllowed(busConfig, input.targetInstance)) {
      throw new BusProtocolError({
        message: `Instance "${input.targetInstance}" is not in the peer list`,
        code: "peer_not_allowed",
        retryable: false,
      });
    }

    if (input.depth >= busConfig.maxDepth) {
      throw new BusProtocolError({
        message: `Max delegation depth (${busConfig.maxDepth}) exceeded`,
        code: "max_depth_exceeded",
        retryable: false,
      });
    }
  };
  await checkPermission();

  const body = JSON.stringify(createBusTalkRequestEnvelope({
    fromInstance: input.fromInstance,
    prompt: input.prompt,
    depth: input.depth + 1,
  }));

  // Reject oversized payloads locally (before the network round trip) so we don't
  // depend on the server's 413 flush racing a socket teardown — same non-retryable
  // semantics, no wasted connection.
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new BusProtocolError({
      message: `Delegation to "${input.targetInstance}" exceeds the ${MAX_BODY_BYTES}-byte request limit`,
      code: "request_too_large",
      retryable: false,
      fromInstance: input.targetInstance,
    });
  }

  const channelRoot = resolveChannelRoot(input.stateDir);
  // lookupInstance now probes the bus port, so a returned entry means the
  // server is actually reachable. A redundant PID check here would only
  // add false positives (PID alive but bus dead) — ECONNREFUSED from the
  // POST below gives us a more accurate error anyway.
  const target = await lookupInstance(channelRoot, input.targetInstance);
  if (input.abortSignal?.aborted) throw cancelled();
  if (!target) {
    throw new BusProtocolError({
      message: `Instance "${input.targetInstance}" is not running or not registered on the bus`,
      code: "instance_unavailable",
      retryable: true,
    });
  }

  const url = `http://127.0.0.1:${target.port}/api/talk`;
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? resolveDefaultDelegationTimeoutMs();
  let abortKind: "timeout" | "cancelled" | undefined;
  const abort = (kind: "timeout" | "cancelled") => {
    if (!controller.signal.aborted) { abortKind = kind; controller.abort(); }
  };
  const timeout = setTimeout(() => abort("timeout"), timeoutMs);
  const onAbort = () => abort("cancelled");
  if (input.abortSignal?.aborted) {
    onAbort();
  } else {
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.secret) {
    headers.Authorization = `Bearer ${target.secret}`;
  }

  try {
    for (let attempt = 0; ; attempt++) {
      const res = await postBusTurn(url, headers, body, controller.signal);

      let payload: unknown;
      try {
        payload = JSON.parse(res.body);
      } catch {
        throw new BusProtocolError({
          message: `Invalid bus response from "${input.targetInstance}"`,
          code: "invalid_response",
          retryable: false,
          fromInstance: input.targetInstance,
        });
      }

      const parsed = parseBusTalkResponse(payload);
      if (!parsed || parsed.success && (res.status < 200 || res.status >= 300)) {
        throw new BusProtocolError({
          message: `Invalid bus response from "${input.targetInstance}"`,
          code: "invalid_response",
          retryable: false,
          fromInstance: input.targetInstance,
        });
      }

      // Only the HTTP admission gate proves this turn has not executed. An
      // engine can return the same code in an HTTP 200 response; never resend it.
      if (!parsed.success && res.status === 503 && parsed.errorCode === "server_busy"
        && parsed.retryable === true && parsed.fromInstance === input.targetInstance
        && attempt < 3) {
        await delay(200 * 2 ** attempt, undefined, { signal: controller.signal });
        await checkPermission();
        controller.signal.throwIfAborted();
        continue;
      }
      if (!parsed.success) {
        throw new BusProtocolError({
          message: parsed.error ?? `Delegation to "${input.targetInstance}" failed`,
          code: parsed.errorCode ?? "unknown",
          retryable: parsed.retryable ?? false,
          fromInstance: parsed.fromInstance ?? input.targetInstance,
          protocolVersion: parsed.protocolVersion,
        });
      }

      return parsed;
    }
  } catch (error) {
    // Cancellation/deadline also cover response-body reads. Never turn a local
    // abort into an invalid-response or unavailable-service error.
    if (abortKind) {
      if (abortKind === "cancelled") throw cancelled();
      // Not retryable: the remote turn may still be running, so an automatic retry
      // would double-execute it. The operator can resend deliberately if needed.
      throw new BusProtocolError({
        message: `Delegation to "${input.targetInstance}" timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
        code: "timeout",
        retryable: false,
        fromInstance: input.targetInstance,
      });
    }
    if (error instanceof BusProtocolError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "BUS_RESPONSE_TOO_LARGE") throw new BusProtocolError({
      message: `Response from "${input.targetInstance}" exceeds the 16 MiB limit; the task was not resent`,
      code: "response_too_large", retryable: false, fromInstance: input.targetInstance,
    });
    // Only a refused connection proves the target never accepted this request.
    // A reset/malformed response may follow completed work: never auto-retry.
    if (code !== "ECONNREFUSED") throw new BusProtocolError({
      message: `Connection to "${input.targetInstance}" was lost while waiting for the result; execution may have started and the task was not resent`,
      code: "connection_lost", retryable: false, fromInstance: input.targetInstance,
    });
    throw new BusProtocolError({
      message: `Delegation to "${input.targetInstance}" could not reach the bus server`,
      code: "instance_unavailable",
      retryable: true,
      fromInstance: input.targetInstance,
    });
  } finally {
    clearTimeout(timeout);
    input.abortSignal?.removeEventListener("abort", onAbort);
  }
}

import type { ConnectionVerificationFailure, Route } from "../../src/client-protocol/routes.js";
import { connectionVerificationFailure, preferredVerificationFailure } from "./connection-verification.js";

export type PairingProbeSuccess = {
  route: Route;
  publicKey: string;
  supportsInvites: boolean;
};

export type PairingCandidateRaceFailureKind =
  | "verification"
  | "direct-and-relay-failed"
  | "direct-failed"
  | "relay-failed";

/** What one candidate's probe was rejected with. */
export type PairingCandidateFailure = { route: Route; error: unknown };

export class PairingCandidateRaceError extends Error {
  constructor(
    readonly kind: PairingCandidateRaceFailureKind,
    readonly verificationFailure?: ConnectionVerificationFailure,
    /** Every candidate, in the order given, with its own probe error. The race
     * only fails once all probes have ended, so none of these is an abort caused
     * by the race itself: route diagnostics can name the observed reason. */
    readonly attempts: readonly PairingCandidateFailure[] = [],
  ) {
    super(verificationFailure ?? kind);
  }
}

export interface RacePairingCandidatesOptions {
  /** Microsecond/millisecond grace window when a relay answers while at least one
   * direct candidate is still in flight, so a fast LAN reply wins a close tie. */
  directTieGraceMs?: number;
  probe: (route: Route, signal: AbortSignal) => Promise<PairingProbeSuccess>;
}

/** Probe all candidate routes concurrently and resolve with the first route that
 * passes host identity verification, preferring direct routes over relays on a tie.
 * Aborts remaining slow or blackholed probes as soon as a winner is chosen. */
export function racePairingCandidates(
  routes: readonly Route[],
  options: RacePairingCandidatesOptions,
): Promise<PairingProbeSuccess> {
  if (!routes.length) {
    return Promise.reject(new PairingCandidateRaceError("direct-failed"));
  }

  const directTieGraceMs = options.directTieGraceMs ?? 50;
  const controller = new AbortController();
  const hasDirect = routes.some(route => route.name !== "VPS");
  const hasRelay = routes.some(route => route.name === "VPS");

  return new Promise((resolve, reject) => {
    let settled = false;
    let selectionQueued = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let directPending = routes.filter(route => route.name !== "VPS").length;
    let totalFinished = 0;

    const successes = new Map<number, PairingProbeSuccess>();
    const failures: (ConnectionVerificationFailure | undefined)[] = [];
    const rejected = new Map<number, unknown>();

    const finishWithWinner = () => {
      if (settled) return;
      settled = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      controller.abort();
      const ordered = [...successes.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
      const winner = ordered.find(item => item.route.name !== "VPS") ?? ordered[0]!;
      resolve(winner);
    };

    const scheduleDirectWinner = () => {
      if (settled || selectionQueued) return;
      selectionQueued = true;
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      // Defer one microtask so simultaneous direct successes resolve in route priority order.
      queueMicrotask(finishWithWinner);
    };

    const checkAllFailed = () => {
      if (settled || totalFinished < routes.length || successes.size > 0) return;
      settled = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      controller.abort();
      const attempts = routes.map((route, index): PairingCandidateFailure => ({ route, error: rejected.get(index) }));
      const verification = preferredVerificationFailure(failures);
      if (verification) {
        reject(new PairingCandidateRaceError("verification", verification, attempts));
        return;
      }
      const kind: PairingCandidateRaceFailureKind = hasDirect && hasRelay
        ? "direct-and-relay-failed"
        : hasRelay && !hasDirect
          ? "relay-failed"
          : "direct-failed";
      reject(new PairingCandidateRaceError(kind, undefined, attempts));
    };

    routes.forEach((route, index) => {
      const isDirect = route.name !== "VPS";
      void options.probe(route, controller.signal).then(
        (result) => {
          totalFinished++;
          if (isDirect) directPending--;
          if (settled) return;
          successes.set(index, result);
          if (isDirect) {
            scheduleDirectWinner();
            return;
          }
          // Relay succeeded: if no direct candidates are still in flight (or grace is 0),
          // settle in one microtask; otherwise give in-flight direct candidates a brief tie window.
          if (directPending <= 0 || directTieGraceMs <= 0) {
            if (!selectionQueued) {
              selectionQueued = true;
              queueMicrotask(finishWithWinner);
            }
          } else if (graceTimer === undefined && !selectionQueued) {
            graceTimer = setTimeout(() => {
              graceTimer = undefined;
              finishWithWinner();
            }, directTieGraceMs);
          }
        },
        (error: unknown) => {
          totalFinished++;
          if (isDirect) directPending--;
          if (settled) return;
          failures.push(connectionVerificationFailure(error));
          rejected.set(index, error);
          // If a relay already succeeded and the last pending direct route just failed,
          // stop waiting out the tie grace timer immediately.
          if (successes.size > 0 && directPending <= 0 && !selectionQueued) {
            selectionQueued = true;
            if (graceTimer !== undefined) {
              clearTimeout(graceTimer);
              graceTimer = undefined;
            }
            queueMicrotask(finishWithWinner);
            return;
          }
          checkAllFailed();
        },
      );
    });
  });
}

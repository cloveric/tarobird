/** A run card's stop request, identified by the socket that carried it and the
 * number of stop_incomplete receipts that socket's connection had reported. */
export type StopReceipt = { socket: number; failures: number };

/** What a run card is waiting on: its own request (with a receipt), or the
 * run's reported "stopping" phase (without one). Each wait is a new object. */
export type StopWait = { receipt?: StopReceipt };

/** Longer than the Hub's 10s Bot RPC deadline, after which it reports
 * stop_incomplete. A successful stop is shown by the run's own phase. */
export const STOP_CONFIRMATION_MS = 15_000;

/** turn.stop has no success receipt and is scoped to a conversation/Bot, not a
 * run. A sent request waits for the run to report "stopping"; that phase then
 * waits for the run to end. Either wait ends on its deadline, and a request's
 * also on a reconnect or any later stop_incomplete. The card may then offer a
 * manual retry for its own run and Bot; nothing here ever resends, so a stop
 * can't reach the next task without a new user click. */
export function stopOutcome(wait: StopWait, current: StopReceipt, expired: boolean): "waiting" | "unconfirmed" {
  if (expired) return "unconfirmed";
  // stop_incomplete carries no request, run or Bot ID: one seen after this
  // request leaves it unconfirmed, but is not evidence about this Bot. The
  // failure may also be drained just before the socket is replaced.
  if (wait.receipt && (current.failures !== wait.receipt.failures || current.socket !== wait.receipt.socket)) return "unconfirmed";
  return "waiting";
}

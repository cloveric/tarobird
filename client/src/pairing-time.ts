/** HTTP Date is provided by both browser and native transports. Persist the
 * offset with the pending code so reloading keeps the same server deadline.
 * Old hosts/caches without a usable Date retain their existing behavior. */
export function pairingClockOffset(serverDate: string | null, localNow: number): number | undefined {
  const serverNow = serverDate ? Date.parse(serverDate) : NaN;
  return Number.isFinite(serverNow) ? serverNow - localNow : undefined;
}
export function pairingRemaining(expiresAt: number, localNow: number, serverTimeOffset = 0): number {
  return Math.max(0, Math.min(300, Math.ceil((expiresAt - localNow - serverTimeOffset) / 1000)));
}

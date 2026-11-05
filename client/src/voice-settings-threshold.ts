/** Preserve whole-second policies displayed in minutes (e.g. 500 / 60).
 * Only remove floating-point noise; actual fractional seconds stay invalid. */
export function voiceThresholdSeconds(minutes: string): number {
  const seconds = Number(minutes) * 60;
  const nearest = Math.round(seconds);
  return Math.abs(seconds - nearest) < 1e-8 ? nearest : seconds;
}

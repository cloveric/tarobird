import { HubHttpError, transientUploadError } from "./http-error.js";

/** Newest opt-ins first. Each later shape drops the most recently added one. */
export const SIDE_CAPABILITY_SHAPES = [{ delivery: true, tools: true, audio: true }, { delivery: false, tools: true, audio: true }, { delivery: false, tools: false, audio: true }, { delivery: false, tools: false, audio: false }] as const;
export type SideCapabilityShape = (typeof SIDE_CAPABILITY_SHAPES)[number];
export type SideCapabilityOutcome<T> = { kind: "ok"; value: T } | { kind: "transient" } | { kind: "final" } | { kind: "stale" };

/** Only an explicit request rejection (400) means an older Host cannot parse an
 * opt-in. Hubs ignore unknown query keys and absorb strict Gateways themselves,
 * so a timeout, dropped connection or overloaded Host says nothing about it. */
export function sideCapabilityFailure(error: unknown): "older" | "retry" | "final" {
  if (error instanceof HubHttpError) return error.status === 400 ? "older" : transientUploadError(error) ? "retry" : "final";
  // A malformed reply repeats on retry; match by name across bundled schema copies.
  if (error instanceof Error && error.name === "ZodError") return "final";
  // Includes native transport failures that are not browser TypeErrors.
  return "retry";
}

/** Read-only capability negotiation: steps down a shape only on an explicit
 * rejection and retries the same shape, boundedly, on a transient failure. */
export async function negotiateSideCapability<T>(request: (shape: SideCapabilityShape) => Promise<T>, options: {
  current: () => boolean; delays?: readonly number[]; sleep?: (ms: number) => Promise<void>;
}): Promise<SideCapabilityOutcome<T>> {
  const delays = options.delays ?? [1000, 3000], sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let shape = 0, attempt = 0; ;) {
    try { return { kind: "ok", value: await request(SIDE_CAPABILITY_SHAPES[shape]!) }; }
    catch (error) {
      if (!options.current()) return { kind: "stale" };
      const failure = sideCapabilityFailure(error);
      if (failure === "older" && shape < SIDE_CAPABILITY_SHAPES.length - 1) { shape++; attempt = 0; continue; }
      if (failure !== "retry") return { kind: "final" };
      if (attempt >= delays.length) return { kind: "transient" };
      await sleep(delays[attempt++]!);
      if (!options.current()) return { kind: "stale" };
    }
  }
}

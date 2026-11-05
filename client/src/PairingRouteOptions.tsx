import { DeploymentGuide } from "./DeploymentGuide.js";
import { VpsRouteFields } from "./RouteFields.js";
import type { Route } from "../../src/client-protocol/routes.js";

/** Advanced network choices load only when requested during pairing. */
export function PairingRouteOptions({ relays, busy, setRelays }: { relays: Route[]; busy: boolean; setRelays: (value: Route[]) => void }) {
  return <><VpsRouteFields routes={relays} change={setRelays} disabled={busy}/><DeploymentGuide/></>;
}

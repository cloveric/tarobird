import type { Page } from "@playwright/test";
import type { HubServer } from "../../../src/hub/server.js";
import { fixtureInvitation } from "./pairing-invite.js";
import type { multipleHosts } from "./multiple-hosts.js";

/** Non-UI cache/sync fixtures still use the real public strict pairing API. */
export async function pairFixtureHost(page: Page, hub: HubServer, name: string) {
  const invitation = await fixtureInvitation(hub);
  return page.evaluate(({ url, name, invite }) => (window as unknown as { multipleHosts: typeof multipleHosts }).multipleHosts.pair(url, name, invite),
    { url: hub.url, name, invite: invitation.invite });
}

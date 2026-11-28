import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { screenRtcSelectedRoute } from "../src/client-protocol/screen-rtc-browser.js";

const udp = (candidateType: string, address?: string) => ({ protocol: "udp", candidateType, address });

it("uses the selected, DTLS-connected UDP pair to describe playback", () => {
  const relay = udp("relay"), host = udp("host", "192.168.1.11");
  expect(screenRtcSelectedRoute("connecting", relay, relay)).toBeUndefined();
  expect(screenRtcSelectedRoute("connected", relay, { ...relay, protocol: "tcp" })).toBeUndefined();
  expect(screenRtcSelectedRoute("connected", relay, host)).toBeUndefined();
  expect(screenRtcSelectedRoute("connected", relay, relay)).toBe("udp_vps_relay");
  expect(screenRtcSelectedRoute("connected", host, udp("host", "192.168.1.12"))).toBe("udp_lan_direct");
  expect(screenRtcSelectedRoute("connected", udp("host", "fd7a:115c:a1e0::1"), udp("host", "fd7a:115c:a1e0::2"))).toBe("udp_tailscale_direct");
  expect(screenRtcSelectedRoute("connected", host, udp("prflx"))).toBe("udp_p2p");
  expect(screenRtcSelectedRoute("connected", udp("srflx"), udp("prflx"))).toBe("udp_p2p");
  expect(screenRtcSelectedRoute("connected", host, udp("host", `${randomUUID()}.local`))).toBe("udp_direct");
  expect(screenRtcSelectedRoute("connected", udp("host"), udp("host"))).toBe("udp_direct");
  expect(screenRtcSelectedRoute("connected", host, { protocol: "udp" })).toBe("udp_connected");
});
